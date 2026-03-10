import type { TranscribeResult, TranscriptionSegment } from '../../types';

export interface ISttSession {
	pushChunk(pcm16: Int16Array): void;
	onSegment(cb: (seg: TranscriptionSegment) => void): void;
	onError(cb: (err: Error) => void): void;
	finalize(): Promise<void>;
}

export interface ISttEngine {
	readonly name: string;
	readonly available: boolean;
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	startSession(): ISttSession;
	transcribeSegment(pcm16kMono: Float32Array, language?: string, prompt?: string): Promise<TranscribeResult>;
}
