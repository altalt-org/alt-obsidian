import * as https from 'https';
import type { App } from 'obsidian';
import type { AltHttpClient } from '../../infra/AltHttpClient';
import type { ChatMessage, GenerateOpts, StreamCallbacks } from '../../types';
import { getAllModels } from '../../services/ModelStore';
import type { ILlmProvider } from './ILlmProvider';

const LLM_URL = 'https://api.altalt.io/llm';
const LLM_ANONYMOUS_URL = 'https://api.altalt.io/llm-anonymous';

function createAbortError(): Error {
	const error = new Error('The operation was aborted.');
	error.name = 'AbortError';
	return error;
}

export class AltLlmProvider implements ILlmProvider {
	readonly name = 'alt-server';

	private app: App;
	private client: AltHttpClient;
	private abortController: AbortController | null = null;
	private _available = false;
	private _accessToken: string | null = null;
	private _machineId: string | null = null;

	constructor(client: AltHttpClient, app: App) {
		this.app = app;
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
			const stored = this.app.loadLocalStorage('alt-note-machine-id');
			if (typeof stored === 'string' && stored) return stored;
		} catch {
			/* machine ID lookup can fail without blocking requests */
		}

		const id = crypto.randomUUID();
		try {
			this.app.saveLocalStorage('alt-note-machine-id', id);
		} catch {
			/* machine ID persistence failure is non-critical */
		}
		return id;
	}

	async streamChat(messages: ChatMessage[], opts: GenerateOpts, cb: StreamCallbacks): Promise<void> {
		const modelId = opts.model || 'openai/gpt-oss-20b';
		const modelDef = getAllModels().find((m) => m.id === modelId);

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
			await new Promise<void>((resolve, reject) => {
				const abortController = this.abortController;
				if (!abortController) {
					reject(createAbortError());
					return;
				}

				const signal = abortController.signal;
				let buffer = '';
				let isSSE = false;
				let pendingEventType: string | null = null;
				let fullText = '';
				let chunkBuffer = '';
				let lastFlush = Date.now();
				const THROTTLE_MS = 100;
				let settled = false;

				const flush = () => {
					if (chunkBuffer) {
						cb.onToken?.(chunkBuffer);
						fullText += chunkBuffer;
						chunkBuffer = '';
						lastFlush = Date.now();
					}
				};

				const finish = (error?: Error) => {
					if (settled) return;
					settled = true;
					signal.removeEventListener('abort', onAbort);
					if (error) {
						reject(error);
						return;
					}
					resolve();
				};

				const processSseLines = (lines: string[]): boolean => {
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
								finish();
								return true;
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

					return false;
				};

				const onAbort = () => {
					req.destroy(createAbortError());
				};

				const req = https.request(endpoint, { method: 'POST', headers }, (res) => {
					const statusCode = res.statusCode ?? 0;

					if (statusCode < 200 || statusCode >= 300) {
						let errText = '';
						res.setEncoding('utf8');
						res.on('data', (chunk: string) => {
							errText += chunk;
						});
						res.on('end', () => {
							if (settled) return;
							if (statusCode === 429) {
								finish(new Error('Rate limit exceeded.'));
								return;
							}
							finish(new Error(`API Error ${statusCode}: ${errText}`));
						});
						res.on('error', (error) => {
							finish(error instanceof Error ? error : new Error(String(error)));
						});
						return;
					}

					res.setEncoding('utf8');
					res.on('data', (chunk: string) => {
						if (settled || signal.aborted) return;
						buffer += chunk;

						if (!isSSE && (buffer.includes('data: ') || buffer.includes('event: '))) {
							isSSE = true;
						}

						if (isSSE) {
							const lines = buffer.split('\n');
							buffer = lines.pop() || '';
							processSseLines(lines);
						} else {
							chunkBuffer += chunk;
							if (Date.now() - lastFlush > THROTTLE_MS) flush();
							buffer = '';
						}
					});

					res.on('end', () => {
						if (settled) return;
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
											/* ignore malformed trailing SSE payloads */
										}
									}
								}
							}
						} else if (buffer.trim()) {
							chunkBuffer += buffer;
						}

						flush();
						cb.onDone?.(fullText);
						finish();
					});

					res.on('error', (error) => {
						finish(error instanceof Error ? error : new Error(String(error)));
					});
				});

				req.on('error', (error) => {
					finish(error instanceof Error ? error : new Error(String(error)));
				});

				signal.addEventListener('abort', onAbort, { once: true });
				req.write(JSON.stringify(payload));
				req.end();
			});
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
			void this.streamChat(messages, opts, {
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
