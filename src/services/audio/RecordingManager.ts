import { AudioSegmentBuffer, CircularAudioBuffer, concatenateFloat32Arrays } from './AudioBufferManager';

const SAMPLE_RATE = 16000;
const SILENCE_BUF_MS = 1000;
const SILENCE_TO_FLUSH_MS = 300;
const MIN_SEG_MS = 30000;
const MAX_SEG_MS = 60000;
const INACTIVITY_FLUSH_MS = 5000;
const RMS_SPEECH_THRESHOLD = 0.01;
const RMS_SILENCE_THRESHOLD = 0.006;
const HANGOVER_MS = 200;

export type SegmentReadyCallback = (audioData: Float32Array, offsetMs: number) => void;

export class RecordingManager {
	private mainBuffer: AudioSegmentBuffer;
	private startSilence: AudioSegmentBuffer;
	private endSilence: CircularAudioBuffer;

	private hasAnySpeech = false;
	private allowFlushOnSilence = false;
	private currentSilenceMs = 0;
	private elapsedMs = 0;
	private flushedMs = 0;

	private inSpeech = false;
	private hangoverRemaining = 0;

	private onSegmentReady: SegmentReadyCallback | null = null;
	private active = false;

	constructor() {
		this.mainBuffer = new AudioSegmentBuffer(MAX_SEG_MS + 3000);
		this.startSilence = new AudioSegmentBuffer(SILENCE_BUF_MS);
		this.endSilence = new CircularAudioBuffer(SILENCE_BUF_MS);
	}

	setSegmentReadyCallback(cb: SegmentReadyCallback | null): void {
		this.onSegmentReady = cb;
	}

	start(): void {
		this.reset();
		this.active = true;
	}

	stop(): void {
		if (!this.active) return;
		if (this.mainBuffer.durationMs > 0) {
			this.flushAll(true);
		}
		this.active = false;
		this.reset();
	}

	isActive(): boolean {
		return this.active;
	}

	getElapsedMs(): number {
		return this.elapsedMs;
	}

	pushChunk(chunk16k: Float32Array): void {
		if (!this.active) return;

		const chunkMs = (chunk16k.length / SAMPLE_RATE) * 1000;
		this.elapsedMs += chunkMs;

		const rms = this.computeRMS(chunk16k);
		const isSpeech = this.detectSpeech(rms, chunkMs);

		if (this.mainBuffer.durationMs + chunkMs > MAX_SEG_MS + 3000) {
			this.flushAll(false, true);
		}

		if (isSpeech) {
			this.handleSpeech(chunk16k);
		} else {
			this.handleSilence(chunk16k, chunkMs);
		}
	}

	private detectSpeech(rms: number, chunkMs: number): boolean {
		if (this.inSpeech) {
			if (rms < RMS_SILENCE_THRESHOLD) {
				this.hangoverRemaining -= chunkMs;
				if (this.hangoverRemaining <= 0) {
					this.inSpeech = false;
					return false;
				}
				return true;
			}
			this.hangoverRemaining = HANGOVER_MS;
			return true;
		} else {
			if (rms >= RMS_SPEECH_THRESHOLD) {
				this.inSpeech = true;
				this.hangoverRemaining = HANGOVER_MS;
				return true;
			}
			return false;
		}
	}

	private handleSpeech(chunk: Float32Array): void {
		if (this.mainBuffer.durationMs >= MIN_SEG_MS) {
			this.allowFlushOnSilence = true;
		}

		if (!this.hasAnySpeech) {
			this.mainBuffer.append(chunk);
			this.hasAnySpeech = true;
			this.startSilence.clear();
			this.endSilence.clear();
			this.currentSilenceMs = 0;
			this.maybeForceFlush();
			return;
		}

		if (this.startSilence.durationMs > 0) {
			this.mainBuffer.append(this.startSilence.getData());
			this.startSilence.clear();
			if (this.endSilence.durationMs > 0) {
				this.mainBuffer.append(this.endSilence.getData());
				this.endSilence.clear();
			}
		}

		this.mainBuffer.append(chunk);
		this.currentSilenceMs = 0;
		this.hasAnySpeech = true;
		this.maybeForceFlush();
	}

	private handleSilence(chunk: Float32Array, chunkMs: number): void {
		this.currentSilenceMs += chunkMs;

		if (!this.hasAnySpeech) return;

		if (this.startSilence.durationMs < SILENCE_BUF_MS) {
			this.startSilence.append(chunk);
		} else {
			this.endSilence.append(chunk);
		}

		if (this.allowFlushOnSilence && this.startSilence.durationMs >= SILENCE_TO_FLUSH_MS) {
			this.flushAll(true);
			return;
		}

		if (!this.allowFlushOnSilence && this.currentSilenceMs >= INACTIVITY_FLUSH_MS && this.mainBuffer.durationMs > 0) {
			this.flushAll(true);
		}
	}

	private maybeForceFlush(): void {
		if (this.mainBuffer.durationMs >= MAX_SEG_MS) {
			this.flushAll(false, true);
		}
	}

	private flushAll(includeSilence: boolean, padTail = false): void {
		const offsetMs = this.flushedMs;

		let payload = this.mainBuffer.getData();

		if (includeSilence && this.startSilence.durationMs > 0) {
			payload = concatenateFloat32Arrays(payload, this.startSilence.getData());
		}

		if (!includeSilence && padTail) {
			const padSamples = Math.floor((SILENCE_BUF_MS / 1000) * SAMPLE_RATE);
			payload = concatenateFloat32Arrays(payload, new Float32Array(padSamples));
		}

		if (payload.length > 0) {
			this.flushedMs += (payload.length / SAMPLE_RATE) * 1000;
			this.onSegmentReady?.(payload, offsetMs);
		}

		this.mainBuffer.clear();
		this.startSilence.clear();
		this.endSilence.clear();
		this.hasAnySpeech = false;
		this.allowFlushOnSilence = false;
		this.currentSilenceMs = 0;
	}

	private computeRMS(data: Float32Array): number {
		let sum = 0;
		for (let i = 0; i < data.length; i++) {
			sum += data[i] * data[i];
		}
		return Math.sqrt(sum / data.length);
	}

	private reset(): void {
		this.mainBuffer.clear();
		this.startSilence.clear();
		this.endSilence.clear();
		this.hasAnySpeech = false;
		this.allowFlushOnSilence = false;
		this.currentSilenceMs = 0;
		this.elapsedMs = 0;
		this.flushedMs = 0;
		this.inSpeech = false;
		this.hangoverRemaining = 0;
	}
}
