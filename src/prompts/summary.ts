/**
 * Summary prompt builder.
 * Ported from Alt iOS app (SummaryPromptBuilder.swift).
 */

export interface SummaryPrompt {
	system: string;
	user: string;
}

// ============================================================================
// Default Mode Prompts
// ============================================================================

const DEFAULT_SYSTEM_PROMPT = `You are an elite content strategist and summarization specialist. Your goal is to convert raw, potentially unstructured, and error-prone content into clean, concise, and highly readable Markdown summaries.

**CORE RESPONSIBILITIES:**
1.  **Distill and Condense:** Remove all filler words, meaningful pauses, stuttering, and conversational fluff. The output MUST be significantly shorter than the original text.
2.  **Intelligent Error Correction:**
    - **Phonetic Errors:** The transcript may contain words that sound similar but are wrong (e.g., "whole" vs "hole", "write" vs "right"). You must infer the correct term based on context.
    - **Gibberish/Nonsense:** If a sentence makes absolutely no logical sense within the context (severe hallucination or audio glitch), **OMIT IT COMPLETELY**. Do not try to invent a meaning for it.
3.  **Structure:** Use logical hierarchy (headers, lists) rather than just chronological order.
4.  **Objectivity:** Write in a direct, professional voice. Do not use phrases like "The speaker says" or "The text mentions." State the facts directly.
5.  **Language:** Summarize in the same language as the content unless explicitly told otherwise.`;

const DEFAULT_USER_PROMPT = `Please summarize the following content. The result must be a structured, high-quality note that captures the essence of the content without the noise.

**FORMATTING RULES:**
- Use Markdown formatting.
- Use **Bold** for key terms or important emphasis.
- Use bullet points for lists.
- Use > Blockquotes for crucial one-line takeaways or conclusions.

**REQUIRED OUTPUT STRUCTURE:**
1.  **# Title**: A concise title based on the content.
2.  **## Executive Summary**: A 1-2 sentence high-level overview (TL;DR).
3.  **## Key Takeaways**: A bulleted list of the most important points.
4.  **## Detailed Summary**: Segmented by topic/theme (use ### subheaders).

**EXAMPLES:**

*Input (Verbose & Filler):*
"Um, so, essentially, if you look at the data, specifically the Q3 numbers, well, they're up by like 20%, which is strictly due to the new marketing campaign we launched, you know, back in July."
*Output:*
- **Q3 Growth**: Data shows a 20% increase attributed to the July marketing campaign.

*Input (Transcription Errors):*
"We need to optimize our **cloud compute in** costs. **The banana flies at midnight.** Also, ensure the **API keys** are rotated."
*Output:*
- **Cost Optimization**: Focus on optimizing cloud computing costs.
- **Security**: Ensure API keys are rotated.
*(Note: "compute in" was corrected to "computing", and the nonsensical banana sentence was ignored)*

**CONTENT TO SUMMARIZE:**
{{source}}

Please provide the organized result:`;

// ============================================================================
// Custom Mode Prompts
// ============================================================================

const CUSTOM_SYSTEM_PROMPT = `You are an expert editor and synthesizer of information.

- **Source Material:** Use only information that exists in the provided text.
- **No External Info:** Do not introduce outside facts not present in the context.
- **Brevity:** Prioritize concise phrasing over verbose sentences.
- **Formatting:** Adhere strictly to Markdown standards.`;

// ============================================================================
// Language Suffixes
// ============================================================================

function languageSystemSuffix(language: string): string {
	return `

**CRITICAL LANGUAGE REQUIREMENT:**
- You MUST respond ONLY in ${language}.
- Do NOT use any other language (except for preserving technical terms or proper nouns that are commonly used in their original language).
- This is a strict requirement.`;
}

function languageUserSuffix(language: string): string {
	return `\n\n**IMPORTANT: Respond ONLY in ${language}.**`;
}

// ============================================================================
// Internal Builders
// ============================================================================

function buildDefaultPrompts(sourceText: string): { system: string; user: string } {
	return {
		system: DEFAULT_SYSTEM_PROMPT,
		user: DEFAULT_USER_PROMPT.replace('{{source}}', sourceText),
	};
}

function buildCustomPrompts(sourceText: string, customPromptText: string): { system: string; user: string } {
	return {
		system: CUSTOM_SYSTEM_PROMPT,
		user: `${customPromptText}\n\n**CONTENT:**\n${sourceText}`,
	};
}

function appendAdditionalInstruction(userPrompt: string, instruction?: string): string {
	const cleaned = instruction?.trim();
	if (!cleaned) return userPrompt;
	return `${userPrompt}\n\n**ADDITIONAL INSTRUCTIONS:**\n- ${cleaned}`;
}

function appendLanguageRequirement(
	systemPrompt: string,
	userPrompt: string,
	outputLanguage?: string,
): { system: string; user: string } {
	const language = outputLanguage?.trim();
	if (!language) return { system: systemPrompt, user: userPrompt };
	return {
		system: `${systemPrompt}${languageSystemSuffix(language)}`,
		user: `${userPrompt}${languageUserSuffix(language)}`,
	};
}

// ============================================================================
// Public API
// ============================================================================

export function buildSummaryPrompt(
	sourceText: string,
	config: {
		customPrompt?: string;
		additionalInstruction?: string;
		outputLanguage?: string;
	},
): SummaryPrompt {
	const customPromptText = config.customPrompt?.trim();
	const isCustomMode = !!customPromptText;

	const base = customPromptText ? buildCustomPrompts(sourceText, customPromptText) : buildDefaultPrompts(sourceText);

	const userWithInstruction = isCustomMode
		? base.user
		: appendAdditionalInstruction(base.user, config.additionalInstruction);

	const final = appendLanguageRequirement(base.system, userWithInstruction, config.outputLanguage);

	return { system: final.system, user: final.user };
}
