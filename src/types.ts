// ============================================================================
// LLM Provider Types (from Alt desktop — src/shared/types/llm.ts)
// ============================================================================

export type LLMProviderType = 'openai' | 'anthropic' | 'google' | 'groq' | 'xai' | 'local';

export type LLMPurpose = 'note_title' | 'transcript_summary' | 'chat' | 'translate' | 'typo_correct';

export interface ModelDefinition {
	id: string;
	name: string;
	provider: LLMProviderType;
	tier: 'free' | 'pro' | 'local';
	description?: string;
}

// ============================================================================
// Model Definitions (from Alt desktop — src/shared/constants/models.ts)
// ============================================================================

export const GENERAL_MODELS: ModelDefinition[] = [
	{
		id: 'openai/gpt-oss-20b',
		name: 'Auto',
		provider: 'groq',
		tier: 'free',
		description: 'Extremely fast',
	},
	{
		id: 'gpt-5-nano',
		name: 'GPT-5 Nano',
		provider: 'openai',
		tier: 'free',
		description: 'Smart but slow',
	},
	{
		id: 'openai/gpt-oss-120b',
		name: 'Auto Max',
		provider: 'groq',
		tier: 'pro',
		description: 'Fast & smart',
	},
	{
		id: 'gpt-5.1-chat-latest',
		name: 'GPT-5.1 Instant',
		provider: 'openai',
		tier: 'pro',
		description: 'Balanced',
	},
	{
		id: 'gpt-5.1',
		name: 'GPT-5.1 Thinking',
		provider: 'openai',
		tier: 'pro',
		description: 'Maximum intelligence',
	},
	{
		id: 'gemini-3-pro-preview',
		name: 'Gemini 3 Pro Preview',
		provider: 'google',
		tier: 'pro',
		description: 'Maximum intelligence',
	},
	{
		id: 'gemma-3n-E2B-it-Q8_0-gguf',
		name: 'Gemma Local',
		provider: 'local',
		tier: 'local',
		description: 'Private & offline',
	},
];

export const EXTRA_AI_MODELS: ModelDefinition[] = [
	{
		id: 'openai/gpt-oss-20b',
		name: 'Auto',
		provider: 'groq',
		tier: 'free',
		description: 'Extremely fast',
	},
	{
		id: 'gemma-3n-E2B-it-Q8_0-gguf',
		name: 'Gemma Local',
		provider: 'local',
		tier: 'local',
		description: 'Private & offline',
	},
];

export const MEETING_NOTES_MODELS: ModelDefinition[] = [
	{
		id: 'xai/grok-code-fast-1',
		name: 'Grok Code Fast 1',
		provider: 'xai',
		tier: 'pro',
	},
	{
		id: 'xai/grok-4.1-fast-reasoning',
		name: 'Grok 4.1 Fast Reasoning',
		provider: 'xai',
		tier: 'pro',
	},
	{
		id: 'xai/grok-4.1-fast-non-reasoning',
		name: 'Grok 4.1 Fast Non-Reasoning',
		provider: 'xai',
		tier: 'free',
	},
	{
		id: 'claude-haiku-4-5-20251001',
		name: 'Claude Haiku 4.5',
		provider: 'anthropic',
		tier: 'pro',
	},
	{
		id: 'gemini-3-flash-preview',
		name: 'Gemini 3 Flash Preview',
		provider: 'google',
		tier: 'pro',
	},
];

/** All models combined, deduplicated by ID */
export const ALL_MODELS: ModelDefinition[] = Array.from(
	new Map([...GENERAL_MODELS, ...EXTRA_AI_MODELS, ...MEETING_NOTES_MODELS].map((m) => [m.id, m])).values(),
);

export const DEFAULT_MODEL = GENERAL_MODELS[0];
export const DEFAULT_EXTRA_AI_MODEL = EXTRA_AI_MODELS[0];

export type SummaryMode = 'compact' | 'meeting-notes';

// ============================================================================
// Transcription Types
// ============================================================================

export interface TranscriptionSegment {
	/** Start time in seconds */
	start: number;
	/** Duration in seconds */
	duration: number;
	/** Transcribed text */
	text: string;
}

export interface TranscribeResult {
	segments: TranscriptionSegment[];
	text: string;
	language?: string;
}

// ============================================================================
// Audio Types
// ============================================================================

export type RecordingState = 'idle' | 'recording' | 'paused';

// ============================================================================
// Chat Message Types (for ILlmProvider)
// ============================================================================

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface GenerateOpts {
	model?: string;
	maxTokens?: number;
	temperature?: number;
	topP?: number;
	purpose?: LLMPurpose;
}

export interface StreamCallbacks {
	onToken?: (token: string) => void;
	onDone?: (fullText: string) => void;
	onError?: (error: Error) => void;
}

// ============================================================================
// Note Types
// ============================================================================

export type NoteStatus = 'draft' | 'in_progress' | 'completed';

export interface AltNoteFrontmatter {
	'alt-type': 'lecture-note' | 'meeting-note';
	status: NoteStatus;
	lecture_date: string;
	recording_file?: string;
	language?: string;
	created: string;
}

// ============================================================================
// Plugin Settings
// ============================================================================

export interface AltNoteSettings {
	llmCloudModel: string;
	llmExtraModel: string;

	// Plugin UI
	language: 'en' | 'ko';

	// Recording
	defaultTranscriptionLanguage: string;
	selectedMicrophoneId: string;
	includeSystemAudio: boolean;
	transcriptionKeywords: string;
	transcriptTranslateEnabled: boolean;
	transcriptTranslateTargetLanguage: string;
	recordingsFolder: string;
	audioChunkDuration: number;
	vadEnabled: boolean;
	vadThreshold: number;

	// Alt Server
	altServerEnabled: boolean;
	altServerHost: string;
	altServerPort: number;
	altServerToken: string;

	// AI Features
	autoGenerateTitle: boolean;
	autoSummarize: boolean;
	summaryOutputLanguage: string;
	summaryGenerateLanguage: string;
	customSummaryPrompt: string;
	translationTargetLanguage: string;
	summaryMode: SummaryMode;
	exportsFolder: string;
}

export const DEFAULT_SETTINGS: AltNoteSettings = {
	// LLM
	llmCloudModel: DEFAULT_MODEL.id,
	llmExtraModel: DEFAULT_EXTRA_AI_MODEL.id,

	// Alt Server
	altServerEnabled: false,
	altServerHost: '127.0.0.1',
	altServerPort: 45623,
	altServerToken: '',

	// Plugin UI
	language: 'en',

	// Recording
	defaultTranscriptionLanguage: 'auto',
	selectedMicrophoneId: '',
	includeSystemAudio: true,
	transcriptionKeywords: '',
	transcriptTranslateEnabled: false,
	transcriptTranslateTargetLanguage: 'ko',
	recordingsFolder: 'Alt',
	audioChunkDuration: 10,
	vadEnabled: true,
	vadThreshold: 0.3,

	// AI Features
	autoGenerateTitle: true,
	autoSummarize: false,
	summaryOutputLanguage: '',
	summaryGenerateLanguage: '',
	customSummaryPrompt: '',
	translationTargetLanguage: 'en',
	summaryMode: 'compact',
	exportsFolder: 'exports',
};
