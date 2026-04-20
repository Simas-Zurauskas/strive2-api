import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getClarifyModel, getStructureModel } from '@lib/langchain';
import { withRetry } from '@lib/retry';
import { jsonish } from '@lib/zodHelpers';
import { COURSE_DEPTHS, COURSE_DOMAINS, CourseDepth, CourseDomain } from '@lib/constants';
import { sanitizePromptInput } from '@lib/sanitize';
import { bumpClarifyRefinementRetry, bumpStructureCapExceededRetry, bumpStructureCapViolationUnresolved } from '@lib/metrics';
import { detectSoftnessHint, getLessonCountHint, SoftnessHint } from './softness';
import {
  clarifyOutputSchema,
  ClarifyOutput,
  CLARIFY_TEXT_QUESTION_REFINEMENT_MARKER,
} from './clarifyValidation';

// Re-export from the validation module so existing importers (jobRunner.ts)
// continue working without a mechanical import refactor.
export { clarifyOutputSchema, isThinFreeText } from './clarifyValidation';

// ── Clarify course ──────────────────────────────────────

const CLARIFY_SYSTEM_PROMPT = `You are a world-class curriculum designer and learning scientist. You specialize in personalized education — designing curricula that adapt to each individual learner's background, goals, and constraints.

Your task: Given a learning goal, generate a concise course title and 3-6 clarifying questions whose answers will most significantly change the resulting curriculum. Think like a skilled tutor meeting a new student for the first time — you need to quickly understand who they are and what they actually need. Prefer fewer, higher-impact questions. Only go beyond 4 if the topic genuinely has that many discriminating dimensions.

First, generate a courseName (2-6 words) — a concise, descriptive title for the course based on the learning goal. Make it specific and professional: "Python for Data Science" not "Learn Python."

Before generating questions, reason about:
- What are the major branches or specializations within this topic?
- What prior knowledge dramatically changes the starting point?
- What are the most common reasons people learn this topic, and how do those reasons change what should be taught?
- What constraints (time, tools, environment) would meaningfully affect the curriculum design?

Principles for high-quality questions:
- Each question must be DISCRIMINATING — different answers should produce meaningfully different curricula. If all answers lead to roughly the same course, the question is wasted.
- Questions should demonstrate deep domain knowledge. For "Learn Python," don't ask generic questions — ask about specific Python ecosystems (data science vs web vs automation vs scripting) because these are entirely different curricula.
- Avoid formulaic patterns. Do NOT ask "how many hours per week can you study" — this rarely changes what modules to include. Instead ask questions that reveal WHAT to teach, not scheduling logistics.
- Every question must be CONCRETE and SIMPLE — answerable in under 5 seconds. Never ask abstract or meta questions like "What challenges do you anticipate?" or "What constraints do you face?" — learners don't know what they don't know. Ask specific, factual questions: "What tools do you already use?" not "What constraints affect your tool choice?"
- Options must use language the LEARNER knows, not expert jargon. If someone says they're a beginner, don't offer options like "AI-driven prototyping tools" — use plain language like "Figma", "Canva", "Adobe XD."
- Default to multiple_select over multiple_choice. Most real-world answers are NOT mutually exclusive. Only use multiple_choice when options are truly exclusive (e.g., experience level where you can only be one: beginner OR intermediate OR advanced).
- You MUST include AT LEAST ONE "text" question in every clarify set — this is a hard requirement, not a preference. Typically 1-2 text questions, more if the goal is domain-specific, professional, or highly personal. A well-scoped text question elicits a concrete artifact (a specific project, stakeholder, constraint, prior tool, dataset, or domain-concrete detail) that the curriculum can thread through lessons and examples; MCQ options cannot substitute because they flatten the learner's specifics into invented choices. Good text-question examples: "What's the specific project or problem you want to solve?", "Who is your audience — describe them briefly", "What prior tools or frameworks have you already used?". If the topic feels fully multi-choice, you are wrong — ask for the context (use case, team setup, prior attempt, specific deliverable). NEVER ship a clarify set with zero text questions.

Question types — pick the best type for each question:
- "multiple_select": PREFERRED for list-like answers. One or more options. Use for topics of interest, tools, skills, goals — anything where the learner might want to pick several. Provide 4-6 options. Set options array.
- "multiple_choice": One option only. ONLY for truly mutually exclusive choices (experience level, primary learning format preference). Provide 3-5 options. Set options array.
- "text": Free-form answer. Use for open-ended answers where a concrete phrase from the learner — a project name, a specific tool, a stakeholder, a constraint — will materially improve curriculum design. Set options to null.

Each question must have a unique id (q1, q2, q3, etc).`;

export const clarifyCourse = async (params: { goal: string }): Promise<ClarifyOutput> => {
  const goal = sanitizePromptInput(params.goal);
  const model = getClarifyModel();
  const structuredModel = model.withStructuredOutput(clarifyOutputSchema);

  const response = await withRetry(async () => {
    try {
      return await structuredModel.invoke([new SystemMessage(CLARIFY_SYSTEM_PROMPT), new HumanMessage(goal)]);
    } catch (e) {
      // Detect refinement-triggered retries separately from generic JSON-parse
      // failures so `/metrics` exposes a clean "how often does the LLM ignore
      // the hard-contract text-question rule" signal. withRetry then handles
      // the actual backoff + re-invocation.
      if (e instanceof Error && e.message.includes(CLARIFY_TEXT_QUESTION_REFINEMENT_MARKER)) {
        bumpClarifyRefinementRetry();
      }
      throw e;
    }
  });

  return response;
};

// ── Shared helpers ──────────────────────────────────────

const formatAnswers = (answers: { questionId: string; answer: string }[]) =>
  answers.map((a) => `- ${a.questionId}: ${sanitizePromptInput(a.answer)}`).join('\n');

/**
 * Render the softness signal block consumed by both the depth-previews and
 * structure-generation prompts. Always emits the SOFT= line so the LLM sees
 * an explicit NO when no cue matched (rather than silence, which it might
 * interpret as missing-data).
 */
const formatSoftnessSection = (softness: SoftnessHint): string => {
  if (!softness.isSoft) {
    return 'Heuristic softness check: SOFT=NO (no light-effort phrasing detected in answers).';
  }
  const cueList = softness.cues.map((c) => `  - ${c}`).join('\n');
  return `Heuristic softness check: SOFT=YES — the learner used phrasing that suggests light-effort intent.\nCues:\n${cueList}`;
};

// ── Depth previews ──────────────────────────────────────

const depthPreviewsOutputSchema = z.object({
  overview: z.object({
    summary: z.string(),
    bullets: jsonish(z.array(z.string())),
  }),
  comprehensive: z.object({
    summary: z.string(),
    bullets: jsonish(z.array(z.string())),
  }),
  deep_dive: z.object({
    summary: z.string(),
    bullets: jsonish(z.array(z.string())),
  }),
  recommended: z.enum(COURSE_DEPTHS),
  recommendationReason: z.string(),
});

type DepthPreviewsOutput = z.infer<typeof depthPreviewsOutputSchema>;

const DEPTH_PREVIEWS_SYSTEM_PROMPT = `You are a world-class curriculum designer. Given a learning goal and the learner's answers to clarifying questions, generate a personalized preview for each of the three course depth levels.

For each depth tier (overview, comprehensive, deep_dive), generate:

1. A "summary" — one sentence describing what THIS learner would achieve at this depth, referencing their specific topic and context. Not generic. Example: "Build a working mental model of Kubernetes architecture and core resources" — not "Get a broad overview of the topic."

2. "bullets" — 3-4 concrete skills or topics covered at this depth. Each bullet should be specific enough that the learner can evaluate whether they need it. Reference their stated experience level, selected focus areas, and goals. Keep each bullet concise (under 15 words).

Rules for depth progression:
- Each level must visibly BUILD on the previous one. Do NOT repeat bullets across levels — each level's bullets cover NEW ground.
- Overview: Key concepts, mental models, foundational understanding. The "I can talk about this intelligently" level.
- Comprehensive: Working knowledge with hands-on application. The "I can do this independently" level. Covers practical skills, real-world techniques, and intermediate patterns beyond overview.
- Deep Dive: Mastery-level coverage. The "I can teach this and handle edge cases" level. Covers advanced patterns, optimization, architecture decisions, and expert-level nuance beyond comprehensive.
- Bullets must reference the learner's specific context. If they mentioned specific tools, interests, or experience, reflect that in the bullets.

Also select a "recommended" depth tier and provide a "recommendationReason" — a single sentence explaining why this depth best fits THIS learner. Reference specific details from their answers (e.g., "Since you already have intermediate Python experience and want to build production APIs, Comprehensive covers the practical depth you need without the theoretical deep dive you didn't ask for.").

Softness handling — read carefully:

The human message may include a "Heuristic softness check" section listing phrases the learner used that suggest light-effort intent (e.g. "just want to learn", "lighter load", "minimal effort", "casual"). When this section says SOFT=YES:
- Default-recommend OVERVIEW. A learner who phrases their goal in low-effort terms is poorly served by being steered into a long course they will not finish.
- Override to Comprehensive only when other answers strongly contradict the softness — for example, a stated deadline that requires deeper coverage, an explicitly-named professional project, or self-reported expert background that needs advanced topics.
- Never override to Deep Dive on a SOFT signal. If you must go beyond Overview, Comprehensive is the ceiling.
- Quote at least one of the detected cues verbatim in \`recommendationReason\` so the learner sees why we trimmed (e.g. "Since you said 'just want to learn more', Overview gets you the mental model without a 30-lesson commitment.").

When SOFT=NO, recommend whichever depth the answers actually call for — do not bias toward Overview.`;

interface DepthPreviewsInput {
  goal: string;
  answers: { questionId: string; answer: string }[];
}

export const generateDepthPreviews = async (params: DepthPreviewsInput): Promise<DepthPreviewsOutput> => {
  const goal = sanitizePromptInput(params.goal);
  const softness = detectSoftnessHint({ answers: params.answers });
  const model = getClarifyModel();
  const structuredModel = model.withStructuredOutput(depthPreviewsOutputSchema);

  const humanMessage = `Learning goal: ${goal}

Learner's answers to clarifying questions:
${formatAnswers(params.answers)}

${formatSoftnessSection(softness)}

Generate personalized depth previews for each tier.`;

  const response = await withRetry(() =>
    structuredModel.invoke([new SystemMessage(DEPTH_PREVIEWS_SYSTEM_PROMPT), new HumanMessage(humanMessage)]),
  );

  return response;
};

// ── Generate course structure ───────────────────────────

const structureOutputSchema = z.object({
  courseName: z.string(),
  domain: z.enum(COURSE_DOMAINS),
  reasoning: z.object({
    learnerProfile: z.string(),
    topicAnalysis: z.string(),
    scopeDecisions: z.string(),
    progressionStrategy: z.string(),
  }),
  modules: jsonish(z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      lessons: jsonish(z.array(
        z.object({
          name: z.string(),
          description: z.string(),
        }),
      )),
    }),
  )),
});

type StructureOutput = z.infer<typeof structureOutputSchema>;

// ── Per-domain classifier guidance ─────────────────────
// The structure-design prompt asks the LLM to classify each course into
// one of COURSE_DOMAINS. The map below both documents the scope of each
// domain (for the LLM to read) and enforces a compile-time check: adding
// a value to COURSE_DOMAINS without an entry here fails `tsc`. That's the
// primary guarantee we want — the classifier can never silently default
// to "other" for a new domain because the enum grew without the prompt
// being updated.

const STRUCTURE_DOMAIN_GUIDANCE: Record<CourseDomain, string> = {
  programming: 'software engineering, systems, web, devops, data engineering, security, any course whose primary content is source code.',
  stem: 'mathematics, physics, chemistry, biology, statistics, engineering, economics, quantitative finance — disciplines whose content lives on equations, formulas, and quantitative reasoning. Choose this even when some coding is involved, as long as math is the heart of the subject.',
  humanities: 'history, philosophy, literature, law, social sciences, religion.',
  language: 'natural-language learning (Spanish, Mandarin, ASL, etc.) — acquiring a language as a non-native speaker. NOT communication skills in the learner\'s own language (that is life-skills).',
  creative: 'visual art, music, writing craft, design, photography, performance — production-oriented courses where the learner MAKES something in a medium.',
  business: 'management, marketing, product management, sales, strategy, negotiation, personal finance, entrepreneurship, operations, and economics applied to real-world decisions. Includes Agile/Scrum, leadership, and applied econ/finance.',
  practical: 'hands-on physical skills — cooking, baking, home repair, gardening, trades (plumbing, carpentry, electrical), crafts, fitness and training routines, outdoor skills. Courses where practice requires tools, materials, or physical action in a real environment.',
  'life-skills': 'personal effectiveness and communication in the learner\'s own language — public speaking, interpersonal communication, productivity systems, career development, habit-building, emotional intelligence, soft skills. Distinct from creative writing (which is creative) and from language acquisition (which is language).',
  other: "anything that genuinely doesn't fit any of the categories above. Rare after the introduction of business, practical, and life-skills — before picking this, re-check whether the course actually fits one of those three.",
};

const STRUCTURE_DOMAIN_BULLETS = COURSE_DOMAINS
  .map((d) => `- "${d}": ${STRUCTURE_DOMAIN_GUIDANCE[d]}`)
  .join('\n');

const STRUCTURE_SYSTEM_PROMPT = `You are a world-class curriculum designer, subject matter expert, and learning scientist. You design personalized courses that respect each learner's existing knowledge, align with their goals, and progress through increasing cognitive complexity.

Your task: Design a structured course as a linear sequence of modules, each containing ordered lessons. The course must be deeply personalized — not a generic template with the learner's topic inserted.

First, generate a concise, descriptive course title as the courseName field (2-6 words). The title should reflect both the topic and the learner's specific focus — "Kubernetes for Data Engineers" not just "Learn Kubernetes." Make it specific and professional.

Next, classify the course into ONE primary domain (the \`domain\` field). This classification steers downstream lesson generation (block-type mix, math-vs-code balance, example style):
${STRUCTURE_DOMAIN_BULLETS}
Pick the SINGLE best fit. When a course spans domains (e.g., computational physics), pick the domain that best describes the lesson-level content the learner will read.

Classify by the SUBJECT MATTER the learner will actually study, not by the action verb in their goal. Pedagogy-of-X keeps X's domain: "teaching creative writing to high schoolers" is \`creative\` (the subject IS creative writing); "learning to teach biology" is \`stem\` (the subject is biology). "Blockchain with Solidity" is \`programming\` (code-heavy); "the math behind zero-knowledge proofs" is \`stem\`. "Business writing" is \`business\` (the aim is business communication); "writing short fiction" is \`creative\`. Before defaulting to \`other\`, re-read the \`business\`, \`practical\`, and \`life-skills\` scopes — most non-STEM/non-code courses fit one of those three.

CRITICAL — Before generating any modules, you MUST fill in the reasoning fields. Think carefully:

1. learnerProfile: Synthesize who this learner is from their answers. What do they already know? What are their blind spots? What motivates them? What constraints do they have? Be specific — "A beginner interested in web development for a career change" not "A learner who wants to learn programming."

2. topicAnalysis: What are the core concepts, prerequisite chains, and common pitfalls in this domain? What do experts know that beginners don't realize they need? What are the critical "unlock" concepts that enable everything else?

3. scopeDecisions: Based on the learner's profile and the depth tier, what SPECIFICALLY should be included and excluded? This is where personalization happens. If the learner is experienced, state exactly which foundational topics are being skipped and why. If they selected specific focus areas, those should dominate — state how much weight each gets. If they have a specific project, the curriculum should build toward it.

4. progressionStrategy: How should cognitive difficulty build across this specific curriculum? Map the progression through Bloom's taxonomy:
   - Early modules: Remember & Understand (definitions, concepts, mental models)
   - Middle modules: Apply & Analyze (hands-on practice, problem-solving, pattern recognition)
   - Later modules: Evaluate & Create (independent judgment, original work, integration of concepts)
   State where the transitions happen for THIS curriculum.

Course depth — scope guidance:
- "overview": A short course. A few modules covering key concepts and mental models only. No deep practice.
- "comprehensive": A thorough course. Multiple modules covering the topic with solid working knowledge and application. The bulk of the course should be at the Apply/Analyze level.
- "deep_dive": An extensive, mastery-level course. Many modules covering the topic from foundations (or wherever the learner starts) through to advanced material. Let the topic's natural complexity determine the right number of modules and lessons within the cap below.

Total-lesson scope cap (mandatory) — the human message includes a "Lesson-count target" line stating a (min, max) range for the total lesson count summed across all modules. This range is derived from the chosen depth and the heuristic softness signal:
- Generate a course whose TOTAL lesson count (sum across all modules) falls within the stated range. The max is a hard ceiling for normal cases — going over it requires the topic to genuinely need more (e.g., a multi-language programming course where each language is itself a sub-course).
- When the softness signal is SOFT=YES, treat the LOW end of the range as the default and only push toward the middle when the answers genuinely require more breadth. Never go above the range on a SOFT=YES learner — they explicitly signalled they will not finish a long course.
- If you trim the course to fit a SOFT cap, name what you trimmed in \`scopeDecisions\`. For example: "Because the learner said 'just want to learn more', advanced modules on X and Y are deferred — the course covers the 18 highest-leverage lessons."
- The total lesson count is the sum across modules. If you produce 6 modules with 5 lessons each, that's 30 lessons total — make sure the sum sits within the cap, not just any individual module.

Rules for module and lesson design:
- If the learner reported intermediate or advanced experience, DO NOT include introductory or foundational modules. Start where their knowledge ends.
- If the learner selected specific focus areas (via multiple-select answers), those areas should comprise the majority of the curriculum. Don't dilute focus with tangential topics.
- Every module and lesson name must be specific to the topic. NEVER use generic names like "Advanced Topics", "Best Practices", "Getting Started", or "Key Concepts" — these tell the learner nothing. Use names that describe concrete outcomes: "Building a CI/CD Pipeline with GitHub Actions" not "DevOps Best Practices".
- Each module description should explain what the learner will be able to DO after completing it, not just what they'll "learn about".
- Each lesson description should be specific enough that the learner can preview whether they already know this material.
- Early modules should have slightly fewer, simpler lessons. Lesson count and complexity should increase as the course progresses — this respects cognitive load.
- The final module should integrate and synthesize — not just "more topics". It should pull together everything into a capstone-level challenge or project.

When the learner supplied free-text answers in \`answers[]\`, treat their exact phrasing as a contract. If they named a concrete concept, tool, stakeholder, audience, project, framework, or constraint, surface that wording in your reasoning and let it shape the curriculum. If they said "RLHF", the course mentions RLHF by name; if they said "I'm teaching middle-schoolers", the examples and framing target middle-schoolers; if they named a specific codebase or dataset, the curriculum builds toward it. Quote at least one such phrase verbatim in \`learnerProfile\` or \`scopeDecisions\` whenever a free-text answer is present — do not paraphrase away the specificity.

Thin-answer handling: a text answer may be tagged with the marker \`[thin answer — weak signal]\`. This means the learner replied with ≤3 tokens (e.g., "stop overspending" or "analyzing customer data") — enough to hint at their intent but NOT enough to support confident scope decisions. When you see this marker:
- Do not invent specifics the learner did not supply (don't infer "stop overspending" means "they have specifically $X in credit card debt at Y rate"). Acknowledge the intent in \`learnerProfile\` and leave specifics open.
- Prefer broader, reversible scope decisions over narrow, highly-tailored ones. If they said "stop overspending", design the course around general overspending mechanisms — not a debt-payoff calculator track the learner never asked for.
- Note the thinness explicitly in \`scopeDecisions\` (e.g., "Learner gave a brief 'stop overspending' goal — curriculum covers the core diagnostic and budgeting patterns without over-specializing to a particular debt type the learner did not name.").

Within the lesson-count cap, let the topic and the learner's needs determine the right scope — do not pad with filler lessons. Every lesson should earn its place.`;

interface StructureInput {
  goal: string;
  answers: { questionId: string; answer: string }[];
  depth: CourseDepth;
}

/** How much over the cap we tolerate before bouncing. +2 accepts minor LLM
 *  rounding (e.g. cap 14, generated 15) without a full regeneration round
 *  trip. Anything more than 2 over is a meaningful scope violation. */
const STRUCTURE_CAP_TOLERANCE = 2;

/** Count total lessons across all modules in a generated structure. */
const totalLessonCount = (structure: StructureOutput): number =>
  structure.modules.reduce((sum, m) => sum + m.lessons.length, 0);

export const generateCourseStructure = async (params: StructureInput): Promise<StructureOutput> => {
  const { answers, depth } = params;
  const goal = sanitizePromptInput(params.goal);
  const softness = detectSoftnessHint({ answers });
  const [capMin, capMax] = getLessonCountHint({ depth, isSoft: softness.isSoft });
  const model = getStructureModel();
  const structuredModel = model.withStructuredOutput(structureOutputSchema);

  const baseHumanMessage = `Learning goal: ${goal}

Learner's answers to clarifying questions:
${formatAnswers(answers)}

Chosen course depth: ${depth}

${formatSoftnessSection(softness)}

Lesson-count target: ${capMin}-${capMax} total lessons (sum across all modules). Do not exceed ${capMax} unless the topic genuinely cannot be taught at this scale.

Fill in the reasoning fields first, then design the course structure.`;

  // First attempt — the prompt carries the cap guidance already.
  const first = await withRetry(() =>
    structuredModel.invoke([new SystemMessage(STRUCTURE_SYSTEM_PROMPT), new HumanMessage(baseHumanMessage)]),
  );

  const firstCount = totalLessonCount(first);
  if (firstCount <= capMax + STRUCTURE_CAP_TOLERANCE) {
    return first;
  }

  // The LLM ignored the cap. Retry exactly once with an explicit corrective
  // message. The assessment's 3/5 persona scope-bloat pattern was partly
  // because the cap was advisory — adding a code-enforced regenerate with a
  // concrete "you produced N; trim to ≤ capMax" instruction gives the LLM a
  // chance to re-plan rather than silently shipping an oversized course.
  bumpStructureCapExceededRetry();
  console.warn(
    `[generateCourseStructure] First attempt exceeded cap: produced ${firstCount} lessons vs cap ${capMax}. Retrying with corrective message.`.yellow,
  );

  const correctiveMessage = `${baseHumanMessage}

--- PREVIOUS ATTEMPT EXCEEDED THE CAP ---
Your previous attempt produced ${firstCount} lessons, which exceeds the cap of ${capMax}. Regenerate the structure trimmed to at most ${capMax} lessons total (sum across all modules). Preserve the Bloom progression and the learner's focus areas — cut the lowest-leverage lessons, merge closely-related ones, and shorten any modules that were padded. Explicitly name what you cut or merged in \`scopeDecisions\`.`;

  const second = await withRetry(() =>
    structuredModel.invoke([new SystemMessage(STRUCTURE_SYSTEM_PROMPT), new HumanMessage(correctiveMessage)]),
  );

  const secondCount = totalLessonCount(second);
  if (secondCount > capMax + STRUCTURE_CAP_TOLERANCE) {
    // Second attempt also failed — bump the pathological counter and surface
    // a descriptive error. Do NOT silently truncate the result: truncation
    // would violate the Bloom progression (the structure assumes all lessons
    // build sequentially).
    bumpStructureCapViolationUnresolved();
    throw Object.assign(
      new Error(
        `Structure cap violation: generated ${secondCount} lessons after retry, cap is ${capMax} (depth=${depth}, soft=${softness.isSoft}).`,
      ),
      { statusCode: 500 },
    );
  }

  console.log(
    `[generateCourseStructure] Retry succeeded: produced ${secondCount} lessons within cap ${capMax}.`.green,
  );
  return second;
};

// ── Refine course structure ─────────────────────────────

interface RefineInput extends StructureInput {
  currentStructure: {
    modules: { name: string; description: string; lessons: { name: string; description: string }[] }[];
  };
  currentDomain?: CourseDomain | null;
  feedback: string;
  feedbackHistory: string[];
}

export const refineCourseStructure = async (params: RefineInput): Promise<StructureOutput> => {
  const { answers, depth, currentStructure, currentDomain } = params;
  const goal = sanitizePromptInput(params.goal);
  const feedback = sanitizePromptInput(params.feedback);
  const feedbackHistory = params.feedbackHistory.map(sanitizePromptInput);
  const softness = detectSoftnessHint({ answers });
  const [capMin, capMax] = getLessonCountHint({ depth, isSoft: softness.isSoft });
  const model = getStructureModel();
  const structuredModel = model.withStructuredOutput(structureOutputSchema);

  const currentStructureText = currentStructure.modules
    .map(
      (m, i) =>
        `Module ${i + 1}: ${m.name}\n  ${m.description}\n  Lessons:\n${m.lessons.map((l, j) => `    ${j + 1}. ${l.name} — ${l.description}`).join('\n')}`,
    )
    .join('\n\n');

  const humanMessage = `Learning goal: ${goal}

Learner's answers to clarifying questions:
${formatAnswers(answers)}

Chosen course depth: ${depth}

${formatSoftnessSection(softness)}

Lesson-count target: ${capMin}-${capMax} total lessons (sum across all modules). The current structure may be inside or outside this range; respect the cap unless the learner's CURRENT REQUEST below explicitly asks to expand beyond it.

${currentDomain ? `Current course domain: ${currentDomain} — keep this domain unless the refinement genuinely changes the subject of the course.\n\n` : ''}--- CURRENT STRUCTURE (previously generated) ---
${currentStructureText}

${feedbackHistory.length > 0 ? `--- PREVIOUS REFINEMENTS (already applied to the structure above) ---\n${feedbackHistory.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n` : ''}--- CURRENT REQUEST ---
${feedback}

The learner has reviewed the structure above and wants changes. Modify the structure to address their current request.

Rules for refinement:
- PRESERVE modules and lessons the learner did not mention — do not reorganize or rename things that are working.
- Only change what the current request specifically asks for.
- The previous refinements listed above have ALREADY been applied to the current structure. Do not undo them unless the current request explicitly asks to reverse a previous change.
- If the feedback asks to remove, add, merge, or split modules/lessons, do exactly that.
- Maintain pedagogical quality, Bloom's taxonomy progression, and specific lesson naming standards.
- Consider whether additions are appropriate for the learner's experience level and the chosen depth tier. If adding content would push the course beyond the lesson-count target above, prefer a focused addition over an expansive one — unless the learner's current request explicitly asks to grow the course.
- Update the reasoning fields to reflect the refined structure.
- The result should feel like a thoughtful revision, not a complete regeneration.`;

  const response = await withRetry(() =>
    structuredModel.invoke([new SystemMessage(STRUCTURE_SYSTEM_PROMPT), new HumanMessage(humanMessage)]),
  );

  return response;
};
