import { type App, Notice, PluginSettingTab, Setting } from 'obsidian';
import { TRANSCRIPTION_LANGUAGES, TRANSLATION_LANGUAGES } from './constants/languages';
import { t } from './i18n';
import type AltNotePlugin from './main';

type ElectronShell = {
	openExternal(url: string): void | Promise<void>;
};

type ElectronModule = {
	shell?: ElectronShell;
	remote?: {
		shell?: ElectronShell;
	};
};

type WindowWithRequire = Window & {
	require?: (moduleName: string) => unknown;
};

function getElectronModule(): ElectronModule | null {
	const required = (window as WindowWithRequire).require?.('electron');
	if (!required || typeof required !== 'object') {
		return null;
	}

	return required as ElectronModule;
}

function openMacPrivacy(pane: string): void {
	const electron = getElectronModule();
	const shell = electron?.shell ?? electron?.remote?.shell;
	void shell?.openExternal(`x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?${pane}`);
}

export class AltNoteSettingTab extends PluginSettingTab {
	plugin: AltNotePlugin;

	constructor(app: App, plugin: AltNotePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName(t('settings.heading')).setHeading();

		// --- Alt App Banner ---
		const banner = containerEl.createDiv({ cls: 'alt-settings-banner' });
		banner.createEl('p', {
			text: t('settings.banner.description'),
		});
		const link = banner.createEl('a', {
			text: t('settings.banner.download'),
			href: 'https://www.altalt.io',
		});
		link.setAttr('target', '_blank');

		// --- Connection ---
		new Setting(containerEl).setName(t('settings.connection.heading')).setHeading();

		const statusSetting = new Setting(containerEl)
			.setName(t('settings.connection.name'))
			.setDesc(`${this.plugin.settings.altServerHost}:${this.plugin.settings.altServerPort}`);

		statusSetting.addButton((button) => {
			button.setButtonText(t('settings.connection.test'));
			button.onClick(async () => {
				button.setDisabled(true);
				button.setButtonText(t('settings.connection.testing'));
				try {
					if (!this.plugin.altClient) {
						throw new Error('Alt client not initialized.');
					}
					if (!this.plugin.settings.altServerToken) {
						const discovered = this.plugin.altClient.discoverToken();
						if (discovered) {
							this.plugin.settings.altServerToken = discovered;
							await this.plugin.saveSettings();
						}
					}
					await this.plugin.altClient.connect();
					new Notice(t('settings.connection.success'));
					button.setButtonText(t('settings.connection.successBtn'));
				} catch (e) {
					new Notice(`Connection failed: ${e instanceof Error ? e.message : String(e)}`);
					button.setButtonText(t('settings.connection.failedBtn'));
				} finally {
					button.setDisabled(false);
				}
			});
		});

		// --- Permissions ---
		new Setting(containerEl).setName(t('settings.permissions.heading')).setHeading();

		new Setting(containerEl)
			.setName(t('settings.permissions.microphone'))
			.setDesc(t('settings.permissions.microphone.desc'))
			.addButton((button) => {
				button.setButtonText(t('settings.permissions.open'));
				button.onClick(() => openMacPrivacy('Privacy_Microphone'));
			});

		new Setting(containerEl)
			.setName(t('settings.permissions.screenRecording'))
			.setDesc(t('settings.permissions.screenRecording.desc'))
			.addButton((button) => {
				button.setButtonText(t('settings.permissions.open'));
				button.onClick(() => openMacPrivacy('Privacy_ScreenCapture'));
			});

		// --- General ---
		new Setting(containerEl).setName(t('settings.general.heading')).setHeading();

		new Setting(containerEl)
			.setName(t('settings.general.noteLanguage'))
			.setDesc(t('settings.general.noteLanguage.desc'))
			.addDropdown((dropdown) => {
				for (const lang of TRANSCRIPTION_LANGUAGES) {
					dropdown.addOption(lang.code, lang.name);
				}
				dropdown.setValue(this.plugin.settings.defaultTranscriptionLanguage);
				dropdown.onChange(async (value) => {
					this.plugin.settings.defaultTranscriptionLanguage = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t('settings.recording.folder'))
			.setDesc(t('settings.recording.folder.desc'))
			.addText((text) => {
				text.setPlaceholder('Alt');
				text.setValue(this.plugin.settings.recordingsFolder);
				text.onChange(async (value) => {
					this.plugin.settings.recordingsFolder = value;
					await this.plugin.saveSettings();
				});
			});

		// --- AI ---
		new Setting(containerEl).setName(t('settings.ai.heading')).setHeading();

		new Setting(containerEl)
			.setName(t('settings.ai.autoTitle'))
			.setDesc(t('settings.ai.autoTitle.desc'))
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoGenerateTitle);
				toggle.onChange(async (value) => {
					this.plugin.settings.autoGenerateTitle = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t('settings.ai.autoSummary'))
			.setDesc(t('settings.ai.autoSummary.desc'))
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoSummarize);
				toggle.onChange(async (value) => {
					this.plugin.settings.autoSummarize = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t('settings.ai.translationTarget'))
			.setDesc(t('settings.ai.translationTarget.desc'))
			.addDropdown((dropdown) => {
				for (const lang of TRANSLATION_LANGUAGES) {
					dropdown.addOption(lang.code, lang.name);
				}
				dropdown.setValue(this.plugin.settings.translationTargetLanguage);
				dropdown.onChange(async (value) => {
					this.plugin.settings.translationTargetLanguage = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t('settings.ai.summaryMode'))
			.setDesc(t('settings.ai.summaryMode.desc'))
			.addDropdown((dropdown) => {
				dropdown.addOption('compact', t('settings.summaryMode.compact'));
				dropdown.addOption('meeting-notes', t('settings.summaryMode.meeting'));
				dropdown.setValue(this.plugin.settings.summaryMode);
				dropdown.onChange(async (value) => {
					this.plugin.settings.summaryMode = value as 'compact' | 'meeting-notes';
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(t('settings.ai.customPrompt'))
			.setDesc(t('settings.ai.customPrompt.desc'))
			.addTextArea((textarea) => {
				textarea.setValue(this.plugin.settings.customSummaryPrompt);
				textarea.inputEl.rows = 4;
				textarea.inputEl.cols = 50;
				textarea.onChange(async (value) => {
					this.plugin.settings.customSummaryPrompt = value;
					await this.plugin.saveSettings();
				});
			});

		// --- Advanced (collapsed) ---
		const advancedDetails = containerEl.createEl('details');
		advancedDetails.createEl('summary', { text: t('settings.advanced.heading'), cls: 'alt-settings-advanced-toggle' });

		new Setting(advancedDetails).setName(t('settings.advanced.host')).addText((text) => {
			text.setPlaceholder('127.0.0.1');
			text.setValue(this.plugin.settings.altServerHost);
			text.onChange(async (value) => {
				this.plugin.settings.altServerHost = value;
				await this.plugin.saveSettings();
			});
		});

		new Setting(advancedDetails).setName(t('settings.advanced.port')).addText((text) => {
			text.setValue(String(this.plugin.settings.altServerPort));
			text.onChange(async (value) => {
				const port = parseInt(value, 10);
				if (!Number.isNaN(port) && port > 0 && port < 65536) {
					this.plugin.settings.altServerPort = port;
					await this.plugin.saveSettings();
				}
			});
		});

		new Setting(advancedDetails)
			.setName(t('settings.advanced.token'))
			.setDesc(t('settings.advanced.token.desc'))
			.addText((text) => {
				text.setPlaceholder('Auto-discover');
				text.setValue(this.plugin.settings.altServerToken);
				text.inputEl.type = 'password';
				text.onChange(async (value) => {
					this.plugin.settings.altServerToken = value;
					await this.plugin.saveSettings();
				});
			});
	}
}
