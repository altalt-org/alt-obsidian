import { Platform } from 'obsidian';

type ScreenCaptureStatus = 'granted' | 'denied' | 'not-determined' | 'unsupported';

type DesktopSource = {
	id: string;
};

type DesktopCapturer = {
	getSources(options: { types: string[] }): Promise<DesktopSource[]>;
};

type DisplayMediaHandler = (
	request: unknown,
	callback: (stream: { video: DesktopSource; audio: 'loopback' }) => void,
) => void;

type ElectronSession = {
	defaultSession?: {
		setDisplayMediaRequestHandler(handler: DisplayMediaHandler | null): void;
	};
};

type ElectronRemote = {
	desktopCapturer?: DesktopCapturer;
	session?: ElectronSession;
	systemPreferences?: {
		getMediaAccessStatus(media: 'screen'): string;
	};
};

type ElectronModule = {
	desktopCapturer?: DesktopCapturer;
	remote?: ElectronRemote;
	shell?: {
		openExternal(url: string): void | Promise<void>;
	};
	systemPreferences?: {
		getMediaAccessStatus(media: 'screen'): string;
	};
};

type WindowWithRequire = Window & {
	require?: (moduleName: string) => unknown;
};

type DesktopTrackConstraints = MediaTrackConstraints & {
	mandatory: {
		chromeMediaSource: 'desktop';
		chromeMediaSourceId: string;
	};
};

function getElectron(): ElectronModule | null {
	try {
		const required = (window as WindowWithRequire).require?.('electron');
		if (!required || typeof required !== 'object') {
			return null;
		}
		return required as ElectronModule;
	} catch {
		return null;
	}
}

export function getScreenCaptureStatus(): ScreenCaptureStatus {
	if (!Platform.isDesktop) return 'unsupported';
	if (process.platform !== 'darwin') return 'granted';

	const electron = getElectron();
	if (!electron) return 'unsupported';

	try {
		const systemPreferences = electron.remote?.systemPreferences ?? electron.systemPreferences;
		if (!systemPreferences?.getMediaAccessStatus) return 'unsupported';
		const status = systemPreferences.getMediaAccessStatus('screen');
		if (status === 'granted') return 'granted';
		if (status === 'denied') return 'denied';
		if (status === 'not-determined') return 'not-determined';
		return 'unsupported';
	} catch {
		return 'unsupported';
	}
}

export function openScreenCaptureSettings(): void {
	const electron = getElectron();
	const shell = electron?.shell;
	if (!shell) return;
	void shell.openExternal(
		'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture',
	);
}

export async function acquireSystemAudioStream(): Promise<MediaStream | null> {
	const electron = getElectron();
	if (!electron) return fallbackGetDisplayMedia();

	const remote = electron.remote;
	const capturer = electron.desktopCapturer ?? remote?.desktopCapturer;
	const hasHandler = !!remote?.session?.defaultSession?.setDisplayMediaRequestHandler;

	if (hasHandler && capturer?.getSources && remote) {
		try {
			return await acquireViaDisplayMediaHandler(remote, capturer);
		} catch {
			/* display-media handler path can fail on older Electron builds */
		}
	}

	if (capturer?.getSources) {
		try {
			return await acquireViaLegacyDesktopCapturer(capturer);
		} catch {
			/* legacy desktopCapturer path can fail when loopback audio is unavailable */
		}
	}

	return fallbackGetDisplayMedia();
}

async function acquireViaDisplayMediaHandler(
	remote: ElectronRemote,
	capturer: DesktopCapturer,
): Promise<MediaStream | null> {
	const sources = await capturer.getSources({ types: ['screen'] });
	if (!sources.length || !remote.session?.defaultSession) return null;

	const source = sources[0];
	remote.session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
		callback({ video: source, audio: 'loopback' });
	});

	try {
		const stream = await navigator.mediaDevices.getDisplayMedia({
			audio: true,
			video: true,
		});

		for (const videoTrack of stream.getVideoTracks()) {
			videoTrack.stop();
			stream.removeTrack(videoTrack);
		}

		return stream.getAudioTracks().length > 0 ? stream : null;
	} finally {
		try {
			remote.session.defaultSession.setDisplayMediaRequestHandler(null);
		} catch {
			/* handler cleanup is best-effort during permission teardown */
		}
	}
}

async function acquireViaLegacyDesktopCapturer(capturer: DesktopCapturer): Promise<MediaStream | null> {
	const sources = await capturer.getSources({ types: ['screen'] });
	if (!sources.length) {
		return null;
	}

	const source = sources[0];
	const audio: DesktopTrackConstraints = {
		mandatory: {
			chromeMediaSource: 'desktop',
			chromeMediaSourceId: source.id,
		},
	};
	const video: DesktopTrackConstraints = {
		mandatory: {
			chromeMediaSource: 'desktop',
			chromeMediaSourceId: source.id,
		},
	};
	const stream = await navigator.mediaDevices.getUserMedia({ audio, video });

	for (const videoTrack of stream.getVideoTracks()) {
		videoTrack.stop();
		stream.removeTrack(videoTrack);
	}

	return stream.getAudioTracks().length > 0 ? stream : null;
}

async function fallbackGetDisplayMedia(): Promise<MediaStream | null> {
	try {
		const stream = await navigator.mediaDevices.getDisplayMedia({
			video: {
				width: { ideal: 1 },
				height: { ideal: 1 },
				frameRate: { ideal: 1, max: 1 },
			},
			audio: true,
		});

		for (const videoTrack of stream.getVideoTracks()) {
			videoTrack.stop();
			stream.removeTrack(videoTrack);
		}

		return stream.getAudioTracks().length > 0 ? stream : null;
	} catch {
		return null;
	}
}
