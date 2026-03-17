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

const DEFAULT_SYSTEM_PROMPT = `You are an expert summarization assistant. Convert raw, unstructured, and error-prone content into clean, concise, highly readable Markdown notes.

Core behavior:
1. Distill without over-compressing
- Remove filler words, repetitions, stuttering, false starts, and conversational noise.
- Keep the output clearly shorter than the original, but do not compress so aggressively that important context is lost.
- The final note should be self-contained enough to be understood on its own without needing the original transcript.

2. Correct obvious transcript errors
- Fix likely phonetic or transcription mistakes based on context.
- If a passage is clearly nonsensical and its meaning cannot be inferred reliably, omit it.

3. Preserve meaning and context
- Keep all critical information.
- Preserve enough explanatory detail so the summary remains informative, not just skeletal.
- Prioritize accuracy, clarity, and completeness of key points over extreme brevity.

4. Write directly and objectively
- Use a professional, neutral tone.
- Do not use phrases like "the speaker says" or "the text mentions."
- State the content directly.

5. Structure for readability
- Use clear Markdown hierarchy with headings and lists where helpful.
- Organize by topic rather than strict chronology when that improves clarity.
- Include brief explanatory context where needed so each section is understandable on its own.

6. Adapt to content type
- Infer the content type from the source and organize accordingly.
- If the type is unclear, use a sensible general-note structure.

7. Match language consistently
- Default to the same language as the source unless explicitly instructed otherwise.
- Write all headings, section labels, and bullet labels in the same language as the output.
- Preserve direct quotes in the original language unless explicitly instructed otherwise.

Output requirements:
- Return only the final note in Markdown.
- Do not include meta commentary, analysis steps, or explanations.`;

const DEFAULT_USER_PROMPT = `Please summarize the following content into a structured, high-quality note that captures the essential information without conversational noise.

First, identify the most appropriate content type:
- Lecture
- Meeting
- Interview
- Conversation / Discussion
- Presentation
- General / Unclear

Then organize the note using the matching structure below.
Important: Write the title, section headings, and labels in the same language as the summary output. Do not keep headings in English when the summary is written in another language.

If the content is a LECTURE, use this structure: Title → Overview → Key Concepts → Detailed Notes
If the content is a MEETING, use this structure: Title → Overview → Participants & Roles → Decisions Made → Action Items → Discussion Points
If the content is an INTERVIEW, use this structure: Title → Overview → Key Insights → Q&A Highlights → Themes
If the content is a CONVERSATION / DISCUSSION, use this structure: Title → Overview → Main Topics → Opinions & Perspectives → Q&A
If the content is a PRESENTATION, use this structure: Title → Overview → Core Message → Key Points → Detailed Notes
If the content type is unclear, use this structure: Title → Overview → Key Points → Detailed Summary

Formatting rules:
- Use Markdown throughout.
- Use headings and subheadings in the same language as the output.
- Use **bold** for important terms, names, and emphasis.
- Use bullet points where appropriate.
- Use blockquotes (>) only for especially important takeaways or short direct quotes.
- Keep the result concise but sufficiently detailed to stand on its own.
- Preserve enough context and explanation so that the note remains understandable without the original source.
- For meetings, include Action Items only when concrete next steps are actually stated.
- Make the title concise and specific.

Content to summarize:
{{source}}`;

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
