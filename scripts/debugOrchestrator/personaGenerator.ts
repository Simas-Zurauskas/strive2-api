import { ChatAnthropic } from '@langchain/anthropic';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { withRetry } from '@lib/retry';
import { makeLlmCacheCallback } from '@lib/ai/cacheLogger';
import { ANTHROPIC_API_KEY } from '@conf/env';
import { GOAL_TYPES, SOURCE_FIDELITIES } from '@lib/constants';
import type { GoalType } from '@lib/constants';
import { summarizeSetForPersona, type LoadedDocumentSet } from './documentSets';
import type { Persona } from './types';

const PERSONA_SYSTEM_PROMPT = `You are generating realistic test personas for an AI-powered course creation platform. These personas will walk through the wizard (clarifying questions → depth choice → structure → optional chat refinement → accept), then through the learning experience (lessons → module quizzes → spaced-repetition recall reviews).

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
- **recallStyleFlags**: A top-level object with four booleans (not inside wizardBehavior). See the per-field descriptions below.
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
  - **recallReviewStyle**: How they'll review retrieval-practice cards (Q&A / cloze) afterwards. Cards show in two modes — 'tap-reveal' (see prompt, reveal answer, self-rate Again/Hard/Good/Easy) and 'typed-recall' (type the answer, get graded 0..1, then rate). Mention: which mode they prefer, whether they type carefully or guess briefly, whether they self-rate honestly/generously/harshly, whether they skip hard cards. E.g., "Prefers typed-recall; types partial but honest attempts; rates generously when close. Never skips." / "Sticks with tap-reveal; self-rates Easy even when hazy; skips the first card that feels hard." / "Types carefully in typed-recall mode; rates honestly; occasionally skips when tired."
  - **recallStyleFlags**: Structured flags derived from recallReviewStyle. Four booleans — \`struggles\` and \`articulate\` are mutually exclusive (set exactly one); \`generous\` and \`harsh\` are mutually exclusive (set at most one).
    - \`struggles\`: types short, imperfect answers with gaps — a "partial" grader score is common.
    - \`articulate\`: types near-canonical quality; typically the baseline.
    - \`generous\`: self-rates tap-reveal high (Good/Easy) even when hazy.
    - \`harsh\`: self-rates tap-reveal low (Again/Hard) even when mostly correct.

## Goal Type axis (orthogonal to topic / domain)

The course-creation pipeline classifies each goal into one of FIVE goalType buckets and uses that to tilt clarify questions and structure decisions. Your personas must span these buckets — and you must annotate each persona with the correct bucket as ground truth.

- **master** — "deeply learn / become an expert in / understand X". Default when the persona names a SUBJECT but no project, channel, deliverable, or exam.
- **monetize** — "become a YouTuber / run ads / freelance / sell / launch a side hustle / grow my audience". The deliverable is revenue, channel, audience, or clients.
- **pass** — exam, certification, school grade, professional license, driving manual. Usually mentions a NAMED test (CPA, JEE, NEET, BITSAT, AWS-SAA, GMAT, MCAT) or a deadline ("by October", "before finals").
- **build** — "build / ship / launch / create" a SPECIFIC NAMED PROJECT. The deliverable is the project (chat app, SaaS, portfolio site, game, Chrome extension), not the topic.
- **fluency** — natural-language acquisition (Spanish, Japanese, Mandarin, German, ASL, etc.). NOT communication skills in the learner's own language.

When a goal could plausibly fit two types, pick the one whose deliverable IS the goal (primary-activity test):
- "Learn React deeply to ship a SaaS" → build (the SaaS is the deliverable).
- "Become a YouTuber making React tutorials" → monetize (the channel is the goal).
- "Master React" → master.
- "Learn Spanish before my Madrid trip" → fluency (NOT pass — no exam).

Set the persona's:
- **predictedGoalType** — the correct bucket for the goal you generated.
- **predictedGoalTypeReasoning** — one sentence naming the cue ("mentions BITSAT 2025 → pass", "wants to build a chat app → build", "no project, no channel, just deeply learn ML → master").
- **goalTypeOverrideTarget** — set to a *different* goalType ONLY if this persona would realistically change their mind via the chip on the ClarifyStep (Skeptic / Anxious Learner archetypes). Most personas: null. Examples: "skeptic who first typed a vague master goal but really wants to build something" → master predicted, build override; "anxious learner whose pass goal becomes master because they don't have a fixed exam date" → pass predicted, master override.

## Crucial Constraints

1. DO NOT make all personas quirky or unusual. Most people are pretty normal. 2-3 personas should be straightforward motivated learners. The diversity comes from their topics, experience levels, and minor behavioral differences — not from everyone being a "character."

2. Every persona must produce a VALID goal (1-500 characters, non-empty). The goal must be about learning something — not a question, not a command, not nonsense.

3. The wizardBehavior predictions must be SPECIFIC and ACTIONABLE — not vague. "answers quickly" is vague. "Picks the first option that seems reasonable on multiple_choice, selects 3-4 options on multi_select because she wants breadth, text answers are 3-6 words" is actionable.

4. When generating 5 personas: ensure at least 2 are "normal" motivated learners, at least 1 has a vague/short goal, at least 1 has a very specific goal, and at least 1 will give structure feedback. Topics must all be different.

5. **goalType coverage** — when generating ≥5 personas, ensure each predictedGoalType (master, monetize, pass, build, fluency) is represented at least once across the cohort. For smaller cohorts (1-4) coverage is unenforced — diversity over completeness. At least one persona total should have a non-null goalTypeOverrideTarget so the override path gets exercised when the orchestrator opts into it.`;

const basePersonaShape = {
  name: z.string(),
  background: z.string(),
  goal: z.string(),
  personality: z.string(),
  priorities: z.string(),
  wizardBehavior: z.object({
    surveyStyle: z.string(),
    depthChoice: z.string(),
    structureReview: z.string(),
    quizAttemptStyle: z.string(),
    recallReviewStyle: z.string(),
  }),
  quizStyleFlags: z.object({
    rushes: z.boolean(),
    secondGuesses: z.boolean(),
    eliminates: z.boolean(),
    guessesWhenUnsure: z.boolean(),
  }),
  recallStyleFlags: z.object({
    struggles: z.boolean(),
    articulate: z.boolean(),
    generous: z.boolean(),
    harsh: z.boolean(),
  }),
  predictedGoalType: z.enum(GOAL_TYPES),
  predictedGoalTypeReasoning: z.string(),
  goalTypeOverrideTarget: z.enum(GOAL_TYPES).nullable(),
} as const;

const personaOutputSchema = z.object({
  personas: z.array(z.object(basePersonaShape)),
});

// Docs-mode variant: same persona shape + a REQUIRED documentsProfile.
// A separate schema (rather than an optional field on the base) keeps
// goal-mode structured-output byte-identical to pre-feature behavior and
// makes a docs-run persona missing its profile a schema violation that
// withRetry can react to, not a silent null.
const documentsPersonaOutputSchema = z.object({
  personas: z.array(
    z.object({
      ...basePersonaShape,
      documentsProfile: z.object({
        ownershipStory: z.string(),
        predictedFidelity: z.enum(SOURCE_FIDELITIES),
        predictedFidelityReasoning: z.string(),
        suggestedGoalStance: z.enum(['accept', 'edit']),
        suggestedGoalStanceReasoning: z.string(),
      }),
    }),
  ),
});

const DOCUMENTS_MODE_ADDENDUM = `
## DOCUMENTS MODE (active for this cohort)

These personas are NOT typing a goal into a text box. Each persona OWNS a set of real documents (listed per-persona in the user message: filenames, a one-line description, short content previews) and uses the platform's "build a course from your documents" flow: they upload the files, the platform analyzes them and suggests a course goal, and the persona confirms or edits that goal plus picks a source-fidelity level.

Additional rules:

1. **Ownership plausibility.** Each persona must be someone who would REALISTICALLY possess exactly these documents (a student with lecture notes, a hobbyist with saved articles, an employee with internal handbooks…). Their background must explain how the documents came to be on their disk. Do not invent documents that aren't in the listing.
2. **goal still matters.** The "goal" field is what the persona HOPES to get out of these documents (their private intent — it drives the goal-type axis exactly as in goal mode). It is not typed into the product in this mode, but the persona will compare the platform's suggested goal against it.
3. **documentsProfile (REQUIRED per persona)**:
   - **ownershipStory**: 1-2 sentences — why this persona owns this document set. Must reference the actual files.
   - **predictedFidelity**: which fidelity they'd pick on the analysis screen. "strict" = stick to my materials only (revision/compliance types); "guided" = follow my materials but fill small gaps (the default most people keep); "enrich" = use my materials as a seed and add context (curious/expansive types).
   - **predictedFidelityReasoning**: one sentence tying the pick to the persona.
   - **suggestedGoalStance**: "accept" (trusts the suggestion, most users) or "edit" (rewrites it to match their real intent — skeptics, people with a sharp deadline or a different angle than the documents' framing).
   - **suggestedGoalStanceReasoning**: one sentence — if "edit", say HOW they'd change it (narrower? exam-focused? project-focused?).
4. **Keep goalTypeOverrideTarget null** for docs-mode personas unless the persona is a genuinely torn archetype — the docs flow already adds steps and the override doubles the clarify cost.
5. All other rules (behavior specificity, realism, topic honesty) still apply — but the persona's topic is DICTATED by their document set. Do not give a persona goals unrelated to their documents.`;

// Temp 0.9 for creative persona diversity — PERSONA_SYSTEM_PROMPT is
// calibrated to high-variance output.
//
// Pinned to sonnet-4-6, NOT MODEL_IDS.SONNET: the app moved to
// claude-sonnet-5 (2026-08), which rejects `temperature` — but persona
// variance is the point of this dev-only call, so it stays on the last
// temperature-capable Sonnet. Revisit if/when 4.6 retires.
const ORCHESTRATOR_MODEL = 'claude-sonnet-4-6';
let _model: ChatAnthropic | null = null;
function getModel(): ChatAnthropic {
  if (!_model) {
    _model = new ChatAnthropic({
      model: ORCHESTRATOR_MODEL,
      temperature: 0.9,
      anthropicApiKey: ANTHROPIC_API_KEY,
      maxTokens: 8192,
      clientOptions: { timeout: 120000 },
      callbacks: [makeLlmCacheCallback({ defaultLabel: 'orchestrator:persona-gen', model: ORCHESTRATOR_MODEL })],
    });
  }
  return _model;
}

export async function generatePersonas(
  count: number = 5,
  distribution: Partial<Record<GoalType, number>> | null = null,
  personaSets: LoadedDocumentSet[] | null = null,
): Promise<Persona[]> {
  const documentsMode = personaSets !== null && personaSets.length > 0;
  console.log(
    `${'[PersonaGen]'.magenta} Generating ${count} personas via Sonnet...${documentsMode ? ' (documents mode)' : ''}`,
  );

  // Cohort-bias constraint — when an operator pins the distribution via
  // --goal-type or --goal-type-distribution, hard-constrain the generator
  // to that shape so a stress-test of a single bucket actually exercises
  // that bucket. This OVERRIDES the default "≥5 → cover all buckets"
  // soft-coverage rule documented in the system prompt.
  let humanMessage = `Generate exactly ${count} personas.`;

  // Documents mode: hand the generator each persona's set summary
  // (filenames + manifest note + ~400-char previews) so the persona
  // plausibly owns exactly that corpus. Index-aligned: persona #i must
  // own set #i.
  if (documentsMode) {
    const setBlocks = personaSets!
      .map((set, i) => `### Persona #${i + 1} owns this document set:\n${summarizeSetForPersona(set)}`)
      .join('\n\n');
    humanMessage += `\n\nDOCUMENTS MODE — per-persona document sets (persona #i MUST plausibly own set #i and their goal MUST be about this material):\n\n${setBlocks}`;
  }
  if (distribution) {
    const lines = (Object.entries(distribution) as [GoalType, number][])
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `- ${t}: ${n}`)
      .join('\n');
    humanMessage += `\n\nDISTRIBUTION CONSTRAINT (overrides the default cohort-coverage rule):\nThe ${count} personas you emit MUST split across goalType buckets EXACTLY as follows. Bucket counts are non-negotiable — if you cannot find a realistic goal that fits a bucket, lean harder on the bucket\'s defining cue (a named exam for "pass", a named project for "build", etc.) rather than re-balancing the counts.\n${lines}`;
    console.log(
      `${'[PersonaGen]'.magenta} Cohort bias active: ${(Object.entries(distribution) as [GoalType, number][])
        .map(([t, n]) => `${t}=${n}`)
        .join(', ')}`,
    );
  }

  // withStructuredOutput enforces the schema via Anthropic tool-use, so a
  // shape miss throws and `withRetry` re-invokes (3 retries, exponential
  // backoff). Without the retry, a single flaky structured-output call
  // tanks the whole orchestrator run. Docs mode swaps in the schema whose
  // personas carry a REQUIRED documentsProfile.
  const systemPrompt = documentsMode ? PERSONA_SYSTEM_PROMPT + DOCUMENTS_MODE_ADDENDUM : PERSONA_SYSTEM_PROMPT;
  const parsed = await withRetry(() =>
    getModel()
      .withStructuredOutput(documentsMode ? documentsPersonaOutputSchema : personaOutputSchema)
      .invoke(
        [
          new SystemMessage(systemPrompt),
          new HumanMessage(humanMessage),
        ],
        { metadata: { llmLabel: 'orchestrator:persona-gen' } },
      ),
  );

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
      !wb.recallReviewStyle
    ) {
      throw new Error(`Persona "${p.name}" is missing wizardBehavior fields`);
    }
    p.quizStyleFlags = normalizeQuizFlags(p.quizStyleFlags);
    p.recallStyleFlags = normalizeRecallFlags(p.recallStyleFlags);
    if (!p.predictedGoalTypeReasoning || p.predictedGoalTypeReasoning.trim().length === 0) {
      // Reasoning is the assessor's only ground-truth anchor for scoring
      // classification accuracy — refuse silently-empty entries here so a
      // missing rationale surfaces immediately, not in the assessment write-up.
      throw new Error(`Persona "${p.name}" is missing predictedGoalTypeReasoning`);
    }
    // Override target may not equal the predicted goalType — that's a no-op,
    // not an override. Coerce same-as-predicted to null and warn.
    if (p.goalTypeOverrideTarget && p.goalTypeOverrideTarget === p.predictedGoalType) {
      console.warn(
        `${'[PersonaGen]'.magenta} ${p.name}: goalTypeOverrideTarget == predictedGoalType (${p.predictedGoalType}); coercing to null.`,
      );
      p.goalTypeOverrideTarget = null;
    }
    // Docs mode: the schema already requires documentsProfile, but guard
    // the free-text fields the same way predictedGoalTypeReasoning is
    // guarded — an empty ownership story leaves the D4 decision step and
    // the assessor with nothing to anchor on.
    const documentsProfile = (p as Persona).documentsProfile ?? null;
    if (documentsMode) {
      if (!documentsProfile || !documentsProfile.ownershipStory.trim() || !documentsProfile.predictedFidelityReasoning.trim()) {
        throw new Error(`Persona "${p.name}" is missing documentsProfile fields (documents mode)`);
      }
    }
    const overrideStr = p.goalTypeOverrideTarget ? ` → override:${p.goalTypeOverrideTarget}` : '';
    const docsStr = documentsProfile
      ? `, fidelity: ${documentsProfile.predictedFidelity}, goal-stance: ${documentsProfile.suggestedGoalStance}`
      : '';
    console.log(
      `${'[PersonaGen]'.magenta}   → ${p.name} [quiz: ${describeQuizFlags(p.quizStyleFlags)}, recall: ${describeRecallFlags(p.recallStyleFlags)}, goalType: ${p.predictedGoalType}${overrideStr}${docsStr}]`,
    );
  }

  // Coverage diagnostic — calls out missing buckets so an operator running
  // ≥5 personas can see at a glance whether the cohort actually spans the
  // goalType axis. Soft warning only; not a hard failure (the LLM's
  // distribution can still be informative even when imperfect).
  // Suppressed when an explicit distribution is pinned: missing buckets
  // are intentional and warning about them would be noise.
  if (count >= 5 && !distribution) {
    const observed = new Set(parsed.personas.map((p) => p.predictedGoalType as GoalType));
    const missing = GOAL_TYPES.filter((t) => !observed.has(t));
    if (missing.length > 0) {
      console.warn(
        `[PersonaGen] Cohort coverage gap — missing goalType(s): ${missing.join(', ')}. Re-run if balanced coverage matters for this evaluation.`.yellow,
      );
    }
  }

  // Distribution-pin diagnostic — warn when the LLM strayed from the
  // pinned counts. The constraint is described as non-negotiable in the
  // user message but the LLM can still slip; surface a yellow warning
  // so the operator notices before reading the per-persona output.
  if (distribution) {
    const observedCounts = new Map<GoalType, number>();
    for (const p of parsed.personas) {
      observedCounts.set(p.predictedGoalType, (observedCounts.get(p.predictedGoalType) ?? 0) + 1);
    }
    for (const [bucket, expected] of Object.entries(distribution) as [GoalType, number][]) {
      const actual = observedCounts.get(bucket) ?? 0;
      if (actual !== expected) {
        console.warn(
          `[PersonaGen] Distribution miss — ${bucket}: expected ${expected}, got ${actual}.`.yellow,
        );
      }
    }
  }

  return parsed.personas as Persona[];
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

const normalizeRecallFlags = (raw: unknown): Persona['recallStyleFlags'] => {
  const r = (raw ?? {}) as Partial<Record<keyof Persona['recallStyleFlags'], unknown>>;
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

const describeRecallFlags = (f: Persona['recallStyleFlags']): string => {
  const set = (['struggles', 'articulate', 'generous', 'harsh'] as const).filter((k) => f[k]);
  return set.length ? set.join('+') : 'none';
};
