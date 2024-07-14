import { ICommonObject, INode, INodeData, INodeParams } from '../../../src/Interface'
import { Telegraf, Context } from 'telegraf'
import { message } from 'telegraf/filters'
import { BaseMessage, HumanMessage, AIMessage } from '@langchain/core/messages'
import { 
    ChatPromptTemplate, 
    SystemMessagePromptTemplate, 
    HumanMessagePromptTemplate,
} from '@langchain/core/prompts'
import { RunnableSequence } from '@langchain/core/runnables'
import { BaseRetriever } from '@langchain/core/retrievers'
import { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { Tool } from 'langchain/tools'
import { Update } from 'telegraf/typings/core/types/typegram'
import { Document } from 'langchain/document'
import { BaseMemory } from 'langchain/memory'
import { Callbacks } from "@langchain/core/callbacks/manager"
import { InputValues, MemoryVariables, OutputValues } from 'langchain/dist/memory/base';
import { BufferMemoryExtended } from './BufferMemoryExtended';

class SimpleInMemoryRetriever extends BaseRetriever {
    private documents: Document[];
    lc_namespace: string[];

    constructor() {
        super();
        this.documents = [
            new Document({ pageContent: "Flowise is a drag & drop tool to build LLM apps", metadata: { source: "Flowise docs" } }),
            new Document({ pageContent: "LangChain is a framework for developing applications powered by language models", metadata: { source: "LangChain docs" } }),
            new Document({ pageContent: "Telegram is a cloud-based instant messaging service", metadata: { source: "Telegram website" } }),
        ];
        this.lc_namespace = ["langchain", "retrievers", "simple_memory"];
    }

    async getRelevantDocuments(
        query: string,
        callbacks?: Callbacks
    ): Promise<Document[]> {
        return this.documents.filter(doc => 
            doc.pageContent.toLowerCase().includes(query.toLowerCase())
        );
    }

    get lc_secrets(): { [key: string]: string } {
        return {};
    }

    get lc_attributes(): { [key: string]: any } {
        return {
            documents: this.documents,
        };
    }
}

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
    private memory: BaseMemory
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
        this.memory = new BufferMemoryExtended(10); // Remember last 10 exchanges
        this.inputs = [
            {
                label: 'Bot Token',
                name: 'botToken',
                type: 'password',
                placeholder: 'Enter your Telegram Bot Token',
                optional: false
            },
            {
                label: 'Chat Model',
                name: 'chatModel',
                type: 'BaseChatModel',
                optional: false
            },
            {
                label: 'Memory',
                name: 'memory',
                type: 'BaseMemory'
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

    async init(nodeData: INodeData): Promise<any> {
        console.log("Starting initialization of TelegramBot_Agents node")

        try {
            console.log("Checking inputs...")
            const botToken = nodeData.inputs?.botToken as string
            this.chatModel = nodeData.inputs?.chatModel as BaseChatModel
            this.retriever = nodeData.inputs?.retriever as BaseRetriever
            this.memory = nodeData.inputs?.memory as BaseMemory || new BufferMemoryExtended(10)
            this.tools = nodeData.inputs?.tools as Tool[] || []

            console.log("Bot Token (first 5 chars):", botToken?.substring(0, 5))
            console.log("LLM type:", this.chatModel?.constructor.name)
            console.log("Memory type:", this.memory.constructor.name)
            console.log("Retriever type:", this.retriever?.constructor.name)
            console.log("Number of tools:", this.tools.length)

            if (!this.memory) {
                console.log("No memory provided, using BufferMemoryExtended as default.")
                this.memory = new BufferMemoryExtended(10); // Remember last 10 exchanges
            }

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
                "Given the following conversation and a follow up question, rephrase the follow up question to be a standalone question. " +
                "If the follow up question is not related to the conversation, just repeat the follow up question."
            ),
            HumanMessagePromptTemplate.fromTemplate("{chat_history}\n\nFollow Up Question: {question}\n\nStandalone question:"),
        ]);
    
        const QA_PROMPT = ChatPromptTemplate.fromMessages([
            SystemMessagePromptTemplate.fromTemplate(
                "You are a helpful AI assistant. Use the following pieces of context to answer the human's question. " +
                "If you don't know the answer, just say that you don't know, don't try to make up an answer."
            ),
            HumanMessagePromptTemplate.fromTemplate("Context: {context}\n\nQuestion: {question}\n\nAnswer:"),
        ]);
    
        return RunnableSequence.from([
            {
                standalone_question: async (input: ChainInput) => {
                    const { question, chat_history } = input;
                    const formattedPrompt = await CONDENSE_QUESTION_PROMPT.formatMessages({
                        chat_history,
                        question,
                    });
                    const response = await this.chatModel.call(formattedPrompt);
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
            },
            async (input) => {
                const formattedPrompt = await QA_PROMPT.formatMessages({
                    context: input.context,
                    question: input.question,
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
    
        console.log(`Received message: ${ctx.message.text}`);
    
        try {
            const userId = ctx.message.from.id.toString();
            const userMessage = ctx.message.text;
    
            console.log(`Processing message from user ${userId}: "${userMessage}"`);
    
            const memoryVariables = await this.memory.loadMemoryVariables({ chatId: userId });
            console.log("Memory variables:", JSON.stringify(memoryVariables, null, 2));
    
            const chatHistory = memoryVariables.chat_history as string;
            console.log(`Chat history length: ${chatHistory.length}`);
    
            const result = await this.chain.invoke({
                question: userMessage,
                chat_history: chatHistory
            });
    
            console.log(`Chain result: ${result}`);
    
            const responseText = result || 'Sorry, I couldn\'t generate a response.';
            await ctx.reply(responseText);
    
            // Save context with a single input key
            await this.memory.saveContext(
                { input: JSON.stringify({ message: userMessage, chatId: userId }) },
                { output: responseText }
            );
    
            // Log updated memory for debugging
            const updatedMemory = await this.memory.loadMemoryVariables({ chatId: userId });
            console.log('Updated memory:', JSON.stringify(updatedMemory, null, 2));
    
        } catch (error) {
            console.error('Error processing message:', error);
            await ctx.reply('Sorry, I encountered an error while processing your message.');
        }
    }
    private formatChatHistory(history: any[]): string {
        if (!Array.isArray(history)) {
            console.warn('Chat history is not an array:', history);
            return '';
        }
        return history.map(msg => {
            if (typeof msg === 'string') {
                return msg;
            } else if (msg && typeof msg === 'object') {
                if (msg instanceof HumanMessage) {
                    return `Human: ${msg.content}`;
                } else if (msg instanceof AIMessage) {
                    return `AI: ${msg.content}`;
                } else if ('role' in msg && 'content' in msg) {
                    return `${msg.role}: ${msg.content}`;
                }
            }
            return `Unknown: ${JSON.stringify(msg)}`;
        }).join('\n');
    }
    async run(nodeData: INodeData, input: string, options: ICommonObject): Promise<string> {
        console.log(`Run method called with input: "${input}"`);
        console.log(`Options:`, options);
        if (!this.isInitialized || !this.bot || !this.chain) {
            throw new Error('Bot or chain is not initialized')
        }

        if (options.chatId) {
            try {
                await this.bot.telegram.sendMessage(options.chatId, input)
                return 'Message sent successfully'
            } catch (error) {
                console.error('Error sending message:', error);
                throw new Error('Error sending message');
            }
        } else {
            try {
                const result = await this.chain.invoke({
                    question: input,
                    chat_history: ''
                })
                return result
            } catch (error) {
                console.error('Error processing input through chain:', error)
                throw new Error('Error processing input')
            }
        }
    }

    async stop(): Promise<void> {
        if (this.bot) {
            await this.bot.stop()
            console.log('Telegram bot has been stopped')
        }
    }
}

module.exports = { nodeClass: TelegramBot_Agents }