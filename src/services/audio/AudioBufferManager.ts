const SAMPLE_RATE = 16000;

export class AudioSegmentBuffer {
	private chunks: Float32Array[] = [];
	private _durationMs = 0;
	private capacityMs: number;

	constructor(capacityMs: number) {
		this.capacityMs = capacityMs;
	}

	get durationMs(): number {
		return this._durationMs;
	}

	append(chunk: Float32Array): void {
		const chunkDurationMs = (chunk.length / SAMPLE_RATE) * 1000;
		const copy = new Float32Array(chunk);
		this.chunks.push(copy);
		this._durationMs += chunkDurationMs;
	}

	getData(): Float32Array {
		if (this.chunks.length === 0) return new Float32Array(0);
		const totalLength = this.chunks.reduce((sum, c) => sum + c.length, 0);
		const result = new Float32Array(totalLength);
		let offset = 0;
		for (const chunk of this.chunks) {
			result.set(chunk, offset);
			offset += chunk.length;
		}
		return result;
	}

	clear(): void {
		this.chunks = [];
		this._durationMs = 0;
	}

	get empty(): boolean {
		return this.chunks.length === 0;
	}
}

export class CircularAudioBuffer {
	private chunks: Float32Array[] = [];
	private _durationMs = 0;
	private capacityMs: number;

	constructor(capacityMs: number) {
		this.capacityMs = capacityMs;
	}

	get durationMs(): number {
		return this._durationMs;
	}

	append(chunk: Float32Array): void {
		const copy = new Float32Array(chunk);
		const chunkDurationMs = (chunk.length / SAMPLE_RATE) * 1000;
		this.chunks.push(copy);
		this._durationMs += chunkDurationMs;

		while (this._durationMs > this.capacityMs && this.chunks.length > 0) {
			const oldest = this.chunks.shift();
			if (oldest) {
				this._durationMs -= (oldest.length / SAMPLE_RATE) * 1000;
			}
		}
	}

	getData(): Float32Array {
		if (this.chunks.length === 0) return new Float32Array(0);
		const totalLength = this.chunks.reduce((sum, c) => sum + c.length, 0);
		const result = new Float32Array(totalLength);
		let offset = 0;
		for (const chunk of this.chunks) {
			result.set(chunk, offset);
			offset += chunk.length;
		}
		return result;
	}

	clear(): void {
		this.chunks = [];
		this._durationMs = 0;
	}

	get empty(): boolean {
		return this.chunks.length === 0;
	}
}

export function concatenateFloat32Arrays(...arrays: Float32Array[]): Float32Array {
	const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
	const result = new Float32Array(totalLength);
	let offset = 0;
	for (const arr of arrays) {
		result.set(arr, offset);
		offset += arr.length;
	}
	return result;
}
