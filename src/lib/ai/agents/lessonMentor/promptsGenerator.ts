import { HumanMessage } from '@langchain/core/messages';
import { getUtilityModel } from '@lib/langchain';

/**
 * One-shot Haiku call that produces 3 lesson-specific opening prompts
 * for the mentor panel's empty state. Run once per lesson during the
 * generation job and cached on `LessonContent.suggestedMentorPrompts`.
 *
 * Why a separate helper rather than a node in `lessonGenerationAgent`:
 *   - It's not on the lesson-content critical path. If this fails, the
 *     lesson still ships (the chat history endpoint falls back to the
 *     hard-coded generic prompts).
 *   - The lesson-generation agent's state graph is tightly scoped to
 *     producing blocks; bolting an unrelated mentor concern onto it
 *     muddies the responsibility boundary.
 *
 * Returns null on:
 *   - LLM call failure (network, timeout)
 *   - malformed JSON / wrong shape
 *   - empty array
 *
 * Caller MUST treat null as "fall back to generic prompts" — never as
 * a hard failure.
 */

const SYSTEM_INSTRUCTIONS = `You generate 3 brief opening questions a learner can pick to start chatting with the AI mentor for this lesson. The learner has just opened the mentor panel.

Requirements:
- Each question must be specific to THIS lesson's content. Generic questions like "Quiz me" or "Explain this differently" are forbidden.
- 6-12 words each. No more.
- Phrased from the learner's perspective: "Why does X...", "What if I...", "How would I...", "When would Y break down?".
- Spur curiosity or surface a likely confusion. Not mere trivia recall.
- Plain language. Use only terms the lesson itself introduces.
- No leading articles like "Can you..." — get straight to the substance.

Return ONLY valid JSON in this exact shape, with no markdown fences or commentary:
{ "prompts": ["question 1", "question 2", "question 3"] }`;

const MAX_LESSON_CONTENT_CHARS = 8_000;
const MAX_PROMPT_CHARS = 200;

interface PromptGenerationInput {
  courseGoal: string;
  moduleTitle: string;
  lessonTitle: string;
  lessonSummary: string;
  lessonContent: string;
}

const tryParsePrompts = (raw: string): string[] | null => {
  // Strip any accidental markdown fence the model might have added
  // (despite explicit instructions). Match a leading ```json ... ```
  // block; otherwise parse as-is.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const promptsField = (parsed as { prompts?: unknown }).prompts;
  if (!Array.isArray(promptsField)) return null;

  // Hard-trim to 3, drop non-strings + empty strings, enforce length cap.
  const prompts = promptsField
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p.length <= MAX_PROMPT_CHARS)
    .slice(0, 3);

  return prompts.length > 0 ? prompts : null;
};

export const generateMentorPrompts = async ({
  courseGoal,
  moduleTitle,
  lessonTitle,
  lessonSummary,
  lessonContent,
}: PromptGenerationInput): Promise<string[] | null> => {
  // Cap content length: the lesson can be tens of thousands of chars,
  // and the prompt-gen task doesn't need the whole thing. The intro +
  // first few sections give plenty of signal at a fraction of the tokens.
  const truncatedContent =
    lessonContent.length > MAX_LESSON_CONTENT_CHARS
      ? lessonContent.slice(0, MAX_LESSON_CONTENT_CHARS)
      : lessonContent;

  const userPrompt = `${SYSTEM_INSTRUCTIONS}

## Course goal
${courseGoal || '(none provided)'}

## Module
${moduleTitle || '(unnamed)'}

## Lesson
${lessonTitle || '(unnamed)'}

## Lesson summary
${lessonSummary || '(no summary)'}

## Lesson content
${truncatedContent || '(no content)'}`;

  try {
    const model = getUtilityModel();
    const result = await model.invoke([new HumanMessage(userPrompt)], {
      metadata: { llmLabel: 'mentor:generate-prompts' },
    });

    const content =
      typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
    const prompts = tryParsePrompts(content);
    if (!prompts) {
      console.warn(`[mentor:promptsGen] malformed response, returning null. Raw: ${content.slice(0, 200)}`.yellow);
      return null;
    }

    console.log(
      `[mentor:promptsGen] ✓ generated ${prompts.length} prompts for "${lessonTitle}"`.green,
    );
    return prompts;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[mentor:promptsGen] failed: ${message}`.yellow);
    return null;
  }
};
