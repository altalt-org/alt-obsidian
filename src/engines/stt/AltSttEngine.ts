import type { AltHttpClient } from '../../infra/AltHttpClient';
import type { TranscribeResult, TranscriptionSegment } from '../../types';
import type { ISttEngine, ISttSession } from './ISttEngine';

export class AltSttEngine implements ISttEngine {
	readonly name = 'alt-server';

	private client: AltHttpClient;
	private _available = false;

	constructor(client: AltHttpClient) {
		this.client = client;
	}

	get available(): boolean {
		return this._available;
	}

	async connect(): Promise<void> {
		try {
			await this.client.checkHealth();

			await this.client.isWhisperReady();

			this._available = true;
		} catch (e) {
			this._available = false;
			throw new Error(`Alt server unreachable: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	disconnect(): Promise<void> {
		this._available = false;
		return Promise.resolve();
	}

	startSession(): ISttSession {
		return new AltSttSession(this.client);
	}

	async transcribeSegment(pcm16kMono: Float32Array, language?: string, prompt?: string): Promise<TranscribeResult> {
		const result = await this.client.transcribe(pcm16kMono, language, prompt);
		return {
			text: result.text,
			segments: result.segments.map((seg) => ({
				start: seg.start / 1000,
				duration: (seg.end - seg.start) / 1000,
				text: seg.text,
			})),
		};
	}
}

class AltSttSession implements ISttSession {
	private client: AltHttpClient;
	private segmentCb: ((seg: TranscriptionSegment) => void) | null = null;
	private errorCb: ((err: Error) => void) | null = null;
	private unsubSSE: (() => void) | null = null;

	constructor(client: AltHttpClient) {
		this.client = client;
		this.unsubSSE = this.client.onSSE('transcription.segment', (event) => {
			const data = event.data as { text?: string; start?: number; end?: number };
			if (data.text && this.segmentCb) {
				this.segmentCb({
					start: (data.start ?? 0) / 1000,
					duration: ((data.end ?? 0) - (data.start ?? 0)) / 1000,
					text: data.text,
				});
			}
		});
	}

	pushChunk(_pcm16: Int16Array): void {
		// No-op: Alt handles audio capture internally
	}

	onSegment(cb: (seg: TranscriptionSegment) => void): void {
		this.segmentCb = cb;
	}

	onError(cb: (err: Error) => void): void {
		this.errorCb = cb;
	}

	finalize(): Promise<void> {
		this.unsubSSE?.();
		this.unsubSSE = null;
		return Promise.resolve();
	}
}
