import type { AltHttpClient } from '../../infra/AltHttpClient';
import type { ChatMessage, GenerateOpts, StreamCallbacks } from '../../types';
import { ALL_MODELS } from '../../types';
import type { ILlmProvider } from './ILlmProvider';

const LLM_URL = 'https://api.altalt.io/llm';
const LLM_ANONYMOUS_URL = 'https://api.altalt.io/llm-anonymous';

export class AltLlmProvider implements ILlmProvider {
	readonly name = 'alt-server';

	private client: AltHttpClient;
	private abortController: AbortController | null = null;
	private _available = false;
	private _accessToken: string | null = null;
	private _machineId: string | null = null;

	constructor(client: AltHttpClient) {
		this.client = client;
	}

	get available(): boolean {
		return this._available;
	}

	async checkAvailability(): Promise<void> {
		if (!this.client.connected) {
			this._available = false;
			return;
		}

		try {
			const authStorage = await this.client.getStorage<Record<string, unknown>>('auth');
			const session = authStorage?.session as Record<string, unknown> | undefined;
			this._accessToken = (session?.accessToken as string) || null;

			if (!this._machineId) {
				this._machineId = this.getOrCreateMachineId();
			}

			this._available = true;
		} catch {
			this._available = false;
		}
	}

	private getOrCreateMachineId(): string {
		try {
			const stored = localStorage.getItem('alt-note-machine-id');
			if (stored) return stored;
		} catch {
			/* noop */
		}

		const id = crypto.randomUUID();
		try {
			localStorage.setItem('alt-note-machine-id', id);
		} catch {
			/* noop */
		}
		return id;
	}

	async streamChat(messages: ChatMessage[], opts: GenerateOpts, cb: StreamCallbacks): Promise<void> {
		const modelId = opts.model || 'openai/gpt-oss-20b';
		const modelDef = ALL_MODELS.find((m) => m.id === modelId);

		const isLoggedIn = !!this._accessToken;
		let endpoint: string;
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };

		if (isLoggedIn) {
			endpoint = LLM_URL;
			headers.Authorization = `Bearer ${this._accessToken}`;
		} else {
			endpoint = LLM_ANONYMOUS_URL;
			if (this._machineId) {
				headers['X-Machine-ID'] = this._machineId;
			}
			if (modelDef?.tier === 'pro') {
				cb.onError?.(new Error('Pro models require Alt login.'));
				return;
			}
		}

		const payload = {
			provider: modelDef?.provider || 'groq',
			model: modelId,
			messages,
			purpose: opts.purpose,
			temperature: opts.temperature,
			maxOutputTokens: opts.maxTokens,
		};

		this.abortController = new AbortController();

		try {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers,
				body: JSON.stringify(payload),
				signal: this.abortController.signal,
			});

			if (!response.ok) {
				if (response.status === 429) throw new Error('Rate limit exceeded.');
				const errText = await response.text();
				throw new Error(`API Error ${response.status}: ${errText}`);
			}

			if (!response.body) throw new Error('Response body is null');

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let isSSE = false;
			let pendingEventType: string | null = null;
			let fullText = '';
			let chunkBuffer = '';
			let lastFlush = Date.now();
			const THROTTLE_MS = 100;

			const flush = () => {
				if (chunkBuffer) {
					cb.onToken?.(chunkBuffer);
					fullText += chunkBuffer;
					chunkBuffer = '';
					lastFlush = Date.now();
				}
			};

			try {
				while (true) {
					if (this.abortController.signal.aborted) {
						reader.releaseLock();
						return;
					}

					const { done, value } = await reader.read();
					if (done) {
						if (buffer.trim() && isSSE) {
							for (const line of buffer.split('\n')) {
								if (line.startsWith('data: ')) {
									const jsonStr = line.replace(/^data: /, '').trim();
									if (jsonStr !== '[DONE]') {
										try {
											const parsed = JSON.parse(jsonStr);
											const text = parsed.text || parsed.content || '';
											if (text) chunkBuffer += text;
										} catch {
											/* non-JSON */
										}
									}
								}
							}
						} else if (buffer.trim()) {
							chunkBuffer += buffer;
						}
						flush();
						cb.onDone?.(fullText);
						break;
					}

					const chunk = decoder.decode(value, { stream: true });
					buffer += chunk;

					if (!isSSE && (buffer.includes('data: ') || buffer.includes('event: '))) {
						isSSE = true;
					}

					if (isSSE) {
						const lines = buffer.split('\n');
						buffer = lines.pop() || '';

						for (const line of lines) {
							if (line.startsWith('event: ')) {
								pendingEventType = line.replace(/^event: /, '').trim();
								continue;
							}
							if (line.startsWith('data: ')) {
								const jsonStr = line.replace(/^data: /, '').trim();
								if (jsonStr === '[DONE]') {
									flush();
									cb.onDone?.(fullText);
									return;
								}
								try {
									const parsed = JSON.parse(jsonStr);
									if (pendingEventType === 'error' && parsed.error) {
										cb.onError?.(new Error(parsed.error));
										pendingEventType = null;
										continue;
									}
									const text = parsed.text || parsed.content || '';
									if (text) {
										chunkBuffer += text;
										if (Date.now() - lastFlush > THROTTLE_MS) flush();
									}
									pendingEventType = null;
								} catch {
									if (jsonStr && jsonStr !== '[DONE]') {
										chunkBuffer += jsonStr;
										if (Date.now() - lastFlush > THROTTLE_MS) flush();
									}
									pendingEventType = null;
								}
							}
						}
					} else {
						chunkBuffer += chunk;
						if (Date.now() - lastFlush > THROTTLE_MS) flush();
						buffer = '';
					}
				}
			} finally {
				reader.releaseLock();
			}
		} catch (e) {
			if (e instanceof Error && (e.name === 'AbortError' || this.abortController?.signal.aborted)) return;
			cb.onError?.(e instanceof Error ? e : new Error(String(e)));
		} finally {
			this.abortController = null;
		}
	}

	async generate(messages: ChatMessage[], opts: GenerateOpts): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			let result = '';
			this.streamChat(messages, opts, {
				onToken: (token) => {
					result += token;
				},
				onDone: () => resolve(result),
				onError: (err) => reject(err),
			}).catch(reject);
		});
	}

	abort(): void {
		this.abortController?.abort();
		this.abortController = null;
	}
}
