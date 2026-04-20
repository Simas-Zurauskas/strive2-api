import { z } from 'zod';
import { jsonish } from '@lib/zodHelpers';
import { COURSE_DOMAINS, CourseDomain } from '@lib/constants';

// ── Schemas ────────────────────────────────────────────

export const quizQuestionSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: jsonish(z.array(z.string()).length(4)),
  correctIndex: z.number().min(0).max(3),
  explanation: z.string(),
  sourceLessons: jsonish(z.array(z.number())),
  isInterleaved: z.boolean(),
  interleavedModuleIndex: z.number().optional(),
});

export const quizOutputSchema = z.object({
  questions: jsonish(z.array(quizQuestionSchema).min(5).max(8)),
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
  'life-skills': '**life-skills** (communication, public speaking, productivity, career, soft skills)',
  other: '**other / unknown**',
};

const MODULE_QUIZ_DOMAIN_BRANCHES: Record<CourseDomain, string> = {
  programming: 'questions can reference code snippets, API behavior, error messages, stack traces, performance trade-offs. Distractors should reflect common misunderstandings a developer at this depth might hold.',
  stem: 'use numeric scenarios, formula applications, derivation traps, unit errors. LaTeX is welcome in question text (`$E = mc^2$`) when it clarifies. Distractors reflect common algebraic slips or misapplied formulas.',
  humanities: 'interpretation, comparison of viewpoints, identifying arguments vs claims, historical cause-and-effect. Distractors are plausible but less defensible readings, not opposite positions.',
  language: 'grammar in context, translation nuance, collocation, register. Distractors are near-miss choices a learner at this level would be tempted by.',
  creative: 'craft decisions, technique recognition, stylistic intent. Distractors reflect common amateur choices.',
  business: "scenario-based stems naming a named role / company / constraint ('the CFO pushes back on…', 'your team of 8 at a seed-stage SaaS…'); options are plausible management decisions. Distractors reflect common managerial anti-patterns — solving for vanity metrics, 'shipped = done', consensus for its own sake, framework-as-cargo-cult. Numeric scenarios welcome for finance items (ROI, unit economics). Avoid code blocks; use `$…$` only for explicit quant (NPV, CAC).",
  practical: "procedural-scenario stems ('your bread is over-proofed and dense', 'the cabinet door binds on the top-right corner'); options are plausible next-step actions. Distractors reflect common amateur mistakes — wrong tool for the material, skipping a safety or timing-critical step, reversing the correct sequence, using the right technique at the wrong stage. Avoid code and LaTeX; measurements and units in prose are fine.",
  'life-skills': "interpersonal scenario stems ('a direct report just told you they're burned out', 'you're preparing for a salary negotiation next Tuesday'); options are possible responses. Distractors reflect common pitfalls — reassurance in place of specificity, avoiding the hard conversation, pep-talks instead of concrete feedback, rehearsing content without rehearsing delivery. Avoid code and LaTeX.",
  other: 'let the lesson summaries drive the framing; stay neutral on domain-specific styling.',
};

const MODULE_QUIZ_NULL_DOMAIN_BRANCH = 'let the lesson summaries drive the framing; stay neutral on domain-specific styling.';

const MODULE_QUIZ_DOMAIN_BULLETS = COURSE_DOMAINS
  .map((d) => `- ${MODULE_QUIZ_DOMAIN_LABELS[d]}: ${MODULE_QUIZ_DOMAIN_BRANCHES[d]}`)
  .join('\n');

const MODULE_QUIZ_DOMAIN_SECTION = `## Adapting to the course domain

The \`## Course context\` may include a \`Course domain\` field. Shape questions and distractors to the discipline so the assessment feels native to the subject, not generic:

${MODULE_QUIZ_DOMAIN_BULLETS}
- **null / unclassified**: ${MODULE_QUIZ_NULL_DOMAIN_BRANCH}

Never emit code snippets as question content for non-programming domains, and never use prose-only questions for a deep programming module — the mismatch reads as a bug to the learner.`;

// ── System prompt ──────────────────────────────────────

export const MODULE_QUIZ_SYSTEM_PROMPT = `You are an expert assessment designer for educational content. Given summaries of ALL lessons in a module, generate a comprehensive module quiz that tests SYNTHESIS and APPLICATION across multiple lessons.

## What to generate

Generate 5-8 multiple-choice questions that assess the learner's understanding across the entire module. This is NOT a per-lesson recall test — it is a synthesis assessment.

## Question requirements

Each question must:
- Test understanding that spans 1 or more lessons (set sourceLessons to the lesson indices within the module that the question draws from)
- Have exactly 4 answer choices
- Have plausible distractors (common misconceptions or partial understanding), not obviously wrong options
- Include an explanation that references specific concepts from the relevant lessons
- Test UNDERSTANDING or APPLICATION, not just recall — ask "why", "what happens when", "which approach", "what would you do if"

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

${MODULE_QUIZ_DOMAIN_SECTION}

## Synthesis questions

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
