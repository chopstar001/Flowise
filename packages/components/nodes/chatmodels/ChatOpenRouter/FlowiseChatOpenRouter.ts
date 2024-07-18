import { BaseChatModel, BaseChatModelParams } from '@langchain/core/language_models/chat_models'
import { BaseMessage, AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager'
import { getEnvironmentVariable } from '@langchain/core/utils/env'
import { ChatResult, ChatGeneration } from '@langchain/core/outputs'
import { BaseCache } from '@langchain/core/caches'
import { StructuredTool } from '@langchain/core/tools'
import { RunnableInterface, type RunnableConfig } from '@langchain/core/runnables';
import axios from 'axios'

function safeStringify(obj: any, indent = 2): string {
    const cache = new Set<any>();
    const retVal = JSON.stringify(
        obj,
        (key, value) => {
            if (typeof value === "object" && value !== null) {
                if (cache.has(value)) {
                    return undefined; // Duplicate reference found, discard key
                }
                cache.add(value); // Store value in our collection
            }
            return value;
        },
        indent
    );
    return retVal;
}
export interface OpenRouterCallOptions extends RunnableConfig {
    // Add any additional options specific to OpenRouter if needed
}

export interface OpenRouterParams extends BaseChatModelParams {
    modelName: string;
    openRouterApiKey?: string;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    streaming?: boolean;
    cache?: BaseCache;
    tools?: StructuredTool[];
}

export class ChatOpenRouter extends BaseChatModel<OpenRouterCallOptions> {
    modelName: string;
    openRouterApiKey?: string;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    streaming?: boolean;
    cache?: BaseCache;
    tools: StructuredTool[];

    constructor(params: OpenRouterParams) {
        super(params);
        this.modelName = params.modelName;
        this.openRouterApiKey = params.openRouterApiKey ?? getEnvironmentVariable('OPENROUTER_API_KEY');
        this.temperature = params.temperature;
        this.maxTokens = params.maxTokens;
        this.topP = params.topP;
        this.streaming = params.streaming;
        this.cache = params.cache;
        this.tools = params.tools || [];
    }


    _llmType() {
        return 'openrouter'
    }
    _modelType() {
        return 'chat-openrouter';
    }

    async _generate(messages: BaseMessage[], options: this['ParsedCallOptions'], runManager?: CallbackManagerForLLMRun): Promise<ChatResult> {
        const url = 'https://openrouter.ai/api/v1/chat/completions';
        
        const formattedMessages = messages.map((message) => {
            if (message._getType() === 'human') {
                return { role: 'user', content: message.content };
            } else if (message._getType() === 'ai') {
                return { role: 'assistant', content: message.content };
            } else if (message._getType() === 'system') {
                return { role: 'system', content: message.content };
            }
            // Default to 'user' if type is unknown
            return { role: 'user', content: message.content };
        });

        const data = {
            model: this.modelName,
            messages: formattedMessages,
            temperature: this.temperature,
            max_tokens: this.maxTokens,
            top_p: this.topP,
            stream: this.streaming,
        };

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.openRouterApiKey}`,
            'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:3003',
            'X-Title': 'Flowise',
        };

        // If cache is available, try to retrieve the response from cache
        if (this.cache) {
            const cacheKey = this.getCacheKey(messages, options)
            const cachedResponse = await this.cache.lookup(cacheKey, this._llmType())
            if (cachedResponse) {
                return {
                    generations: cachedResponse as ChatGeneration[],
                }
            }
        }

        try {
            console.log('Sending request to OpenRouter API:', safeStringify(data));
            console.log('Headers:', safeStringify(headers));
            
            const response = await axios.post(url, data, { 
                headers,
                responseType: 'stream'
            });
            
            let fullContent = '';
            let partialLine = '';
            for await (const chunk of response.data) {
                const lines = (partialLine + chunk.toString()).split('\n');
                partialLine = lines.pop() || '';

                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine === '') continue;
                    if (trimmedLine === 'data: [DONE]') break;
                    if (trimmedLine.startsWith('data: ')) {
                        try {
                            const jsonData = JSON.parse(trimmedLine.slice(6));
                            if (jsonData.choices && jsonData.choices[0].delta && jsonData.choices[0].delta.content) {
                                const content = jsonData.choices[0].delta.content;
                                fullContent += content;
                                if (runManager) {
                                    await runManager.handleLLMNewToken(content);
                                }
                            }
                        } catch (parseError) {
                            console.warn('Failed to parse JSON:', trimmedLine);
                        }
                    }
                }
            }

            console.log('Received full response from OpenRouter API:', fullContent);

            const generation: ChatGeneration = {
                text: fullContent,
                message: new AIMessage(fullContent),
            };
            return {
                generations: [generation],
            };
        } catch (error) {
            console.error('Error calling OpenRouter API:', error);
            if (axios.isAxiosError(error)) {
                console.error('Axios error details:', safeStringify(error.response?.data));
                console.error('Axios error status:', error.response?.status);
                console.error('Axios error headers:', safeStringify(error.response?.headers));
            }
            throw new Error(`Failed to generate response from OpenRouter: ${error.message}`);
        }
    }

    private getCacheKey(messages: BaseMessage[], options: this['ParsedCallOptions']): string {
        // Implement a method to generate a unique cache key based on messages and options
        return `${this.modelName}:${JSON.stringify(messages)}:${JSON.stringify(options)}`
    }
    bindTools(tools: StructuredTool[], kwargs?: Partial<OpenRouterCallOptions>): RunnableInterface {
        this.tools = tools
        return this
    }
}