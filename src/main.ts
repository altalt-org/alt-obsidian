import { getLanguage, Notice, Plugin, type TFile } from 'obsidian';
import { AltLlmProvider } from './engines/llm/AltLlmProvider';
import type { ILlmProvider } from './engines/llm/ILlmProvider';
import { AltSttEngine } from './engines/stt/AltSttEngine';
import type { ISttEngine } from './engines/stt/ISttEngine';
import { setLocale, t } from './i18n';
import { AltHttpClient } from './infra/AltHttpClient';
import { updateModels } from './services/ModelStore';

import { buildTitlePrompt, TITLE_MAX_LENGTH } from './prompts/title';
import { MarkdownExportService } from './services/export/MarkdownExportService';
import { SummaryService } from './services/SummaryService';
import { TranslationService } from './services/TranslationService';
import { TranscriptionPipeline } from './services/transcription/TranscriptionPipeline';
import { AltNoteSettingTab } from './settings';
import type { AltNoteSettings, ChatMessage } from './types';
import { DEFAULT_SETTINGS } from './types';
import { RecordingStatusBar } from './ui/RecordingStatusBar';
import { RECORDING_VIEW_TYPE, RecordingView } from './views/RecordingView';

export default class AltNotePlugin extends Plugin {
	settings: AltNoteSettings = DEFAULT_SETTINGS;

	sttEngine: ISttEngine = null!;
	llmProvider: ILlmProvider = null!;
	summaryService: SummaryService = null!;
	translationService: TranslationService = null!;
	exportService: MarkdownExportService = null!;

	altClient: AltHttpClient | null = null;
	private altRetryTimer: ReturnType<typeof setTimeout> | null = null;
	private altRetryCount = 0;

	pipeline: TranscriptionPipeline | null = null;
	lastTranscript: string | null = null;
	lastTargetFile: TFile | null = null;
	lastRecordingPcm: Float32Array | null = null;
	private statusBar: RecordingStatusBar | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		setLocale(getLanguage());

		this.initializeEngines();

		this.summaryService = new SummaryService(this.llmProvider);
		this.translationService = new TranslationService(this.llmProvider);
		this.exportService = new MarkdownExportService(this.app);

		this.statusBar = new RecordingStatusBar(this.addStatusBarItem());
		this.addSettingTab(new AltNoteSettingTab(this.app, this));

		this.registerView(RECORDING_VIEW_TYPE, (leaf) => new RecordingView(leaf, this));

		this.addRibbonIcon('mic', t('command.openRecordingPanel'), () => {
			void this.activateRecordingPanel();
		});

		this.registerCommands();
	}

	onunload(): void {
		if (this.altRetryTimer) {
			clearTimeout(this.altRetryTimer);
			this.altRetryTimer = null;
		}
		void this.pipeline?.stop().catch(() => {});
		void this.sttEngine?.disconnect().catch(() => {});
		this.altClient?.disconnect();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		setLocale(getLanguage());
		this.reinitializeEngines();
	}

	initializeEngines(): void {
		this.initializeAltClient();

		if (!this.altClient) {
			throw new Error('Alt client not initialized');
		}

		this.sttEngine = new AltSttEngine(this.altClient);
		this.llmProvider = new AltLlmProvider(this.altClient, this.app);
	}

	isAltServerMode(): boolean {
		return this.settings.altServerEnabled && this.altClient !== null;
	}

	private initializeAltClient(): void {
		if (!this.altClient) {
			this.altClient = new AltHttpClient(
				this.settings.altServerHost || '127.0.0.1',
				this.settings.altServerPort || 45623,
				this.settings.altServerToken || '',
			);
		} else {
			this.altClient.configure(
				this.settings.altServerHost || '127.0.0.1',
				this.settings.altServerPort || 45623,
				this.settings.altServerToken || '',
			);
		}

		if (!this.settings.altServerEnabled) {
			this.altClient.disconnect();
			return;
		}

		void this.connectAltServer();
	}

	private async connectAltServer(): Promise<void> {
		if (!this.altClient) return;

		if (!this.settings.altServerToken) {
			const discovered = this.altClient.discoverToken();
			if (discovered) {
				this.settings.altServerToken = discovered;
				await this.saveData(this.settings);
			}
		}

		try {
			await this.altClient.connect();
			this.altClient.startSSE();
			this.altRetryCount = 0;
			void this.refreshModels();
		} catch {
			this.scheduleAltRetry();
		}
	}

	private async refreshModels(): Promise<void> {
		if (!this.altClient) return;
		try {
			const catalog = await this.altClient.fetchModels();
			if (catalog) {
				updateModels(catalog);
				this.getRecordingView()?.refreshModelDropdown();
			}
		} catch {
			// Malformed catalog — keep fallback
		}
	}

	private scheduleAltRetry(): void {
		if (this.altRetryTimer) return;
		if (!this.settings.altServerEnabled) return;

		const MAX_RETRIES = 10;
		if (this.altRetryCount >= MAX_RETRIES) return;

		const delay = Math.min(5000 * 2 ** this.altRetryCount, 60_000);
		this.altRetryCount++;

		this.altRetryTimer = setTimeout(() => {
			void (async () => {
				this.altRetryTimer = null;
				if (!this.altClient || !this.settings.altServerEnabled) return;

				try {
					await this.altClient.connect();
					this.altClient.startSSE();
					this.altRetryCount = 0;
					void this.refreshModels();
					this.reinitializeEngines();
				} catch {
					this.scheduleAltRetry();
				}
			})();
		}, delay);
	}

	private reinitializeEngines(): void {
		this.initializeEngines();
		this.summaryService?.setProvider(this.llmProvider);
		this.translationService?.setProvider(this.llmProvider);
	}

	async ensureAltConnected(): Promise<void> {
		if (!this.settings.altServerEnabled || !this.altClient) return;
		if (this.altClient.connected) return;

		await this.connectAltServer();

		if (!this.altClient.connected) {
			throw new Error('Alt server connection failed');
		}
	}

	async ensureSttConnected(): Promise<void> {
		await this.ensureAltConnected();

		if (this.sttEngine.available) return;

		new Notice(`${t('recording.status.idle')} — Connecting to STT server...`);
		try {
			await this.sttEngine.connect();
			new Notice('Alt server connected.');
		} catch (e) {
			throw new Error(`STT server unavailable: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	async ensureLlmAvailable(): Promise<void> {
		if (this.llmProvider.available) return;

		await this.ensureAltConnected();
		await (this.llmProvider as AltLlmProvider).checkAvailability();
		if (!this.llmProvider.available) {
			new Notice('Alt server LLM unavailable. Check Alt app is running.');
		}

		if (!this.llmProvider.available) {
			throw new Error('LLM provider unavailable. Check settings and ensure server is running.');
		}
	}

	private registerCommands(): void {
		this.addCommand({
			id: 'open-recording-panel',
			name: t('command.openRecordingPanel'),
			callback: () => {
				void this.activateRecordingPanel();
			},
		});

		this.addCommand({
			id: 'start-recording',
			name: t('command.startRecording'),
			callback: () => {
				void (async () => {
					try {
						await this.ensureSttConnected();
						await this.startRecording();
					} catch (e) {
						this.showError(e instanceof Error ? e.message : String(e));
					}
				})();
			},
		});

		this.addCommand({
			id: 'stop-recording',
			name: t('command.stopRecording'),
			callback: () => {
				void this.stopRecording();
			},
		});

		this.addCommand({
			id: 'pause-recording',
			name: t('command.pauseRecording'),
			callback: () => {
				const state = this.pipeline?.getState();
				if (state === 'recording') {
					this.pipeline?.pause();
				} else if (state === 'paused') {
					this.pipeline?.resume();
				}
			},
		});

		this.addCommand({
			id: 'generate-summary',
			name: t('command.generateSummary'),
			editorCallback: async (editor) => {
				const content = editor.getValue();
				if (!content.trim()) {
					new Notice(t('summary.noContent'));
					return;
				}

				await this.ensureLlmAvailable();
				new Notice(t('summary.generating'));

				try {
					const summary = await this.summaryService.summarize(content, {
						model: this.settings.llmCloudModel,
						customPrompt: this.settings.customSummaryPrompt || undefined,
						outputLanguage: this.settings.summaryOutputLanguage || undefined,
						summaryMode: this.settings.summaryMode,
					});

					const cursor = editor.getCursor();
					editor.replaceRange(`\n\n## Summary\n\n${summary}\n`, cursor);
					new Notice(t('summary.done'));
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					new Notice(`${t('summary.error')}: ${msg}`);
				}
			},
		});

		this.addCommand({
			id: 'translate-selection',
			name: t('command.translateSelection'),
			editorCallback: async (editor) => {
				const selection = editor.getSelection();
				if (!selection.trim()) {
					new Notice(t('translation.noSelection'));
					return;
				}

				await this.ensureLlmAvailable();
				new Notice(t('translation.translating'));

				try {
					const translated = await this.translationService.translate(
						selection,
						this.settings.translationTargetLanguage,
						{
							model: this.settings.llmExtraModel,
						},
					);
					editor.replaceSelection(translated);
					new Notice(t('translation.done'));
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					new Notice(`Translation failed: ${msg}`);
				}
			},
		});

		this.addCommand({
			id: 'translate-transcript',
			name: t('command.translateTranscript'),
			editorCallback: async (editor) => {
				const content = editor.getValue();
				if (!content.trim()) {
					new Notice(t('summary.noContent'));
					return;
				}

				await this.ensureLlmAvailable();
				new Notice(t('translation.translating'));

				try {
					const translated = await this.translationService.translate(content, this.settings.translationTargetLanguage, {
						model: this.settings.llmExtraModel,
					});
					editor.replaceRange(
						`\n\n## Translation (${this.settings.translationTargetLanguage})\n\n${translated}\n`,
						editor.getCursor(),
					);
					new Notice(t('translation.done'));
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					new Notice(`Translation failed: ${msg}`);
				}
			},
		});

		this.addCommand({
			id: 'fix-typos',
			name: t('command.fixTypos'),
			editorCallback: async (editor) => {
				const selection = editor.getSelection();
				if (!selection.trim()) {
					new Notice(t('typo.noSelection'));
					return;
				}

				await this.ensureLlmAvailable();
				new Notice(t('typo.fixing'));

				try {
					const fixed = await this.translationService.fixTypos(selection, this.settings.defaultTranscriptionLanguage, {
						model: this.settings.llmExtraModel,
					});
					editor.replaceSelection(fixed);
					new Notice(t('typo.done'));
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					new Notice(`Typo fix failed: ${msg}`);
				}
			},
		});

		this.addCommand({
			id: 'generate-title',
			name: t('command.generateTitle'),
			editorCallback: async (editor) => {
				const content = editor.getValue();
				if (!content.trim()) return;

				await this.ensureLlmAvailable();

				try {
					const titlePrompt = buildTitlePrompt(content.slice(0, 2000));
					const messages: ChatMessage[] = [
						{ role: 'system', content: titlePrompt.system },
						{ role: 'user', content: titlePrompt.user },
					];

					const title = await this.llmProvider.generate(messages, {
						model: this.settings.llmCloudModel,
						maxTokens: 50,
						temperature: 0.7,
						purpose: 'note_title',
					});

					const trimmed = title
						.trim()
						.replace(/^["']|["']$/g, '')
						.slice(0, TITLE_MAX_LENGTH);
					const file = this.app.workspace.getActiveFile();
					if (file && trimmed) {
						await this.app.fileManager.renameFile(file, `${file.parent?.path ?? ''}/${trimmed}.md`);
						new Notice(`Title: ${trimmed}`);
					}
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					new Notice(`Title generation failed: ${msg}`);
				}
			},
		});

		this.addCommand({
			id: 'export-markdown',
			name: t('command.exportMarkdown'),
			callback: () => {
				void (async () => {
					const file = this.app.workspace.getActiveFile();
					if (!file) {
						new Notice('Open a note first.');
						return;
					}

					const content = await this.app.vault.read(file);
					if (!content.trim()) {
						new Notice(t('summary.noContent'));
						return;
					}

					await this.ensureLlmAvailable();

					let summary = '';
					let translation = '';

					try {
						summary = await this.summaryService.summarize(content, {
							model: this.settings.llmCloudModel,
							customPrompt: this.settings.customSummaryPrompt || undefined,
							outputLanguage: this.settings.summaryOutputLanguage || undefined,
							summaryMode: this.settings.summaryMode,
						});
					} catch {
						summary = '';
					}

					try {
						translation = await this.translationService.translate(content, this.settings.translationTargetLanguage, {
							model: this.settings.llmExtraModel,
						});
					} catch {
						translation = '';
					}

					const exported = await this.exportService.export(
						{
							title: file.basename,
							transcript: content,
							summary: summary || undefined,
							translation: translation || undefined,
							metadata: {
								llmModel: this.settings.llmCloudModel,
								createdAt: new Date().toISOString(),
								sourceNote: file.path,
							},
						},
						this.settings.exportsFolder,
					);

					new Notice(`Exported: ${exported.path}`);
				})();
			},
		});
	}

	async startRecording(): Promise<void> {
		if (this.pipeline?.getState() !== 'idle' && this.pipeline !== null) {
			new Notice('Already recording');
			return;
		}

		this.lastTranscript = null;
		this.lastTargetFile = null;
		this.lastRecordingPcm = null;

		await this.activateRecordingPanel();
		const view = this.getRecordingView();

		const callbacks = {
			onLevel: (level: number) => {
				view?.updateLevel(level);
			},
			onStateChange: (state: import('./types').RecordingState) => {
				view?.updateState(state);
			},
			onSegment: (segment: import('./types').TranscriptionSegment) => {
				view?.appendSegment(segment);
			},
			onChunkTranscribed: () => {},
			onError: (error: Error) => {
				this.showError(error.message);
			},
			onElapsed: (elapsedMs: number) => {
				view?.updateElapsed(elapsedMs);
				this.statusBar?.update(this.pipeline?.getState() ?? 'idle', elapsedMs);
			},
			onSystemAudioDenied: () => {
				new Notice(t('recording.systemAudioDenied'));
			},
		};

		this.pipeline = new TranscriptionPipeline(this.app, this.sttEngine, this.settings, callbacks);

		await this.pipeline.start();
	}

	async stopRecording(): Promise<void> {
		if (!this.pipeline || this.pipeline.getState() === 'idle') return;

		await this.pipeline.stop();
		this.statusBar?.hide();

		const transcript = this.pipeline.getFullTranscript();
		this.lastTranscript = transcript || null;
		this.lastTargetFile = this.pipeline.getTargetFile();
		this.lastRecordingPcm = this.pipeline.getLastRecordingPcm16k();

		if (transcript && this.settings.autoSummarize) {
			new Notice(t('summary.generating'));
			try {
				await this.ensureLlmAvailable();
				const summary = await this.summaryService.summarize(transcript, {
					model: this.settings.llmCloudModel,
					outputLanguage: this.settings.summaryOutputLanguage || undefined,
					summaryMode: this.settings.summaryMode,
				});

				const file = this.pipeline.getTargetFile();
				if (file) {
					const content = await this.app.vault.read(file);
					await this.app.vault.modify(file, `${content}\n\n## Summary\n\n${summary}\n`);
				}
				new Notice(t('summary.done'));
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				new Notice(`${t('summary.error')}: ${msg}`);
			}
		}

		if (this.settings.autoGenerateTitle) {
			const file = this.pipeline.getTargetFile();
			if (file && transcript) {
				try {
					await this.ensureLlmAvailable();
					const titlePrompt = buildTitlePrompt(transcript.slice(0, 2000));
					const messages: ChatMessage[] = [
						{ role: 'system', content: titlePrompt.system },
						{ role: 'user', content: titlePrompt.user },
					];

					const title = await this.llmProvider.generate(messages, {
						model: this.settings.llmCloudModel,
						maxTokens: 50,
						temperature: 0.7,
						purpose: 'note_title',
					});

					const trimmed = title
						.trim()
						.replace(/^["']|["']$/g, '')
						.slice(0, TITLE_MAX_LENGTH);
					if (trimmed) {
						await this.app.fileManager.renameFile(file, `${file.parent?.path ?? ''}/${trimmed}.md`);
					}
				} catch {
					// Title generation failure is non-critical
				}
			}
		}

		this.pipeline = null;
		this.notifyRecordingStopped();
	}

	notifyRecordingStopped(): void {
		const view = this.getRecordingView();
		view?.onRecordingStopped();
	}

	async activateRecordingPanel(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(RECORDING_VIEW_TYPE);
		if (existing.length > 0) {
			void this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: RECORDING_VIEW_TYPE, active: true });
			void this.app.workspace.revealLeaf(leaf);
		}
	}

	private getRecordingView(): RecordingView | null {
		const leaves = this.app.workspace.getLeavesOfType(RECORDING_VIEW_TYPE);
		if (leaves.length > 0) {
			return leaves[0].view as RecordingView;
		}
		return null;
	}

	showError(message: string): void {
		new Notice(`Error: ${message}`, 5000);
	}
}
