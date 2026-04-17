import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getClarifyModel, getStructureModel } from '@lib/langchain';
import { withRetry } from '@lib/retry';
import { COURSE_DEPTHS, COURSE_DOMAINS, CourseDepth, CourseDomain, QUESTION_TYPES } from '@lib/constants';
import { sanitizePromptInput } from '@lib/sanitize';

// ── Clarify course ──────────────────────────────────────

const clarifyOutputSchema = z.object({
  courseName: z.string(),
  questions: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      type: z.enum(QUESTION_TYPES),
      options: z.array(z.string()).nullable(),
    }),
  ),
});

type ClarifyOutput = z.infer<typeof clarifyOutputSchema>;

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
- Use text type sparingly — only when a short free-text answer genuinely adds value (e.g., "What specific project are you working on?"). Keep text questions simple and specific.

Question types — pick the best type for each question:
- "multiple_select": PREFERRED. One or more options. Use for topics of interest, tools, skills, goals — anything where the learner might want to pick several. Provide 4-6 options. Set options array.
- "multiple_choice": One option only. ONLY for truly mutually exclusive choices (experience level, primary learning format preference). Provide 3-5 options. Set options array.
- "text": Free-form answer. Use rarely. Set options to null.

Each question must have a unique id (q1, q2, q3, etc).`;

export const clarifyCourse = async (params: { goal: string }): Promise<ClarifyOutput> => {
  const goal = sanitizePromptInput(params.goal);
  const model = getClarifyModel();
  const structuredModel = model.withStructuredOutput(clarifyOutputSchema);

  const response = await withRetry(() =>
    structuredModel.invoke([new SystemMessage(CLARIFY_SYSTEM_PROMPT), new HumanMessage(goal)]),
  );

  return response;
};

// ── Shared helpers ──────────────────────────────────────

const formatAnswers = (answers: { questionId: string; answer: string }[]) =>
  answers.map((a) => `- ${a.questionId}: ${sanitizePromptInput(a.answer)}`).join('\n');

// ── Depth previews ──────────────────────────────────────

const depthPreviewsOutputSchema = z.object({
  overview: z.object({
    summary: z.string(),
    bullets: z.array(z.string()),
  }),
  comprehensive: z.object({
    summary: z.string(),
    bullets: z.array(z.string()),
  }),
  deep_dive: z.object({
    summary: z.string(),
    bullets: z.array(z.string()),
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

Also select a "recommended" depth tier and provide a "recommendationReason" — a single sentence explaining why this depth best fits THIS learner. Reference specific details from their answers (e.g., "Since you already have intermediate Python experience and want to build production APIs, Comprehensive covers the practical depth you need without the theoretical deep dive you didn't ask for.").`;

interface DepthPreviewsInput {
  goal: string;
  answers: { questionId: string; answer: string }[];
}

export const generateDepthPreviews = async (params: DepthPreviewsInput): Promise<DepthPreviewsOutput> => {
  const goal = sanitizePromptInput(params.goal);
  const model = getClarifyModel();
  const structuredModel = model.withStructuredOutput(depthPreviewsOutputSchema);

  const humanMessage = `Learning goal: ${goal}

Learner's answers to clarifying questions:
${formatAnswers(params.answers)}

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
  modules: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      lessons: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
        }),
      ),
    }),
  ),
});

type StructureOutput = z.infer<typeof structureOutputSchema>;

const STRUCTURE_SYSTEM_PROMPT = `You are a world-class curriculum designer, subject matter expert, and learning scientist. You design personalized courses that respect each learner's existing knowledge, align with their goals, and progress through increasing cognitive complexity.

Your task: Design a structured course as a linear sequence of modules, each containing ordered lessons. The course must be deeply personalized — not a generic template with the learner's topic inserted.

First, generate a concise, descriptive course title as the courseName field (2-6 words). The title should reflect both the topic and the learner's specific focus — "Kubernetes for Data Engineers" not just "Learn Kubernetes." Make it specific and professional.

Next, classify the course into ONE primary domain (the \`domain\` field). This classification steers downstream lesson generation (block-type mix, math-vs-code balance, example style):
- "programming": software engineering, systems, web, devops, data engineering, security, any course whose primary content is source code.
- "stem": mathematics, physics, chemistry, biology, statistics, engineering, economics, quantitative finance — disciplines whose content lives on equations, formulas, and quantitative reasoning. Choose this even when some coding is involved, as long as math is the heart of the subject.
- "humanities": history, philosophy, literature, law, social sciences, religion.
- "language": natural-language learning (Spanish, Mandarin, ASL, etc.).
- "creative": visual art, music, writing craft, design, photography, performance.
- "other": anything that genuinely doesn't fit the above (business skills, cooking, gardening, personal finance basics, etc.).
Pick the SINGLE best fit. When a course spans domains (e.g., computational physics), pick the domain that best describes the lesson-level content the learner will read.

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
- "deep_dive": An extensive, mastery-level course. Many modules covering the topic from foundations (or wherever the learner starts) through to advanced material. This should be a genuinely long course — let the topic's natural complexity determine the right number of modules and lessons. Don't artificially limit scope.

Rules for module and lesson design:
- If the learner reported intermediate or advanced experience, DO NOT include introductory or foundational modules. Start where their knowledge ends.
- If the learner selected specific focus areas (via multiple-select answers), those areas should comprise the majority of the curriculum. Don't dilute focus with tangential topics.
- Every module and lesson name must be specific to the topic. NEVER use generic names like "Advanced Topics", "Best Practices", "Getting Started", or "Key Concepts" — these tell the learner nothing. Use names that describe concrete outcomes: "Building a CI/CD Pipeline with GitHub Actions" not "DevOps Best Practices".
- Each module description should explain what the learner will be able to DO after completing it, not just what they'll "learn about".
- Each lesson description should be specific enough that the learner can preview whether they already know this material.
- Early modules should have slightly fewer, simpler lessons. Lesson count and complexity should increase as the course progresses — this respects cognitive load.
- The final module should integrate and synthesize — not just "more topics". It should pull together everything into a capstone-level challenge or project.

Let the topic and the learner's needs determine the right scope — do not pad with filler lessons, but do not artificially constrain either. Every lesson should earn its place.`;

interface StructureInput {
  goal: string;
  answers: { questionId: string; answer: string }[];
  depth: CourseDepth;
}

export const generateCourseStructure = async (params: StructureInput): Promise<StructureOutput> => {
  const { answers, depth } = params;
  const goal = sanitizePromptInput(params.goal);
  const model = getStructureModel();
  const structuredModel = model.withStructuredOutput(structureOutputSchema);

  const humanMessage = `Learning goal: ${goal}

Learner's answers to clarifying questions:
${formatAnswers(answers)}

Chosen course depth: ${depth}

Fill in the reasoning fields first, then design the course structure.`;

  const response = await withRetry(() =>
    structuredModel.invoke([new SystemMessage(STRUCTURE_SYSTEM_PROMPT), new HumanMessage(humanMessage)]),
  );

  return response;
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
- Consider whether additions are appropriate for the learner's experience level and the chosen depth tier. If adding content would push the course significantly beyond typical scope for its depth, prefer a focused addition over an expansive one, unless the learner explicitly requests more.
- Update the reasoning fields to reflect the refined structure.
- The result should feel like a thoughtful revision, not a complete regeneration.`;

  const response = await withRetry(() =>
    structuredModel.invoke([new SystemMessage(STRUCTURE_SYSTEM_PROMPT), new HumanMessage(humanMessage)]),
  );

  return response;
};
