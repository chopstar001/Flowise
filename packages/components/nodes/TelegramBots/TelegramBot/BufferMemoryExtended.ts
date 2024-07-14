import { BaseMemory } from 'langchain/memory';
import { InputValues, MemoryVariables, OutputValues } from 'langchain/dist/memory/base';

export class BufferMemoryExtended extends BaseMemory {
    private messages: Record<string, string> = {};
    private maxLength: number;

    constructor(maxLength: number = 1000) {
        super();
        this.maxLength = maxLength;
    }

    get memoryKeys(): string[] {
        return ["chat_history"];
    }

    async loadMemoryVariables(values: InputValues): Promise<MemoryVariables> {
        const chatId = values.chatId as string;
        return { chat_history: this.messages[chatId] || '' };
    }

    async saveContext(inputValues: InputValues, outputValues: OutputValues): Promise<void> {
        let chatId: string;
        let input: string;

        try {
            const parsedInput = JSON.parse(inputValues.input as string);
            chatId = parsedInput.chatId;
            input = parsedInput.message;
        } catch (error) {
            console.error('Error parsing input:', error);
            return;
        }

        const output = outputValues.output as string;

        if (!this.messages[chatId]) {
            this.messages[chatId] = '';
        }

        this.messages[chatId] += `\nHuman: ${input}\nAI: ${output}`;
        
        // Trim the history if it exceeds maxLength
        if (this.messages[chatId].length > this.maxLength) {
            const excess = this.messages[chatId].length - this.maxLength;
            this.messages[chatId] = this.messages[chatId].slice(excess);
        }
    }

    async clear(): Promise<void> {
        this.messages = {};
    }
}