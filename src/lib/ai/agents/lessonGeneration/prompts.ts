import { z } from 'zod';
import { BLOCK_TYPES } from '@models/LessonContentModel';

// ── Schemas ────────────────────────────────────────────

export const lessonBlockSchema = z.object({
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

export const contentOutputSchema = z.object({
  blocks: z.array(lessonBlockSchema),
  summary: z.string(),
});

export const interactiveOutputSchema = z.object({
  blocks: z.array(lessonBlockSchema),
});

// ── System prompts ─────────────────────────────────────

export const LESSON_SYSTEM_PROMPT = `You are a world-class educator and technical writer. You create lesson content that is clear, engaging, and deeply personalized to the learner's context.

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
   - Do NOT add diagrams just to have them — only when a visual representation genuinely reduces explanation burden
   - Keep diagrams focused — 5-15 nodes maximum
   - Do NOT wrap the mermaid code in markdown code fences — just the raw mermaid syntax

5. **callout** (0-3): Info/tip/warning/important boxes for emphasis. Rules:
   - Set metadata.variant to one of: "info", "tip", "warning", "important"
   - Place callouts inline where they naturally belong — after the concept they relate to

6. **summary** (exactly 1, last block): 4-6 bullet points of key takeaways. Each bullet states one concrete thing the learner now knows or can do.

## Block format

Each block needs:
- id: A unique string (use format "type-N", e.g., "intro-1", "section-1", "code-1", "callout-1", "summary-1")
- type: One of the types above
- content: The text content (use markdown formatting within text blocks)
- metadata: Type-specific fields (see above) or null for text-only blocks
- order: Sequential integer starting from 0

## Also produce

A "summary" field (separate from the summary block) — a 1-2 sentence plain text summary of the entire lesson.

## Quality principles

- PERSONALIZE: Reference the learner's stated goals, experience level, and chosen depth.
- CONCRETE > ABSTRACT: Every concept gets a concrete example.
- PROGRESSIVE COMPLEXITY: Start simple, build up. Don't front-load jargon.
- POSITION IN COURSE: Reference where this lesson fits — what previous lessons covered (don't repeat), what upcoming lessons will build on.`;

export const INTERACTIVE_SYSTEM_PROMPT = `You are an expert assessment designer for educational content. Given lesson content that a learner will read, generate inline quiz questions and a practical exercise.

## What to generate

1. **quiz** blocks (1-2): Multiple-choice comprehension checks placed AFTER the most important concepts in the lesson. Rules:
   - Set metadata.question to the question text
   - Set metadata.options to an array of exactly 4 answer choices
   - Set metadata.correctIndex to the index (0-3) of the correct answer
   - Set metadata.explanation to a 1-2 sentence explanation shown after answering
   - Questions should test UNDERSTANDING, not just recall
   - The content field should be empty string for quiz blocks (all data is in metadata)

2. **exercise** block (exactly 1): A practical challenge the learner can do to apply what they learned. Rules:
   - Content is a markdown description of the exercise
   - Should be achievable in 5-10 minutes
   - For code topics, set these metadata fields:
     - metadata.language: the programming language
     - metadata.starterCode: pre-filled code the learner will modify/extend
     - metadata.expectedOutput: the expected stdout when solved correctly
   - For non-code topics: metadata should be null

## Block format

- id: Unique string (use "quiz-1", "quiz-2", "exercise-1")
- type: "quiz" or "exercise"
- content: Empty string for quiz, markdown description for exercise
- metadata: See above
- order: Use the order values provided to position blocks correctly

## Positioning

Place quiz blocks AFTER the section that covers the concept being tested (use decimal orders like 2.5). Place the exercise block just before the summary.

Return ONLY the quiz and exercise blocks.`;
