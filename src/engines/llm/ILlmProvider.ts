import type { ChatMessage, GenerateOpts, StreamCallbacks } from '../../types';

export interface ILlmProvider {
	readonly name: string;
	readonly available: boolean;
	streamChat(messages: ChatMessage[], opts: GenerateOpts, cb: StreamCallbacks): Promise<void>;
	generate(messages: ChatMessage[], opts: GenerateOpts): Promise<string>;
	abort(): void;
}
