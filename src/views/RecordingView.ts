import type { TFile } from 'obsidian';
import { ItemView, MarkdownRenderer, Menu, Notice, setIcon, type WorkspaceLeaf } from 'obsidian';
import { TRANSCRIPTION_LANGUAGES, TRANSLATION_LANGUAGES } from '../constants/languages';
import { t } from '../i18n';
import type AltNotePlugin from '../main';
import type { ChatMessage, RecordingState, TranscriptionSegment } from '../types';
import { GENERAL_MODELS } from '../types';

export const RECORDING_VIEW_TYPE = 'alt-note-recording';

type TabId = 'transcript' | 'summary' | 'chat';

type UiChatMessage = {
	role: 'user' | 'assistant';
	content: string;
};

type SettingsManager = {
	open(): void;
	openTabById(id: string): void;
};

function getSettingsManager(value: unknown): SettingsManager | null {
	if (!value || typeof value !== 'object' || !('setting' in value)) {
		return null;
	}

	const setting = (value as { setting?: unknown }).setting;
	if (!setting || typeof setting !== 'object') {
		return null;
	}

	const maybeSettings = setting as Partial<SettingsManager>;
	if (typeof maybeSettings.open !== 'function' || typeof maybeSettings.openTabById !== 'function') {
		return null;
	}

	return maybeSettings as SettingsManager;
}

export class RecordingView extends ItemView {
	plugin: AltNotePlugin;

	private activeTab: TabId = 'transcript';
	private tabButtons = new Map<TabId, HTMLButtonElement>();
	private tabPanels = new Map<TabId, HTMLElement>();

	private topDeleteBtn: HTMLButtonElement = null!;
	private topShareBtn: HTMLButtonElement = null!;
	private topCopyBtn: HTMLButtonElement = null!;
	private topHistoryBtn: HTMLButtonElement = null!;
	private topNewBtn: HTMLButtonElement = null!;

	private statusEl: HTMLElement = null!;
	private timerEl: HTMLElement = null!;
	private transcriptEl: HTMLElement = null!;

	private recordBtn: HTMLButtonElement = null!;
	private playerBtn: HTMLButtonElement = null!;
	private playerSeekEl: HTMLInputElement = null!;
	private playerCurrentEl: HTMLElement = null!;
	private playerDurationEl: HTMLElement = null!;

	private summaryContentEl: HTMLElement = null!;
	private summaryBtn: HTMLButtonElement = null!;
	private summaryModelSelect: HTMLSelectElement = null!;
	private summaryLangSelect: HTMLSelectElement = null!;

	private chatMessagesEl: HTMLElement = null!;
	private chatInputEl: HTMLTextAreaElement = null!;
	private chatSendBtn: HTMLButtonElement = null!;
	private chatStopBtn: HTMLButtonElement = null!;
	private chatModelSelect: HTMLSelectElement = null!;

	private transcriptionLangSelect: HTMLSelectElement = null!;
	private microphoneSelect: HTMLSelectElement = null!;
	private systemAudioBtn: HTMLButtonElement = null!;
	private translateToggle: HTMLInputElement = null!;
	private translateLangSelect: HTMLSelectElement = null!;
	private translateChipBtn: HTMLButtonElement = null!;
	private settingsBtn: HTMLButtonElement = null!;

	private transcriptToolbarEl: HTMLElement = null!;
	private updateTranslateChip: () => void = () => {};

	private playbackAudio: HTMLAudioElement | null = null;
	private playbackUrl: string | null = null;
	private toolbarResizeObserver: ResizeObserver | null = null;

	private waveformCanvas: HTMLCanvasElement = null!;
	private waveformCtx: CanvasRenderingContext2D | null = null;
	private waveformBuffer: number[] = [];
	private readonly WAVEFORM_BARS = 64;

	private chatMessages: UiChatMessage[] = [];
	private chatStreaming = false;
	private isProcessing = false;
	private segmentTranslateQueue: Promise<void> = Promise.resolve();

	constructor(leaf: WorkspaceLeaf, plugin: AltNotePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return RECORDING_VIEW_TYPE;
	}

	getDisplayText(): string {
		return t('command.openRecordingPanel');
	}

	getIcon(): string {
		return 'mic';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('alt-panel');

		this.buildHeader(this.contentEl);
		this.buildTranscriptTab(this.contentEl);
		this.buildSummaryTab(this.contentEl);
		this.buildChatTab(this.contentEl);
		this.switchTab('transcript');

		await this.loadMicrophones();

		if (this.plugin.pipeline && this.plugin.pipeline.getState() !== 'idle') {
			this.updateUI(this.plugin.pipeline.getState());
		}
	}

	async onClose(): Promise<void> {
		this.toolbarResizeObserver?.disconnect();
		this.toolbarResizeObserver = null;
		if (this.playbackAudio) {
			this.playbackAudio.pause();
			this.playbackAudio = null;
		}
		if (this.playbackUrl) {
			URL.revokeObjectURL(this.playbackUrl);
			this.playbackUrl = null;
		}
		if (this.plugin.pipeline?.getState() !== 'idle') {
			await this.plugin.pipeline?.stop();
		}
	}

	updateLevel(level: number): void {
		if (!this.waveformCtx || !this.waveformCanvas) return;
		this.waveformBuffer.push(level);
		if (this.waveformBuffer.length > this.WAVEFORM_BARS) {
			this.waveformBuffer.shift();
		}
		this.drawWaveform();
	}

	private drawWaveform(): void {
		const ctx = this.waveformCtx;
		const canvas = this.waveformCanvas;
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		const rect = canvas.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) return;

		canvas.width = rect.width * dpr;
		canvas.height = rect.height * dpr;
		ctx.scale(dpr, dpr);

		const w = rect.width;
		const h = rect.height;
		ctx.clearRect(0, 0, w, h);

		const bars = this.waveformBuffer;
		if (bars.length === 0) return;

		const barCount = this.WAVEFORM_BARS;
		const gap = 2;
		const barWidth = Math.max(1, (w - gap * (barCount - 1)) / barCount);
		const midY = h / 2;
		const maxBarH = h * 0.8;
		const minBarH = 2;
		const radius = Math.min(barWidth / 2, 3);

		const style = getComputedStyle(this.contentEl);
		const accentColor = style.getPropertyValue('--alt-fab').trim() || '#0eb7ae';
		const mutedColor = style.getPropertyValue('--text-faint').trim() || '#666';

		for (let i = 0; i < barCount; i++) {
			const val = i < bars.length ? bars[i] : 0;
			const barH = Math.max(minBarH, val * maxBarH);
			const x = i * (barWidth + gap);
			const y = midY - barH / 2;

			ctx.fillStyle = val > 0.02 ? accentColor : mutedColor;
			ctx.globalAlpha = val > 0.02 ? 0.4 + val * 0.6 : 0.2;
			ctx.beginPath();
			if (typeof ctx.roundRect === 'function') {
				ctx.roundRect(x, y, barWidth, barH, radius);
			} else {
				ctx.moveTo(x + radius, y);
				ctx.arcTo(x + barWidth, y, x + barWidth, y + barH, radius);
				ctx.arcTo(x + barWidth, y + barH, x, y + barH, radius);
				ctx.arcTo(x, y + barH, x, y, radius);
				ctx.arcTo(x, y, x + barWidth, y, radius);
				ctx.closePath();
			}
			ctx.fill();
		}
		ctx.globalAlpha = 1;
	}

	updateElapsed(elapsedMs: number): void {
		if (!this.timerEl) return;
		const totalSec = Math.floor(elapsedMs / 1000);
		const min = Math.floor(totalSec / 60)
			.toString()
			.padStart(2, '0');
		const sec = (totalSec % 60).toString().padStart(2, '0');
		this.timerEl.setText(`${min}:${sec}`);
	}

	updateState(state: RecordingState): void {
		this.updateUI(state);
	}

	onRecordingStopped(): void {
		this.updateUI('idle');
	}

	appendSegment(segment: TranscriptionSegment): void {
		if (!this.transcriptEl) return;
		const placeholder = this.transcriptEl.querySelector('.alt-placeholder');
		if (placeholder) placeholder.remove();

		const seg = this.transcriptEl.createDiv({ cls: 'alt-seg' });
		const start = this.hhmmss(segment.start);
		const end = this.hhmmss(segment.start + Math.max(0, segment.duration));

		const head = seg.createDiv({ cls: 'alt-seg-head' });
		head.createSpan({ cls: 'alt-seg-time', text: `${start} - ${end}` });

		seg.createDiv({ cls: 'alt-seg-text', text: segment.text.trim() });

		if (this.plugin.settings.transcriptTranslateEnabled) {
			const translated = seg.createDiv({ cls: 'alt-seg-trans', text: t('quickAction.translating') });
			this.segmentTranslateQueue = this.segmentTranslateQueue.then(async () => {
				try {
					await this.plugin.ensureLlmAvailable();
					const translatedText = await this.plugin.translationService.translate(
						segment.text,
						this.plugin.settings.transcriptTranslateTargetLanguage || this.plugin.settings.translationTargetLanguage,
						{ model: this.plugin.settings.llmExtraModel },
					);
					translated.setText(translatedText.trim());
				} catch {
					translated.setText(t('summary.error'));
				}
			});
		}

		this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
	}

	private buildHeader(container: HTMLElement): void {
		const row = container.createDiv({ cls: 'alt-desk-header' });
		const tabs = row.createDiv({ cls: 'alt-tab-switcher' });

		const entries: Array<{ id: TabId; label: string; icon: string }> = [
			{ id: 'transcript', label: 'Transcript', icon: 'file-audio' },
			{ id: 'summary', label: 'Summary', icon: 'file-text' },
			{ id: 'chat', label: 'Chat', icon: 'message-square' },
		];

		for (const entry of entries) {
			const btn = tabs.createEl('button', { cls: 'alt-tab-btn' });
			btn.type = 'button';
			const iconWrap = btn.createSpan({ cls: 'alt-tab-icon' });
			setIcon(iconWrap, entry.icon);
			btn.createSpan({ text: entry.label });
			btn.addEventListener('click', () => this.switchTab(entry.id));
			this.tabButtons.set(entry.id, btn);
		}

		const actions = row.createDiv({ cls: 'alt-header-actions' });
		this.topDeleteBtn = this.createIconButton(actions, 'trash', 'alt-icon-btn', () => {
			void this.handleDeleteAllTranscription();
		});
		this.topDeleteBtn.title = t('recording.deleteAll');
		this.topShareBtn = this.createIconButton(actions, 'share', 'alt-icon-btn', () => {
			void this.handleShare();
		});
		this.topShareBtn.title = t('recording.shareNote');
		this.topCopyBtn = this.createIconButton(actions, 'copy', 'alt-icon-btn', () => {
			if (this.activeTab === 'summary') {
				void this.handleCopySummary();
				return;
			}
			void this.handleCopyTranscript();
		});
		this.topCopyBtn.title = t('summary.copy');
		this.topHistoryBtn = this.createIconButton(actions, 'history', 'alt-icon-btn', () => {
			new Notice('History is not available yet.');
		});
		this.topHistoryBtn.title = t('recording.replay');
		this.topNewBtn = this.createIconButton(actions, 'plus', 'alt-icon-btn', () => {
			this.chatMessages = [];
			this.renderChat();
		});
		this.topNewBtn.title = t('chat.title');

		this.updateTopActions();
	}

	private buildTranscriptTab(container: HTMLElement): void {
		const panel = container.createDiv({ cls: 'alt-tab-panel alt-transcript-panel' });
		this.tabPanels.set('transcript', panel);

		const statusRow = panel.createDiv({ cls: 'alt-recording-status' });
		this.statusEl = statusRow.createSpan({ cls: 'alt-status alt-status-idle', text: t('recording.status.idle') });
		this.waveformCanvas = statusRow.createEl('canvas', { cls: 'alt-waveform' });
		this.waveformCanvas.height = 28;
		this.waveformCtx = this.waveformCanvas.getContext('2d');
		this.timerEl = statusRow.createSpan({ cls: 'alt-status-timer', text: '00:00' });

		const player = panel.createDiv({ cls: 'alt-player-row' });
		this.playerBtn = this.createIconButton(player, 'play', 'alt-player-btn', () => {
			void this.handleReplayToggle();
		});
		this.playerBtn.title = t('recording.replay');
		this.playerCurrentEl = player.createSpan({ cls: 'alt-player-time', text: '0:00' });
		this.playerSeekEl = player.createEl('input', { cls: 'alt-player-seek', type: 'range' });
		this.playerSeekEl.min = '0';
		this.playerSeekEl.max = '1000';
		this.playerSeekEl.value = '0';
		this.playerSeekEl.addEventListener('input', () => {
			if (!this.playbackAudio || !this.playbackAudio.duration) return;
			const ratio = Number(this.playerSeekEl.value) / 1000;
			this.playbackAudio.currentTime = ratio * this.playbackAudio.duration;
		});
		this.playerDurationEl = player.createSpan({ cls: 'alt-player-time', text: '0:00' });

		this.transcriptEl = panel.createDiv({ cls: 'alt-transcript' });
		const ph = this.transcriptEl.createDiv({ cls: 'alt-placeholder' });
		ph.createEl('p', { cls: 'alt-placeholder-main', text: t('recording.transcriptPlaceholder') });
		ph.createEl('p', { cls: 'alt-placeholder-hint', text: t('recording.transcriptPlaceholderHint') });

		const fabWrap = panel.createDiv({ cls: 'alt-fab-wrap' });
		this.recordBtn = this.createIconButton(fabWrap, 'mic', 'alt-record-fab', () => {
			void this.handleFabRecordToggle();
		});
		this.recordBtn.title = t('recording.start');

		const controls = panel.createDiv({ cls: 'alt-floating-bar alt-transcript-controls' });
		this.transcriptToolbarEl = controls;

		const primaryGroup = controls.createDiv({ cls: 'alt-toolbar-primary' });

		const langWrap = primaryGroup.createDiv({ cls: 'alt-select-wrap alt-lang-wrap' });
		const langIcon = langWrap.createSpan({ cls: 'alt-select-icon' });
		setIcon(langIcon, 'globe');
		this.transcriptionLangSelect = langWrap.createEl('select', { cls: 'alt-pill-select' });
		for (const lang of TRANSCRIPTION_LANGUAGES) {
			const opt = this.transcriptionLangSelect.createEl('option', { value: lang.code, text: lang.name });
			if (lang.code === this.plugin.settings.defaultTranscriptionLanguage) opt.selected = true;
		}
		this.transcriptionLangSelect.addEventListener('change', () => {
			this.plugin.settings.defaultTranscriptionLanguage = this.transcriptionLangSelect.value;
			void this.plugin.saveSettings();
		});

		const micWrap = primaryGroup.createDiv({ cls: 'alt-select-wrap' });
		const micIcon = micWrap.createSpan({ cls: 'alt-select-icon' });
		setIcon(micIcon, 'mic');
		this.microphoneSelect = micWrap.createEl('select', { cls: 'alt-pill-select' });
		this.microphoneSelect.title = t('recording.microphone');
		this.microphoneSelect.addEventListener('change', () => {
			this.plugin.settings.selectedMicrophoneId = this.microphoneSelect.value;
			void this.plugin.saveSettings();
		});

		const secondaryGroup = controls.createDiv({ cls: 'alt-toolbar-secondary' });

		this.systemAudioBtn = secondaryGroup.createEl('button', { cls: 'alt-chip-btn' });
		this.systemAudioBtn.type = 'button';
		setIcon(this.systemAudioBtn, 'monitor-speaker');
		this.systemAudioBtn.createSpan({ text: t('recording.systemAudio') });
		this.systemAudioBtn.toggleClass('alt-chip-active', this.plugin.settings.includeSystemAudio);
		this.systemAudioBtn.addEventListener('click', () => {
			this.plugin.settings.includeSystemAudio = !this.plugin.settings.includeSystemAudio;
			this.systemAudioBtn.toggleClass('alt-chip-active', this.plugin.settings.includeSystemAudio);
			void this.plugin.saveSettings();
		});

		const translateWrap = secondaryGroup.createDiv({ cls: 'alt-control-slot' });
		this.translateChipBtn = translateWrap.createEl('button', { cls: 'alt-chip-btn' });
		this.translateChipBtn.type = 'button';
		setIcon(this.translateChipBtn, 'languages');
		const translateLabel = this.translateChipBtn.createSpan();
		this.translateLangSelect = translateWrap.createEl('select', { cls: 'alt-pill-select alt-translate-lang-select' });
		for (const lang of TRANSLATION_LANGUAGES) {
			const opt = this.translateLangSelect.createEl('option', { value: lang.code, text: lang.name });
			if (lang.code === this.plugin.settings.transcriptTranslateTargetLanguage) opt.selected = true;
		}
		this.setHidden(this.translateLangSelect, !this.plugin.settings.transcriptTranslateEnabled);
		this.translateLangSelect.addEventListener('change', () => {
			this.plugin.settings.transcriptTranslateTargetLanguage = this.translateLangSelect.value;
			void this.plugin.saveSettings();
			this.updateTranslateChip();
		});

		this.translateToggle = secondaryGroup.createEl('input', { cls: 'alt-hidden', type: 'checkbox' });
		this.translateToggle.checked = this.plugin.settings.transcriptTranslateEnabled;

		const updateTranslateLabel = () => {
			const enabled = this.plugin.settings.transcriptTranslateEnabled;
			const langName =
				TRANSLATION_LANGUAGES.find((l) => l.code === this.plugin.settings.transcriptTranslateTargetLanguage)?.name ||
				'';
			translateLabel.setText(enabled ? `Translate → ${langName}` : 'Translate');
			this.translateChipBtn.toggleClass('alt-chip-active', enabled);
			this.setHidden(this.translateLangSelect, !enabled);
			this.updateTranscriptToolbarLayout();
		};
		this.updateTranslateChip = updateTranslateLabel;
		updateTranslateLabel();

		this.translateChipBtn.addEventListener('click', () => {
			this.plugin.settings.transcriptTranslateEnabled = !this.plugin.settings.transcriptTranslateEnabled;
			this.translateToggle.checked = this.plugin.settings.transcriptTranslateEnabled;
			void this.plugin.saveSettings();
			updateTranslateLabel();
		});

		const overflowBtn = this.createIconButton(controls, 'more-horizontal', 'alt-overflow-btn', () => {
			this.showOverflowMenu(overflowBtn);
		});

		this.settingsBtn = this.createIconButton(controls, 'sliders-horizontal', 'alt-icon-btn', () => {
			const settingsManager = getSettingsManager(this.app);
			if (!settingsManager) {
				return;
			}
			settingsManager.open();
			settingsManager.openTabById('alt');
		});
		this.settingsBtn.title = t('settings.heading');

		this.setupTranscriptToolbarObserver(panel);
	}

	private buildSummaryTab(container: HTMLElement): void {
		const panel = container.createDiv({ cls: 'alt-tab-panel alt-summary-panel' });
		this.tabPanels.set('summary', panel);

		this.summaryContentEl = panel.createDiv({ cls: 'alt-summary-content' });
		this.summaryContentEl.createEl('p', { cls: 'alt-placeholder', text: t('summary.empty') });

		const regenerateWrap = panel.createDiv({ cls: 'alt-summary-regenerate' });
		this.summaryBtn = this.createLabeledIconButton(
			regenerateWrap,
			'refresh-cw',
			t('summary.generate'),
			'alt-btn-dark-pill',
			() => {
				void this.handleSummary();
			},
		);

		const bottom = panel.createDiv({ cls: 'alt-floating-bar alt-summary-controls' });

		const modelWrap = bottom.createDiv({ cls: 'alt-select-wrap' });
		const modelIcon = modelWrap.createSpan({ cls: 'alt-select-icon' });
		setIcon(modelIcon, 'bot');
		this.summaryModelSelect = modelWrap.createEl('select', { cls: 'alt-pill-select' });
		this.populateModelOptions(this.summaryModelSelect);
		this.summaryModelSelect.value = this.plugin.settings.llmCloudModel;
		this.summaryModelSelect.addEventListener('change', () => {
			this.plugin.settings.llmCloudModel = this.summaryModelSelect.value;
			void this.plugin.saveSettings();
		});

		const langWrap = bottom.createDiv({ cls: 'alt-select-wrap alt-lang-wrap' });
		const summaryLangIcon = langWrap.createSpan({ cls: 'alt-select-icon' });
		setIcon(summaryLangIcon, 'globe');
		this.summaryLangSelect = langWrap.createEl('select', { cls: 'alt-pill-select' });
		this.summaryLangSelect.createEl('option', { value: '', text: 'Auto' });
		for (const lang of TRANSCRIPTION_LANGUAGES.filter((item) => item.code !== 'auto')) {
			const opt = this.summaryLangSelect.createEl('option', { value: lang.code, text: lang.name });
			if (lang.code === this.plugin.settings.summaryGenerateLanguage) opt.selected = true;
		}
		this.summaryLangSelect.addEventListener('change', () => {
			this.plugin.settings.summaryGenerateLanguage = this.summaryLangSelect.value;
			void this.plugin.saveSettings();
		});
	}

	private buildChatTab(container: HTMLElement): void {
		const panel = container.createDiv({ cls: 'alt-tab-panel alt-chat-panel' });
		this.tabPanels.set('chat', panel);

		this.chatMessagesEl = panel.createDiv({ cls: 'alt-chat-messages' });
		this.chatMessagesEl.createEl('p', { cls: 'alt-placeholder', text: t('chat.noHistory') });

		const actions = panel.createDiv({ cls: 'alt-chat-actions' });

		const composer = actions.createDiv({ cls: 'alt-chat-composer' });
		this.chatInputEl = composer.createEl('textarea', { cls: 'alt-chat-input' });
		this.chatInputEl.rows = 2;
		this.chatInputEl.placeholder = t('chat.placeholder');
		this.chatInputEl.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
				event.preventDefault();
				void this.handleSendChat();
			}
		});

		const footer = composer.createDiv({ cls: 'alt-chat-composer-footer' });
		const chatModelWrap = footer.createDiv({ cls: 'alt-select-wrap' });
		const chatModelIcon = chatModelWrap.createSpan({ cls: 'alt-select-icon' });
		setIcon(chatModelIcon, 'bot');
		this.chatModelSelect = chatModelWrap.createEl('select', { cls: 'alt-pill-select alt-chat-model' });
		this.populateModelOptions(this.chatModelSelect);
		this.chatModelSelect.value = this.plugin.settings.llmCloudModel;

		this.chatSendBtn = this.createIconButton(footer, 'send', 'alt-chat-send', () => {
			void this.handleSendChat();
		});
		this.chatSendBtn.title = t('chat.send');
		this.chatStopBtn = this.createIconButton(footer, 'square', 'alt-chat-send alt-chat-stop', () => {
			this.handleStopChat();
		});
		this.chatStopBtn.title = t('chat.stop');
		this.chatStopBtn.addClass('alt-hidden');
	}

	private switchTab(tab: TabId): void {
		this.activeTab = tab;
		for (const [id, btn] of this.tabButtons) {
			btn.toggleClass('alt-tab-active', id === tab);
		}
		for (const [id, panel] of this.tabPanels) {
			panel.toggleClass('alt-hidden', id !== tab);
		}
		this.updateTopActions();
		if (tab === 'summary') void this.refreshSummaryContent();
		if (tab === 'chat') this.renderChat();
	}

	private updateTopActions(): void {
		if (!this.topDeleteBtn) return;
		const transcript = this.activeTab === 'transcript';
		const summary = this.activeTab === 'summary';
		const chat = this.activeTab === 'chat';

		this.setHidden(this.topDeleteBtn, !transcript);
		this.setHidden(this.topShareBtn, !(transcript || summary));
		this.setHidden(this.topCopyBtn, !(transcript || summary));
		this.setHidden(this.topHistoryBtn, !chat);
		this.setHidden(this.topNewBtn, !chat);
	}

	private populateModelOptions(select: HTMLSelectElement): void {
		for (const model of GENERAL_MODELS) {
			if (model.tier === 'local') continue;
			const label = model.tier === 'pro' ? `${model.name} · Pro` : model.name;
			select.createEl('option', { value: model.id, text: label });
		}
	}

	private createIconButton(parent: HTMLElement, icon: string, cls: string, onClick: () => void): HTMLButtonElement {
		const btn = parent.createEl('button', { cls });
		btn.type = 'button';
		btn.empty();
		setIcon(btn, icon);
		btn.addEventListener('click', () => onClick());
		return btn;
	}

	private createLabeledIconButton(
		parent: HTMLElement,
		icon: string,
		label: string,
		cls: string,
		onClick: () => void,
	): HTMLButtonElement {
		const btn = parent.createEl('button', { cls });
		btn.type = 'button';
		btn.empty();
		setIcon(btn, icon);
		btn.createSpan({ text: label });
		btn.addEventListener('click', () => onClick());
		return btn;
	}

	private setHidden(el: HTMLElement, hidden: boolean): void {
		el.toggleClass('alt-hidden', hidden);
	}

	private addDivider(parent: HTMLElement, transparent = false): void {
		parent.createDiv({ cls: transparent ? 'alt-divider alt-divider-transparent' : 'alt-divider' });
	}

	private setupTranscriptToolbarObserver(panel: HTMLElement): void {
		this.toolbarResizeObserver?.disconnect();
		this.toolbarResizeObserver = new ResizeObserver(() => {
			this.updateTranscriptToolbarLayout();
		});
		this.toolbarResizeObserver.observe(this.contentEl);
		this.updateTranscriptToolbarLayout();
	}

	private updateTranscriptToolbarLayout(): void {
		if (!this.transcriptToolbarEl) return;
		const w = this.contentEl.clientWidth;
		// toolbar needs ~680px for all items; switch to compact (overflow menu) when narrower
		this.transcriptToolbarEl.classList.toggle('is-compact', w < 700);
		this.transcriptToolbarEl.classList.toggle('is-ultra-compact', w < 380);
	}

	private showOverflowMenu(anchor: HTMLElement): void {
		const menu = new Menu();

		menu.addItem((item) => {
			item.setTitle(`System Audio: ${this.plugin.settings.includeSystemAudio ? 'ON' : 'OFF'}`);
			item.setIcon('monitor-speaker');
			item.onClick(() => {
				this.plugin.settings.includeSystemAudio = !this.plugin.settings.includeSystemAudio;
				this.systemAudioBtn.toggleClass('alt-chip-active', this.plugin.settings.includeSystemAudio);
				void this.plugin.saveSettings();
			});
		});

		menu.addSeparator();

		menu.addItem((item) => {
			const enabled = this.plugin.settings.transcriptTranslateEnabled;
			item.setTitle(enabled ? 'Translate: ON' : 'Translate: OFF');
			item.setIcon('languages');
			item.onClick(() => {
				this.plugin.settings.transcriptTranslateEnabled = !this.plugin.settings.transcriptTranslateEnabled;
				this.translateToggle.checked = this.plugin.settings.transcriptTranslateEnabled;
				void this.plugin.saveSettings();
				this.updateTranslateChip();
			});
		});

		if (this.plugin.settings.transcriptTranslateEnabled) {
			for (const lang of TRANSLATION_LANGUAGES) {
				menu.addItem((item) => {
					const isCurrent = lang.code === this.plugin.settings.transcriptTranslateTargetLanguage;
					item.setTitle(`  ${lang.name}${isCurrent ? ' ✓' : ''}`);
					item.onClick(() => {
						this.plugin.settings.transcriptTranslateTargetLanguage = lang.code;
						this.translateLangSelect.value = lang.code;
						void this.plugin.saveSettings();
						this.updateTranslateChip();
					});
				});
			}
		}

		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.top });
	}

	private async loadMicrophones(): Promise<void> {
		if (!this.microphoneSelect) {
			return;
		}
		this.microphoneSelect.empty();

		try {
			try {
				const permStream = await navigator.mediaDevices.getUserMedia({ audio: true });
				for (const tr of permStream.getTracks()) tr.stop();
			} catch {
				/* microphone permission probe can fail before the user grants access */
			}
			const devices = await navigator.mediaDevices.enumerateDevices();
			const audioInputs = devices.filter((d) => d.kind === 'audioinput');
			let idx = 1;
			for (const d of audioInputs) {
				this.microphoneSelect.createEl('option', {
					value: d.deviceId,
					text: d.label || `${t('recording.microphone')} ${idx++}`,
				});
			}
			if (this.plugin.settings.selectedMicrophoneId) {
				this.microphoneSelect.value = this.plugin.settings.selectedMicrophoneId;
			}
		} catch {
			this.microphoneSelect.value = '';
		}

		this.updateTranscriptToolbarLayout();
	}

	private async handleFabRecordToggle(): Promise<void> {
		const state = this.plugin.pipeline?.getState() ?? 'idle';
		if (state === 'idle') {
			await this.handleRecord();
			return;
		}
		if (state === 'recording' || state === 'paused') {
			await this.handleStop();
		}
	}

	private async handleReplayToggle(): Promise<void> {
		if (this.playbackAudio && !this.playbackAudio.paused) {
			this.playbackAudio.pause();
			this.playerBtn.empty();
			setIcon(this.playerBtn, 'play');
			return;
		}
		await this.handleReplay();
	}

	private async handleRecord(): Promise<void> {
		if ((this.plugin.pipeline?.getState() ?? 'idle') !== 'idle') return;
		try {
			await this.plugin.ensureSttConnected();
			await this.plugin.startRecording();
		} catch (e) {
			this.plugin.showError(e instanceof Error ? e.message : String(e));
		}
	}

	private handlePause(): void {
		const state = this.plugin.pipeline?.getState();
		if (state === 'recording') this.plugin.pipeline?.pause();
		else if (state === 'paused') this.plugin.pipeline?.resume();
	}

	private async handleStop(): Promise<void> {
		try {
			await this.plugin.stopRecording();
		} catch (e) {
			this.plugin.showError(e instanceof Error ? e.message : String(e));
		}
	}

	private async handleReplay(): Promise<void> {
		const pcm = this.plugin.lastRecordingPcm;
		if (!pcm || pcm.length === 0) {
			new Notice(t('recording.noReplay'));
			return;
		}

		if (this.playbackAudio && this.playbackUrl) {
			this.playbackAudio.pause();
			URL.revokeObjectURL(this.playbackUrl);
		}

		const wav = this.float32ToWav(pcm, 16000);
		const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
		const audio = new Audio(url);
		this.playbackAudio = audio;
		this.playbackUrl = url;

		audio.onloadedmetadata = () => {
			if (Number.isFinite(audio.duration)) {
				this.playerDurationEl.setText(this.mmss(audio.duration));
			}
		};

		audio.ontimeupdate = () => {
			this.playerCurrentEl.setText(this.mmss(audio.currentTime));
			if (audio.duration) {
				this.playerSeekEl.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
			}
		};

		audio.onended = () => {
			this.playerCurrentEl.setText('0:00');
			this.playerSeekEl.value = '0';
			this.playerBtn.empty();
			setIcon(this.playerBtn, 'play');
		};

		audio.onerror = () => {
			this.playerBtn.empty();
			setIcon(this.playerBtn, 'play');
		};

		this.playerBtn.empty();
		setIcon(this.playerBtn, 'pause');
		await audio.play();
	}

	private async handleDeleteAllTranscription(): Promise<void> {
		if (this.plugin.pipeline && this.plugin.pipeline.getState() !== 'idle') {
			new Notice(t('recording.stopBeforeDelete'));
			return;
		}

		const file = this.plugin.lastTargetFile;
		if (!file) {
			this.clearTranscriptUi();
			return;
		}

		const content = await this.app.vault.read(file);
		const replaced = content.replace(/## Transcript\n\n([\s\S]*?)(?=\n## |\n---|$)/, '## Transcript\n\n');
		await this.app.vault.modify(file, replaced);
		this.plugin.lastTranscript = null;
		this.clearTranscriptUi();
		new Notice(t('recording.deleted'));
	}

	private clearTranscriptUi(): void {
		this.transcriptEl.empty();
		const ph = this.transcriptEl.createDiv({ cls: 'alt-placeholder' });
		ph.createEl('p', { cls: 'alt-placeholder-main', text: t('recording.transcriptPlaceholder') });
		ph.createEl('p', { cls: 'alt-placeholder-hint', text: t('recording.transcriptPlaceholderHint') });
	}

	private async handleShare(): Promise<void> {
		const file = this.plugin.lastTargetFile ?? this.app.workspace.getActiveFile();
		if (!file) {
			new Notice(t('recording.noNote'));
			return;
		}

		if (!this.plugin.altClient) {
			new Notice(t('recording.shareAltOnly'));
			return;
		}

		try {
			if (!this.plugin.altClient.connected) {
				await this.plugin.altClient.connect();
			}
			const content = await this.app.vault.read(file);
			const transcript = this.extractSection(content, 'Transcript');
			const summary = this.extractSection(content, 'Summary');

			const note = await this.plugin.altClient.createNote({
				title: file.basename,
				status: 'completed',
				lecture_date: new Date().toISOString().slice(0, 10),
			});

			if (transcript.trim()) {
				await this.plugin.altClient.createComponent({
					note_id: note.id,
					component_type: 'transcript',
					title: 'Transcript',
					content_text: transcript.trim(),
				});
			}

			if (summary.trim()) {
				await this.plugin.altClient.createComponent({
					note_id: note.id,
					component_type: 'summary',
					title: 'Summary',
					content_text: summary.trim(),
				});
			}

			const shared = await this.plugin.altClient.createShare(note.id, {
				selectedComponents: {
					transcript: true,
					summary: true,
				},
			});

			if (!shared.success || !shared.shareUrl) {
				throw new Error(shared.error || 'Share failed');
			}

			await navigator.clipboard.writeText(shared.shareUrl);
			new Notice(t('recording.shareDone'));
		} catch (e) {
			new Notice(`${t('recording.shareFailed')}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private async handleSummary(): Promise<void> {
		if (this.isProcessing) return;
		const source = await this.resolveTranscriptSource();
		if (!source) return;

		const { transcript, file } = source;
		this.isProcessing = true;
		this.summaryBtn.disabled = true;
		this.summaryBtn.empty();
		this.summaryBtn.setText(t('quickAction.summarizing'));

		try {
			await this.plugin.ensureLlmAvailable();
			const existing = await this.app.vault.read(file);
			const cleaned = this.removeManagedSection(existing, 'Summary');
			if (cleaned !== existing) await this.app.vault.modify(file, cleaned);

			const summary = await this.plugin.summaryService.summarize(transcript, {
				model: this.summaryModelSelect.value || this.plugin.settings.llmCloudModel,
				customPrompt: this.plugin.settings.customSummaryPrompt || undefined,
				outputLanguage: this.summaryLangSelect.value || undefined,
				summaryMode: this.plugin.settings.summaryMode,
			});

			const fresh = await this.app.vault.read(file);
			await this.app.vault.modify(file, `${fresh}\n\n## Summary\n\n${summary}\n`);
			new Notice(t('summary.done'));
			if (this.activeTab === 'summary') await this.refreshSummaryContent();
		} catch (e) {
			new Notice(`${t('summary.error')}: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.isProcessing = false;
			this.summaryBtn.disabled = false;
			this.summaryBtn.empty();
			setIcon(this.summaryBtn, 'refresh-cw');
			this.summaryBtn.createSpan({ text: t('summary.generate') });
		}
	}

	private async refreshSummaryContent(): Promise<void> {
		const file = this.plugin.lastTargetFile;
		this.summaryContentEl.empty();

		if (!file) {
			this.summaryContentEl.createEl('p', { cls: 'alt-placeholder', text: t('summary.empty') });
			return;
		}

		const content = await this.app.vault.read(file);
		const summary = this.extractSection(content, 'Summary');
		if (!summary.trim()) {
			this.summaryContentEl.createEl('p', { cls: 'alt-placeholder', text: t('summary.empty') });
			return;
		}

		const md = this.summaryContentEl.createDiv({ cls: 'alt-summary-md' });
		await MarkdownRenderer.render(this.app, summary.trim(), md, file.path, this);
	}

	private async handleCopyTranscript(): Promise<void> {
		const file = this.plugin.lastTargetFile;
		if (!file) {
			new Notice(t('recording.noNote'));
			return;
		}

		const content = await this.app.vault.read(file);
		const transcript = this.extractSection(content, 'Transcript').trim();
		if (!transcript) {
			new Notice(t('summary.noContent'));
			return;
		}

		await navigator.clipboard.writeText(transcript);
		new Notice('Transcript copied');
	}

	private async handleCopySummary(): Promise<void> {
		const file = this.plugin.lastTargetFile;
		if (!file) return;

		const content = await this.app.vault.read(file);
		const summary = this.extractSection(content, 'Summary').trim();
		if (!summary) {
			new Notice(t('summary.empty'));
			return;
		}

		await navigator.clipboard.writeText(summary);
		new Notice(t('summary.copied'));
	}

	private async handleSendChat(): Promise<void> {
		if (this.chatStreaming) return;

		const userText = this.chatInputEl.value.trim();
		if (!userText) return;

		this.chatInputEl.value = '';
		this.chatMessages.push({ role: 'user', content: userText });
		this.chatMessages.push({ role: 'assistant', content: '' });
		this.renderChat();

		this.chatStreaming = true;
		this.setHidden(this.chatSendBtn, true);
		this.setHidden(this.chatStopBtn, false);

		try {
			await this.plugin.ensureLlmAvailable();
			const context = await this.buildChatContext();
			const baseMessages: ChatMessage[] = [
				{
					role: 'system',
					content: `You are a helpful assistant for transcript notes. Use this context:\n\n${context}`,
				},
			];

			for (const msg of this.chatMessages.slice(-10)) {
				baseMessages.push({ role: msg.role, content: msg.content });
			}

			await this.plugin.llmProvider.streamChat(
				baseMessages,
				{
					model: this.chatModelSelect.value || this.plugin.settings.llmCloudModel,
					purpose: 'chat',
					temperature: 0.4,
					maxTokens: 2048,
				},
				{
					onToken: (token) => {
						const last = this.chatMessages[this.chatMessages.length - 1];
						if (!last || last.role !== 'assistant') return;
						last.content += token;
						this.renderChat();
					},
					onDone: (fullText) => {
						const last = this.chatMessages[this.chatMessages.length - 1];
						if (last && last.role === 'assistant' && !last.content.trim()) {
							last.content = fullText;
						}
					},
					onError: (err) => {
						new Notice(`${t('error.llmFailed')}: ${err.message}`);
					},
				},
			);
		} catch (e) {
			new Notice(`${t('error.llmFailed')}: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.chatStreaming = false;
			this.setHidden(this.chatSendBtn, false);
			this.setHidden(this.chatStopBtn, true);
		}
	}

	private handleStopChat(): void {
		this.plugin.llmProvider.abort();
		this.chatStreaming = false;
		this.setHidden(this.chatSendBtn, false);
		this.setHidden(this.chatStopBtn, true);
	}

	private renderChat(): void {
		if (!this.chatMessagesEl) return;
		this.chatMessagesEl.empty();

		if (this.chatMessages.length === 0) {
			this.chatMessagesEl.createEl('p', { cls: 'alt-placeholder', text: t('chat.noHistory') });
			return;
		}

		for (const msg of this.chatMessages) {
			const row = this.chatMessagesEl.createDiv({ cls: `alt-chat-row alt-chat-${msg.role}` });
			row.createDiv({
				cls: 'alt-chat-bubble',
				text: msg.content || (msg.role === 'assistant' ? t('chat.thinking') : ''),
			});
		}

		this.chatMessagesEl.scrollTop = this.chatMessagesEl.scrollHeight;
	}

	private async buildChatContext(): Promise<string> {
		const file = this.plugin.lastTargetFile ?? this.app.workspace.getActiveFile();
		if (!file) return 'No note context available.';

		const content = await this.app.vault.read(file);
		const transcript = this.extractSection(content, 'Transcript');
		const summary = this.extractSection(content, 'Summary');
		const translation = this.extractSection(content, 'Translation');

		return [
			`Note: ${file.path}`,
			transcript ? `Transcript:\n${transcript}` : '',
			summary ? `Summary:\n${summary}` : '',
			translation ? `Translation:\n${translation}` : '',
		]
			.filter(Boolean)
			.join('\n\n');
	}

	private async handleExport(): Promise<void> {
		const file = this.plugin.lastTargetFile;
		if (!file || this.isProcessing) return;

		this.isProcessing = true;
		try {
			const content = await this.app.vault.read(file);
			const sm = this.extractSection(content, 'Summary').trim();
			const tm = this.extractSection(content, 'Translation').trim();
			const exported = await this.plugin.exportService.export(
				{
					title: file.basename,
					transcript: this.plugin.lastTranscript || content,
					summary: sm || undefined,
					translation: tm || undefined,
					metadata: {
						llmModel: this.plugin.settings.llmCloudModel,
						createdAt: new Date().toISOString(),
						sourceNote: file.path,
					},
				},
				this.plugin.settings.exportsFolder,
			);
			new Notice(`Exported: ${exported.path}`);
		} catch (e) {
			new Notice(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.isProcessing = false;
		}
	}

	private updateUI(state: RecordingState): void {
		const statusMap: Record<RecordingState, [string, string]> = {
			idle: [t('recording.status.idle'), 'alt-status alt-status-idle'],
			recording: [t('recording.status.recording'), 'alt-status alt-status-rec'],
			paused: [t('recording.status.paused'), 'alt-status alt-status-paused'],
		};

		if (this.statusEl) {
			const [text, cls] = statusMap[state];
			this.statusEl.setText(text);
			this.statusEl.className = cls;
		}

		if (this.recordBtn) {
			this.recordBtn.empty();
			setIcon(this.recordBtn, state === 'idle' ? 'mic' : 'square');
		}

		if (state === 'idle') {
			this.waveformBuffer = [];
			this.drawWaveform();
			if (this.timerEl) this.timerEl.setText('00:00');
		}
	}

	private mmss(seconds: number): string {
		const total = Math.max(0, Math.floor(seconds));
		const min = Math.floor(total / 60);
		const sec = total % 60;
		return `${min}:${String(sec).padStart(2, '0')}`;
	}

	private hhmmss(seconds: number): string {
		const s = Math.max(0, Math.floor(seconds));
		const h = Math.floor(s / 3600)
			.toString()
			.padStart(2, '0');
		const m = Math.floor((s % 3600) / 60)
			.toString()
			.padStart(2, '0');
		const ss = (s % 60).toString().padStart(2, '0');
		return `${h}:${m}:${ss}`;
	}

	private extractSection(content: string, name: string): string {
		const range = this.findManagedSectionRange(content, name);
		return range ? range.body.trim() : '';
	}

	private removeManagedSection(content: string, name: string): string {
		const range = this.findManagedSectionRange(content, name);
		if (!range) return content;
		return `${content.slice(0, range.fullStart)}${content.slice(range.fullEnd)}`.trimEnd();
	}

	private findManagedSectionRange(
		content: string,
		name: string,
	): { fullStart: number; fullEnd: number; body: string } | null {
		const headings = ['Transcript', 'Summary', 'Translation'];
		const escapedName = this.escapeRegExp(name);
		const headerPattern =
			name === 'Translation' ? /^## Translation(?:\b[^\n]*)?$/m : new RegExp(`^## ${escapedName}$`, 'm');
		const headerMatch = content.match(headerPattern);
		if (!headerMatch || headerMatch.index == null) return null;

		let bodyStart = headerMatch.index + headerMatch[0].length;
		if (content.startsWith('\n\n', bodyStart)) bodyStart += 2;
		else if (content.startsWith('\n', bodyStart)) bodyStart += 1;

		const otherHeadings = headings.map((heading) =>
			heading === 'Translation' ? 'Translation(?:\\b[^\\n]*)?' : this.escapeRegExp(heading),
		);
		const nextHeaderPattern = new RegExp(`\n## (?:${otherHeadings.join('|')})$`, 'm');
		const rest = content.slice(bodyStart);
		const nextMatch = rest.match(nextHeaderPattern);
		const fullStart =
			content.slice(Math.max(0, headerMatch.index - 2), headerMatch.index) === '\n\n'
				? headerMatch.index - 2
				: headerMatch.index;
		const fullEnd = nextMatch && nextMatch.index != null ? bodyStart + nextMatch.index : content.length;

		return {
			fullStart,
			fullEnd,
			body: content.slice(bodyStart, fullEnd).trimEnd(),
		};
	}

	private escapeRegExp(value: string): string {
		return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	private float32ToWav(input: Float32Array, sampleRate: number): ArrayBuffer {
		const int16 = new Int16Array(input.length);
		for (let i = 0; i < input.length; i++) {
			const sample = Math.max(-1, Math.min(1, input[i]));
			int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
		}

		const headerSize = 44;
		const dataSize = int16.length * 2;
		const buffer = new ArrayBuffer(headerSize + dataSize);
		const view = new DataView(buffer);

		const write = (offset: number, str: string) => {
			for (let i = 0; i < str.length; i++) {
				view.setUint8(offset + i, str.charCodeAt(i));
			}
		};

		write(0, 'RIFF');
		view.setUint32(4, 36 + dataSize, true);
		write(8, 'WAVE');
		write(12, 'fmt ');
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * 2, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		write(36, 'data');
		view.setUint32(40, dataSize, true);
		new Int16Array(buffer, headerSize).set(int16);

		return buffer;
	}

	private async resolveTranscriptSource(): Promise<{ transcript: string; file: TFile } | null> {
		const file = this.plugin.lastTargetFile;
		if (!file) {
			new Notice(t('recording.noNote'));
			return null;
		}

		const cached = this.plugin.lastTranscript?.trim();
		if (cached) return { transcript: cached, file };

		const content = await this.app.vault.read(file);
		const section = this.extractTranscriptSection(content);
		if (!section) {
			new Notice(t('summary.noContent'));
			return null;
		}

		this.plugin.lastTranscript = section;
		return { transcript: section, file };
	}

	private extractTranscriptSection(content: string): string {
		const match = content.match(/## Transcript\n\n([\s\S]*?)(?=\n## |\n---|$)/);
		if (!match) return '';

		const raw = match[1].trim();
		if (!raw) return '';

		return raw
			.split('\n')
			.map((line) => line.replace(/^\*\*\[\d{2}:\d{2}(?::\d{2})?\]\*\*\s*/u, ''))
			.join(' ')
			.replace(/\s+/g, ' ')
			.trim();
	}
}
