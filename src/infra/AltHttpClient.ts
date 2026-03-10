/**
 * AltHttpClient — HTTP client for Alt desktop app's local server.
 *
 * Connects to Alt's HTTP server (default 127.0.0.1:45623) with Bearer token auth.
 * Provides REST API access + SSE event streaming.
 */

import * as fs from 'fs';
import * as http from 'http';
import { requestUrl } from 'obsidian';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export interface AltServerStatus {
	ok: boolean;
	version?: string;
	platform?: string;
	uptime?: number;
}

export interface AltApiResponse<T = unknown> {
	ok: boolean;
	data?: T;
	error?: string;
}

export interface AltLectureNote {
	id: number;
	title: string;
	description?: string;
	lecture_date?: string;
	status?: string;
	folder_id?: number | null;
	created_at?: string;
	updated_at?: string;
}

export interface AltNoteComponent {
	id: number;
	note_id: number;
	component_type: 'transcript' | 'summary' | 'memo' | 'recording' | 'slides';
	title?: string;
	content_text?: string;
	created_at?: string;
	updated_at?: string;
}

export interface AltShareResult {
	success: boolean;
	shareToken?: string;
	shareUrl?: string;
	visibility?: string;
	error?: string;
}

export interface AltShareOptions {
	visibility?: 'public' | 'unlisted' | 'private';
	selectedComponents?: {
		transcript?: boolean;
		summary?: boolean;
		slides?: boolean;
		meeting_notes?: boolean;
		memo?: boolean;
	};
}

export interface SSEEvent {
	event: string;
	data: unknown;
}

export type SSEEventHandler = (event: SSEEvent) => void;

// ============================================================================
// Client
// ============================================================================

export class AltHttpClient {
	private host: string;
	private port: number;
	private token: string;
	private _connected = false;
	private sseAbort: AbortController | null = null;
	private sseHandlers = new Map<string, Set<SSEEventHandler>>();
	private sseReconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private _sseRequest: http.ClientRequest | null = null;

	constructor(host = '127.0.0.1', port = 45623, token = '') {
		this.host = host;
		this.port = port;
		this.token = token;
	}

	get connected(): boolean {
		return this._connected;
	}

	get baseUrl(): string {
		return `http://${this.host}:${this.port}`;
	}

	// --------------------------------------------------------------------------
	// Configuration
	// --------------------------------------------------------------------------

	configure(host: string, port: number, token: string): void {
		const changed = this.host !== host || this.port !== port || this.token !== token;
		this.host = host;
		this.port = port;
		this.token = token;
		if (changed) {
			this._connected = false;
		}
	}

	/**
	 * Try to auto-discover the auth token from Alt's token file.
	 * macOS: ~/Library/Application Support/Alt/http-server-token
	 */
	async discoverToken(): Promise<string | null> {
		const platform = process.platform;
		let tokenPath: string;

		if (platform === 'darwin') {
			tokenPath = path.join(process.env.HOME || '', 'Library', 'Application Support', 'Alt', 'http-server-token');
		} else if (platform === 'win32') {
			tokenPath = path.join(process.env.APPDATA || '', 'Alt', 'http-server-token');
		} else {
			tokenPath = path.join(process.env.HOME || '', '.config', 'Alt', 'http-server-token');
		}

		try {
			const token = fs.readFileSync(tokenPath, 'utf-8').trim();
			if (token) {
				this.token = token;
				return token;
			}
		} catch {
			// Token file not found — user must provide manually
		}
		return null;
	}

	// --------------------------------------------------------------------------
	// Connection
	// --------------------------------------------------------------------------

	/**
	 * Check if Alt server is reachable (health check — no auth required).
	 */
	async checkHealth(): Promise<AltServerStatus> {
		try {
			const res = await requestUrl({
				url: `${this.baseUrl}/api/status`,
				method: 'GET',
				headers: { 'Content-Type': 'application/json' },
			});
			const body = res.json as AltApiResponse<AltServerStatus>;
			if (body.ok) {
				this._connected = true;
				return body.data as AltServerStatus;
			}
			this._connected = false;
			throw new Error(body.error || 'Unknown error');
		} catch (e) {
			this._connected = false;
			throw new Error(`Alt server unreachable at ${this.baseUrl}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * Full connection test: health check + auth validation.
	 */
	async connect(): Promise<void> {
		await this.checkHealth();

		// Validate auth by calling an authenticated endpoint
		try {
			await this.request<string>('GET', '/api/app/platform');
		} catch (e) {
			this._connected = false;
			throw new Error(`Alt server auth failed. Check your token. ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	disconnect(): void {
		this.stopSSE();
		this._connected = false;
	}

	// --------------------------------------------------------------------------
	// Generic Request
	// --------------------------------------------------------------------------

	private async request<T>(
		method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
		path: string,
		body?: Record<string, unknown>,
	): Promise<T> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		if (this.token) {
			headers['Authorization'] = `Bearer ${this.token}`;
		}

		const opts: Parameters<typeof requestUrl>[0] = {
			url: `${this.baseUrl}${path}`,
			method,
			headers,
		};

		if (body && ['POST', 'PATCH', 'PUT'].includes(method)) {
			opts.body = JSON.stringify(body);
		}

		const res = await requestUrl(opts);
		const json = res.json as AltApiResponse<T>;

		if (!json.ok) {
			throw new Error(json.error || `API error: ${method} ${path}`);
		}

		return json.data as T;
	}

	// --------------------------------------------------------------------------
	// Lecture Notes API
	// --------------------------------------------------------------------------

	async createNote(data: Partial<AltLectureNote>): Promise<AltLectureNote> {
		return this.request<AltLectureNote>('POST', '/api/lectureNotes', data as Record<string, unknown>);
	}

	// --------------------------------------------------------------------------
	// Note Components API
	// --------------------------------------------------------------------------

	async createComponent(data: Partial<AltNoteComponent>): Promise<AltNoteComponent> {
		return this.request<AltNoteComponent>('POST', '/api/noteComponents', data as Record<string, unknown>);
	}

	// --------------------------------------------------------------------------
	// Transcribe API
	// --------------------------------------------------------------------------

	async transcribe(
		pcm16kMono: Float32Array,
		language?: string,
		prompt?: string,
	): Promise<{ text: string; segments: { start: number; end: number; text: string }[] }> {
		const buffer = Buffer.from(pcm16kMono.buffer, pcm16kMono.byteOffset, pcm16kMono.byteLength);
		const audioBase64 = buffer.toString('base64');

		return this.request('POST', '/api/transcribe', {
			audio: audioBase64,
			language: language || undefined,
			prompt: prompt || undefined,
		});
	}

	async isWhisperReady(): Promise<boolean> {
		try {
			const result = await this.request<{ ready: boolean }>('GET', '/api/transcribe/status');
			return result.ready;
		} catch {
			return false;
		}
	}

	// --------------------------------------------------------------------------
	// Share API
	// --------------------------------------------------------------------------

	async createShare(noteId: number, options?: AltShareOptions): Promise<AltShareResult> {
		return this.request<AltShareResult>('POST', '/api/share', {
			noteId,
			options: options || undefined,
		});
	}

	// --------------------------------------------------------------------------
	// Storage API (read Alt's settings/preferences)
	// --------------------------------------------------------------------------

	async getStorage<T = unknown>(namespace: string): Promise<T> {
		return this.request<T>('GET', `/api/storage/${namespace}`);
	}

	// --------------------------------------------------------------------------
	// SSE Event Stream
	// --------------------------------------------------------------------------

	/**
	 * Start listening to SSE events from Alt server.
	 * Automatically reconnects on disconnect.
	 */
	startSSE(): void {
		if (this.sseAbort) {
			return; // Already running
		}
		this._connectSSE();
	}

	stopSSE(): void {
		if (this.sseReconnectTimer) {
			clearTimeout(this.sseReconnectTimer);
			this.sseReconnectTimer = null;
		}
		if (this.sseAbort) {
			this.sseAbort.abort();
			this.sseAbort = null;
		}
		if (this._sseRequest) {
			this._sseRequest.destroy();
			this._sseRequest = null;
		}
	}

	onSSE(event: string, handler: SSEEventHandler): () => void {
		if (!this.sseHandlers.has(event)) {
			this.sseHandlers.set(event, new Set());
		}
		this.sseHandlers.get(event)!.add(handler);

		return () => {
			this.sseHandlers.get(event)?.delete(handler);
		};
	}

	private _connectSSE(): void {
		this.sseAbort = new AbortController();
		const signal = this.sseAbort.signal;

		const req = http.get(
			{
				hostname: this.host,
				port: this.port,
				path: '/api/events',
				headers: {
					Authorization: `Bearer ${this.token}`,
					Accept: 'text/event-stream',
				},
			},
			(res) => {
				if (res.statusCode !== 200) {
					res.resume();
					this._scheduleSSEReconnect();
					return;
				}

				res.setEncoding('utf-8');
				let buffer = '';
				let currentEvent = '';

				res.on('data', (chunk: string) => {
					if (signal.aborted) return;
					buffer += chunk;
					const lines = buffer.split('\n');
					buffer = lines.pop() || '';

					for (const line of lines) {
						if (line.startsWith('event: ')) {
							currentEvent = line.slice(7).trim();
						} else if (line.startsWith('data: ')) {
							const dataStr = line.slice(6).trim();
							if (currentEvent && dataStr) {
								try {
									const data = JSON.parse(dataStr);
									this._emitSSE(currentEvent, data);
								} catch {
									this._emitSSE(currentEvent, dataStr);
								}
							}
							currentEvent = '';
						}
					}
				});

				res.on('end', () => {
					if (!signal.aborted) {
						this._scheduleSSEReconnect();
					}
				});

				res.on('error', (e) => {
					if (!signal.aborted) {
						this._scheduleSSEReconnect();
					}
				});
			},
		);

		req.on('error', (e) => {
			if (signal.aborted) return;
			this._scheduleSSEReconnect();
		});

		signal.addEventListener('abort', () => {
			req.destroy();
		});

		this._sseRequest = req;
	}

	private _scheduleSSEReconnect(): void {
		this.sseAbort = null;
		this.sseReconnectTimer = setTimeout(() => {
			if (this._connected) {
				this._connectSSE();
			}
		}, 5000);
	}

	private _emitSSE(event: string, data: unknown): void {
		const handlers = this.sseHandlers.get(event);
		if (handlers) {
			for (const handler of handlers) {
				try {
					handler({ event, data });
				} catch {}
			}
		}

		// Also emit to wildcard '*' handlers
		const wildcardHandlers = this.sseHandlers.get('*');
		if (wildcardHandlers) {
			for (const handler of wildcardHandlers) {
				try {
					handler({ event, data });
				} catch {}
			}
		}
	}
}
