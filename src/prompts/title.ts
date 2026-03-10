export interface TitlePrompt {
	system: string;
	user: string;
}

const TITLE_SYSTEM_PROMPT = `You are an expert at creating concise, descriptive titles for lecture notes and transcripts.

**CORE RESPONSIBILITIES:**
1. **Conciseness:** Create a title that is 3-8 words long, maximum 50 characters.
2. **Clarity:** The title should clearly indicate the main topic or subject matter.
3. **Relevance:** Base the title solely on the content provided. Do not add information that isn't present.
4. **Language:** Generate the title in the same language as the transcript content.
5. **Format:** Return ONLY the title text, without quotes, prefixes, or explanations.
6. **No Markdown:** Do not use markdown formatting (no #, **, etc.). Plain text only.

**EXAMPLES:**

*Input:*
"Today we're going to discuss the fundamentals of machine learning, including supervised and unsupervised learning algorithms, neural networks, and their applications in computer vision."

*Output:*
Machine Learning Fundamentals

*Input:*
"이번 시간에는 한국사의 삼국시대에 대해 배워보겠습니다. 고구려, 백제, 신라의 형성과 발전 과정을 중심으로 설명하겠습니다."

*Output:*
삼국시대의 형성과 발전

*Input:*
"Let's review the key concepts from Chapter 5: Photosynthesis, including the light-dependent and light-independent reactions, and how plants convert carbon dioxide into glucose."

*Output:*
Photosynthesis: Light Reactions`;

const TITLE_USER_PROMPT_TEMPLATE = `Based on the following transcript content, generate a concise and descriptive title for this lecture note.

**REQUIREMENTS:**
- 3-8 words maximum
- Maximum 50 characters
- Plain text only (no markdown, no quotes)
- Same language as the transcript
- Return ONLY the title, nothing else

**TRANSCRIPT CONTENT:**
{{source}}

**TITLE:**`;

export function buildTitlePrompt(sourceText: string): TitlePrompt {
	return {
		system: TITLE_SYSTEM_PROMPT,
		user: TITLE_USER_PROMPT_TEMPLATE.replace('{{source}}', sourceText),
	};
}

export const TITLE_MAX_LENGTH = 50;
