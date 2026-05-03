import { z } from 'zod';
import * as Sentry from '@sentry/node';
import { HumanMessage } from '@langchain/core/messages';
import { getInteractiveModel, getUtilityModel } from '@lib/langchain';
import { cachedSystemMessage } from '@lib/ai/cacheControl';
import { COURSE_DOMAINS, CourseDomain } from '@lib/constants';
import { sanitizeLatex } from '@lib/latexSanitizer';
import { sanitizeArtifacts } from '@lib/artifactSanitizer';
import {
  bumpArtifactScrubStrips,
  bumpArtifactScrubGutted,
  bumpQuizDistractorLintRetry,
  bumpQuizDistractorLintHardFail,
  bumpQuizDistractorLintRepaired,
  bumpQuizDistractorLintLengthOnlyShipped,
  bumpQuizHaikuAttempt,
  bumpQuizSonnetEscalation,
} from '@lib/metrics';
import { withRetry } from '@lib/retry';
import { lintDistractors, repairDistractors } from '@lib/ai/distractorLint';
import { lintQuizIntegrity } from '@lib/ai/quizIntegrityLint';
import { genLog } from '@lib/loggers';
import { QuizState } from '../state';
import { quizOutputSchema, buildModuleQuizSystemPrompt, quizQuestionSchema } from '../prompts';
import { shuffleQuizOptions } from './shuffleQuizOptions';

type QuizQuestion = z.infer<typeof quizQuestionSchema>;

const GUTTED_EXPLANATION_FALLBACK = 'See the source lessons for the rationale.';

// See `interactiveGeneration.ts` — one retry max, attempt 3 was diminishing
// returns and the prompt reframing + worked example should raise first-try
// pass rate.
const MAX_DISTRACTOR_LINT_ATTEMPTS = 2;

type QuizLintViolation = { id: string; reasons: string[] };

// See `interactiveGeneration.ts` for rationale — length-uniformity is low-
// signal when it's the only residual reason; the skim-gaming guard is
// `correct-not-longest`. Retrying on it creates a seesaw where the model
// shortens the correct answer past the band.
const LENGTH_ONLY_REASON = 'length-uniformity';

const actionableReasonsOf = (violation: QuizLintViolation): string[] =>
  violation.reasons.filter((r) => r !== LENGTH_ONLY_REASON);

const isActionableViolation = (violation: QuizLintViolation): boolean =>
  actionableReasonsOf(violation).length > 0;

const LINT_REASON_HINT: Record<string, string> = {
  'length-uniformity': 'all four options must be within ±35% of the median character length — move the short/long outliers toward the median, preferably by lengthening short distractors with plausible elaboration rather than shortening the correct answer',
  'correct-is-longest': 'the correct answer cannot be strictly the longest option — tighten it or lengthen the distractors so at least one ties or exceeds it',
  'distractor-absolute-qualifier': 'distractors contain "always / never / only / all / none / every / any" while the correct answer does not — strip those absolute qualifiers from distractors (or add one to the correct answer)',
  'duplicate-options': 'two or more options have identical text after trimming and casefolding — generate four distinct distractors with different misconceptions, no near-duplicates',
  'truncated-correct': 'the correct option appears truncated (ends mid-clause / on a trailing conjunction / as an unbalanced quote / as a SQL fragment shorter than peers) — rewrite it as a complete self-contained answer',
  'explanation-mismatch': 'the explanation argues for a different option than `correctIndex` points to (textual cite or signature-token overlap disagrees) — re-read the explanation and either (a) update correctIndex to match what the explanation actually justifies, or (b) rewrite the explanation to defend the option at correctIndex',
};

const lintQuizQuestions = (questions: QuizQuestion[]): QuizLintViolation[] => {
  const out: QuizLintViolation[] = [];
  for (const q of questions) {
    const styleLint = lintDistractors({ options: q.options, correctIndex: q.correctIndex });
    const integrityLint = lintQuizIntegrity({
      options: q.options,
      correctIndex: q.correctIndex,
      explanation: q.explanation,
    });
    const merged = [...styleLint.reasons, ...integrityLint.reasons];
    if (merged.length > 0) out.push({ id: q.id, reasons: merged });
  }
  return out;
};

// Final-attempt mechanical repair pass. Mirrors `repairQuizBlocks` in
// interactiveGeneration.ts; question-level shape differs (options and
// correctIndex live directly on the question, not in a metadata object).
// Mutates `question.options` in place on repair; residual lint reasons are
// returned so the caller can still hard-fail-log whatever survived.
const repairQuizQuestions = ({
  questions,
  violations,
}: {
  questions: QuizQuestion[];
  violations: QuizLintViolation[];
}): { residual: QuizLintViolation[]; repairedIds: string[] } => {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const repairedIds: string[] = [];
  const residual: QuizLintViolation[] = [];

  for (const v of violations) {
    const q = byId.get(v.id);
    if (!q) {
      residual.push(v);
      continue;
    }

    const repair = repairDistractors({ options: q.options, correctIndex: q.correctIndex });
    if (!repair.changed) {
      residual.push(v);
      continue;
    }

    q.options = repair.options;

    // Re-lint with BOTH style and integrity. `repairDistractors` only
    // addresses style violations (`correct-is-longest`, `distractor-
    // absolute-qualifier`); integrity violations (`duplicate-options`,
    // `truncated-correct`, `explanation-mismatch`) survive any repair.
    // Without re-checking integrity here, a question with both kinds of
    // violations would be marked `repairedIds` after the style fix and
    // ship with the integrity violation silently intact.
    const postStyle = lintDistractors({ options: repair.options, correctIndex: q.correctIndex });
    const postIntegrity = lintQuizIntegrity({
      options: repair.options,
      correctIndex: q.correctIndex,
      explanation: q.explanation,
    });
    const postReasons = [...postStyle.reasons, ...postIntegrity.reasons];
    if (postReasons.length === 0) {
      repairedIds.push(v.id);
    } else {
      residual.push({ id: v.id, reasons: postReasons });
    }
  }

  return { residual, repairedIds };
};

const buildDistractorLintFeedback = ({
  questions,
  violations,
}: {
  questions: QuizQuestion[];
  violations: QuizLintViolation[];
}): HumanMessage => {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const perQuestion = violations
    .map((v) => {
      const q = byId.get(v.id);
      const options = q ? q.options.map((o, i) => `    ${i}: ${o}`).join('\n') : '    (options unavailable)';
      const correctIndex = q ? q.correctIndex : -1;
      const reasons = v.reasons.map((r) => `  - ${r}: ${LINT_REASON_HINT[r] ?? ''}`).join('\n');
      return `Question "${v.id}" (correctIndex=${correctIndex}):\n${options}\n${reasons}`;
    })
    .join('\n\n');

  return new HumanMessage(
    `The previous response violated distractor-quality rules on ${violations.length} question(s). Regenerate the WHOLE quiz set (same question topics), fixing the violations below. Keep correct answers semantically the same — only rewrite OPTION phrasing / length so the lint passes.\n\n${perQuestion}\n\nReminder of the rules:\n- Length discipline: lengthen distractors with plausible elaboration, keep the correct answer tighter. All four within ±35% of the median length; correct answer NOT the strictly longest.\n- No absolute qualifiers in distractors unless the correct answer also uses one.\n- Surface-intuition trap: at least one distractor shares surface features with the correct answer.`,
  );
};

/**
 * Capture diagnostic context when quiz generation fails. The concrete fault
 * mode we're tracking: the LLM returns `{}` (empty object) as the structured-
 * output tool-call input, which fails Zod validation with
 *   Failed to parse. Text: "{}". Error: [...]invalid_type...path:["questions"]
 * That's not a network or transient failure — it's the model emitting an
 * empty tool call. We send the offending context (prompt length, module
 * name, retry attempt) to Sentry + log a diagnostic line so we can correlate
 * which prompts / topics reliably cause this.
 *
 * We do NOT short-circuit retries. Retrying is the right behavior for a
 * stochastic model failure — but we want telemetry, not silence.
 */
const reportQuizGenerationFailure = ({
  state,
  error,
  attempt,
}: {
  state: QuizState;
  error: unknown;
  attempt: number;
}) => {
  const message = error instanceof Error ? error.message : String(error);
  const isEmptyTool = /Text:\s*"\{\s*\}"/.test(message);
  const humanMessageLength = state.humanMessage.length;
  const diagnostic = {
    moduleName: state.moduleName,
    humanMessageLength,
    humanMessagePreview: state.humanMessage.slice(0, 500),
    attempt,
    errorPreview: message.slice(0, 500),
    isEmptyTool,
  };
  genLog.warn(
    `quiz:generate attempt-fail attempt=${attempt} module="${state.moduleName}" promptLen=${humanMessageLength} emptyTool=${isEmptyTool}`,
  );
  Sentry.captureMessage('quizGeneration attempt failure', {
    level: 'warning',
    tags: {
      source: 'quizGeneration',
      empty_tool_call: String(isEmptyTool),
    },
    extra: diagnostic,
  });
};

/**
 * Run LaTeX + artifact sanitization on every text-bearing field of a
 * module-quiz question. Mirrors the lesson-generation path
 * (`sanitizeInteractiveBlock` in interactiveGeneration.ts) so both code
 * paths scrub in the same order with the same fallback behaviour.
 */
const sanitizeQuizQuestion = (question: QuizQuestion): { question: QuizQuestion; strips: number; gutted: number } => {
  let strips = 0;
  let gutted = 0;

  const scrub = (value: string, opts: { fallbackOnGut?: string } = {}): string => {
    const latexRes = sanitizeLatex(value);
    const artifactRes = sanitizeArtifacts(latexRes.text);
    if (artifactRes.stripped > 0) strips += artifactRes.stripped;
    if (artifactRes.gutted) {
      gutted += 1;
      if (opts.fallbackOnGut !== undefined) return opts.fallbackOnGut;
    }
    return artifactRes.text;
  };

  return {
    question: {
      ...question,
      question: scrub(question.question),
      options: question.options.map((opt) => scrub(opt)),
      explanation: scrub(question.explanation, { fallbackOnGut: GUTTED_EXPLANATION_FALLBACK }),
    },
    strips,
    gutted,
  };
};

// `state.domain` is typed `string | null` on QuizState (legacy courses predate
// the domain field). Narrow to the COURSE_DOMAINS union before handing it to
// the prompt builder so unrecognised / missing values fall through to the
// null-domain branch rather than being pasted into the prompt verbatim.
const narrowDomain = (raw: string | null): CourseDomain | null =>
  raw !== null && (COURSE_DOMAINS as readonly string[]).includes(raw) ? (raw as CourseDomain) : null;

export const quizGeneration = async (state: QuizState): Promise<Partial<QuizState>> => {
  const quizStart = Date.now();
  genLog.info(`quiz:generate start module="${state.moduleName}"`);

  try {
    // Model-tier escalation — mirror of `interactiveGeneration.ts`. Attempt
    // 1 uses Haiku, escalates to Sonnet on schema failure or distractor-
    // lint residual that survived deterministic repair. Module-quiz quality
    // depends on the synthesis across lessons plus distractor nuance; both
    // of those are still sensitive to model tier, so we measure the Sonnet
    // escalation rate and revert if it climbs past ~10%.
    const haikuModel = getUtilityModel().withStructuredOutput(quizOutputSchema);
    const sonnetModel = getInteractiveModel().withStructuredOutput(quizOutputSchema);
    let attempt = 0;
    const domain = narrowDomain(state.domain);

    // Lint-retry loop (2026-04-21 follow-up). Re-invoke with targeted
    // violation feedback on distractor-lint fail, capped at MAX attempts.
    // Final attempt ships even if still violating — shipping a flagged
    // quiz beats failing the module quiz.
    let result: z.infer<typeof quizOutputSchema> | undefined;
    let lintViolations: QuizLintViolation[] = [];
    let lintFeedback: HumanMessage | null = null;
    let lintAttempt = 0;
    while (lintAttempt < MAX_DISTRACTOR_LINT_ATTEMPTS) {
      lintAttempt += 1;
      const tier: 'haiku' | 'sonnet' = lintAttempt === 1 ? 'haiku' : 'sonnet';
      const activeModel = tier === 'haiku' ? haikuModel : sonnetModel;
      const label = tier === 'haiku' ? 'quiz:generate.haiku' : 'quiz:generate.sonnet';

      if (tier === 'haiku') bumpQuizHaikuAttempt();
      else bumpQuizSonnetEscalation();

      const messages = [cachedSystemMessage({ text: buildModuleQuizSystemPrompt({ domain }), ttl: '1h' }), new HumanMessage(state.humanMessage)];
      if (lintFeedback) messages.push(lintFeedback);

      let attempted: z.infer<typeof quizOutputSchema>;
      try {
        attempted = await withRetry(async () => {
          attempt += 1;
          try {
            return await activeModel.invoke(messages, { metadata: { llmLabel: label } });
          } catch (e) {
            reportQuizGenerationFailure({ state, error: e, attempt });
            throw e;
          }
        });
      } catch (err) {
        // Haiku hit a schema failure that withRetry couldn't recover from.
        // Escalate to Sonnet if we still have attempts left. Reset
        // `lintFeedback` because its question-id references won't apply to
        // a fresh Sonnet generation.
        if (tier === 'haiku' && lintAttempt < MAX_DISTRACTOR_LINT_ATTEMPTS) {
          genLog.warn(`quiz:generate haiku-fail reason=${err instanceof Error ? err.message : err} — escalating to Sonnet`);
          lintFeedback = null;
          continue;
        }
        throw err;
      }

      lintViolations = lintQuizQuestions(attempted.questions);
      result = attempted;

      if (lintViolations.length === 0) break;

      const actionableViolations: QuizLintViolation[] = lintViolations
        .filter(isActionableViolation)
        .map((v) => ({ id: v.id, reasons: actionableReasonsOf(v) }));
      const lengthOnlyIds = lintViolations
        .filter((v) => !isActionableViolation(v))
        .map((v) => v.id);

      if (actionableViolations.length === 0) {
        for (let i = 0; i < lengthOnlyIds.length; i++) bumpQuizDistractorLintLengthOnlyShipped();
        genLog.info(`quiz:generate lint-length-only count=${lengthOnlyIds.length} ids=${lengthOnlyIds.join(',')} — shipping (correct-not-longest holds)`);
        break;
      }

      // Repair-first: mechanical repair runs on every attempt now, not just
      // the final one. When repair clears every actionable residual, skip
      // the Sonnet retry entirely. Mutates `attempted.questions[...].options`
      // in place. See `repairDistractors` in distractorLint.ts for scope.
      const repair = repairQuizQuestions({ questions: attempted.questions, violations: actionableViolations });
      if (repair.repairedIds.length > 0) {
        for (let i = 0; i < repair.repairedIds.length; i++) bumpQuizDistractorLintRepaired();
        genLog.info(`quiz:generate lint-repair-ok cleared=${repair.repairedIds.length} ids=${repair.repairedIds.join(',')}`);
      }

      const residualActionable = repair.residual.filter(isActionableViolation);
      const residualLengthOnlyIds = [
        ...lengthOnlyIds,
        ...repair.residual.filter((v) => !isActionableViolation(v)).map((v) => v.id),
      ];

      if (residualActionable.length === 0) {
        // Repair cleared every actionable reason — ship without a retry.
        if (residualLengthOnlyIds.length > 0) {
          for (let i = 0; i < residualLengthOnlyIds.length; i++) bumpQuizDistractorLintLengthOnlyShipped();
          genLog.info(`quiz:generate lint-length-only count=${residualLengthOnlyIds.length} ids=${residualLengthOnlyIds.join(',')} — shipping`);
        }
        break;
      }

      const residualSummary = residualActionable
        .map((v) => `${v.id}=[${actionableReasonsOf(v).join(',')}]`)
        .join(' ');

      if (lintAttempt === MAX_DISTRACTOR_LINT_ATTEMPTS) {
        // Out of attempts. Ship with hard-fail log.
        bumpQuizDistractorLintHardFail();
        genLog.warn(`quiz:generate lint-hardfail attempts=${MAX_DISTRACTOR_LINT_ATTEMPTS} stillFailing=${residualActionable.length}/${attempted.questions.length} residual=${residualSummary} — shipping anyway`);
        if (residualLengthOnlyIds.length > 0) {
          for (let i = 0; i < residualLengthOnlyIds.length; i++) bumpQuizDistractorLintLengthOnlyShipped();
          genLog.info(`quiz:generate lint-length-only count=${residualLengthOnlyIds.length} ids=${residualLengthOnlyIds.join(',')} — shipping`);
        }
        break;
      }
      bumpQuizDistractorLintRetry();
      genLog.warn(`quiz:generate lint-retry attempt=${lintAttempt}/${MAX_DISTRACTOR_LINT_ATTEMPTS} residual=${residualSummary} — retrying with feedback`);
      lintFeedback = buildDistractorLintFeedback({ questions: attempted.questions, violations: residualActionable });
    }

    if (!result) throw new Error('quiz generation produced no result');

    let totalStrips = 0;
    let totalGutted = 0;
    const sanitizedQuestions = result.questions.map((q) => {
      const { question, strips, gutted } = sanitizeQuizQuestion(q);
      totalStrips += strips;
      totalGutted += gutted;
      return question;
    });

    if (totalStrips > 0) {
      bumpArtifactScrubStrips(totalStrips);
      for (let i = 0; i < totalGutted; i++) bumpArtifactScrubGutted();
      genLog.warn(`quiz:generate artifact-scrub strips=${totalStrips} gutted=${totalGutted}`);
    }

    const shuffledQuestions = sanitizedQuestions.map((question) => shuffleQuizOptions({ question }));

    genLog.info(`quiz:generate done questions=${shuffledQuestions.length} ms=${Date.now() - quizStart}`);
    return { questions: shuffledQuestions };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    genLog.error(`quiz:generate fail module="${state.moduleName}" reason=${reason}`);
    throw e;
  }
};
