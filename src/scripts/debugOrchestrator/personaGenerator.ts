import OpenAI from 'openai';
import type { Persona } from './types';

const PERSONA_SYSTEM_PROMPT = `You are generating realistic test personas for an AI-powered course creation platform. These personas will walk through the wizard (clarifying questions → depth choice → structure → optional chat refinement → accept), then through the learning experience (lessons → module quizzes → spaced-repetition insight reviews).

Your job is to create personas that behave like real humans interacting with this wizard. Not idealized students. Not AI-generated caricatures. Real people with real habits.

## What Real Users Actually Look Like

Study after study shows: most users of learning platforms fall into a handful of behavioral clusters. Your personas should be drawn from these REAL patterns, not invented archetypes:

**The Motivated Professional (most common, ~35% of users)**
Has a concrete reason to learn — job requirement, upcoming project, career transition. Types a specific goal that references their work context. Answers questions thoughtfully but quickly — they're busy. Usually picks the recommended depth because they trust the system and don't want to overthink it. Accepts the generated structure without feedback ~80% of the time because they came here to learn, not to design curricula.

**The Curious Browser (~25% of users)**
No deadline, no pressure. Saw something interesting and wants to explore. Goal is vague — sometimes just a topic name. Fills out surveys casually, picks whatever sounds fun without agonizing. Picks recommended or one level down. Usually accepts the structure — they're not invested enough to critique it. Might say "looks good" without reading it carefully.

**The Overambitious Beginner (~15% of users)**
Wants to learn everything. Writes a broad goal that's actually 3-4 courses worth of content. On multi-select questions, picks too many options. Claims more experience than they have. Picks deep_dive or comprehensive even if they're beginners. Might actually give structure feedback because the generated scope didn't match their (unrealistic) expectations.

**The Anxious Learner (~10% of users)**
Worried about wasting time on the wrong thing. Writes careful, specific goals. Reads every option thoroughly before answering. On multi-select, picks conservatively — doesn't want to overcommit. Picks the recommended depth or one below it. Might give feedback because they're worried something important was left out.

**The Skeptic / Returning User (~10% of users)**
Has tried other platforms or has existing knowledge. Writes goals that signal "I already know the basics, don't waste my time." Answers questions to demonstrate their existing knowledge. Might pick against the recommendation on purpose. Most likely persona to give structure feedback — they have opinions about how the topic should be taught.

**The Minimum-Effort User (~5% of users)**
Just wants to see what happens. Writes the shortest possible goal. Picks the first reasonable option on every question. Picks recommended depth without reading descriptions. Accepts structure without reading it. Will never give chat feedback.

## Generating Realistic Goals

The "goal" field is what the user LITERALLY TYPES into a text box. Study how real people type in forms:

- Most people write 5-20 words. Very few write more than 2 sentences.
- Capitalization is inconsistent. Some people capitalize properly, some don't bother.
- Grammar varies. Some write fragments ("python for data science"), some write full sentences.
- Specificity varies enormously: "coding" vs "I need to build a REST API in Go for our microservices migration at work"
- Some goals have implicit context: "learn SQL for the analytics role I'm interviewing for"
- Some are copy-pasted from job descriptions or course titles they saw elsewhere
- Almost nobody writes goals with perfect grammar AND perfect specificity AND perfect scope — there's always SOMETHING slightly off about how a real person would phrase it.

DO NOT: Write goals that sound like AI prompts. "I wish to acquire comprehensive knowledge of..." is not how humans type.

## Topic Diversity

Vary topics significantly. Don't default to programming. Real course platforms see:
- Technical: programming languages, frameworks, DevOps, data science, cybersecurity
- Creative: design, photography, music production, writing, illustration
- Professional: project management, leadership, negotiation, public speaking, finance
- Academic: math, physics, biology, statistics, linguistics
- Practical: cooking, gardening, fitness, home repair, personal finance
- Languages: Spanish, Japanese, sign language, technical writing

## Output Format

Return a JSON object with a "personas" array. Each persona has:

- **name**: First name + short descriptor. "Priya - Deadline-Driven PM" not "Priya - The Motivated Professional"
- **background**: 2-3 sentences. Their real situation. Include: what they actually do, why they want to learn this, any relevant constraints or contradictions. Write in third person.
- **goal**: What they literally type. In their voice. With their level of effort and specificity.
- **personality**: How they interact with forms and tools. Specific behavioral tendencies (reads carefully vs skims, trusts recommendations vs does own thing, gives detailed text answers vs one-word answers). NOT adjective lists.
- **priorities**: What they actually care about, stated honestly. It's OK to include contradictions ("wants depth but also wants it fast").
- **quizStyleFlags**: A top-level object with four booleans (not inside wizardBehavior). See the per-field descriptions below.
- **insightStyleFlags**: A top-level object with four booleans (not inside wizardBehavior). See the per-field descriptions below.
- **wizardBehavior**: An object with five fields predicting their SPECIFIC behavior across the wizard AND the post-lesson learning experience:
  - **surveyStyle**: How they'll answer the clarifying questions. E.g., "Reads all options carefully, picks conservatively on multi-select (1-2 choices). Text answers are 1-2 thoughtful sentences. Gets slightly more hasty on questions 4+."
  - **depthChoice**: What they'll pick and WHY. E.g., "Picks recommended without reading the other options. Just trusts the system." or "Picks deep_dive despite being a beginner because 'I want the real thing, not a watered-down version.'"
  - **structureReview**: What they'll do when shown the structure. E.g., "Accepts immediately without reading. Types 'looks good' in 2 seconds." or "Reads module names, notices there's no section on testing, asks to add it. Feedback is direct and specific."
  - **quizAttemptStyle**: How they'll approach a multiple-choice module quiz after finishing the lessons. Mention: whether they re-read questions, whether they eliminate wrong options, whether they second-guess, whether position bias dominates, whether they guess when unsure. E.g., "Reads each question twice, eliminates obviously-wrong options, picks the remaining best answer. Doesn't second-guess." / "Rushes; picks the first option that sounds right. Skims the question on every item after the third." / "Overthinks on the last question of every quiz and flips to a wrong-but-plausible option."
  - **quizStyleFlags**: Structured flags derived from quizAttemptStyle. Four booleans — set ONLY the ones that genuinely describe this persona (most personas will have 1-2 flags set, rarely 3). Precedence when multiple fire simultaneously: rushes > guessesWhenUnsure > secondGuesses > eliminates.
    - \`rushes\`: picks first plausible option, no re-reading. True for "Minimum-Effort" and most "Curious Browser" personas.
    - \`secondGuesses\`: overthinks; changes correct answers at the last moment. True for "Anxious Learner" personas; explicitly false when quizAttemptStyle says "doesn't second-guess".
    - \`eliminates\`: eliminates obviously-wrong distractors before picking. True for "Motivated Professional" and "Skeptic" personas.
    - \`guessesWhenUnsure\`: random pick on low-confidence items. True for "Overambitious Beginner" (fakes confidence) and some "Minimum-Effort" personas.
  - **insightReviewStyle**: How they'll review retrieval-practice cards (Q&A / cloze) afterwards. Cards show in two modes — 'tap-reveal' (see prompt, reveal answer, self-rate Again/Hard/Good/Easy) and 'typed-recall' (type the answer, get graded 0..1, then rate). Mention: which mode they prefer, whether they type carefully or guess briefly, whether they self-rate honestly/generously/harshly, whether they skip hard cards. E.g., "Prefers typed-recall; types partial but honest attempts; rates generously when close. Never skips." / "Sticks with tap-reveal; self-rates Easy even when hazy; skips the first card that feels hard." / "Types carefully in typed-recall mode; rates honestly; occasionally skips when tired."
  - **insightStyleFlags**: Structured flags derived from insightReviewStyle. Four booleans — \`struggles\` and \`articulate\` are mutually exclusive (set exactly one); \`generous\` and \`harsh\` are mutually exclusive (set at most one).
    - \`struggles\`: types short, imperfect answers with gaps — a "partial" grader score is common.
    - \`articulate\`: types near-canonical quality; typically the baseline.
    - \`generous\`: self-rates tap-reveal high (Good/Easy) even when hazy.
    - \`harsh\`: self-rates tap-reveal low (Again/Hard) even when mostly correct.

## Crucial Constraints

1. DO NOT make all personas quirky or unusual. Most people are pretty normal. 2-3 personas should be straightforward motivated learners. The diversity comes from their topics, experience levels, and minor behavioral differences — not from everyone being a "character."

2. Every persona must produce a VALID goal (1-500 characters, non-empty). The goal must be about learning something — not a question, not a command, not nonsense.

3. The wizardBehavior predictions must be SPECIFIC and ACTIONABLE — not vague. "answers quickly" is vague. "Picks the first option that seems reasonable on multiple_choice, selects 3-4 options on multi_select because she wants breadth, text answers are 3-6 words" is actionable.

4. When generating 5 personas: ensure at least 2 are "normal" motivated learners, at least 1 has a vague/short goal, at least 1 has a very specific goal, and at least 1 will give structure feedback. Topics must all be different.`;

export async function generatePersonas(count: number = 5): Promise<Persona[]> {
  const client = new OpenAI();

  console.log(`${'[PersonaGen]'.magenta} Generating ${count} personas via GPT-4o...`);

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: PERSONA_SYSTEM_PROMPT },
      { role: 'user', content: `Generate exactly ${count} personas.` },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.9,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) throw new Error('Empty response from persona generation');

  const parsed = JSON.parse(content) as { personas: Persona[] };
  if (!Array.isArray(parsed.personas) || parsed.personas.length !== count) {
    throw new Error(`Expected ${count} personas, got ${parsed.personas?.length ?? 0}`);
  }

  // Validate wizardBehavior + style flags exist on all personas.
  // Flags may arrive malformed from the LLM (missing booleans, true/false
  // encoded as strings, etc.). Normalize once at ingestion so the rest of
  // the orchestrator can trust the shape.
  for (const p of parsed.personas) {
    const wb = p.wizardBehavior;
    if (
      !wb ||
      !wb.surveyStyle ||
      !wb.depthChoice ||
      !wb.structureReview ||
      !wb.quizAttemptStyle ||
      !wb.insightReviewStyle
    ) {
      throw new Error(`Persona "${p.name}" is missing wizardBehavior fields`);
    }
    p.quizStyleFlags = normalizeQuizFlags(p.quizStyleFlags);
    p.insightStyleFlags = normalizeInsightFlags(p.insightStyleFlags);
    console.log(`${'[PersonaGen]'.magenta}   → ${p.name} [quiz: ${describeQuizFlags(p.quizStyleFlags)}, insight: ${describeInsightFlags(p.insightStyleFlags)}]`);
  }

  return parsed.personas;
}

// ── Flag normalization ─────────────────────────────────────
// The LLM may omit flag fields or mis-type them. Coerce to strict booleans
// and enforce the mutual-exclusion contract documented in the prompt:
//   - struggles XOR articulate (at least one must be true; default to
//     articulate if both unset or both set)
//   - generous / harsh are mutually exclusive (if both true, prefer harsh
//     since it's the rarer calibration and deserves emphasis when signaled)

const toBool = (v: unknown): boolean => v === true || v === 'true';

const normalizeQuizFlags = (raw: unknown): Persona['quizStyleFlags'] => {
  const r = (raw ?? {}) as Partial<Record<keyof Persona['quizStyleFlags'], unknown>>;
  return {
    rushes: toBool(r.rushes),
    secondGuesses: toBool(r.secondGuesses),
    eliminates: toBool(r.eliminates),
    guessesWhenUnsure: toBool(r.guessesWhenUnsure),
  };
};

const normalizeInsightFlags = (raw: unknown): Persona['insightStyleFlags'] => {
  const r = (raw ?? {}) as Partial<Record<keyof Persona['insightStyleFlags'], unknown>>;
  let struggles = toBool(r.struggles);
  let articulate = toBool(r.articulate);
  if (struggles && articulate) {
    // Contradiction — prefer struggles since it's the rarer, more consequential flag.
    articulate = false;
  } else if (!struggles && !articulate) {
    // Neither set — default to articulate (the baseline) so downstream doesn't
    // hit an undefined-style-code path.
    articulate = true;
  }
  let generous = toBool(r.generous);
  let harsh = toBool(r.harsh);
  if (generous && harsh) {
    // Prefer harsh — see contract comment above.
    generous = false;
  }
  return { struggles, articulate, generous, harsh };
};

const describeQuizFlags = (f: Persona['quizStyleFlags']): string => {
  const set = (['rushes', 'secondGuesses', 'eliminates', 'guessesWhenUnsure'] as const).filter((k) => f[k]);
  return set.length ? set.join('+') : 'none';
};

const describeInsightFlags = (f: Persona['insightStyleFlags']): string => {
  const set = (['struggles', 'articulate', 'generous', 'harsh'] as const).filter((k) => f[k]);
  return set.length ? set.join('+') : 'none';
};
