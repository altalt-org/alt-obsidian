import type { ILlmProvider } from '../engines/llm/ILlmProvider';
import type { ChatMessage } from '../types';

const LANGUAGE_NAMES: Record<string, string> = {
	ko: '한국어',
	en: 'English',
	de: 'Deutsch',
	ja: '日本語',
	zh: '中文',
};

export class TranslationService {
	private llm: ILlmProvider;

	constructor(llm: ILlmProvider) {
		this.llm = llm;
	}

	setProvider(llm: ILlmProvider): void {
		this.llm = llm;
	}

	async translate(
		text: string,
		targetLanguage: string,
		options: { model?: string; onToken?: (token: string) => void } = {},
	): Promise<string> {
		if (!text.trim()) return text;

		const targetName = LANGUAGE_NAMES[targetLanguage] ?? targetLanguage;

		const messages: ChatMessage[] = [
			{
				role: 'user',
				content: [
					`You are a professional translator. Translate the following text into ${targetName}.`,
					`Output only the translated text without any additional explanation.`,
					``,
					`Text to translate:`,
					text,
				].join('\n'),
			},
		];

		return this.llm.generate(messages, {
			model: options.model,
			maxTokens: 2048,
			temperature: 0.3,
			purpose: 'translate',
		});
	}

	async fixTypos(
		text: string,
		_language: string,
		options: { model?: string; onToken?: (token: string) => void } = {},
	): Promise<string> {
		if (!text.trim()) return text;

		const messages: ChatMessage[] = [
			{
				role: 'user',
				content: [
					`You are an expert in correcting typos in speech transcription text.`,
					`Only fix obvious typos, spacing errors, and grammatical errors.`,
					`Do not change the content or meaning.`,
					`Output only the corrected text without any additional explanation.`,
					``,
					`Text to correct:`,
					text,
				].join('\n'),
			},
		];

		return this.llm.generate(messages, {
			model: options.model,
			maxTokens: 2048,
			temperature: 0.2,
			purpose: 'typo_correct',
		});
	}
}
