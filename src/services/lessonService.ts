import { z } from 'zod';
import OpenAI from 'openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getLessonModel, getInteractiveModel } from '@lib/langchain';
import { withRetry } from '@lib/retry';
import { sanitizePromptInput } from '@lib/sanitize';
import { TavilySearch } from '@langchain/tavily';
import { OPENAI_API_KEY, TAVILY_API_KEY } from '@conf/env';
import { BLOCK_TYPES, ILessonBlock } from '@models/LessonContentModel';

// ── Output schemas ─────────────────────────────────────

const lessonBlockSchema = z.object({
  id: z.string(),
  type: z.enum(BLOCK_TYPES),
  content: z.string(),
  metadata: z
    .object({
      language: z.string().optional(),
      executable: z.boolean().optional(),
      variant: z.enum(['info', 'tip', 'warning', 'important']).optional(),
      diagramType: z.enum(['flowchart', 'sequenceDiagram', 'classDiagram', 'stateDiagram-v2', 'erDiagram', 'mindmap']).optional(),
      question: z.string().optional(),
      options: z.array(z.string()).optional(),
      correctIndex: z.number().optional(),
      explanation: z.string().optional(),
      starterCode: z.string().optional(),
      expectedOutput: z.string().optional(),
    })
    .nullable(),
  order: z.number(),
});

const contentOutputSchema = z.object({
  blocks: z.array(lessonBlockSchema),
  summary: z.string(),
});

const interactiveOutputSchema = z.object({
  blocks: z.array(lessonBlockSchema),
});

// ── Content system prompt ──────────────────────────────

const LESSON_SYSTEM_PROMPT = `You are a world-class educator and technical writer. You create lesson content that is clear, engaging, and deeply personalized to the learner's context.

Your task: Generate the full content for a single lesson as structured blocks. Each block has a type, content, and order. You must produce high-quality educational content that a learner can read and understand without external help.

## Block types you MUST produce

1. **intro** (exactly 1): A compelling opening paragraph. Hook the learner — state what they will know or be able to do by the end. Reference their specific context where possible. 2-4 sentences.

2. **section** (2-5): The core teaching content. Each section covers one key concept or skill. Rules:
   - Each section's content starts with a markdown heading (## Section Title)
   - 150-400 words per section
   - Use concrete, specific examples — never generic placeholders
   - Build on the learner's existing knowledge (don't re-explain what they already know based on their profile)
   - Use analogies to connect new concepts to familiar ones
   - End each section at a natural conceptual boundary

3. **code** (0-4, when the topic involves programming or technical commands): Runnable, complete code examples. Rules:
   - Set metadata.language to the programming language (e.g., "typescript", "python", "sql", "bash")
   - Code must be COMPLETE and runnable — no pseudocode, no "// ..." stubs, no "implement here" placeholders
   - Each code block illustrates exactly one concept
   - Include brief comments explaining intent, not mechanics
   - Set metadata.executable to true if the code can meaningfully run standalone

4. **mermaid** (0-2, when a visual diagram genuinely aids understanding): Mermaid.js diagram code. Rules:
   - Set metadata.diagramType to one of: "flowchart", "sequenceDiagram", "classDiagram", "stateDiagram-v2", "erDiagram", "mindmap"
   - Content must be VALID Mermaid syntax — start with the diagram type keyword on the first line
   - Use diagrams for: processes/algorithms (flowchart), API/protocol flows (sequenceDiagram), OOP/data structures (classDiagram), state transitions (stateDiagram-v2), database schemas (erDiagram), concept overviews (mindmap)
   - Do NOT add diagrams just to have them — only when a visual representation genuinely reduces explanation burden. Many lessons need zero diagrams.
   - Keep diagrams focused — 5-15 nodes maximum. Simple and clear beats comprehensive and cluttered.
   - Do NOT wrap the mermaid code in markdown code fences — just the raw mermaid syntax

5. **callout** (0-3): Info/tip/warning/important boxes for emphasis. Rules:
   - Set metadata.variant to one of: "info", "tip", "warning", "important"
   - "info" — supplementary context ("Note: This behavior changed in version 3.0")
   - "tip" — practical advice ("Pro tip: Always use const by default")
   - "warning" — pitfalls or performance concerns ("Warning: This has O(n²) complexity")
   - "important" — critical concept the learner must understand
   - Place callouts inline where they naturally belong — after the concept they relate to

6. **summary** (exactly 1, last block): 4-6 bullet points of key takeaways. Each bullet:
   - States one concrete thing the learner now knows or can do
   - Is distinct from other bullets (no redundancy)

## Block format

Each block needs:
- id: A unique string (use format "type-N", e.g., "intro-1", "section-1", "code-1", "callout-1", "summary-1")
- type: One of the types above
- content: The text content (use markdown formatting within text blocks)
- metadata: Type-specific fields (see above) or null for text-only blocks
- order: Sequential integer starting from 0

## Also produce

A "summary" field (separate from the summary block) — a 1-2 sentence plain text summary of the entire lesson. This is used for search indexing and AI mentor context, not shown to the learner.

## Quality principles

- PERSONALIZE: Reference the learner's stated goals, experience level, and chosen depth. A lesson for a beginner reads very differently from one for an experienced developer.
- CONCRETE > ABSTRACT: Every concept gets a concrete example. "A closure is a function that captures variables from its enclosing scope" is okay but "Here's a closure that remembers a counter between calls" is better.
- PROGRESSIVE COMPLEXITY: Start simple, build up. Don't front-load jargon.
- POSITION IN COURSE: This lesson exists within a larger course. Reference where it fits — what the learner covered in previous lessons (don't repeat), what upcoming lessons will build on.`;

// ── Interactive system prompt ──────────────────────────

const INTERACTIVE_SYSTEM_PROMPT = `You are an expert assessment designer for educational content. Given lesson content that a learner will read, generate inline quiz questions and a practical exercise.

## What to generate

1. **quiz** blocks (1-2): Multiple-choice comprehension checks placed AFTER the most important concepts in the lesson. Rules:
   - Set metadata.question to the question text
   - Set metadata.options to an array of exactly 4 answer choices
   - Set metadata.correctIndex to the index (0-3) of the correct answer
   - Set metadata.explanation to a 1-2 sentence explanation shown after answering (explains WHY the correct answer is right, not just restating it)
   - Questions should test UNDERSTANDING, not just recall. "What would happen if..." is better than "What is the definition of..."
   - Distractors (wrong answers) must be plausible but clearly wrong — not trick questions
   - The content field should be empty string for quiz blocks (all data is in metadata)

2. **exercise** block (exactly 1): A practical challenge the learner can do to apply what they learned. Rules:
   - Content is a markdown description of the exercise (the task description, goals, hints)
   - Should be achievable in 5-10 minutes
   - Tests the single most important skill from the lesson
   - For code topics, set these metadata fields:
     - metadata.language: the programming language (e.g., "python", "javascript", "typescript", "java", "go", "cpp", "bash")
     - metadata.starterCode: pre-filled code that the learner will modify/extend. Include comments like "# Your code here" at the point where they need to write. Include any setup code (data, imports) they'll need.
     - metadata.expectedOutput: the expected stdout when the exercise is solved correctly (plain text, what print/console.log would show). This helps the learner verify their solution.
   - For non-code topics: metadata should be null, content is a thought exercise or application prompt

## Block format

Each block needs:
- id: Unique string (use "quiz-1", "quiz-2", "exercise-1")
- type: "quiz" or "exercise"
- content: Empty string for quiz (data in metadata), markdown description for exercise
- metadata: See above for quiz and exercise fields
- order: Use the order values provided to position blocks correctly

## Positioning

You will receive the lesson blocks with their order numbers. Place quiz blocks AFTER the section that covers the concept being tested. Place the exercise block BEFORE the summary block (second to last).

Return ONLY the quiz and exercise blocks. Do not return any other block types.`;

// ── Types ──────────────────────────────────────────────

interface LessonGenerationInput {
  goal: string;
  answers: { questionId: string; answer: string }[];
  depth: string;
  structure: {
    modules: {
      name: string;
      description: string;
      lessons: { name: string; description: string }[];
    }[];
  };
  moduleIndex: number;
  lessonIndex: number;
}

interface LessonOutput {
  blocks: ILessonBlock[];
  summary: string;
  heroImageUrl: string | null;
}

// ── Image generation ───────────────────────────────────

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const generateHeroImage = async (lessonName: string, moduleName: string, courseGoal: string): Promise<string | null> => {
  try {
    console.log(`[LessonService] Generating hero image...`.cyan);

    const prompt = `A clean, modern educational illustration for a lesson titled "${lessonName}" in a course about "${courseGoal}". The style should be minimal, professional, with a subtle gradient background. Use abstract geometric shapes and icons to represent the concept — no text, no people, no faces. Suitable as a hero banner image for an online learning platform.`;

    const response = await openai.images.generate({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1792x1024',
      quality: 'standard',
      response_format: 'b64_json',
    });

    const b64 = response.data?.[0]?.b64_json;
    if (!b64) return null;

    return `data:image/png;base64,${b64}`;
  } catch (e) {
    console.warn('[LessonService] Hero image generation failed:', e instanceof Error ? e.message : e);
    return null;
  }
};

// ── Curated links generation ───────────────────────────

interface CuratedLink {
  title: string;
  url: string;
  description: string;
}

const tavilySearch = new TavilySearch({
  maxResults: 5,
  tavilyApiKey: TAVILY_API_KEY,
});

const generateCuratedLinks = async (lessonName: string, moduleName: string, courseGoal: string): Promise<ILessonBlock | null> => {
  try {
    console.log(`[LessonService] Searching for curated links...`.cyan);

    const query = `${lessonName} ${moduleName} tutorial documentation official guide`;
    const results = await tavilySearch.invoke({ query });

    console.log(`[LessonService] Tavily result type: ${typeof results}, isArray: ${Array.isArray(results)}`.gray);
    console.log(`[LessonService] Tavily result keys: ${typeof results === 'object' && results ? Object.keys(results as object).join(', ') : 'N/A'}`.gray);
    console.log(`[LessonService] Tavily result preview: ${JSON.stringify(results).slice(0, 500)}`.gray);

    // Tavily returns different shapes depending on the wrapper:
    // - Raw API object: { results: [{ url, title, content }], ... }
    // - LangChain array: [{ url, title, content }]
    // - Formatted string: plain text with URLs
    let links: CuratedLink[] = [];
    const raw = results as Record<string, unknown>;

    let items: Array<{ title?: string; url?: string; content?: string }> = [];
    if (raw && Array.isArray(raw.results)) {
      items = raw.results;
    } else if (Array.isArray(results)) {
      items = results;
    }

    if (items.length > 0) {
      links = items
        .filter((r) => r.url && r.title)
        .slice(0, 5)
        .map((r) => ({
          title: r.title ?? '',
          url: r.url ?? '',
          description: (r.content ?? '').slice(0, 150).trim(),
        }));
    }

    console.log(`[LessonService] Parsed ${links.length} links`.gray);

    if (links.length === 0) return null;

    const content = links
      .map((l) => `- [${l.title}](${l.url}) — ${l.description}`)
      .join('\n');

    return {
      id: 'links-1',
      type: 'links',
      content,
      metadata: { links },
      order: 9999, // Will be repositioned after merge
    };
  } catch (e) {
    console.warn('[LessonService] Curated links generation failed:', e instanceof Error ? e.message : e);
    return null;
  }
};

// ── Helpers ────────────────────────────────────────────

const formatAnswers = (answers: { questionId: string; answer: string }[]) =>
  answers.map((a) => `- ${a.questionId}: ${sanitizePromptInput(a.answer)}`).join('\n');

const formatCourseOutline = (
  structure: LessonGenerationInput['structure'],
  currentModuleIndex: number,
  currentLessonIndex: number,
) => {
  return structure.modules
    .map((mod, mi) => {
      const moduleHeader = `Module ${mi + 1}: ${mod.name}`;
      const lessons = mod.lessons
        .map((lesson, li) => {
          const marker = mi === currentModuleIndex && li === currentLessonIndex ? ' ← CURRENT LESSON' : '';
          return `    ${li + 1}. ${lesson.name} — ${lesson.description}${marker}`;
        })
        .join('\n');
      return `${moduleHeader}\n  ${mod.description}\n${lessons}`;
    })
    .join('\n\n');
};

const formatBlocksForContext = (blocks: ILessonBlock[]) => {
  return blocks
    .map((b) => `[order=${b.order}] [${b.type}] ${b.content.slice(0, 300)}${b.content.length > 300 ? '...' : ''}`)
    .join('\n\n');
};

// ── Build prompts (shared) ─────────────────────────────

const buildLessonPrompts = (params: LessonGenerationInput) => {
  const { answers, depth, structure, moduleIndex, lessonIndex } = params;
  const goal = sanitizePromptInput(params.goal);

  const mod = structure.modules[moduleIndex];
  const lesson = mod.lessons[lessonIndex];
  const courseOutline = formatCourseOutline(structure, moduleIndex, lessonIndex);

  const positionContext: string[] = [];
  if (moduleIndex > 0 || lessonIndex > 0) {
    const prevLessons: string[] = [];
    for (let mi = 0; mi <= moduleIndex; mi++) {
      const lessonLimit = mi === moduleIndex ? lessonIndex : structure.modules[mi].lessons.length;
      for (let li = 0; li < lessonLimit; li++) {
        prevLessons.push(structure.modules[mi].lessons[li].name);
      }
    }
    if (prevLessons.length > 0) {
      positionContext.push(`Previous lessons already covered: ${prevLessons.join(', ')}. Do NOT repeat content from these lessons.`);
    }
  }

  const nextLessons: string[] = [];
  for (let li = lessonIndex + 1; li < mod.lessons.length; li++) {
    nextLessons.push(mod.lessons[li].name);
  }
  if (nextLessons.length > 0) {
    positionContext.push(`Upcoming lessons in this module: ${nextLessons.join(', ')}. You may reference these to set expectations but do not teach their content.`);
  }

  const humanMessage = `## Course context

Learning goal: ${goal}
Course depth: ${depth}

Learner's answers to clarifying questions:
${formatAnswers(answers)}

## Full course outline

${courseOutline}

## Lesson to generate

Module ${moduleIndex + 1}: ${mod.name}
Lesson ${lessonIndex + 1}: ${lesson.name}
Description: ${lesson.description}

${positionContext.length > 0 ? `## Position context\n\n${positionContext.join('\n\n')}` : ''}

Generate the full lesson content as structured blocks.`;

  return { goal, mod, lesson, humanMessage };
};

const buildInteractivePrompt = (
  contentBlocks: ILessonBlock[],
  lessonName: string,
  lessonDescription: string,
  depth: string,
) => {
  const summaryBlock = contentBlocks.find((b) => b.type === 'summary');
  const maxContentOrder = Math.max(...contentBlocks.map((b) => b.order));

  return `## Lesson content

${formatBlocksForContext(contentBlocks)}

## Lesson info

Title: ${lessonName}
Description: ${lessonDescription}
Course depth: ${depth}

## Positioning instructions

The content blocks use order values 0 through ${maxContentOrder}.
- Place quiz blocks by inserting them between existing content blocks. Use decimal orders to insert between integers (e.g., 2.5 to place between order 2 and 3). Pick positions AFTER the section that teaches the concept being tested.
- Place the exercise block at order ${summaryBlock ? summaryBlock.order - 0.5 : maxContentOrder + 1} (just before the summary).

Generate 1-2 quiz blocks and 1 exercise block.`;
};

const mergeAllBlocks = (
  contentBlocks: ILessonBlock[],
  interactiveBlocks: ILessonBlock[],
  linksBlock: ILessonBlock | null,
): ILessonBlock[] => {
  const allBlocks = [...contentBlocks, ...interactiveBlocks];
  if (linksBlock) {
    const maxOrder = Math.max(...allBlocks.map((b) => b.order));
    linksBlock.order = maxOrder + 1;
    allBlocks.push(linksBlock);
  }
  return allBlocks;
};

// ── Non-streaming (used by jobRunner) ──────────────────

export const generateLessonContent = async (params: LessonGenerationInput): Promise<LessonOutput> => {
  const { goal, mod, lesson, humanMessage } = buildLessonPrompts(params);

  console.log(`[LessonService] Generating content blocks...`.cyan);
  const contentResult = await withRetry(() =>
    getLessonModel().withStructuredOutput(contentOutputSchema).invoke([
      new SystemMessage(LESSON_SYSTEM_PROMPT),
      new HumanMessage(humanMessage),
    ]),
  );

  console.log(`[LessonService] Generating interactive + hero image + links (parallel)...`.cyan);
  const interactivePrompt = buildInteractivePrompt(contentResult.blocks, lesson.name, lesson.description, params.depth);

  const [interactiveResult, heroImageUrl, linksBlock] = await Promise.all([
    withRetry(() =>
      getInteractiveModel().withStructuredOutput(interactiveOutputSchema).invoke([
        new SystemMessage(INTERACTIVE_SYSTEM_PROMPT),
        new HumanMessage(interactivePrompt),
      ]),
    ),
    generateHeroImage(lesson.name, mod.name, goal),
    generateCuratedLinks(lesson.name, mod.name, goal),
  ]);

  return {
    blocks: mergeAllBlocks(contentResult.blocks, interactiveResult.blocks, linksBlock),
    summary: contentResult.summary,
    heroImageUrl,
  };
};

// ── Streaming (used by SSE controller) ─────────────────

export interface StreamCallbacks {
  onContentBlocks: (blocks: ILessonBlock[], summary: string) => void;
  onInteractiveBlocks: (blocks: ILessonBlock[]) => void;
  onHeroImage: (url: string) => void;
  onLinksBlock: (block: ILessonBlock) => void;
}

export const generateLessonContentStreaming = async (
  params: LessonGenerationInput,
  callbacks: StreamCallbacks,
): Promise<LessonOutput> => {
  const { goal, mod, lesson, humanMessage } = buildLessonPrompts(params);

  // ── Phase 1: Content (sequential) ────────────────────
  console.log(`[LessonService] [stream] Generating content blocks...`.cyan);
  const contentResult = await withRetry(() =>
    getLessonModel().withStructuredOutput(contentOutputSchema).invoke([
      new SystemMessage(LESSON_SYSTEM_PROMPT),
      new HumanMessage(humanMessage),
    ]),
  );

  // Emit content blocks immediately — client sees content now
  callbacks.onContentBlocks(contentResult.blocks, contentResult.summary);

  // ── Phase 2: Parallel (fire callbacks as each resolves) ──
  console.log(`[LessonService] [stream] Generating interactive + hero image + links (parallel)...`.cyan);
  const interactivePrompt = buildInteractivePrompt(contentResult.blocks, lesson.name, lesson.description, params.depth);

  const interactivePromise = withRetry(() =>
    getInteractiveModel().withStructuredOutput(interactiveOutputSchema).invoke([
      new SystemMessage(INTERACTIVE_SYSTEM_PROMPT),
      new HumanMessage(interactivePrompt),
    ]),
  ).then((result) => {
    callbacks.onInteractiveBlocks(result.blocks);
    return result;
  });

  const imagePromise = generateHeroImage(lesson.name, mod.name, goal).then((url) => {
    if (url) callbacks.onHeroImage(url);
    return url;
  });

  const linksPromise = generateCuratedLinks(lesson.name, mod.name, goal).then((block) => {
    if (block) callbacks.onLinksBlock(block);
    return block;
  });

  const [interactiveResult, heroImageUrl, linksBlock] = await Promise.all([
    interactivePromise,
    imagePromise,
    linksPromise,
  ]);

  return {
    blocks: mergeAllBlocks(contentResult.blocks, interactiveResult.blocks, linksBlock),
    summary: contentResult.summary,
    heroImageUrl,
  };
};
