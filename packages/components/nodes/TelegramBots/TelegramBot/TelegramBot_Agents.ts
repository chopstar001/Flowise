import { ICommonObject, INode, INodeData, INodeParams, FlowiseMemory, MessageType, IMessage } from '../../../src/Interface'
import { message } from 'telegraf/filters'
import { Telegraf, Context } from 'telegraf'
import { Message } from 'telegraf/typings/core/types/typegram'
import { ExtraReplyMessage } from 'telegraf/typings/telegram-types'
import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages'
import { MessageContentComplex } from '@langchain/core/messages';
import { Update, User, Chat } from 'telegraf/typings/core/types/typegram';
import { 
    ChatPromptTemplate, 
    SystemMessagePromptTemplate, 
    HumanMessagePromptTemplate,
    MessagesPlaceholder,
} from '@langchain/core/prompts'
import { BaseLanguageModel } from '@langchain/core/language_models/base'
import { RunnableSequence } from '@langchain/core/runnables'
import { BaseRetriever } from '@langchain/core/retrievers'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { Tool } from 'langchain/tools'
import { Document } from 'langchain/document'
import { ChatMember } from 'telegraf/typings/core/types/typegram';
import { Callbacks } from "@langchain/core/callbacks/manager"
import { getBaseClasses, getCredentialData, getCredentialParam } from '../../../src/utils'
import axios, { Axios } from 'axios'
let response: AIMessage;
let relevantDocs: Document[] = [];
interface ChainInput {
    question: string;
    chat_history: string;
}
class TelegramBot_Agents implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    inputs: INodeParams[]
    credential: INodeParams

    private bot: Telegraf<Context<Update>> | null = null
    private chain: RunnableSequence<ChainInput, string> | null = null
    private isInitialized: boolean = false
    private memory: FlowiseMemory | null = null
    private retriever: BaseRetriever
    private chatModel: BaseChatModel
    private knownBotIds: Set<number> = new Set();
    private groupMembers: Map<number, Map<number, { is_bot: boolean, is_admin: boolean }>> = new Map();
    private botToken: string;
    private botId: number | null = null;
    private knownBotUsernames: Set<string> = new Set(['BotB_username', 'AnotherBot_username']); // Add known bot usernames here
    private ragSystemPrompt: string | undefined;
    private generalSystemPrompt: string | undefined;
    private humanMessageTemplate: string | undefined;
    private combinedPrompt: ChatPromptTemplate;
    private tools: Tool[]

    constructor() {
        this.label = 'Telegram Bot with Retrieval Chain'
        this.name = 'telegramBotRetrievalChain'
        this.version = 1.0
        this.type = 'TelegramBot'
        this.icon = 'telegram.svg'
        this.category = 'Agents'
        this.description = 'Versatile Telegram bot with optional RAG capabilities. Supports custom prompts, handles human/AI interactions. Ideal for customer service, information retrieval, and inter-bot communication. Requires Telegram API credentials.'
        this.baseClasses = [this.type, 'Composer']
        this.credential = {
            label: 'Telegram API',
            name: 'telegramApi',
            type: 'credential',
            credentialNames: ['telegramApi']
        }
        this.inputs = [
            {
                label: 'Memory',
                name: 'memory',
                type: 'BaseChatMemory',
                optional: true
            },
            {
                label: 'Chat Model',
                name: 'chatModel',
                type: 'BaseChatModel',
                optional: false
            },
            {
                label: 'Retriever',
                name: 'retriever',
                type: 'BaseRetriever',
                optional: true
            },
            {
                label: 'Tools',
                name: 'tools',
                type: 'Tool',
                list: true,
                optional: true
            },
            {
                label: 'RAG System Prompt',
                name: 'ragSystemPrompt',
                type: 'string',
                rows: 4,
                placeholder: 'Enter the system prompt for RAG mode',
                optional: true,
                additionalParams: true
            },
            {
                label: 'General System Prompt',
                name: 'generalSystemPrompt',
                type: 'string',
                rows: 4,
                placeholder: 'Enter the system prompt for general mode',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Human Message Template',
                name: 'humanMessageTemplate',
                type: 'string',
                rows: 2,
                placeholder: 'Enter the human message template',
                optional: true,
                additionalParams: true
            }
                
        ]
    }
    // Add these methods near the top of the class, after the constructor

    private async getRelevantContext(question: string, chatHistory: string): Promise<string> {
        if (!this.retriever) return "";

        const docs = await this.retriever.invoke(question);
        const scoredDocs = docs.map(doc => ({
            content: doc.pageContent,
            score: this.calculateRelevanceScore(doc.pageContent, question, chatHistory)
        }));

        // Sort by score and take top N
        const topDocs = scoredDocs.sort((a, b) => b.score - a.score).slice(0, 3);
        return topDocs.map(doc => doc.content).join("\n\n");
    }

    private calculateRelevanceScore(docContent: string, question: string, chatHistory: string): number {
        // Implement a scoring mechanism here
        // This could use techniques like TF-IDF, cosine similarity, or even a small ML model
        // For now, we'll use a simple keyword matching score as a placeholder
        const keywords = [...question.toLowerCase().split(' '), ...chatHistory.toLowerCase().split(' ')];
        const uniqueKeywords = [...new Set(keywords)];
        return uniqueKeywords.filter(keyword => docContent.toLowerCase().includes(keyword)).length / uniqueKeywords.length;
    }

    private async getDynamicContext(question: string, chatHistory: string): Promise<string> {
        const relevantContext = await this.getRelevantContext(question, chatHistory);
        const contextComplexity = this.assessContextComplexity(relevantContext);
        const questionComplexity = this.assessQuestionComplexity(question);

        if (contextComplexity > 0.7 && questionComplexity > 0.5) {
            return relevantContext; // Use full context for complex questions and rich context
        } else if (questionComplexity < 0.3) {
            return ""; // Skip context for very simple questions
        } else {
            return this.summarizeContext(relevantContext); // Use summarized context for moderate cases
        }
    }

    private assessContextComplexity(context: string): number {
        // Implement complexity assessment logic
        // This is a simple placeholder implementation
        return context.split(' ').length / 1000; // Normalize by 1000 words
    }

    private assessQuestionComplexity(question: string): number {
        // Implement question complexity assessment
        // This is a simple placeholder implementation
        const complexityIndicators = ['why', 'how', 'explain', 'compare', 'analyze'];
        return complexityIndicators.filter(indicator => question.toLowerCase().includes(indicator)).length / complexityIndicators.length;
    }

    private summarizeContext(context: string): string {
        // Implement context summarization logic
        // This is a simple placeholder implementation
        return context.split(' ').slice(0, 100).join(' ') + '...';
    }

    private async trackContextSuccess(context: string, question: string, response: string) {
        // Implement logic to store successful context-question-response triplets
        // This data can be used to improve retrieval and relevance scoring over time
        console.log('Tracking successful context-question-response:');
        console.log('Context:', context);
        console.log('Question:', question);
        console.log('Response:', response);
        // In a real implementation, you would store this data for later analysis
    }
    async init(nodeData: INodeData, flowData: string, options: ICommonObject): Promise<any> {
        console.log("Starting initialization of TelegramBot_Agents node");
    
        try {
            console.log("Checking inputs...");
            
            // Initialize components from inputs
            this.chatModel = nodeData.inputs?.chatModel as BaseChatModel;
            this.memory = nodeData.inputs?.memory as FlowiseMemory;
            this.ragSystemPrompt = nodeData.inputs?.ragSystemPrompt as string;
            this.generalSystemPrompt = nodeData.inputs?.generalSystemPrompt as string;
            this.humanMessageTemplate = nodeData.inputs?.humanMessageTemplate as string;
            this.chatModel = nodeData.inputs?.chatModel as BaseChatModel;
            this.retriever = nodeData.inputs?.retriever as BaseRetriever || new SimpleInMemoryRetriever();
            console.log(this.retriever ? "Using provided retriever." : "Using SimpleInMemoryRetriever as fallback.");
            this.tools = nodeData.inputs?.tools as Tool[] || [];
            console.log(this.tools.length ? `Tool Agent detected with ${this.tools.length} tools available.` : 'No Tool Agent detected.');
            this.ragSystemPrompt = nodeData.inputs?.ragSystemPrompt as string;
            this.generalSystemPrompt = nodeData.inputs?.generalSystemPrompt as string;
            this.humanMessageTemplate = nodeData.inputs?.humanMessageTemplate as string;
            this.combinedPrompt = this.createCombinedPrompt();
            console.log("Prompts initialized:");
            console.log("RAG System Prompt:", this.ragSystemPrompt || "Using default");
            console.log("General System Prompt:", this.generalSystemPrompt || "Using default");
            console.log("Human Message Template:", this.humanMessageTemplate || "Using default");

            // Handle credential
            const credentialId = nodeData.credential;
            if (!credentialId) {
                throw new Error('Telegram API credential not found');
            }

            // Fetch credential data using the utility function
            const credentialData = await getCredentialData(credentialId, options);
            if (!credentialData) {
                throw new Error(`Failed to fetch credential data for id: ${credentialId}`);
            }
            if (this.bot) {
                console.log("Bot instance already exists. Stopping previous instance.");
                await this.stop();
            }
            // Get the bot token from the credential data
            this.botToken = getCredentialParam('botToken', credentialData, nodeData);
            if (!this.botToken) {
                throw new Error('Bot token not found in credential data');
            }

            if (!this.chatModel) {
                throw new Error('Missing required input: chatModel');
            }
            if (this.retriever) {
                await this.checkRetrieverConfiguration();
                console.log('Retriever detected. RAG system will be used.');
              } else {
                console.log('No retriever detected. Using general QA system.');
              }
              
            // Initialize fallback retriever if not provided
            if (!this.retriever) {
                console.log("No retriever provided. Using SimpleInMemoryRetriever as fallback.");
                this.retriever = new SimpleInMemoryRetriever();
            }
            if (this.tools && this.tools.length > 0) {
                console.log(`Tool Agent detected with ${this.tools.length} tools available.`);
              } else {
                console.log('No Tool Agent detected.');
              }
              

            console.log("All required inputs are present");

            // Initialize Telegram bot
            console.log("Initializing Telegram bot...");
            this.bot = new Telegraf(this.botToken);
            try {
                const botInfo = await this.bot.telegram.getMe();
                this.botId = botInfo.id;
                console.log(`Bot initialized with ID: ${this.botId}`);
            } catch (error) {
                console.error('Error getting bot info:', error);
                throw error;
            }

            // Set up bot commands and message handler
            console.log("Setting up bot commands...");
            this.bot.command('start', this.handleStart.bind(this));
            this.bot.command('help', this.handleHelp.bind(this));
            this.bot.command('update_members', this.updateGroupMembers.bind(this));
            this.bot.on(message('text'), this.handleMessage.bind(this));
            this.bot.command('debug', this.handleDebug.bind(this));
            this.bot.command('stop', this.handleStopCommand.bind(this));
            this.bot.command('stopclear', this.handleStopAndClearMemoryCommand.bind(this));
            this.bot.command('clearmemory', this.handleClearMemoryCommand.bind(this));

            // Initialize the chain
            console.log("Initializing the chain...");
            this.chain = this.createChain();

            // Launch the bot
            console.log('Launching bot...');
            await this.bot.launch();
            console.log('Telegram bot launched successfully');

            this.isInitialized = true;
            console.log('TelegramBot_Agents initialization completed successfully');

            return this.bot;

        } catch (error) {
            console.error("Error in init method:", error);
            throw error;
        }
    }
    async stop(): Promise<void> {
    if (this.isInitialized) {
        await this.handleStop(false);
    } else {
        console.log('TelegramBot_Agents is not running. No need to stop.');
    }
}
    private async processMessage(ctx: Context, incomingMessage: Message, isAI: boolean): Promise<void> {
        console.log("Entering processMessage method");
        console.log(`Message type: ${isAI ? 'AI' : 'Human'}`);

        if (!this.chain) {
            console.error('Chain is not initialized');
            await this.sendReply(ctx, 'Sorry, I\'m not ready to process messages yet.', incomingMessage.message_id);
            return;
        }
    
        const sessionId = this.getSessionId(ctx);
        console.log(`Session ID: ${sessionId}`);

        if (!('text' in incomingMessage)) {
            console.error('Received message is not a text message');
            await this.sendReply(ctx, 'Sorry, I can only process text messages.', incomingMessage.message_id);
            return;
        }
        const textMessage = incomingMessage as Message.TextMessage;
        const userMessage = textMessage.text;
        console.log(`Received message: "${userMessage}"`);

        try {
            const chatHistory = await this.getChatHistory(sessionId);
            console.log("Chat history retrieved:", chatHistory);
    
            let chainInput: ChainInput = {
                question: userMessage,
                chat_history: chatHistory
            };
            console.log('Preparing to invoke chain with input:', JSON.stringify(chainInput, null, 2));
            console.log('Current configuration:');
            console.log(`- Retriever: ${this.retriever ? 'Active' : 'Inactive'}`);
            console.log(`- Tool Agent: ${this.tools && this.tools.length > 0 ? 'Active' : 'Inactive'}`);
            
            const result = await this.chain.invoke(chainInput);
            console.log("Chain result:", result);

            if (!result) {
                console.error("Chain returned empty result");
                await this.sendReply(ctx, "I'm sorry, but I couldn't process your request. Please try again.", textMessage.message_id);
                return;
            }

            console.log(`Result: ${result}`);
            if (isAI) {
                chainInput.question = `[AI Message] ${chainInput.question}`;
                chainInput.chat_history = `[AI Interaction]\n${chainInput.chat_history}`;
                console.log("Modified chain input for AI message:", chainInput);
            }
    
            // Use the existing chain
            console.log("Invoking chain with input:", chainInput);
            console.log("Chain result:", result);
    
            console.log(`Result: ${result}`);
            // Send the reply with reference to the original message
            await this.sendReply(ctx, result, textMessage.message_id);
            console.log("Reply sent to user");

            if (this.memory) {
                console.log(`Updating memory for session ${sessionId}`);
                const messages: { text: string; type: MessageType }[] = [
                    { text: userMessage, type: isAI ? 'apiMessage' : 'userMessage' },
                    { text: result, type: 'apiMessage' }
                ];
                await this.memory.addChatMessages(messages, sessionId);
                console.log("Memory updated with new messages");
            }
        } catch (error) {
            console.error(`[${sessionId}] Error processing message:`, error);
            const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
            await this.sendReply(ctx, `Sorry, I encountered an error: ${errorMessage}`, textMessage.message_id);
        }
        console.log("Exiting processMessage method");
    }
    
    private createCombinedPrompt(): ChatPromptTemplate {
        console.log("Creating combined prompt");       
        const systemMessageContent = this.ragSystemPrompt || this.generalSystemPrompt || 
            "You are a helpful AI assistant. Use the following pieces of information to formulate your response: " +
            "1. The chat history provides context for the conversation. " +
            "2. The retrieved context provides factual information to answer the question. " +
            "If you can't find the answer in the provided information, say that you don't know.";
            console.log("Using System Message Content:", systemMessageContent);
        const humanMessageTemplate = this.humanMessageTemplate || 
            "Chat History:\n{chat_history}\n\nRetrieved Context:\n{context}\n\nCurrent Input: {question}\n\nResponse:";
            console.log("Using Human Message Template:", humanMessageTemplate);
        return ChatPromptTemplate.fromMessages([
            SystemMessagePromptTemplate.fromTemplate(systemMessageContent),
            new MessagesPlaceholder("chat_history"),
            HumanMessagePromptTemplate.fromTemplate(humanMessageTemplate)
        ]);
    }

    
    private async sendReply(ctx: Context, text: string, replyToMessageId: number): Promise<void> {
        try {
            const extra: any = {
                parse_mode: 'HTML',
                reply_to_message_id: replyToMessageId
            };
            await ctx.telegram.sendMessage(ctx.chat!.id, text, extra);
        } catch (error) {
            console.error('Error sending reply:', error);
            // Fallback to regular message if reply fails
            await ctx.telegram.sendMessage(ctx.chat!.id, text);
        }
    }
    private async handleStart(ctx: Context) {
        console.log("Received /start command");
        if ('message' in ctx.update && 'message_id' in ctx.update.message) {
            await this.sendReply(ctx, 'Welcome! I\'m your AI assistant with Retrieval Chain capabilities.', ctx.update.message.message_id);
        } else {
            await ctx.reply('Welcome! I\'m your AI assistant with Retrieval Chain capabilities.');
        }
    }
    
    private async handleHelp(ctx: Context) {
        console.log("Received /help command");
        if ('message' in ctx.update && 'message_id' in ctx.update.message) {
            await this.sendReply(ctx, 'I can assist you with various tasks and provide information from my knowledge base. Just send me a message!', ctx.update.message.message_id);
        } else {
            await ctx.reply('I can assist you with various tasks and provide information from my knowledge base. Just send me a message!');
        }
    }
    private async handleStop(clearMemory: boolean = false): Promise<void> {
        console.log('Stopping Telegram bot...');
    
        try {
            // Stop the bot
            if (this.bot) {
                await this.bot.stop();
                console.log('Telegram bot stopped successfully');
            }
    
            // Clear any ongoing operations or timers
            // For example, if you have any setInterval or setTimeout, clear them here
    
            // Close any open connections
            // For example, if you're using a database connection, close it here
    
            // Clear memory if specified
            if (clearMemory && this.memory) {
                await this.memory.clear();
                console.log('Memory cleared');
            }
    
            // Reset instance variables
            this.bot = null;
            this.chain = null;
            this.isInitialized = false;
    
            console.log('TelegramBot_Agents stopped and resources cleaned up');
        } catch (error) {
            console.error('Error stopping TelegramBot_Agents:', error);
            throw error;
        }
    }
    private async handleStopCommand(ctx: Context): Promise<void> {
        console.log("Received /stop command");
        await ctx.reply('Stopping the bot. Goodbye!');
        await this.handleStop(false);
    }
    
    private async handleStopAndClearMemoryCommand(ctx: Context): Promise<void> {
        console.log("Received /stop -cm command");
        await ctx.reply('Stopping the bot and clearing memory. Goodbye!');
        await this.handleStop(true);
    }
    
    private async handleClearMemoryCommand(ctx: Context): Promise<void> {
        console.log("Received /clearmemory command");
        if (this.memory) {
            await this.memory.clear();
            await ctx.reply('Memory has been cleared.');
        } else {
            await ctx.reply('No memory to clear.');
        }
    }
    private async updateGroupMembers(ctx: Context): Promise<void> {
        console.log("Entering updateGroupMembers");
        if (!ctx.chat) {
            console.error('Chat context is undefined');
            return;
        }

        if (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') {
            try {
                const chatId = ctx.chat.id;
                console.log(`Fetching members for chat ${chatId}`);
                
                // Fetch administrators
                const admins = await ctx.telegram.getChatAdministrators(chatId);
                console.log(`Fetched ${admins.length} administrators`);

                // Initialize member info map
                const memberInfo = new Map<number, { is_bot: boolean, is_admin: boolean }>();

                // Add admins to the member info
                admins.forEach((admin: ChatMember) => {
                    memberInfo.set(admin.user.id, {
                        is_bot: admin.user.is_bot,
                        is_admin: true
                    });
                });

                // For non-admin members, we can't fetch all of them at once.
                // Instead, we'll update the member info when we encounter new users.

                this.groupMembers.set(chatId, memberInfo);
                console.log(`Updated group members for chat ${chatId}`);
                await ctx.reply('Group member list updated.');
            } catch (error) {
                console.error('Error updating group members:', error);
                await ctx.reply('Failed to update group member list.');
            }
        } else {
            console.log("Not a group chat, skipping member update");
            await ctx.reply('This command can only be used in group chats.');
        }
    }
    // Replace the entire createChain method with this updated version

    private createChain(): RunnableSequence<ChainInput, string> {
        const CONDENSE_QUESTION_PROMPT = ChatPromptTemplate.fromMessages([
            SystemMessagePromptTemplate.fromTemplate(
                "Given the following conversation history and a new question, rephrase the new question to be a standalone question. " +
                "Use the chat history for context, but make sure the new question can be understood on its own."
            ),
            HumanMessagePromptTemplate.fromTemplate("Chat History:\n{chat_history}\n\nNew Question: {question}\n\nStandalone question:"),
        ]);
    
        const QA_PROMPT = ChatPromptTemplate.fromMessages([
            SystemMessagePromptTemplate.fromTemplate(
                "You are a helpful AI assistant with access to relevant context information. " +
                "Use the following pieces of information to answer the human's question:\n" +
                "1. The chat history provides context for the conversation.\n" +
                "2. The retrieved context provides factual information to answer the question.\n" +
                "If you can't find the answer in the provided information, rely on your general knowledge. " +
                "If you're still unsure, say that you don't know."
            ),
            HumanMessagePromptTemplate.fromTemplate("Chat History:\n{chat_history}\n\nRetrieved Context:\n{context}\n\nQuestion: {question}\n\nAnswer:"),
        ]);
    
        return RunnableSequence.from([
            {
                standalone_question: async (input: ChainInput) => {
                    const { question, chat_history } = input;
                    const truncatedHistory = this.truncateChatHistory(chat_history, 500);
                    const formattedPrompt = await CONDENSE_QUESTION_PROMPT.formatMessages({
                        chat_history: truncatedHistory,
                        question,
                    });
                    const response = await this.chatModel.invoke(formattedPrompt);
                    return response.content;
                },
                original_input: (input: ChainInput) => input.question,
                chat_history: (input: ChainInput) => input.chat_history,
            },
            {
                context: async (input: { standalone_question: string }) => {
                    if (!this.retriever) return "";
                    const relevantDocs = await this.retriever.invoke(input.standalone_question);
                    const context = relevantDocs.map(doc => doc.pageContent).join("\n\n");
                    return this.truncateChatHistory(context, 1000); // Limit context to ~1000 tokens
                },
                question: (input) => input.standalone_question,
                chat_history: (input) => input.chat_history,
            },
            async (input) => {
                const truncatedHistory = this.truncateChatHistory(input.chat_history, 500);
                const formattedPrompt = await QA_PROMPT.formatMessages({
                    context: input.context,
                    question: input.question,
                    chat_history: truncatedHistory,
                });
                
                let response: AIMessage;
                try {
                    response = await this.chatModel.invoke(formattedPrompt);
                } catch (error) {
                    console.error('Error invoking chat model:', error);
                    throw error;
                }
    
                if (this.tools && this.tools.length > 0) {
                    console.log('Using Tool Agent to process response...');
                    response = await this.processWithToolAgent(response.content);
                }
    
                return this.truncateMessage(response.content as string);
            },
        ]);
    }
        
    private truncateChatHistory(chatHistory: string, maxTokens: number = 1000): string {
        const tokens = chatHistory.split(/\s+/);
        if (tokens.length <= maxTokens) return chatHistory;
        return tokens.slice(-maxTokens).join(' ');
    }
    
    private truncateMessage(message: string, maxLength: number = 4096): string {
        if (message.length <= maxLength) return message;
        return message.slice(0, maxLength - 3) + '...';
    }
    private async handleDebug(ctx: Context) {
            console.log("Received /debug command");
            const configInfo = this.getConfigurationInfo();
            await ctx.reply(configInfo);
        }
        
        private getConfigurationInfo(): string {
            return `
        Bot Configuration:
        - Retriever: ${this.retriever ? 'Enabled' : 'Disabled'}
        - Tool Agent: ${this.tools && this.tools.length > 0 ? 'Enabled' : 'Disabled'}
        - Chat Model: ${this.chatModel ? this.chatModel.constructor.name : 'Not set'}
        - Memory: ${this.memory ? 'Enabled' : 'Disabled'}`;
        }
        
        private responseContentIncludesContext(content: string | object, context: string): boolean {
            const contentString = typeof content === 'string' ? content : JSON.stringify(content);
            return contentString.toLowerCase().includes(context.toLowerCase().substring(0, 50));
        }
        
        private async processWithToolAgent(content: string | MessageContentComplex): Promise<AIMessage> {
            console.log('Processing with Tool Agent:', content);
            // Implement actual Tool Agent logic here
            // This is a placeholder implementation
            return new AIMessage(typeof content === 'string' ? content : JSON.stringify(content));
        }
    

    // Replace the existing handleMessage method with this updated version

    private async handleMessage(ctx: Context): Promise<void> {
        console.log("Entering handleMessage");
        if (!ctx.message || !('text' in ctx.message) || !ctx.chat) {
            console.error('Invalid message or chat context');
            return;
        }

        const message = ctx.message as Message.TextMessage;
        console.log("Received message:", JSON.stringify(message, null, 2));
        const chatId = ctx.chat.id;
        const senderId = message.from?.id;
        const senderUsername = message.from?.username;

        if (!senderId) {
            console.error('Sender ID is undefined');
            return;
        }
        // Check if the bot is mentioned
        const botUsername = this.bot?.botInfo?.username;
        if (!botUsername) {
        console.error('Bot username is undefined');
        return;
        }
        const botMentionRegex = new RegExp(`@${botUsername}\\b`, 'i');
        if (!botMentionRegex.test(message.text)) {
            console.log('Bot not mentioned, ignoring message');
            return;
        }
        console.log(`Processing message from sender ${senderId} (username: ${senderUsername}) in chat ${chatId}`);
        console.log(`Sender info: ${JSON.stringify(message.from, null, 2)}`);
        const cleanedMessage = message.text.replace(botMentionRegex, '').trim();
        console.log(`Bot mentioned. Cleaned message: "${cleanedMessage}"`);
        const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
        console.log(`Is group chat: ${isGroup}`);

        const isKnownBot = senderUsername && this.knownBotUsernames.has(senderUsername);
        console.log(`Is known bot (by username): ${isKnownBot}`);

        if (isGroup) {
            console.log(`Processing group message in chat ${chatId}`);
            const isBotByCheck = await this.isBotInGroup(chatId, senderId);
            console.log(`Is sender a bot (according to our check): ${isBotByCheck}`);
    
            if (isBotByCheck && senderId !== this.botId) {
                console.log(`Message is from another bot (ID: ${senderId}, Username: ${senderUsername})`);
                await this.handleBotMessage(ctx, { ...message, text: cleanedMessage });
            } else {
                console.log(`Message is from a human user or this bot`);
                await this.handleHumanMessage(ctx, { ...message, text: cleanedMessage });
            }
        } else {
            console.log("Processing as private chat message");
            const isAI = await this.isAIUser(ctx);
            await this.processMessage(ctx, { ...message, text: cleanedMessage }, isAI);
        }
    }
    private async checkRetrieverConfiguration(): Promise<void> {
        if (!this.retriever) {
          console.log('No retriever configured.');
          return;
        }
      
        console.log('Checking retriever configuration...');
        
        try {
          // Attempt to retrieve documents for a simple query
          const testQuery = 'test';
          const testDocs = await this.retriever.invoke(testQuery);
          console.log(`Test query "${testQuery}" retrieved ${testDocs.length} documents.`);
          
          if (testDocs.length > 0) {
            console.log('Sample document:', JSON.stringify(testDocs[0], null, 2));
          }
      
          // If your retriever has a method to get its configuration, call it here
          // For example:
          // if (typeof this.retriever.getConfiguration === 'function') {
          //   const config = await this.retriever.getConfiguration();
          //   console.log('Retriever configuration:', config);
          // }
        } catch (error) {
          console.error('Error checking retriever configuration:', error);
          if (error instanceof Error) {
            console.error('Error name:', error.name);
            console.error('Error message:', error.message);
            console.error('Error stack:', error.stack);
          }
        }
      }
      
    private async isBotInGroup(chatId: number, userId: number): Promise<boolean> {
        console.log(`Checking if user ${userId} is a bot in chat ${chatId}`);
        
        if (!this.bot || this.botId === null) {
            console.error('Bot is not properly initialized');
            return false;
        }
    
        if (userId === this.botId) {
            console.log(`User ${userId} is this bot, not considering as external bot`);
            return false;
        }
    
        let members = this.groupMembers.get(chatId);
        if (!members) {
            console.log(`No members found for chat ${chatId}, initializing`);
            members = new Map();
            this.groupMembers.set(chatId, members);
        }
    
        let memberInfo = members.get(userId);
        if (!memberInfo) {
            console.log(`User ${userId} not found in cache, fetching info`);
            try {
                const chatMember = await this.bot.telegram.getChatMember(chatId, userId);
                console.log(`Chat member info for ${userId}:`, JSON.stringify(chatMember, null, 2));
                
                memberInfo = {
                    is_bot: chatMember.user.is_bot,
                    is_admin: ['administrator', 'creator'].includes(chatMember.status)
                };
                members.set(userId, memberInfo);
                
                console.log(`User ${userId} is bot: ${memberInfo.is_bot}, is admin: ${memberInfo.is_admin}`);
            } catch (error) {
                console.error(`Error fetching info for user ${userId}:`, error);
                return false;
            }
        } else {
            console.log(`User ${userId} found in cache`);
        }
    
        console.log(`User ${userId} is bot: ${memberInfo.is_bot}, is admin: ${memberInfo.is_admin}`);
        return memberInfo.is_bot;
    }

    private async handleBotMessage(ctx: Context, message: Message.TextMessage): Promise<void> {
        console.log(`Received bot message: ${message.text}`);
        await this.processMessage(ctx, message, true);
    }

    private async handleHumanMessage(ctx: Context, message: Message.TextMessage): Promise<void> {
        console.log(`Received human message: ${message.text}`);
        await this.processMessage(ctx, message, false);
    }

    private async isAIUser(ctx: Context): Promise<boolean> {
        const userId = ctx.from?.id;
        const username = ctx.from?.username?.toLowerCase() || '';
        const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';

        if (!userId) return false;
        if (this.knownBotIds.has(userId)) return true;
        if (username.endsWith('bot')) return true;
        if (messageText.startsWith('[BOT]')) return true;

        // API check as a last resort
        try {
            if (!this.botToken) throw new Error('Bot token not available');
            const response = await axios.get(`https://api.telegram.org/bot${this.botToken}/getChat?chat_id=${userId}`);
            return response.data.result.type === 'bot';
        } catch (error) {
            console.error('Error checking user type:', error);
            return false;
        }
    }
    private async getChatHistory(sessionId: string): Promise<string> {
        if (!this.memory) {
            console.log(`[${sessionId}] No memory available, returning empty chat history`);
            return '';
        }
        const messages = await this.memory.getChatMessages(sessionId);
        console.log(`[${sessionId}] Retrieved messages from memory:`, messages);
        
        // Limit to last 10 messages or adjust as needed
        const recentMessages = messages.slice(-10);
        
        const formattedHistory = this.formatChatHistory(this.convertToIMessages(recentMessages));
        console.log(`[${sessionId}] Formatted chat history:`, formattedHistory);
        return formattedHistory;
    }
    private async updateMemory(sessionId: string, userMessage: string, botResponse: string): Promise<void> {
        if (this.memory) {
            await this.memory.addChatMessages([
                { text: userMessage, type: 'userMessage' },
                { text: botResponse, type: 'apiMessage' }
            ], sessionId);
        }
    }

    private convertToIMessages(messages: BaseMessage[] | IMessage[]): IMessage[] {
        return messages.map(msg => {
            if ('message' in msg && 'type' in msg) {
                // It's already an IMessage
                return msg as IMessage;
            } else {
                // It's a BaseMessage, convert it to IMessage
                return {
                    message: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                    type: msg._getType() === 'human' ? 'userMessage' : 'apiMessage'
                };
            }
        });
    }

    private formatChatHistory(messages: IMessage[]): string {
        return messages.map(msg => `${msg.type === 'userMessage' ? 'Human' : 'AI'}: ${msg.message}`).join('\n');
    }


    async run(nodeData: INodeData, input: string, options?: ICommonObject): Promise<string | ICommonObject> {
        if (!this.isInitialized || !this.bot || !this.chain) {
            throw new Error('Bot or chain is not initialized');
        }
    
        console.log(`Run method called with input: "${input}"`);
        console.log('Run options:', options);
    
        options = options || {}; // Ensure options is defined
    
        if (options.chatId) {
            await this.bot.telegram.sendMessage(options.chatId, input);
            console.log(`Message sent to chat ID ${options.chatId}`);
            return 'Message sent successfully';
        } else {
            console.log('Invoking chain with chat history');
            
            // Create a more accurate mock Context object
            const mockContext: Partial<Context<Update>> = {
                from: options.fromId ? {
                    id: options.fromId,
                    is_bot: false,
                    first_name: 'Unknown'
                } : undefined,
                chat: options.chatId ? {
                    id: options.chatId,
                    type: 'private',
                } as Chat.PrivateChat | Chat.GroupChat | Chat.SupergroupChat | Chat.ChannelChat : undefined
            };
    
            const sessionId = this.getSessionId(mockContext as Context);
            const chatHistory = await this.getChatHistory(sessionId);
            const result = await this.chain.invoke({
                question: input,
                chat_history: chatHistory
            });
            console.log('Chain result:', result);
            
            // Update memory with the new interaction
            await this.updateMemory(sessionId, input, result);
            
            return result;
        }
    }
    
    // Keep your existing getSessionId method
    private getSessionId(ctx: Context): string {
        const fromId = ctx.from?.id;
        const chatId = ctx.chat?.id;
        return `telegram-${fromId || chatId || 'unknown'}`;
    }
}

class SimpleInMemoryRetriever extends BaseRetriever {
    private documents: Document[];
    lc_namespace: string[] = ["langchain", "retrievers", "simple_memory"];

    constructor() {
        super();
        this.documents = [
            new Document({ pageContent: "Flowise is a drag & drop tool to build LLM apps", metadata: { source: "Flowise docs" } }),
            new Document({ pageContent: "LangChain is a framework for developing applications powered by language models", metadata: { source: "LangChain docs" } }),
            new Document({ pageContent: "Telegram is a cloud-based instant messaging service", metadata: { source: "Telegram website" } }),
        ];
    }

    async getRelevantDocuments(query: string): Promise<Document[]> {
        return this.documents.filter(doc => 
            doc.pageContent.toLowerCase().includes(query.toLowerCase())
        );
    }
}


module.exports = { nodeClass: TelegramBot_Agents }