import { type App, moment, type TFile } from 'obsidian';
import type { ISttEngine } from '../../engines/stt/ISttEngine';
import type { AltNoteFrontmatter, AltNoteSettings, RecordingState, TranscriptionSegment } from '../../types';
import { AudioRecorder } from '../audio/AudioRecorder';
import { RecordingManager } from '../audio/RecordingManager';

export interface PipelineCallbacks {
	onLevel: (level: number) => void;
	onStateChange: (state: RecordingState) => void;
	onSegment: (segment: TranscriptionSegment) => void;
	onChunkTranscribed: (text: string) => void;
	onError: (error: Error) => void;
	onElapsed: (elapsedMs: number) => void;
	onSystemAudioDenied?: () => void;
}

export class TranscriptionPipeline {
	private app: App;
	private sttEngine: ISttEngine;
	private settings: AltNoteSettings;
	private callbacks: PipelineCallbacks;

	private recorder: AudioRecorder | null = null;
	private recordingManager: RecordingManager | null = null;
	private targetFile: TFile | null = null;
	private allSegments: TranscriptionSegment[] = [];
	private state: RecordingState = 'idle';
	private startTime = 0;
	private elapsedTimer: ReturnType<typeof setInterval> | null = null;
	private pausedElapsed = 0;
	private writeQueue: Promise<void> = Promise.resolve();
	private segmentIndex = 0;
	private recordingPcmChunks: Float32Array[] = [];

	constructor(app: App, sttEngine: ISttEngine, settings: AltNoteSettings, callbacks: PipelineCallbacks) {
		this.app = app;
		this.sttEngine = sttEngine;
		this.settings = settings;
		this.callbacks = callbacks;
	}

	getState(): RecordingState {
		return this.state;
	}

	getTargetFile(): TFile | null {
		return this.targetFile;
	}

	getAllSegments(): TranscriptionSegment[] {
		return [...this.allSegments];
	}

	getFullTranscript(): string {
		return this.allSegments
			.map((s) => s.text)
			.join(' ')
			.trim();
	}

	getLastRecordingPcm16k(): Float32Array | null {
		if (this.recordingPcmChunks.length === 0) return null;
		const total = this.recordingPcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
		const out = new Float32Array(total);
		let offset = 0;
		for (const chunk of this.recordingPcmChunks) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	}

	async start(existingFile?: TFile): Promise<void> {
		if (this.state !== 'idle') {
			throw new Error(`Pipeline already in state: ${this.state}`);
		}

		if (existingFile) {
			this.targetFile = existingFile;
		} else {
			this.targetFile = await this.createNote();
		}

		this.allSegments = [];
		this.pausedElapsed = 0;
		this.writeQueue = Promise.resolve();
		this.segmentIndex = 0;
		this.recordingPcmChunks = [];

		this.recordingManager = new RecordingManager();
		this.recordingManager.setSegmentReadyCallback((audioData, offsetMs) =>
			this.handleSegmentReady(audioData, offsetMs),
		);
		this.recordingManager.start();

		this.recorder = new AudioRecorder({
			onPcm16k: (pcm16kMono) => {
				this.recordingPcmChunks.push(new Float32Array(pcm16kMono));
				this.recordingManager?.pushChunk(pcm16kMono);
			},
			onLevel: (level) => this.callbacks.onLevel(level),
			onStateChange: (state) => {
				this.state = state;
				this.callbacks.onStateChange(state);
			},
			onError: (error) => this.callbacks.onError(error),
			onSystemAudioDenied: () => this.callbacks.onSystemAudioDenied?.(),
		});

		await this.recorder.start({
			microphoneDeviceId: this.settings.selectedMicrophoneId || undefined,
			includeSystemAudio: this.settings.includeSystemAudio,
		});

		this.startTime = Date.now();
		this.elapsedTimer = setInterval(() => {
			if (this.state === 'recording') {
				const elapsed = Date.now() - this.startTime + this.pausedElapsed;
				this.callbacks.onElapsed(elapsed);
			}
		}, 500);
	}

	pause(): void {
		if (this.state !== 'recording' || !this.recorder) return;
		this.pausedElapsed += Date.now() - this.startTime;
		this.recorder.pause();
	}

	resume(): void {
		if (this.state !== 'paused' || !this.recorder) return;
		this.startTime = Date.now();
		this.recorder.resume();
	}

	async stop(): Promise<void> {
		if (this.state === 'idle') return;

		if (this.elapsedTimer) {
			clearInterval(this.elapsedTimer);
			this.elapsedTimer = null;
		}

		if (this.recorder) {
			await this.recorder.stop();
			this.recorder = null;
		}

		if (this.recordingManager) {
			this.recordingManager.stop();
			this.recordingManager = null;
		}

		await this.writeQueue;

		this.state = 'idle';
		this.callbacks.onStateChange('idle');
	}

	private handleSegmentReady(audioData: Float32Array, offsetMs: number): void {
		this.writeQueue = this.writeQueue.then(async () => {
			try {
				const result = await this.sttEngine.transcribeSegment(
					audioData,
					this.settings.defaultTranscriptionLanguage,
					this.settings.transcriptionKeywords || undefined,
				);
				if (!result.text.trim()) return;

				const adjustedSegments: TranscriptionSegment[] = result.segments.map((seg) => ({
					start: seg.start + offsetMs / 1000,
					duration: seg.duration,
					text: seg.text,
				}));

				this.allSegments.push(...adjustedSegments);
				for (const seg of adjustedSegments) {
					this.callbacks.onSegment(seg);
				}

				const formatted = this.formatSegmentMarkdown(result.text, offsetMs);
				await this.appendToNote(formatted);
				this.callbacks.onChunkTranscribed(result.text);
				this.segmentIndex++;
			} catch (e) {
				const error = e instanceof Error ? e : new Error(String(e));
				this.callbacks.onError(error);
			}
		});
	}

	private formatSegmentMarkdown(text: string, offsetMs: number): string {
		const timestamp = this.formatTimestamp(offsetMs);
		return `**[${timestamp}]** ${text.trim()}\n`;
	}

	private formatTimestamp(ms: number): string {
		const totalSeconds = Math.floor(ms / 1000);
		const hours = Math.floor(totalSeconds / 3600);
		const minutes = Math.floor((totalSeconds % 3600) / 60);
		const seconds = totalSeconds % 60;

		if (hours > 0) {
			return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
		}
		return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
	}

	private async appendToNote(text: string): Promise<void> {
		if (!this.targetFile) return;
		const existing = await this.app.vault.read(this.targetFile);
		const newContent = existing.endsWith('\n') ? `${existing}\n${text}` : `${existing}\n\n${text}`;
		await this.app.vault.modify(this.targetFile, newContent);
	}

	private async createNote(): Promise<TFile> {
		const now = moment();
		const dateStr = now.format('YYYY-MM-DD');
		const timeStr = now.format('HH-mm-ss');
		const fileName = `Recording ${dateStr} ${timeStr}.md`;

		const folder = this.settings.recordingsFolder;
		if (folder && !(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.createFolder(folder);
		}

		const path = folder ? `${folder}/${fileName}` : fileName;

		const frontmatter: AltNoteFrontmatter = {
			'alt-type': 'lecture-note',
			status: 'in_progress',
			lecture_date: dateStr,
			language: this.settings.defaultTranscriptionLanguage,
			created: now.toISOString(),
		};

		const content = [
			'---',
			...Object.entries(frontmatter)
				.map(([k, v]) => (v !== undefined ? `${k}: "${v}"` : null))
				.filter(Boolean),
			'---',
			'',
			`# Recording ${dateStr} ${now.format('HH:mm')}`,
			'',
			'## Transcript',
			'',
		].join('\n');

		return await this.app.vault.create(path, content);
	}
}
