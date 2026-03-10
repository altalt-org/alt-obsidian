/**
 * RecordingStatusBar
 * Shows recording state and elapsed time in the Obsidian status bar.
 */

import { setIcon } from 'obsidian';
import type { RecordingState } from '../types';

export class RecordingStatusBar {
	private el: HTMLElement;
	private iconEl: HTMLElement;
	private textEl: HTMLElement;
	private visible = false;

	constructor(statusBarEl: HTMLElement) {
		this.el = statusBarEl;
		this.el.addClass('alt-status-bar');

		this.iconEl = this.el.createSpan({ cls: 'alt-status-bar-icon' });
		this.textEl = this.el.createSpan({ cls: 'alt-status-bar-text' });

		this.hide();
	}

	show(): void {
		this.el.removeClass('alt-hidden');
		this.visible = true;
	}

	hide(): void {
		this.el.addClass('alt-hidden');
		this.visible = false;
	}

	update(state: RecordingState, elapsedMs: number): void {
		if (state === 'idle') {
			this.hide();
			return;
		}

		if (!this.visible) {
			this.show();
		}

		// Icon
		this.iconEl.empty();
		switch (state) {
			case 'recording':
				setIcon(this.iconEl, 'mic');
				this.el.className = 'alt-status-bar alt-status-bar-recording';
				break;
			case 'paused':
				setIcon(this.iconEl, 'pause');
				this.el.className = 'alt-status-bar alt-status-bar-paused';
				break;
		}

		// Timer
		const totalSec = Math.floor(elapsedMs / 1000);
		const min = Math.floor(totalSec / 60)
			.toString()
			.padStart(2, '0');
		const sec = (totalSec % 60).toString().padStart(2, '0');
		this.textEl.setText(`${min}:${sec}`);
	}
}
