import Anthropic from '@anthropic-ai/sdk';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

/**
 * Structured hand-off primitive — used by both the lesson-scoped and
 * course-scoped mentors to render an inline, clickable navigation button
 * under their reply.
 *
 * Why a tool (rather than a free-text marker the client parses): the
 * agent's existing tool-result plumbing already streams a structured
 * JSON payload to the client through the SSE `tool-output-available`
 * event. The client recognises `toolName === 'emit_handoff'` and renders
 * a `<HandoffButton>` instead of the standard tool badge. No new SSE
 * event types, no client-side text parsing, no opportunity for the
 * model to emit malformed link syntax.
 *
 * The tool's execute function is **load-bearing** — it validates the
 * input against the course structure before returning success. The LLM
 * can hallucinate a lesson index that doesn't exist; we want the agent
 * to self-correct (via the existing `tools → chat` back-edge) rather
 * than the client rendering a broken button.
 *
 * Targets:
 *   - 'quiz' — module quiz. Requires moduleIndex; rejected when not
 *     all lessons in that module have content generated (the quiz
 *     can't be taken until lessons are ready).
 *   - 'lesson' — a specific lesson. Requires moduleIndex+lessonIndex;
 *     rejected when out of range. Does NOT require the lesson to be
 *     generated — opening an ungenerated lesson is a valid action and
 *     the lesson screen handles that state itself.
 *   - 'recall' — the global recall practice queue. No params.
 */

export interface ModuleHandoffInfo {
  /** Total lessons in this module. */
  lessonsCount: number;
  /** Number of lessons in this module whose content has been generated (LessonContent.completed=true). */
  lessonsGeneratedCount: number;
}

/**
 * The validation context the controller MUST pass through `config.configurable`.
 * Both controllers compute this from the course they already load. Without
 * it the tool returns a generic error and the agent falls back to plain text.
 */
export interface HandoffValidationContext {
  /** Per-module info. Index in the array IS the moduleIndex. */
  modules: ModuleHandoffInfo[];
}

const HANDOFF_TARGETS = ['quiz', 'recall', 'lesson'] as const;
type HandoffTarget = (typeof HANDOFF_TARGETS)[number];

interface HandoffSuccess {
  ok: true;
  target: HandoffTarget;
  moduleIndex?: number;
  lessonIndex?: number;
  label: string;
}

interface HandoffFailure {
  ok: false;
  error:
    | 'missing_validation_context'
    | 'module_not_in_structure'
    | 'lesson_not_in_structure'
    | 'lessons_not_ready'
    | 'missing_module_index'
    | 'missing_lesson_index'
    | 'invalid_target';
  message: string;
}

const failure = (
  error: HandoffFailure['error'],
  message: string,
): HandoffFailure => ({ ok: false, error, message });

const trimLabel = (raw: string | undefined, fallback: string): string => {
  const stripped = (raw ?? '').trim();
  if (!stripped) return fallback;
  // Cap at ~50 chars for safety; the system prompt asks for ≤5 words
  // but a verbose model might overshoot.
  return stripped.length > 50 ? `${stripped.slice(0, 47)}…` : stripped;
};

/**
 * Validate a handoff against the course structure. Pure function — easy
 * to unit-test. Returns a discriminated union the agent's tool wrapper
 * forwards to the client (success → render button, failure → agent
 * sees the error and self-corrects on next iteration).
 */
export const validateHandoff = (
  input: { target: HandoffTarget; moduleIndex?: number; lessonIndex?: number; label: string },
  ctx: HandoffValidationContext | undefined,
): HandoffSuccess | HandoffFailure => {
  if (input.target === 'recall') {
    return {
      ok: true,
      target: 'recall',
      label: trimLabel(input.label, 'Open recall'),
    };
  }

  if (!ctx) {
    return failure(
      'missing_validation_context',
      'Tool context did not include course structure; cannot validate handoff.',
    );
  }

  if (input.target === 'quiz') {
    if (input.moduleIndex === undefined) {
      return failure('missing_module_index', "target='quiz' requires moduleIndex.");
    }
    const mod = ctx.modules[input.moduleIndex];
    if (!mod) {
      return failure(
        'module_not_in_structure',
        `Module index ${input.moduleIndex} is not in the course structure (have ${ctx.modules.length} modules).`,
      );
    }
    if (mod.lessonsGeneratedCount < mod.lessonsCount) {
      return failure(
        'lessons_not_ready',
        `Module ${input.moduleIndex} has ${mod.lessonsGeneratedCount}/${mod.lessonsCount} lessons generated; the module quiz unlocks only when all lessons are ready. Suggest the learner generate the remaining lessons first instead of pointing them at the quiz.`,
      );
    }
    return {
      ok: true,
      target: 'quiz',
      moduleIndex: input.moduleIndex,
      label: trimLabel(input.label, `Take the module ${input.moduleIndex + 1} quiz`),
    };
  }

  if (input.target === 'lesson') {
    if (input.moduleIndex === undefined) {
      return failure('missing_module_index', "target='lesson' requires moduleIndex.");
    }
    if (input.lessonIndex === undefined) {
      return failure('missing_lesson_index', "target='lesson' requires lessonIndex.");
    }
    const mod = ctx.modules[input.moduleIndex];
    if (!mod) {
      return failure(
        'module_not_in_structure',
        `Module index ${input.moduleIndex} is not in the course structure (have ${ctx.modules.length} modules).`,
      );
    }
    if (input.lessonIndex >= mod.lessonsCount) {
      return failure(
        'lesson_not_in_structure',
        `Lesson index ${input.lessonIndex} is out of range for module ${input.moduleIndex} (have ${mod.lessonsCount} lessons).`,
      );
    }
    return {
      ok: true,
      target: 'lesson',
      moduleIndex: input.moduleIndex,
      lessonIndex: input.lessonIndex,
      label: trimLabel(input.label, `Open lesson ${input.lessonIndex + 1}`),
    };
  }

  return failure('invalid_target', `Unknown target '${input.target}'.`);
};

/**
 * The LangChain tool consumed by the ToolNode of both agents. Wraps
 * `validateHandoff` and reads the validation context from configurable.
 *
 * The tool result is a JSON string (LangChain's tool-result convention).
 * The client parses it and renders accordingly.
 */
export const emitHandoffTool = tool(
  async (input, config) => {
    const ctx = config?.configurable?.handoffContext as HandoffValidationContext | undefined;
    const result = validateHandoff(input, ctx);
    return JSON.stringify(result);
  },
  {
    name: 'emit_handoff',
    description:
      'Render an inline navigation button under your reply that takes the learner to a quiz, the recall queue, or a specific lesson. Use this whenever you would otherwise tell them to "open lesson X", "take the module quiz", or "review your recall cards" — the button speaks for itself, so do not narrate the tool call. One handoff per recommendation; up to two handoffs per turn.',
    schema: z.object({
      target: z
        .enum(HANDOFF_TARGETS)
        .describe("Where the button takes the learner: 'quiz' (module quiz), 'recall' (global recall practice queue), or 'lesson' (a specific lesson)."),
      moduleIndex: z
        .number()
        .optional()
        .describe("Required for target='quiz' and target='lesson'. Zero-indexed."),
      lessonIndex: z
        .number()
        .optional()
        .describe("Required for target='lesson'. Zero-indexed."),
      label: z
        .string()
        .describe('Button label, max ~5 words (e.g. "Take the module quiz", "Open lesson 4", "Go to recall").'),
    }),
  },
);

/**
 * Anthropic-side tool schema — duplicated structure (the model talks
 * to the raw SDK in our chat nodes, not via LangChain's auto-derivation).
 * Keep in sync with `emitHandoffTool`'s Zod schema above; both agents
 * import this constant so a change here lands in both at once.
 */
export const EMIT_HANDOFF_ANTHROPIC_TOOL: Anthropic.Messages.Tool = {
  name: 'emit_handoff',
  description:
    'Render an inline navigation button under your reply that takes the learner to a quiz, the recall queue, or a specific lesson. Use this whenever you would otherwise tell them to "open lesson X", "take the module quiz", or "review your recall cards" — the button speaks for itself, so do not narrate the tool call. One handoff per recommendation; up to two handoffs per turn.',
  input_schema: {
    type: 'object' as const,
    properties: {
      target: {
        type: 'string',
        enum: ['quiz', 'recall', 'lesson'],
        description:
          "Where the button takes the learner: 'quiz' (module quiz), 'recall' (global recall practice queue), or 'lesson' (a specific lesson).",
      },
      moduleIndex: {
        type: 'number',
        description: "Required for target='quiz' and target='lesson'. Zero-indexed.",
      },
      lessonIndex: {
        type: 'number',
        description: "Required for target='lesson'. Zero-indexed.",
      },
      label: {
        type: 'string',
        description:
          'Button label, max ~5 words (e.g. "Take the module quiz", "Open lesson 4", "Go to recall").',
      },
    },
    required: ['target', 'label'],
  },
};

/**
 * Helper for controllers — given a course structure (modules with
 * lessons arrays) and a count of generated lessons per module,
 * produce the validation context for `emitHandoffTool`. Centralises
 * the shape so both controllers compute it identically.
 */
export const buildHandoffValidationContext = ({
  modules,
  generatedCountByModule,
}: {
  modules: { lessons: { name: string }[] }[];
  generatedCountByModule: number[];
}): HandoffValidationContext => ({
  modules: modules.map((m, mi) => ({
    lessonsCount: m.lessons.length,
    lessonsGeneratedCount: generatedCountByModule[mi] ?? 0,
  })),
});
