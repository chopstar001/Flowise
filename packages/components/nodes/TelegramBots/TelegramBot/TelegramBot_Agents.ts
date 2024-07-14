import { ICommonObject, INode, INodeData, INodeParams } from '../../../src/Interface'
import { Telegraf, Context } from 'telegraf'
import { message } from 'telegraf/filters'
import { getBaseClasses } from '../../../src/utils'
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
import { CallbackManagerForRetrieverRun } from "@langchain/core/callbacks/manager";
import { Callbacks } from "@langchain/core/callbacks/manager";


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
        // Simple keyword matching (not ideal, but works as a fallback)
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
    private chatHistory: Map<number, BaseMessage[]> = new Map()
    private isInitialized: boolean = false

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

    async init(nodeData: INodeData): Promise<any> {
        console.log("Starting initialization of TelegramBot_Agents node")

        try {
            console.log("Checking inputs...")
            const botToken = nodeData.inputs?.botToken as string
            const llm = nodeData.inputs?.chatModel as BaseChatModel
            let retriever = nodeData.inputs?.retriever as BaseRetriever
            const tools = nodeData.inputs?.tools as Tool[] || []

            console.log("Bot Token (first 5 chars):", botToken?.substring(0, 5))
            console.log("LLM type:", llm?.constructor.name)
            console.log("Retriever type:", retriever?.constructor.name)
            console.log("Number of tools:", tools.length)

            if (!botToken || !llm) {
                throw new Error('Missing required inputs: botToken or chatModel')
            }

            // Use the SimpleInMemoryRetriever as a fallback
            if (!retriever) {
                console.log("No retriever provided. Using SimpleInMemoryRetriever as fallback.")
                retriever = new SimpleInMemoryRetriever()
            }

            console.log("All required inputs are present")

            console.log("Creating CONDENSE_QUESTION_PROMPT...")
            const CONDENSE_QUESTION_PROMPT = ChatPromptTemplate.fromMessages([
                HumanMessagePromptTemplate.fromTemplate(
                    "Given the following conversation and a follow up question, rephrase the follow up question to be a standalone question.\n\nChat History:\n{chat_history}\nFollow Up Input: {question}\nStandalone question:"
                )
            ])

            console.log("Creating qaPrompt...")
            const qaPrompt = ChatPromptTemplate.fromMessages([
                SystemMessagePromptTemplate.fromTemplate(
                    "You are a helpful AI assistant. Use the following pieces of context to answer the human's question. If you don't know the answer, just say that you don't know, don't try to make up an answer."
                ),
                HumanMessagePromptTemplate.fromTemplate("Context: {context}"),
                HumanMessagePromptTemplate.fromTemplate("Question: {question}"),
                HumanMessagePromptTemplate.fromTemplate("Answer the question based on the context provided.")
            ])

            console.log("Creating standaloneQuestionChain...")
            const standaloneQuestionChain = RunnableSequence.from([
                CONDENSE_QUESTION_PROMPT,
                llm,
                (output: any) => {
                    if (typeof output?.content === 'string') {
                        return output.content;
                    }
                    throw new Error('Unexpected output format from LLM');
                }
            ])

            console.log("Creating retrieverChain...")
            const retrieverChain = RunnableSequence.from([
                (input: string) => {
                    console.log("Querying retriever with:", input)
                    return input
                },
                async (question: string) => {
                    try {
                        console.log("Calling retriever.getRelevantDocuments...")
                        const results = await retriever.getRelevantDocuments(question)
                        console.log("Retriever returned results:", results.length)
                        return results.map(doc => doc.pageContent).join("\n\n")
                    } catch (error) {
                        console.error("Error in retriever:", error)
                        return "Error retrieving information. Using fallback response."
                    }
                }
            ])

            console.log("Creating answerChain...")
            const answerChain = RunnableSequence.from([
                qaPrompt,
                llm,
                (output: any) => {
                    if (typeof output?.content === 'string') {
                        return output.content;
                    }
                    throw new Error('Unexpected output format from LLM');
                }
            ])

            console.log("Creating main chain...")
            this.chain = RunnableSequence.from([
                {
                    standalone_question: async (input: ChainInput) => {
                        console.log("Invoking standaloneQuestionChain...")
                        return standaloneQuestionChain.invoke({
                            question: input.question,
                            chat_history: input.chat_history
                        })
                    },
                    original_input: (input: ChainInput) => input,
                },
                {
                    context: async (input: { standalone_question: string; original_input: ChainInput }) => {
                        console.log("Invoking retrieverChain...")
                        return retrieverChain.invoke(input.standalone_question)
                    },
                    question: (input: { original_input: ChainInput }) => input.original_input.question,
                    chat_history: (input: { original_input: ChainInput }) => input.original_input.chat_history,
                },
                answerChain
            ])

            console.log("Main chain created successfully")

            console.log("Initializing Telegram bot...")
            this.bot = new Telegraf(botToken)

            console.log("Setting up bot commands...")
            this.bot.command('start', (ctx) => {
                ctx.reply('Welcome! I\'m your AI assistant with Retrieval Chain capabilities.')
            })

            this.bot.command('help', (ctx) => {
                ctx.reply('I can assist you with various tasks and provide information from my knowledge base. Just send me a message!')
            })

            this.bot.on(message('text'), this.handleMessage.bind(this))

            console.log("Launching bot...")
            await this.bot.launch()
            this.isInitialized = true
            console.log('Telegram bot launched successfully')

            return this.bot

        } catch (error) {
            console.error("Error in init method:", error)
            throw error
        }
    }

    // ... (rest of the class implementation remains the same)

    private async handleMessage(ctx: Context<Update>) {
        if (!this.chain) {
            console.error('Chain is not initialized')
            await ctx.reply('Sorry, I\'m not ready to process messages yet.')
            return
        }

        const msg = ctx.message
        if (!msg || !('text' in msg)) {
            console.error('Received message is not a text message')
            await ctx.reply('Sorry, I can only process text messages.')
            return
        }

        try {
            const userId = msg.from.id
            const userMessage = msg.text
            const chatHistory = this.chatHistory.get(userId) || []

            const formattedHistory = this.formatChatHistory(chatHistory)

            const result = await this.chain.invoke({
                question: userMessage,
                chat_history: formattedHistory
            })

            const responseText = result || 'Sorry, I couldn\'t generate a response.'
            await ctx.reply(responseText)

            chatHistory.push(new HumanMessage(userMessage))
            chatHistory.push(new AIMessage(responseText))
            this.chatHistory.set(userId, chatHistory)

        } catch (error) {
            console.error('Error processing message:', error)
            await ctx.reply('Sorry, I encountered an error while processing your message.')
        }
    }

    private formatChatHistory(history: BaseMessage[]): string {
        return history.map(msg => {
            if (msg instanceof HumanMessage) {
                return `Human: ${msg.content}`;
            } else if (msg instanceof AIMessage) {
                return `AI: ${msg.content}`;
            }
            return `Unknown: ${msg.content}`;
        }).join('\n');
    }

    async run(nodeData: INodeData, input: string, options: ICommonObject): Promise<string> {
        if (!this.isInitialized || !this.bot || !this.chain) {
            throw new Error('Bot or chain is not initialized')
        }

        if (options.chatId) {
            try {
                await this.bot.telegram.sendMessage(options.chatId, input)
                return 'Message sent successfully'
            } catch (error) {
                console.error('Error sending message:', error)
                throw new Error('Error sending message')
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