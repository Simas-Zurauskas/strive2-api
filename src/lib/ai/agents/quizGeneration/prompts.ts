import { z } from 'zod';
import { jsonish } from '@lib/zodHelpers';
import { CourseDomain } from '@lib/constants';

// ── Schemas ────────────────────────────────────────────

export const quizQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  // Inner fields keep `jsonish` — they're nested inside each question
  // object, not at the tool-input root, so the anyOf wrapper does not
  // interact with the root-level tool-calling failure mode documented in
  // `quizOutputSchema` below. Anthropic occasionally stringifies nested
  // arrays; `jsonish` recovers those.
  options: jsonish(z.array(z.string()).length(4)),
  correctIndex: z.number().min(0).max(3),
  explanation: z.string(),
  sourceLessons: jsonish(z.array(z.number())),
  isInterleaved: z.boolean(),
  interleavedModuleIndex: z.number().optional(),
});

/**
 * Tool-input root schema for `withStructuredOutput`. Intentionally uses
 * a plain `z.array(...)` — NOT `jsonish(...)` — at the top level.
 *
 * Why: `jsonish` wraps its argument in a `z.union([schema, stringToSchema])`
 * which converts to `anyOf` in the JSON Schema Anthropic receives as the
 * tool's `input_schema`. Observed failure mode (2026-04-20 orchestrator
 * run, Lena / DNA course, Module 0 quiz):
 *
 *   [quizGeneration] ✗ Failed: Failed to parse. Text: "{}".
 *   Error: [...]invalid_type...path:["questions"]...
 *
 * — the LLM called the tool with an empty-object input. This is a rare
 * but real Anthropic tool-calling fault mode that correlates with `anyOf`
 * at the root of the tool's input schema (the model collapses to empty
 * rather than committing to a branch). Nested `anyOf` on individual fields
 * (e.g. `options` inside each question) does NOT exhibit this — the fault
 * is specific to the root.
 *
 * Tool input arrives via `tool_use.input` which is always a structured
 * JSON object by API contract — it is never a JSON string at this level,
 * so `jsonish`'s string-recovery branch can never fire usefully here.
 * Removing `jsonish` at the root is therefore both safe (no lost
 * recovery path) and beneficial (eliminates the anyOf that triggers the
 * empty-tool-call fault).
 *
 * The `.min(5).max(8)` constraint is preserved by moving to plain array.
 *
 * See `api/src/lib/ai/agents/quizGeneration/schemaDiagnostic.test.ts` for
 * the regression test that asserts this shape.
 */
export const quizOutputSchema = z.object({
  questions: z.array(quizQuestionSchema).min(5).max(8),
});

// ── Per-domain guidance ────────────────────────────────
// Two typed maps drive the domain section below. `LABELS` controls the
// visible bullet-label (parenthetical examples are here), `BRANCHES` holds
// the guidance body. Both are typed `Record<CourseDomain, string>`, so
// adding a new value to COURSE_DOMAINS causes a compile-time error in BOTH
// maps — no silent drift. The section text is auto-assembled by iterating
// COURSE_DOMAINS, so new domains also appear in the rendered prompt
// automatically.
//
// Null-domain courses (unclassified) fall through to the explicit null branch
// rendered after the enum-driven bullets.

const MODULE_QUIZ_DOMAIN_LABELS: Record<CourseDomain, string> = {
  programming: '**programming**',
  stem: '**stem** (mathematics, physics, chemistry, statistics, engineering, economics)',
  humanities: '**humanities**',
  language: '**language**',
  creative: '**creative**',
  business: '**business** (management, marketing, product, sales, strategy, PM, personal finance)',
  practical: '**practical** (trades, crafts, cooking, gardening, home repair, applied fitness)',
  'practical-ai': '**practical-ai** (prompt engineering, no-code AI workflows, n8n/Zapier/Make, agent recipes, RAG/chatbot assembly, AI as a tool for marketing/ops/research/creative)',
  'life-skills': '**life-skills** (communication, public speaking, productivity, career, soft skills)',
  other: '**other / unknown**',
};

const MODULE_QUIZ_DOMAIN_BRANCHES: Record<CourseDomain, string> = {
  programming: 'questions can reference code snippets, API behavior, error messages, stack traces, performance trade-offs. Distractors should reflect common misunderstandings a developer at this depth might hold.',
  stem: 'use numeric scenarios, formula applications, derivation traps, unit errors. LaTeX is welcome in question text (`$E = mc^2$`) when it clarifies. Distractors reflect common algebraic slips or misapplied formulas.',
  humanities: 'interpretation, comparison of viewpoints, identifying arguments vs claims, historical cause-and-effect. Distractors are plausible but less defensible readings, not opposite positions.',
  language: 'grammar in context, translation nuance, collocation, register. Distractors are near-miss choices a learner at this level would be tempted by.',
  creative: "craft decisions, technique recognition, stylistic intent. Scenario stems NAME the medium and constraint (genre, gear, tools, subject, time of day, mood, brief). Distractors MIRROR amateur misconceptions specific to the sub-domain — e.g. photography: exposure-triangle traps ('f/22 sharpens portraits', 'ISO and shutter are independent', 'wide aperture = more DoF'); writing: pacing fallacies (adverb reliance, scene/summary confusion, tell-don't-show inversions); music: meter/key confusions, dynamics-as-tempo, effect-as-tone; design: hierarchy/contrast swaps, legibility-vs-style trade-offs. Every distractor names a real thing a practitioner might actually think — never a random plausible-sounding alternative.",
  business: "scenario-based stems naming a named role / company / constraint ('the CFO pushes back on…', 'your team of 8 at a seed-stage SaaS…'); options are plausible management decisions. Distractors reflect common managerial anti-patterns — solving for vanity metrics, 'shipped = done', consensus for its own sake, framework-as-cargo-cult. Numeric scenarios welcome for finance items (ROI, unit economics). Avoid code blocks; use `$…$` only for explicit quant (NPV, CAC).",
  practical: "procedural-scenario stems ('your bread is over-proofed and dense', 'the cabinet door binds on the top-right corner'); options are plausible next-step actions. Distractors reflect common amateur mistakes — wrong tool for the material, skipping a safety or timing-critical step, reversing the correct sequence, using the right technique at the wrong stage. Avoid code and LaTeX; measurements and units in prose are fine.",
  'practical-ai': "operational-scenario stems naming the goal, model/tool, and constraint ('you need to extract structured fields from 5k unlabeled support tickets with a $40 budget', 'your n8n agent loops 17 times before answering'). Options are plausible prompts, tool choices, or workflow edits. Distractor families — every distractor must be a NAMED failure mode, not random adjacency: (1) wrong-prompt-shape — missing role/output-spec, leading question, under-constrained, no examples where examples decide it, format demanded in prose instead of schema; (2) wrong-tool-selection — LLM where regex/SQL/RPA fits, fine-tuning where prompting suffices, RAG where the context window already fits, agent where a single call works; (3) agentic-misuse — unbounded loops, no termination criterion, tool-call thrashing, planner-without-critic; (4) capability-confusion — assuming RAG retrieves real-time data, treating an LLM as a search engine, conflating fine-tuning with system-prompting, expecting deterministic output without temperature=0; (5) cost/latency/safety mis-tradeoffs — max-tokens sprawl, sending PII into a third-party endpoint, prompt-injection-oblivious tool exposure, no rate-limit/back-off; (6) no-eval — accepting first-pass output, no golden set, no regression check after a prompt edit. Avoid LaTeX; verbatim prompt fragments inside backticks are welcome in stems and options.",
  'life-skills': "interpersonal scenario stems ('a direct report just told you they're burned out', 'you're preparing for a salary negotiation next Tuesday'); options are possible responses. Distractors reflect common pitfalls — reassurance in place of specificity, avoiding the hard conversation, pep-talks instead of concrete feedback, rehearsing content without rehearsing delivery. Avoid code and LaTeX.",
  other: 'let the lesson summaries drive the framing; stay neutral on domain-specific styling.',
};

const MODULE_QUIZ_NULL_DOMAIN_BRANCH = 'let the lesson summaries drive the framing; stay neutral on domain-specific styling.';

/**
 * Per-domain assembly — same rationale as `buildLessonDomainSection`:
 * pre-baking all 9 domain bullets into the cached prefix wrote tokens the
 * model never read. Per-domain prefixes cache independently.
 */
const buildModuleQuizDomainSection = ({ domain }: { domain: CourseDomain | null }): string => {
  const suffix = 'Never emit code snippets as question content for non-programming domains, and never use prose-only questions for a deep programming module — the mismatch reads as a bug to the learner.';
  if (!domain) {
    return `## Adapting to the course domain

The \`## Course context\` has no explicit \`Course domain\` set — ${MODULE_QUIZ_NULL_DOMAIN_BRANCH}

${suffix}`;
  }
  return `## Adapting to the course domain

The \`## Course context\` tags this module as **${domain}**. Shape questions and distractors to the discipline so the assessment feels native:

- ${MODULE_QUIZ_DOMAIN_LABELS[domain]}: ${MODULE_QUIZ_DOMAIN_BRANCHES[domain]}

${suffix}`;
};

// ── System prompt ──────────────────────────────────────

const moduleQuizSystemPromptCache = new Map<string, string>();

const MODULE_QUIZ_SYSTEM_PROMPT_PREFIX = `You are an expert assessment designer for educational content. Given summaries of ALL lessons in a module, generate a comprehensive module quiz that tests SYNTHESIS and APPLICATION across multiple lessons.

## What to generate

Generate 5-8 multiple-choice questions that assess the learner's understanding across the entire module. This is NOT a per-lesson recall test — it is a synthesis assessment.

## Question requirements

Each question must:
- Test understanding that spans 1 or more lessons (set sourceLessons to the lesson indices within the module that the question draws from)
- Have exactly 4 answer choices
- Have plausible distractors (common misconceptions or partial understanding), not obviously wrong options
- Include an explanation that references specific concepts from the relevant lessons
- Test UNDERSTANDING or APPLICATION, not just recall — ask "why", "what happens when", "which approach", "what would you do if"

## Distractor discipline (Apply / Analyze items in particular)

A learner who skims for "the reasonable-looking option" must not be able to win by surface pattern-match. Every Apply/Analyze item must follow these rules:

- **Surface-intuition trap.** At LEAST ONE distractor must share a surface feature with the correct answer — the same keyword, direction, sign, unit, or named concept — but be wrong for a named reason. If the correct answer says "increase ISO to compensate for low light", a distractor must also mention ISO (but with the wrong direction, the wrong rationale, or the wrong trade-off).
- **Flip the length gradient.** Correct answers drift to being the most precise, which drifts to being the longest — that's a tell. Invert it: draft distractors at the LONGER end carrying the plausible-but-wrong elaboration (a specific mechanism, a named misconception, a qualifying clause), and keep the correct answer closer to the SHORTER end. Target: all four options within ±35% of the median character count, and the correct answer is NOT the strictly longest.
- **No absolute qualifiers in distractors alone.** Never put "always", "never", "only", "all", "none", "every", "any" into a distractor UNLESS the correct answer also uses one. Absolute qualifiers in only-wrong options are a well-known test-taking tell.
- **Position-neutral.** The platform shuffles options client-side. Do NOT bias toward placing the correct answer at index 0 or index 3. Write distractors you would be proud of at ANY position — pre-shuffle, correctIndex should feel arbitrary.
- **Domain-native misconceptions.** Each distractor reflects a NAMED misconception a learner at this depth might actually hold. "Obviously wrong", "randomly adjacent", or "technically valid but unrelated" are all failures. The misconception is the target.
- **Grounded misconceptions, not fabricated facts.** A distractor may be factually wrong, but it must NOT invent specific regulatory, legal, tax, medical, or scientific rules — or specific quantities, dates, named entities, statute numbers, or citations — that the source lessons do not mention. If a distractor reads like an authoritative factual claim ("The IRS classifies…", "Section 409A requires…", "Studies show a 47% reduction…"), the claim itself must come from the lesson (restated, re-contextualized, or correct-in-isolation but wrong-in-context). A distractor that sounds authoritative while inventing a specific rule is a content-safety regression a learner will absorb as fact — reject it in favor of a lesson-grounded misconception.
- **No verbatim prose mirror.** The correct option must NOT be a sentence (or near-sentence — ≥8 consecutive words) copy-pasted from the lesson summaries above. A learner who skimmed the prose 30 seconds ago will pattern-match the familiar phrasing and pick correctly without having tested anything. Paraphrase materially: change the framing (active↔passive, cause↔effect), reorder the clause, or compress to a tighter restatement. The distractors paraphrase too — none of the four should read as "lifted from the lesson".
- **Never ship self-correction artifacts.** If at any point while drafting a question, options, or explanation you find yourself writing "wait,", "actually,", "hmm,", "let me reconsider", "on second thought", "scratch that", "— wait, consider these four actual options", or any visible self-talk, STOP. Do not include the artifact in the output. Restart that field from the final answer you would have arrived at. The learner sees the schema field text directly — meta-reasoning leaked into the JSON ships as prose to the UI.
- **Internal consistency.** All four options must be textually distinct (no two identical or near-identical after trimming whitespace and casefolding). The correct option must be a complete, self-contained answer — not a fragment that ends mid-clause, with a trailing comma, with a hanging conjunction (\`and\`/\`or\`/\`AS\`/\`BY\`/\`WHERE\`), with an unbalanced quote/paren, or as a half-finished SQL/code statement that is clearly shorter than its peers. The \`explanation\` MUST argue for the option at \`correctIndex\` — re-read the explanation before emitting and confirm it justifies the option you marked correct, not a sibling. If the explanation reasons about a different option than \`correctIndex\` points to, the question is broken; rewrite either the explanation or \`correctIndex\` so they agree.

**Worked example of distractor discipline (contrast pair):**

❌ Rejected — correct is strictly longest, a distractor uses "never" alone, lengths spread too wide:
\`\`\`
question: "Why does a closure retain access to variables after its enclosing function returns?"
options:
  0: "Variables are garbage collected immediately"
  1: "The engine never frees closure scopes"
  2: "Functions are first-class values"
  3: "The closure captures references to the variables in its lexical scope, which the GC keeps alive as long as the closure is reachable"
correctIndex: 3
\`\`\`

✅ Accepted — distractors carry the elaboration, correct is tight, no lone absolute qualifiers:
\`\`\`
question: "Why does a closure retain access to variables after its enclosing function returns?"
options:
  0: "It captures references, which keep those variables reachable"
  1: "The engine copies variable values into the closure at creation time"
  2: "Closures pin the entire call stack until they are garbage collected"
  3: "The closure captures names but resolves them against the global scope"
correctIndex: 0
\`\`\`

## Question ID format

Use "q-1", "q-2", "q-3", etc.

## Depth calibration (Bloom's Taxonomy)

Adjust question difficulty based on the course depth:

- **overview**: Focus on Understand and Apply levels.
  - "Which of the following best explains why..."
  - "Given this scenario, which concept applies?"
  - 60% understand, 40% apply

- **comprehensive**: Focus on Apply and Analyze levels.
  - "What would happen if you changed..."
  - "What is the key difference between approach A and B?"
  - "Which solution is most appropriate for this scenario?"
  - 30% understand, 40% apply, 30% analyze

- **deep_dive**: Focus on Analyze and Evaluate levels.
  - "Which approach has the best tradeoff for..."
  - "What is the most likely failure mode of..."
  - "Critique this approach — what does it get wrong?"
  - 20% apply, 40% analyze, 40% evaluate

`;

const MODULE_QUIZ_SYSTEM_PROMPT_SUFFIX = `## Synthesis questions

At least 2 questions MUST draw from 2+ different lessons (sourceLessons should have multiple indices). These cross-lesson questions are the most valuable — they test whether the learner can connect concepts across the module.

## Interleaved review questions (when provided)

If summaries from a previous module are provided, include 1-2 review questions from that earlier material. For these questions:
- Set isInterleaved to true
- Set interleavedModuleIndex to the module index provided
- Set sourceLessons to [] (since they reference a different module)
- These questions reinforce spaced retrieval and should test application, not recall

## Quality principles

- Every distractor should be something a learner with partial understanding might actually choose
- Explanations should teach — not just state the correct answer, but explain WHY it's correct and why the common misconception is wrong
- Questions should be specific enough that they couldn't apply to any generic course on the topic
- Reference concrete concepts, examples, or scenarios from the lesson content

## Examples

Good synthesis question (tests understanding across multiple lessons):
{
  "id": "q-1",
  "question": "A developer sets up JWT authentication (covered in Lesson 2) but their protected API routes (covered in Lesson 4) still return data to unauthenticated users. What is the most likely cause?",
  "options": [
    "The JWT secret key is too short",
    "The authentication middleware is defined after the route handlers",
    "The JWT token has expired",
    "The API routes are using GET instead of POST"
  ],
  "correctIndex": 1,
  "explanation": "Express middleware executes in order of registration. If route handlers are registered before the auth middleware, requests reach the handler without passing through authentication. This connects the middleware ordering concept from Lesson 2 with the route protection patterns from Lesson 4.",
  "sourceLessons": [1, 3],
  "isInterleaved": false
}

Good interleaved review question:
{
  "id": "q-7",
  "question": "In the previous module, you learned about database normalization. How would denormalization apply to the caching strategies covered in this module?",
  "options": [
    "Denormalized data is harder to cache because it changes more frequently",
    "Denormalized data can reduce cache misses by storing pre-joined data",
    "Normalization and caching are unrelated concepts",
    "Cache invalidation eliminates the need for denormalization"
  ],
  "correctIndex": 1,
  "explanation": "Denormalization trades write complexity for read performance — pre-joining data means fewer database queries and simpler cache keys, which directly supports the caching strategies discussed in this module.",
  "sourceLessons": [],
  "isInterleaved": true,
  "interleavedModuleIndex": 0
}

Return ONLY the questions array.`;

export const buildModuleQuizSystemPrompt = ({ domain }: { domain: CourseDomain | null }): string => {
  const key = domain ?? 'null';
  const cached = moduleQuizSystemPromptCache.get(key);
  if (cached) return cached;
  const assembled = `${MODULE_QUIZ_SYSTEM_PROMPT_PREFIX}
${buildModuleQuizDomainSection({ domain })}

${MODULE_QUIZ_SYSTEM_PROMPT_SUFFIX}`;
  moduleQuizSystemPromptCache.set(key, assembled);
  return assembled;
};
