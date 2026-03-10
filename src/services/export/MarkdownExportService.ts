import { type App, moment, type TFile } from 'obsidian';

export interface ExportPayload {
	title: string;
	transcript: string;
	summary?: string;
	translation?: string;
	metadata: {
		llmModel: string;
		createdAt: string;
		sourceNote?: string;
	};
}

export class MarkdownExportService {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	async export(payload: ExportPayload, folder: string): Promise<TFile> {
		if (folder && !(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.createFolder(folder);
		}

		const datePrefix = moment().format('YYYY-MM-DD_HH-mm');
		const sanitizedTitle =
			payload.title
				.replace(/[\\/:*?"<>|]/g, ' ')
				.replace(/\s+/g, ' ')
				.trim()
				.slice(0, 80) || 'export';
		const fileName = `${datePrefix}_${sanitizedTitle}.md`;
		const path = folder ? `${folder}/${fileName}` : fileName;

		const content = [
			'---',
			`title: "${payload.title.replace(/"/g, '\\"')}"`,
			`created: "${payload.metadata.createdAt}"`,
			`llm_model: "${payload.metadata.llmModel}"`,
			payload.metadata.sourceNote ? `source_note: "${payload.metadata.sourceNote.replace(/"/g, '\\"')}"` : null,
			'---',
			'',
			`# ${payload.title}`,
			'',
			'## Transcript',
			'',
			payload.transcript || '(empty)',
			'',
			payload.translation ? '## Translation' : null,
			payload.translation ? '' : null,
			payload.translation ?? null,
			payload.translation ? '' : null,
			payload.summary ? '## Summary' : null,
			payload.summary ? '' : null,
			payload.summary ?? null,
		]
			.filter((line): line is string => line !== null)
			.join('\n');

		return this.app.vault.create(path, content);
	}
}
