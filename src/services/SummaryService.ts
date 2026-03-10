import type { ILlmProvider } from '../engines/llm/ILlmProvider';
import { buildSummaryPrompt } from '../prompts/summary';
import type { ChatMessage } from '../types';

export class SummaryService {
	private llm: ILlmProvider;

	constructor(llm: ILlmProvider) {
		this.llm = llm;
	}

	setProvider(llm: ILlmProvider): void {
		this.llm = llm;
	}

	async summarize(
		sourceText: string,
		options: {
			model?: string;
			customPrompt?: string;
			outputLanguage?: string;
			summaryMode?: 'compact' | 'meeting-notes';
			onToken?: (token: string) => void;
		} = {},
	): Promise<string> {
		if (!sourceText.trim()) {
			throw new Error('No content to summarize');
		}

		const additionalInstruction =
			options.summaryMode === 'meeting-notes'
				? 'Use this structure exactly:\n## Executive Summary\n## Key Takeaways\n## Action Items\n## Open Questions'
				: 'Keep the output concise and practical. Prioritize key facts and decisions.';

		const prompt = buildSummaryPrompt(sourceText, {
			customPrompt: options.customPrompt,
			additionalInstruction,
			outputLanguage: options.outputLanguage,
		});

		const messages: ChatMessage[] = [
			{ role: 'system', content: prompt.system },
			{ role: 'user', content: prompt.user },
		];

		if (options.onToken) {
			return new Promise<string>((resolve, reject) => {
				let result = '';
				this.llm
					.streamChat(
						messages,
						{ model: options.model, maxTokens: 65536, temperature: 0.7, purpose: 'transcript_summary' },
						{
							onToken: (token) => {
								result += token;
								options.onToken?.(token);
							},
							onDone: () => resolve(result),
							onError: (err) => reject(err),
						},
					)
					.catch(reject);
			});
		}

		return this.llm.generate(messages, {
			model: options.model,
			maxTokens: 65536,
			temperature: 0.7,
			purpose: 'transcript_summary',
		});
	}
}
