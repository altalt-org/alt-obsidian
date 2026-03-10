import type { RecordingState } from '../../types';
import { acquireSystemAudioStream, getScreenCaptureStatus, openScreenCaptureSettings } from './SystemAudioPermission';

/* global MediaStreamTrackProcessor, AudioData — Chrome/Electron 94+ non-standard */
interface MSTrackProcessor {
	readable: ReadableStream;
}
declare const MediaStreamTrackProcessor: { new (init: { track: MediaStreamTrack }): MSTrackProcessor } | undefined;

type AudioDataLike = {
	numberOfFrames: number;
	copyTo(destination: Float32Array, options: { planeIndex: number }): void;
	close(): void;
};

function createTrackProcessor(track: MediaStreamTrack): MSTrackProcessor {
	if (!MediaStreamTrackProcessor) {
		throw new Error('MediaStreamTrackProcessor not available — cannot capture audio');
	}

	return new MediaStreamTrackProcessor({ track });
}

export interface AudioRecorderCallbacks {
	onPcm16k: (pcm16kMono: Float32Array) => void;
	onLevel: (level: number) => void;
	onStateChange: (state: RecordingState) => void;
	onError: (error: Error) => void;
	onSystemAudioDenied?: () => void;
}

export interface AudioRecorderStartOptions {
	microphoneDeviceId?: string;
	includeSystemAudio?: boolean;
}

const TARGET_SAMPLE_RATE = 16000;
const EMIT_INTERVAL_MS = 60;

/** Zero-AudioContext recorder — AudioContext.destination + desktopCapturer loopback = CoreAudio crash. */
export class AudioRecorder {
	/* ── Mic pipeline (MediaStreamTrackProcessor) ── */
	private micStream: MediaStream | null = null;
	private micReader: ReadableStreamDefaultReader | null = null;
	private micCaptureActive = false;
	private pendingMicPcm: Float32Array[] = [];
	private currentLevel = 0;

	/* ── System audio pipeline (MediaStreamTrackProcessor) ── */
	private systemStream: MediaStream | null = null;
	private systemReader: ReadableStreamDefaultReader | null = null;
	private systemCaptureActive = false;
	private pendingSystemPcm: Float32Array[] = [];

	/* ── State ── */
	private state: RecordingState = 'idle';
	private levelTimer: ReturnType<typeof setInterval> | null = null;
	private emitTimer: ReturnType<typeof setInterval> | null = null;
	private includeSystemAudio = false;
	private callbacks: AudioRecorderCallbacks;

	constructor(callbacks: AudioRecorderCallbacks) {
		this.callbacks = callbacks;
	}

	getState(): RecordingState {
		return this.state;
	}

	async start(options: AudioRecorderStartOptions = {}): Promise<void> {
		if (this.state !== 'idle') {
			throw new Error(`Cannot start recording in state: ${this.state}`);
		}

		this.includeSystemAudio = options.includeSystemAudio ?? false;

		try {
			if (typeof MediaStreamTrackProcessor === 'undefined') {
				throw new Error('MediaStreamTrackProcessor not available — cannot capture audio');
			}

			await this.waitForAudioDevices();
			this.micStream = await this.acquireMicWithRetry(options.microphoneDeviceId);
			this.startMicCapture();

			if (this.includeSystemAudio) {
				this.systemStream = await acquireSystemAudioStream();
				if (this.systemStream) {
					this.startSystemCapture();
				} else {
					if (getScreenCaptureStatus() === 'denied') {
						openScreenCaptureSettings();
					}
					this.callbacks.onSystemAudioDenied?.();
				}
			}

			if (!this.emitTimer) {
				this.emitTimer = setInterval(() => this.emitPcm(), EMIT_INTERVAL_MS);
			}
			if (!this.levelTimer) {
				this.levelTimer = setInterval(() => this.reportLevel(), 50);
			}

			this.setState('recording');
		} catch (e) {
			await this.cleanup();
			const error = e instanceof Error ? e : new Error(String(e));
			this.callbacks.onError(error);
			throw error;
		}
	}

	pause(): void {
		if (this.state !== 'recording') return;
		this.setState('paused');
	}

	resume(): void {
		if (this.state !== 'paused') return;
		this.setState('recording');
	}

	async stop(): Promise<void> {
		if (this.state === 'idle') return;
		await this.cleanup();
		this.setState('idle');
	}

	/* ── Mic capture via MediaStreamTrackProcessor (no AudioContext) ── */

	private startMicCapture(): void {
		if (!this.micStream) return;

		const audioTrack = this.micStream.getAudioTracks()[0];
		if (!audioTrack) throw new Error('No audio track in mic stream');

		const trackRate = audioTrack.getSettings()?.sampleRate || 44100;
		const processor = createTrackProcessor(audioTrack);
		this.micReader = processor.readable.getReader();
		this.micCaptureActive = true;

		this.readMicFrames(trackRate);
	}

	private async readMicFrames(trackRate: number): Promise<void> {
		if (!this.micReader) return;

		try {
			while (this.micCaptureActive) {
				const { done, value } = await this.micReader.read();
				if (done || !this.micCaptureActive) break;
				const audioData = value as AudioDataLike;
				const numFrames: number = audioData.numberOfFrames;
				const pcm = new Float32Array(numFrames);
				audioData.copyTo(pcm, { planeIndex: 0 });
				audioData.close();

				if (this.state !== 'recording') continue;

				let peak = 0;
				for (let i = 0; i < pcm.length; i++) {
					const abs = Math.abs(pcm[i]);
					if (abs > peak) peak = abs;
				}
				this.currentLevel = Math.max(this.currentLevel, peak);

				const resampled = this.resampleTo16k(pcm, trackRate);
				this.pendingMicPcm.push(resampled);
				while (this.pendingMicPcm.length > 20) {
					this.pendingMicPcm.shift();
				}
			}
		} catch (e) {
			if (this.micCaptureActive) {
				this.callbacks.onError(e instanceof Error ? e : new Error(String(e)));
			}
		}
	}

	private async stopMicCapture(): Promise<void> {
		this.micCaptureActive = false;
		if (this.micReader) {
			try {
				await this.micReader.cancel();
			} catch {}
			this.micReader = null;
		}
		this.pendingMicPcm = [];
	}

	/* ── System audio capture via MediaStreamTrackProcessor ── */

	private startSystemCapture(): void {
		if (!this.systemStream) return;

		const audioTrack = this.systemStream.getAudioTracks()[0];
		if (!audioTrack) return;

		const trackRate = audioTrack.getSettings()?.sampleRate || 48000;
		const processor = createTrackProcessor(audioTrack);
		this.systemReader = processor.readable.getReader();
		this.systemCaptureActive = true;

		this.readSystemFrames(trackRate);
	}

	private async readSystemFrames(trackRate: number): Promise<void> {
		if (!this.systemReader) return;

		try {
			while (this.systemCaptureActive) {
				const { done, value } = await this.systemReader.read();
				if (done || !this.systemCaptureActive) break;

				const audioData = value as AudioDataLike;
				const numFrames: number = audioData.numberOfFrames;
				const pcm = new Float32Array(numFrames);
				audioData.copyTo(pcm, { planeIndex: 0 });
				audioData.close();

				if (this.state !== 'recording') continue;

				let peak = 0;
				for (let i = 0; i < pcm.length; i++) {
					const abs = Math.abs(pcm[i]);
					if (abs > peak) peak = abs;
				}
				this.currentLevel = Math.max(this.currentLevel, peak);

				const resampled = this.resampleTo16k(pcm, trackRate);
				this.pendingSystemPcm.push(resampled);
				while (this.pendingSystemPcm.length > 10) {
					this.pendingSystemPcm.shift();
				}
			}
		} catch (e) {
			if (this.systemCaptureActive) {
				this.callbacks.onError(e instanceof Error ? e : new Error(String(e)));
			}
		}
	}

	private async stopSystemCapture(): Promise<void> {
		this.systemCaptureActive = false;
		if (this.systemReader) {
			try {
				await this.systemReader.cancel();
			} catch {}
			this.systemReader = null;
		}
		this.pendingSystemPcm = [];
	}

	/* ── PCM emission and mixing ── */

	private emitPcm(): void {
		if (this.state !== 'recording') return;
		if (this.pendingMicPcm.length === 0) return;

		const micChunks = this.pendingMicPcm.splice(0);
		let totalLen = 0;
		for (const chunk of micChunks) totalLen += chunk.length;
		const micPcm = new Float32Array(totalLen);
		let offset = 0;
		for (const chunk of micChunks) {
			micPcm.set(chunk, offset);
			offset += chunk.length;
		}

		if (this.pendingSystemPcm.length > 0) {
			this.callbacks.onPcm16k(this.mixWithSystemPcm(micPcm));
		} else {
			this.callbacks.onPcm16k(micPcm);
		}
	}

	private mixWithSystemPcm(micPcm: Float32Array): Float32Array {
		const mixed = new Float32Array(micPcm);
		let offset = 0;

		while (this.pendingSystemPcm.length > 0 && offset < mixed.length) {
			const sys = this.pendingSystemPcm[0];
			const count = Math.min(sys.length, mixed.length - offset);

			for (let i = 0; i < count; i++) {
				mixed[offset + i] = Math.max(-1, Math.min(1, mixed[offset + i] + sys[i]));
			}
			offset += count;

			if (count >= sys.length) {
				this.pendingSystemPcm.shift();
			} else {
				this.pendingSystemPcm[0] = sys.subarray(count);
			}
		}

		return mixed;
	}

	/* ── Level metering (from raw PCM peak) ── */

	private reportLevel(): void {
		if (this.state !== 'recording') {
			this.callbacks.onLevel(0);
			return;
		}
		this.callbacks.onLevel(this.currentLevel);
		this.currentLevel = 0;
	}

	/* ── Device acquisition ── */

	private async waitForAudioDevices(): Promise<void> {
		const delays = [0, 300, 600, 1000];
		for (let i = 0; i < delays.length; i++) {
			if (delays[i] > 0) await new Promise((r) => setTimeout(r, delays[i]));
			const devices = await navigator.mediaDevices.enumerateDevices();
			const mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId);
			if (mics.length > 0) {
				return;
			}
		}
	}

	private async acquireMicWithRetry(deviceId?: string): Promise<MediaStream> {
		const constraints: MediaTrackConstraints = {
			channelCount: 1,
			echoCancellation: true,
			noiseSuppression: true,
		};
		if (deviceId) {
			constraints.deviceId = { exact: deviceId };
		}

		const attempts = [0, 500, 1000, 2000];
		for (let i = 0; i < attempts.length; i++) {
			if (attempts[i] > 0) {
				await new Promise((r) => setTimeout(r, attempts[i]));
			}

			try {
				return await navigator.mediaDevices.getUserMedia({ audio: constraints });
			} catch (e) {
				if (i === 0 && deviceId) {
					try {
						return await navigator.mediaDevices.getUserMedia({ audio: true });
					} catch {}
				}

				const mic = await this.tryAcquireAnyMic();
				if (mic) return mic;

				if (i === attempts.length - 1) {
					throw new Error('Requested device not found');
				}
			}
		}
		throw new Error('Requested device not found');
	}

	private async tryAcquireAnyMic(): Promise<MediaStream | null> {
		try {
			return await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch {}

		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			const mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId);

			for (const mic of mics) {
				try {
					const stream = await navigator.mediaDevices.getUserMedia({
						audio: { deviceId: { exact: mic.deviceId } },
					});
					return stream;
				} catch {}
			}
		} catch {}

		return null;
	}

	/* ── Resampling ── */

	private resampleTo16k(input: Float32Array, sourceSampleRate: number): Float32Array {
		if (sourceSampleRate === TARGET_SAMPLE_RATE) {
			return new Float32Array(input);
		}
		const ratio = sourceSampleRate / TARGET_SAMPLE_RATE;
		const newLength = Math.round(input.length / ratio);
		const result = new Float32Array(newLength);
		for (let i = 0; i < newLength; i++) {
			const srcIdx = i * ratio;
			const srcIdxFloor = Math.floor(srcIdx);
			const srcIdxCeil = Math.min(srcIdxFloor + 1, input.length - 1);
			const frac = srcIdx - srcIdxFloor;
			result[i] = input[srcIdxFloor] * (1 - frac) + input[srcIdxCeil] * frac;
		}
		return result;
	}

	/* ── Cleanup ── */

	private releaseStream(stream: MediaStream | null): void {
		if (!stream) return;
		for (const track of stream.getTracks()) {
			track.stop();
		}
	}

	private async cleanup(): Promise<void> {
		if (this.levelTimer) {
			clearInterval(this.levelTimer);
			this.levelTimer = null;
		}
		if (this.emitTimer) {
			clearInterval(this.emitTimer);
			this.emitTimer = null;
		}
		await this.stopMicCapture();
		await this.stopSystemCapture();
		this.releaseStream(this.micStream);
		this.micStream = null;
		this.releaseStream(this.systemStream);
		this.systemStream = null;
		this.currentLevel = 0;
		await new Promise((r) => setTimeout(r, 300));
	}

	private setState(state: RecordingState): void {
		this.state = state;
		this.callbacks.onStateChange(state);
	}
}
