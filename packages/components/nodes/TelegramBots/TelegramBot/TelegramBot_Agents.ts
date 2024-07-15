import { ICommonObject, INode, INodeData, INodeParams, FlowiseMemory, MessageType, IMessage } from '../../../src/Interface'
import { Telegraf, Context } from 'telegraf'
import { message } from 'telegraf/filters'
import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages'
import { 
    ChatPromptTemplate, 
    SystemMessagePromptTemplate, 
    HumanMessagePromptTemplate,
} from '@langchain/core/prompts'
import { BaseLanguageModel } from '@langchain/core/language_models/base'
import { RunnableSequence } from '@langchain/core/runnables'
import { BaseRetriever } from '@langchain/core/retrievers'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { Tool } from 'langchain/tools'
import { Update } from 'telegraf/typings/core/types/typegram'
import { Document } from 'langchain/document'
import { Callbacks } from "@langchain/core/callbacks/manager"

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

    private bot: Telegraf<Context<Update>> | null = null
    private chain: RunnableSequence<ChainInput, string> | null = null
    private isInitialized: boolean = false
    private memory: FlowiseMemory | null = null
    private retriever: BaseRetriever
    private chatModel: BaseChatModel
    private tools: Tool[]

    constructor() {
        this.label = 'Telegram Bot with Retrieval Chain'
        this.name = 'telegramBotRetrievalChain'
        this.version = 1.0
        this.type = 'TelegramBot'
        this.icon = 'telegram.svg'
        this.category = 'Agents'
        this.description = 'Interact with Telegram using a bot with Retrieval Chain capabilities'
        this.baseClasses = [this.type, 'Composer']
        this.inputs = [
            {
                label: 'Bot Token',
                name: 'botToken',
                type: 'password',
                placeholder: 'Enter your Telegram Bot Token',
                optional: false
            },
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
            }
        ]
    }

    async init(nodeData: INodeData, flowData: string, options: ICommonObject): Promise<any> {
        console.log("Starting initialization of TelegramBot_Agents node")

        try {
            console.log("Checking inputs...")
            const botToken = nodeData.inputs?.botToken as string
            this.chatModel = nodeData.inputs?.chatModel as BaseChatModel
            this.retriever = nodeData.inputs?.retriever as BaseRetriever
            this.memory = nodeData.inputs?.memory as FlowiseMemory
            this.tools = nodeData.inputs?.tools as Tool[] || []

            if (!botToken || !this.chatModel) {
                throw new Error('Missing required inputs: botToken or chatModel')
            }

            if (!this.retriever) {
                console.log("No retriever provided. Using SimpleInMemoryRetriever as fallback.")
                this.retriever = new SimpleInMemoryRetriever()
            }

            console.log("All required inputs are present")

            console.log("Initializing Telegram bot...")
            this.bot = new Telegraf(botToken)

            console.log("Setting up bot commands...")
            this.bot.command('start', this.handleStart.bind(this))
            this.bot.command('help', this.handleHelp.bind(this))

            console.log("Setting up message handler...")
            this.bot.on(message('text'), this.handleMessage.bind(this))

            console.log("Initializing the chain...")
            this.chain = this.createChain()

            console.log('Launching bot...')
            await this.bot.launch()
            console.log('Telegram bot launched successfully')

            this.isInitialized = true
            console.log('TelegramBot_Agents initialization completed successfully')

            return this.bot

        } catch (error) {
            console.error("Error in init method:", error)
            throw error
        }
    }

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
                "You are a helpful AI assistant. Use the following pieces of information to answer the human's question:\n" +
                "1. The chat history provides context for the conversation.\n" +
                "2. The retrieved context provides factual information to answer the question.\n" +
                "If you can't find the answer in the provided information, say that you don't know."
            ),
            HumanMessagePromptTemplate.fromTemplate("Chat History:\n{chat_history}\n\nRetrieved Context:\n{context}\n\nQuestion: {question}\n\nAnswer:"),
        ]);        
    
        return RunnableSequence.from([
            {
                standalone_question: async (input: ChainInput) => {
                    const { question, chat_history } = input;
                    const formattedPrompt = await CONDENSE_QUESTION_PROMPT.formatMessages({
                        chat_history,
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
                    const relevantDocs = await this.retriever.invoke(input.standalone_question);
                    return relevantDocs.map(doc => doc.pageContent).join("\n\n");
                },
                question: (input) => input.standalone_question,
                chat_history: (input) => input.chat_history,
            },
            async (input) => {
                const formattedPrompt = await QA_PROMPT.formatMessages({
                    context: input.context,
                    question: input.question,
                    chat_history: input.chat_history,
                });
                const response = await this.chatModel.invoke(formattedPrompt);
                return response.content as string;
            },
        ]);
    }

    private async handleStart(ctx: Context) {
        console.log("Received /start command")
        await ctx.reply('Welcome! I\'m your AI assistant with Retrieval Chain capabilities.')
    }

    private async handleHelp(ctx: Context) {
        console.log("Received /help command")
        await ctx.reply('I can assist you with various tasks and provide information from my knowledge base. Just send me a message!')
    }

    private async handleMessage(ctx: Context): Promise<void> {
        if (!ctx.message || !('text' in ctx.message)) {
            console.error('Received message is not a text message or is undefined');
            await ctx.reply('Sorry, I can only process text messages.');
            return;
        }
    
        if (!this.chain) {
            console.error('Chain is not initialized');
            await ctx.reply('Sorry, I\'m not ready to process messages yet.');
            return;
        }
    
        const sessionId = this.getSessionId(ctx);
        const userMessage = ctx.message.text;
    
        console.log(`[${sessionId}] Received message: ${userMessage}`);
    
        try {
            const chatHistory = await this.getChatHistory(sessionId);
            console.log(`[${sessionId}] Retrieved chat history:`, chatHistory);

            console.log(`[${sessionId}] Invoking chain with input:`, {
                question: userMessage,
                chat_history: chatHistory
            });

            const result = await this.chain.invoke({
                question: userMessage,
                chat_history: chatHistory
            });

            const responseText = result.toString();
            console.log(`[${sessionId}] Chain response:`, responseText);

            await ctx.reply(responseText);

            if (this.memory) {
                const messages: { text: string; type: MessageType }[] = [
                    {
                        text: userMessage,
                        type: 'userMessage'
                    },
                    {
                        text: responseText,
                        type: 'apiMessage'
                    }
                ];
                console.log(`[${sessionId}] Adding messages to memory:`, messages);
                
                try {
                    await this.memory.addChatMessages(messages, sessionId);
                    console.log(`[${sessionId}] Messages added successfully`);
                } catch (memoryError) {
                    console.error(`[${sessionId}] Error adding messages to memory:`, memoryError);
                }
            }
        } catch (error) {
            console.error('Error processing message:', error);
            await ctx.reply('Sorry, I encountered an error while processing your message. Please try again later.');
        }
    }

    private getSessionId(ctx: Context): string {
        return `telegram-${ctx.from?.id || 'unknown'}`;
    }

    private async getChatHistory(sessionId: string): Promise<string> {
        if (!this.memory) {
            console.log(`[${sessionId}] No memory available, returning empty chat history`);
            return '';
        }
        const messages = await this.memory.getChatMessages(sessionId);
        console.log(`[${sessionId}] Retrieved messages from memory:`, messages);
        
        // Limit to last 10 messages or adjust as needed
        const recentMessages = messages.slice(-12);
        
        const formattedHistory = this.formatChatHistory(this.convertToIMessages(recentMessages));
        console.log(`[${sessionId}] Formatted chat history:`, formattedHistory);
        return formattedHistory;
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


    async run(nodeData: INodeData, input: string, options: ICommonObject): Promise<string> {
        if (!this.isInitialized || !this.bot || !this.chain) {
            throw new Error('Bot or chain is not initialized')
        }

        console.log(`Run method called with input: "${input}"`);
        console.log('Run options:', options);

        if (options.chatId) {
            await this.bot.telegram.sendMessage(options.chatId, input)
            console.log(`Message sent to chat ID ${options.chatId}`);
            return 'Message sent successfully'
        } else {
            console.log('Invoking chain with empty chat history');
            const result = await this.chain.invoke({
                question: input,
                chat_history: ''
            })
            console.log('Chain result:', result);
            return result
        }
    }

    async stop(): Promise<void> {
        if (this.bot) {
            await this.bot.stop()
            console.log('Telegram bot has been stopped')
        }
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