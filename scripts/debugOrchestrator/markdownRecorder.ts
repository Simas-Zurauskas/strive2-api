import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import type {
  Persona,
  StepResult,
  CourseData,
  ClarifyQuestion,
  DepthPreviews,
  CourseStructure,
  ILessonContent,
  ILessonBlock,
  LessonContentStats,
  ModuleQuizForLearner,
  ModuleQuizAttemptRecord,
  RecallReviewResult,
  CourseMentorRecord,
  LessonMentorRecord,
  GoalTypeClassificationSnapshot,
  GoalTypeOverrideRecord,
  GoalType,
  CostEvent,
  CostSummary,
} from './types';
import type { ApiClient } from './apiClient';
import type { ClarifyCueAssertion, StructureConformanceAssertion } from './goalTypeAssertions';
import type { GetRecallQueueResult, RecallStats } from '@services/recallQueueService';

/**
 * Per-persona credit-spend tracker. Snapshots `/api/billing/summary` at
 * step boundaries; the delta between consecutive snapshots is attributed
 * to the step that just completed.
 *
 * Reliability contract: snapshot failures (e.g. transient API hiccup) are
 * non-fatal — they emit a stderr warning and skip the event so a flaky
 * billing endpoint never aborts a persona flow. The tracker keeps the
 * last-known balance as `previousBalance` so the next successful snapshot
 * still computes a sensible delta against the most recent good reading.
 */
export class CostTracker {
  private startBalance: number | null = null;
  private previousBalance: number | null = null;
  private events: CostEvent[] = [];
  /**
   * Promise-chain queue for snapshots. Callers can `enqueueSnapshot()` from
   * synchronous contexts (e.g. inside `beginStep().finish()`); the chain
   * serializes the underlying HTTP requests so `previousBalance` is always
   * the post-balance of the previous-completed snapshot when the next one
   * runs. Without this, two fire-and-forget snapshots could read the same
   * stale `previousBalance` and produce a duplicate-zero-delta event.
   */
  private snapshotQueue: Promise<void> = Promise.resolve();

  constructor(private readonly client: Pick<ApiClient, 'getBillingSummary'>) {}

  /** Capture the persona's starting balance. Idempotent — only records once. */
  async initialize(): Promise<void> {
    if (this.startBalance !== null) return;
    try {
      const { total } = await this.client.getBillingSummary();
      this.startBalance = total;
      this.previousBalance = total;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Soft-fail: cost tracking is analytics, not the persona's job
      // contract. Mark startBalance so subsequent snapshots still try.
      console.warn(`[CostTracker] initialize failed (${reason}) — cost summary will be empty`);
      this.startBalance = 0;
      this.previousBalance = 0;
    }
  }

  /**
   * Enqueue a snapshot to fire after all previously-enqueued snapshots
   * resolve. Returns immediately — call `drain()` before reading
   * `summary()` to ensure the queue has emptied.
   */
  enqueueSnapshot(label: string): void {
    this.snapshotQueue = this.snapshotQueue.then(() => this.takeSnapshot(label));
  }

  /** Synchronous-style snapshot. Awaits the queue first to keep ordering. */
  async snapshot(label: string): Promise<void> {
    this.enqueueSnapshot(label);
    return this.snapshotQueue;
  }

  /** Wait for any enqueued snapshots to complete. Safe to call multiple times. */
  async drain(): Promise<void> {
    await this.snapshotQueue;
  }

  /** Build the final summary. Safe to call even if initialize() never fired. */
  summary(): CostSummary {
    const startBalance = this.startBalance ?? 0;
    const endBalance = this.previousBalance ?? startBalance;
    return {
      startBalance,
      endBalance,
      totalSpent: startBalance - endBalance,
      events: this.events,
    };
  }

  private async takeSnapshot(label: string): Promise<void> {
    if (this.previousBalance === null) {
      // initialize() wasn't called or failed silently — try to recover.
      await this.initialize();
    }
    try {
      const { total } = await this.client.getBillingSummary();
      const balanceBefore = this.previousBalance ?? total;
      const event: CostEvent = {
        label,
        balanceBefore,
        balanceAfter: total,
        deltaCredits: balanceBefore - total,
        ts: new Date(),
      };
      this.events.push(event);
      this.previousBalance = total;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[CostTracker] snapshot('${label}') failed (${reason}) — skipping this event`);
    }
  }
}

export class MarkdownRecorder {
  private sections: string[] = [];
  private persona: Persona | null = null;
  private courseId: string = '';
  private runStart: Date = new Date();

  setPersona(persona: Persona): void {
    this.persona = persona;
    this.runStart = new Date();
  }

  setCourseId(courseId: string): void {
    this.courseId = courseId;
  }

  addHeader(): void {
    const p = this.persona!;
    const overrideLine = p.goalTypeOverrideTarget
      ? ` → would switch to **${p.goalTypeOverrideTarget}** via the chip if given the chance`
      : '';
    this.sections.push(`# Debug Orchestrator Report: ${p.name}
Generated: ${new Date().toISOString()}

## Persona Profile
- **Name:** ${p.name}
- **Background:** ${p.background}
- **Goal:** "${p.goal}"
- **Personality:** ${p.personality}
- **Priorities:** ${p.priorities}

### Predicted Goal Type (ground truth for the classifier)
- **predictedGoalType:** \`${p.predictedGoalType}\`${overrideLine}
- **Reasoning:** ${p.predictedGoalTypeReasoning}

### Predicted Behavior
- **Survey style:** ${p.wizardBehavior.surveyStyle}
- **Depth choice:** ${p.wizardBehavior.depthChoice}
- **Structure review:** ${p.wizardBehavior.structureReview}
- **Quiz attempt style:** ${p.wizardBehavior.quizAttemptStyle}
- **Recall review style:** ${p.wizardBehavior.recallReviewStyle}
`);
  }

  addStep1_CreateCourse({ result, courseId }: { result: StepResult; courseId: string }): void {
    this.sections.push(`---

## Step 1: Create Course (${fmtDuration(result.durationMs)})
**Course ID:** \`${courseId}\`
**Goal submitted:** "${this.persona!.goal}"
`);
  }

  addStep2_Clarify({
    result,
    questions,
    pollDuration,
    classification,
    predictedGoalType,
    predictedGoalTypeReasoning,
  }: {
    result: StepResult;
    questions: ClarifyQuestion[];
    pollDuration: number;
    classification: GoalTypeClassificationSnapshot;
    predictedGoalType: GoalType;
    predictedGoalTypeReasoning: string;
  }): void {
    let questionsTable = '| # | Question | Type | Options |\n|---|----------|------|---------|';
    for (const q of questions) {
      const opts = q.options ? q.options.join(', ') : '_free text_';
      questionsTable += `\n| ${q.id} | ${q.question} | ${q.type} | ${opts} |`;
    }

    // Classifier output sub-section. Surfaces the three orthogonal signals
    // the assessor scores: classification accuracy (predicted vs classified),
    // confidence calibration (high on clear cases, low on garbage), and
    // chip-label noun quality.
    const match = classification.goalType === predictedGoalType ? 'YES' : 'NO';
    const classifierBlock = `### Goal Type Classification
- **Predicted (ground truth):** \`${predictedGoalType}\`
- **Predicted reasoning:** ${predictedGoalTypeReasoning}
- **Classified (api):** \`${classification.goalType ?? 'null'}\`
- **Confidence:** \`${classification.confidence ?? 'null'}\`
- **Chip-label noun:** ${classification.noun ? `"${classification.noun}"` : '_none_'}
- **Match:** ${match}`;

    this.sections.push(`---

## Step 2: Clarify Questions (${fmtDuration(result.durationMs)})
**Job poll duration:** ${fmtDuration(pollDuration)}
**Questions generated:** ${questions.length}

${classifierBlock}

${questionsTable}
`);
  }

  addStep2b_GoalTypeOverride(rec: GoalTypeOverrideRecord): void {
    const fmtSnapshot = (s: GoalTypeClassificationSnapshot): string =>
      `goalType=\`${s.goalType ?? 'null'}\`, confidence=\`${s.confidence ?? 'null'}\`, noun=${s.noun ? `"${s.noun}"` : '_none_'}`;

    let questionsBefore = '| # | Question | Type |\n|---|----------|------|';
    for (const q of rec.clarifyQuestionsBefore) {
      questionsBefore += `\n| ${q.id} | ${escapeCell(q.question)} | ${q.type} |`;
    }
    let questionsAfter = '| # | Question | Type |\n|---|----------|------|';
    for (const q of rec.clarifyQuestionsAfter) {
      questionsAfter += `\n| ${q.id} | ${escapeCell(q.question)} | ${q.type} |`;
    }

    // Diff signal — the assessor needs to know whether the questions
    // actually changed shape (the whole point of the chip override). A
    // post-override clarify that re-emits identical questions implies
    // the goalType tilt isn't load-bearing inside the api prompt.
    const beforeJoined = rec.clarifyQuestionsBefore.map((q) => q.question).join('|');
    const afterJoined = rec.clarifyQuestionsAfter.map((q) => q.question).join('|');
    const questionsChanged = beforeJoined !== afterJoined ? 'YES' : 'NO (regression — chip toggle did not regenerate questions)';

    this.sections.push(`---

## Step 2b: Goal-Type Override (${fmtDuration(rec.durationMs)})
**Target:** \`${rec.target}\`
**Before:** ${fmtSnapshot(rec.before)}
**After:** ${fmtSnapshot(rec.after)}
**Questions regenerated:** ${questionsChanged}

<details>
<summary>Clarify questions BEFORE override (${rec.clarifyQuestionsBefore.length})</summary>

${questionsBefore}

</details>

<details>
<summary>Clarify questions AFTER override (${rec.clarifyQuestionsAfter.length})</summary>

${questionsAfter}

</details>
`);
  }

  addStep3_Answers({
    result,
    answers,
    questions,
    aiReasoning,
    cueAssertion,
  }: {
    result: StepResult;
    answers: Record<string, unknown>;
    questions: ClarifyQuestion[];
    aiReasoning: string;
    cueAssertion: ClarifyCueAssertion;
  }): void {
    let answersTable = '| Question | Answer |\n|----------|--------|';
    for (const q of questions) {
      const answer = answers[q.id];
      const display = Array.isArray(answer) ? answer.join(', ') : String(answer);
      answersTable += `\n| ${escapeCell(q.question)} | ${escapeCell(display)} |`;
    }

    // Cue-presence assertion table — surfaces whether the per-bucket
    // expected cue (exam name, project deliverable, CEFR level, etc.)
    // appeared in at least one free-text answer. False negatives possible;
    // the value is in cross-run aggregate drift, not per-row pass/fail.
    let cueBlock = '';
    if (cueAssertion.verdict === 'n-a') {
      cueBlock = `### Clarify Cue Assertion
- **Goal type:** \`${cueAssertion.goalType}\` — no specific cue expected (n-a).`;
    } else {
      const verdictLabel = cueAssertion.verdict === 'pass' ? 'PASS' : 'FAIL';
      let checksTable = '| Cue | Passed | Evidence |\n|-----|--------|----------|';
      for (const c of cueAssertion.checks) {
        checksTable += `\n| ${c.label} | ${c.passed ? 'YES' : 'NO'} | ${escapeCell(c.evidence)} |`;
      }
      cueBlock = `### Clarify Cue Assertion (${verdictLabel})
_Heuristic regex check — false negatives possible. Tracks whether the persona's free-text answers carry the cue tokens the api should have elicited via the goalType-tilted clarify questions._

${checksTable}`;
    }

    this.sections.push(`---

## Step 3: Answer Questions (${fmtDuration(result.durationMs)})
**AI Reasoning:** ${aiReasoning}

${cueBlock}

${answersTable}
`);
  }

  addStep4_DepthPreviews({ result, previews, pollDuration }: { result: StepResult; previews: DepthPreviews; pollDuration: number }): void {
    const fmtPreview = ({ label, p, isRec }: { label: string; p: { summary: string; bullets: string[] }; isRec: boolean }) => {
      const badge = isRec ? ' **(Recommended)**' : '';
      return `### ${label}${badge}
${p.summary}
${p.bullets.map((b) => `- ${b}`).join('\n')}`;
    };

    this.sections.push(`---

## Step 4: Depth Previews (${fmtDuration(result.durationMs)})
**Job poll duration:** ${fmtDuration(pollDuration)}
**Recommendation reason:** ${previews.recommendationReason}

${fmtPreview({ label: 'Overview', p: previews.overview, isRec: previews.recommended === 'overview' })}

${fmtPreview({ label: 'Comprehensive', p: previews.comprehensive, isRec: previews.recommended === 'comprehensive' })}

${fmtPreview({ label: 'Deep Dive', p: previews.deep_dive, isRec: previews.recommended === 'deep_dive' })}
`);
  }

  addStep5_DepthSelection({ result, selected, recommended, aiReasoning }: { result: StepResult; selected: string; recommended: string; aiReasoning: string }): void {
    this.sections.push(`---

## Step 5: Depth Selection (${fmtDuration(result.durationMs)})
**Selected:** ${selected}
**Recommended:** ${recommended}
**Match:** ${selected === recommended ? 'Yes' : 'No'}
**AI Reasoning:** ${aiReasoning}
`);
  }

  addStep6_Structure({
    result,
    structure,
    pollDuration,
    conformance,
  }: {
    result: StepResult;
    structure: CourseStructure;
    pollDuration: number;
    conformance: StructureConformanceAssertion;
  }): void {
    let modulesList = '';
    let totalLessons = 0;
    for (let i = 0; i < structure.modules.length; i++) {
      const mod = structure.modules[i];
      modulesList += `\n${i + 1}. **${mod.name}** — ${mod.description}`;
      for (const lesson of mod.lessons) {
        modulesList += `\n   - ${lesson.name}: ${lesson.description}`;
        totalLessons++;
      }
    }

    // Per-bucket conformance assertion — naming-shape heuristics on the
    // generated modules + lessons, mirroring `GOAL_TYPE_STRUCTURE_GUIDANCE`
    // in api/src/services/courseService.ts:856-867. False negatives possible
    // (a `monetize` capstone could ship a real artifact under a non-action-
    // verb name); the value is in cohort aggregate drift across runs.
    let conformanceBlock = '';
    if (conformance.verdict === 'n-a') {
      conformanceBlock = `### Structure Conformance
- **Goal type:** \`${conformance.goalType}\` — no special structural constraint (n-a).`;
    } else {
      const verdictLabel = conformance.verdict === 'pass' ? 'PASS' : 'FAIL';
      let checksTable = '| Check | Passed | Evidence |\n|-------|--------|----------|';
      for (const c of conformance.checks) {
        checksTable += `\n| ${c.name} | ${c.passed ? 'YES' : 'NO'} | ${escapeCell(c.evidence)} |`;
      }
      conformanceBlock = `### Structure Conformance (${verdictLabel}) — \`${conformance.goalType}\`
_Naming-shape heuristic — mirrors GOAL_TYPE_STRUCTURE_GUIDANCE in courseService.ts. False negatives possible._

${checksTable}`;
    }

    this.sections.push(`---

## Step 6: Generate Structure (${fmtDuration(result.durationMs)})
**Job poll duration:** ${fmtDuration(pollDuration)}
**Modules:** ${structure.modules.length}
**Total lessons:** ${totalLessons}

### Reasoning
- **Learner Profile:** ${structure.reasoning.learnerProfile}
- **Topic Analysis:** ${structure.reasoning.topicAnalysis}
- **Scope Decisions:** ${structure.reasoning.scopeDecisions}
- **Progression Strategy:** ${structure.reasoning.progressionStrategy}

${conformanceBlock}

### Modules & Lessons
${modulesList}
`);
  }

  addStep7_Review({ result, feedback, aiResponse, structureChanged }: { result: StepResult; feedback: string | null; aiResponse: string | null; structureChanged: boolean }): void {
    if (!feedback) {
      this.sections.push(`---

## Step 7: Structure Review (${fmtDuration(result.durationMs)})
**Chat used:** No — persona accepted the structure as-is.
`);
    } else {
      this.sections.push(`---

## Step 7: Structure Review (${fmtDuration(result.durationMs)})
**Chat used:** Yes
**Structure modified:** ${structureChanged ? 'Yes' : 'No'}

**Persona Feedback:**
> ${feedback}

**AI Response:**
> ${(aiResponse ?? '').replace(/\n/g, '\n> ')}
`);
    }
  }

  addStep8_Accept(result: StepResult): void {
    this.sections.push(`---

## Step 8: Accept Course (${fmtDuration(result.durationMs)})
**Final Status:** ready
`);
  }

  addStep9_LessonGeneration(
    lessons: {
      moduleIndex: number;
      lessonIndex: number;
      moduleName: string;
      lessonName: string;
      content: ILessonContent;
      generationMs: number;
      stats: LessonContentStats | null;
      mentorProbe?: LessonMentorRecord | null;
    }[],
  ): void {
    if (lessons.length === 0) return;

    let md = `---\n\n## Steps 9-10: Lesson Generation (${lessons.length} lessons)\n\n`;

    for (const lesson of lessons) {
      const { moduleIndex, lessonIndex, moduleName, lessonName, content, generationMs, stats, mentorProbe } = lesson;
      const blocks = content.blocks;

      // Prefer server-side counts when available (they include blocks that were
      // dropped before persistence); fall back to client-visible blocks.
      const typeCounts = stats?.blockCountsByType ?? blocks.reduce<Record<string, number>>((acc, b) => {
        acc[b.type] = (acc[b.type] || 0) + 1;
        return acc;
      }, {});
      const typeCountStr = Object.entries(typeCounts)
        .map(([t, c]) => `${t}: ${c}`)
        .join(', ');

      md += `### Lesson [${moduleIndex}/${lessonIndex}]: ${moduleName} → ${lessonName}\n`;
      md += `- **Generation time:** ${fmtDuration(generationMs)}\n`;
      md += `- **Blocks:** ${blocks.length} (${typeCountStr})\n`;
      if (stats) {
        md += `- **Recall cards extracted:** ${stats.recallCardCount}\n`;
        md += `- **Curated links:** ${stats.linkCount}\n`;
      }
      md += `- **Summary:** ${content.summary ? truncate({ str: content.summary, maxLen: 200 }) : '_none_'}\n\n`;

      md += `<details>\n<summary>Block details (${blocks.length} blocks)</summary>\n\n`;
      for (const block of blocks) {
        md += formatBlock(block);
      }
      md += `</details>\n\n`;

      if (mentorProbe) {
        md += formatLessonMentorProbe(mentorProbe);
      }
    }

    this.sections.push(md);
  }

  addStep8b_CourseMentorProbe(probe: CourseMentorRecord): void {
    let md = `---\n\n## Step 8b: Course Mentor Probe — ${probe.turns.length} turn(s) (${fmtDuration(probe.totalDurationMs)})\n\n`;
    md += `**Ended:** ${probe.endedReason}\n\n`;
    if (probe.turns.length === 0) {
      md += `_No turns recorded — see ended reason above._\n`;
    } else {
      for (const t of probe.turns) {
        md += formatMentorTurn(t);
      }
    }
    this.sections.push(md);
  }

  addStep11_ModuleQuizGeneration({
    quizzes,
  }: {
    quizzes: { moduleIndex: number; moduleName: string; quiz: ModuleQuizForLearner; generationMs: number }[];
  }): void {
    if (quizzes.length === 0) return;

    let md = `---\n\n## Step 11: Generate Module Quizzes (${quizzes.length} quiz${quizzes.length === 1 ? '' : 'zes'})\n\n`;

    for (const { moduleIndex, moduleName, quiz, generationMs } of quizzes) {
      md += `### [${moduleIndex}] ${moduleName}\n`;
      md += `- **Generation time:** ${fmtDuration(generationMs)}\n`;
      md += `- **Questions:** ${quiz.questions.length} (version ${quiz.version})\n\n`;
      md += `<details>\n<summary>Questions (prompt + options)</summary>\n\n`;
      // The learner-facing endpoint strips correctIndex + explanation by
      // design, so we render them inline in Step 12 (post-submission) rather
      // than here. Options are safe to show pre-attempt.
      for (let i = 0; i < quiz.questions.length; i++) {
        const q = quiz.questions[i];
        md += `${i + 1}. **${q.question}**\n`;
        for (const opt of q.options) {
          md += `   - ${opt}\n`;
        }
        md += `   - _sourceLessons:_ [${q.sourceLessons.join(', ')}]${q.isInterleaved ? ` _(interleaved from module ${q.interleavedModuleIndex ?? '?'})_` : ''}\n\n`;
      }
      md += `</details>\n\n`;
    }

    this.sections.push(md);
  }

  addStep12_QuizAttempts({ attempts }: { attempts: ModuleQuizAttemptRecord[] }): void {
    if (attempts.length === 0) return;

    let md = `---\n\n## Step 12: Submit Quiz Attempts (${attempts.length})\n\n`;

    for (const a of attempts) {
      md += `### [${a.moduleIndex}] ${a.moduleName}\n`;
      md += `- **Score:** ${a.score}/100 → **${a.masteryTier}**\n`;
      md += `- **Attempt #:** ${a.attemptNumber}\n`;
      md += `- **Next review:** ${a.nextReviewAt} (interval ${a.reviewIntervalDays}d)\n`;
      md += `- **Submission time (simulated):** ${fmtDuration(a.submissionMs)}\n`;
      md += `- **LLM latency:** ${fmtDuration(a.llmLatencyMs)}\n`;
      md += `- **AI Reasoning:** ${a.aiReasoning}\n\n`;

      md += `<details>\n<summary>Question-by-question breakdown</summary>\n\n`;
      md += '| # | Question | Selected | Correct | Match | Conf | Injections |\n|---|----------|----------|---------|-------|------|------------|\n';
      for (let i = 0; i < a.questions.length; i++) {
        const q = a.questions[i];
        const sel = q.selectedOption !== null ? `${q.selectedOption}: ${q.options[q.selectedOption] ?? '?'}` : '_none_';
        const cor = `${q.correctIndex}: ${q.options[q.correctIndex] ?? '?'}`;
        const mark = q.correct ? 'YES' : 'NO';
        // noiseTrace entries are emitted in the same order as the quiz questions,
        // so index-by-index alignment is safe. Render empty cells when noise
        // injection is disabled or when the trace is missing (backwards-compat).
        const trace = a.noiseTrace?.[i];
        const confCell = trace ? trace.confidence.toFixed(2) : '_?_';
        const injCell = trace && trace.injections.length > 0
          ? trace.injections.join(', ') + (trace.originalOption !== trace.finalOption ? ` (${trace.originalOption}→${trace.finalOption})` : '')
          : '—';
        md += `| ${i + 1} | ${escapeCell(q.question)} | ${escapeCell(sel)} | ${escapeCell(cor)} | ${mark} | ${confCell} | ${escapeCell(injCell)} |\n`;
      }
      md += '\n';
      for (let i = 0; i < a.questions.length; i++) {
        const q = a.questions[i];
        md += `**Q${i + 1}:** ${q.question}\n`;
        md += `> ${q.explanation}\n\n`;
      }
      md += `</details>\n\n`;
    }

    this.sections.push(md);
  }

  addStep13_RecallQueue({ queue }: { queue: GetRecallQueueResult }): void {
    let md = `---\n\n## Step 13: Fetch Recall Queue\n\n`;
    md += `- **Due total:** ${queue.counts.dueTotal}\n`;
    md += `- **Fresh available:** ${queue.counts.freshAvailable}\n`;
    md += `- **Learned:** ${queue.counts.learned}\n`;
    md += `- **Returned:** ${queue.due.length} due, ${queue.fresh.length} fresh\n\n`;

    // Render every queue item the server returned — the orchestrator is a
    // debug tool and a silent 10-item cap made `--recall > 10` runs look
    // like half the queue was missing.
    const preview = [...queue.due, ...queue.fresh];
    if (preview.length > 0) {
      md += '| # | Kind | Course | Lesson | Box | Mode | New? | Prompt |\n';
      md += '|---|------|--------|--------|-----|------|------|--------|\n';
      for (let i = 0; i < preview.length; i++) {
        const it = preview[i];
        md += `| ${i + 1} | ${it.kind} | ${escapeCell(it.courseName)} | ${escapeCell(it.lessonName)} | ${it.box} | ${it.mode} | ${it.isNew ? 'yes' : 'no'} | ${escapeCell(truncate({ str: it.prompt, maxLen: 80 }))} |\n`;
      }
      md += '\n';
    }
    this.sections.push(md);
  }

  addStep14_RecallReviews({
    reviews,
    statsAfter,
  }: {
    reviews: RecallReviewResult[];
    statsAfter: RecallStats | null;
  }): void {
    if (reviews.length === 0) return;

    const rated = reviews.filter((r) => r.action === 'rated').length;
    const skipped = reviews.filter((r) => r.action === 'skipped').length;

    let md = `---\n\n## Step 14: Review Recall cards (${rated} rated, ${skipped} skipped)\n\n`;

    for (let i = 0; i < reviews.length; i++) {
      const r = reviews[i];
      md += `### ${i + 1}. ${r.kind.toUpperCase()} — ${r.courseName} → ${r.lessonName}\n`;
      md += `- **Mode:** ${r.mode}${r.action === 'skipped' ? ' (skipped)' : ''}\n`;
      md += `- **Prompt:** ${r.prompt}\n`;
      md += `- **Canonical answer:** ${r.canonicalAnswer}\n`;
      if (r.userAnswer !== undefined) md += `- **User answer:** ${r.userAnswer}\n`;
      if (r.grade) {
        md += `- **Grade:** ${r.grade.verdict} (${r.grade.score.toFixed(2)}) — ${r.grade.feedback}\n`;
      }
      if (r.action === 'rated') {
        md += `- **Rating:** ${r.rating} → new box ${r.newBox}, next due ${r.nextDue ?? '_none_'}\n`;
      }
      md += `- **AI Reasoning:** ${r.aiReasoning}\n\n`;
    }

    if (statsAfter) {
      md += `<details>\n<summary>Recall stats after this run</summary>\n\n`;
      md += `- **Total recall cards:** ${statsAfter.totalCards}\n`;
      md += `- **Total reviewed:** ${statsAfter.totalReviewed}\n`;
      md += `- **Total mastered:** ${statsAfter.totalMastered}\n`;
      md += `- **Due today:** ${statsAfter.dueToday}\n`;
      md += `- **Due this week:** ${statsAfter.dueThisWeek}\n`;
      md += `- **Reviewed this week:** ${statsAfter.reviewedThisWeek}\n`;
      if (statsAfter.boxDistribution.length > 0) {
        md += `- **Box distribution:** ${statsAfter.boxDistribution.map((b) => `box${b.box}=${b.count}`).join(', ')}\n`;
      }
      md += `</details>\n\n`;
    }

    this.sections.push(md);
  }

  addSummary({
    totalDurationMs,
    course,
    status,
    error,
    failedStep,
    lessonsGenerated,
    quizzesAttempted,
    recallReviewed,
    costSummary,
  }: {
    totalDurationMs: number;
    course: CourseData | null;
    status: 'completed' | 'failed';
    error?: string;
    failedStep?: { step: number; name: string };
    lessonsGenerated?: number;
    quizzesAttempted?: number;
    recallReviewed?: number;
    costSummary?: CostSummary;
  }): void {
    const totalLessons = course?.structure?.modules.reduce((sum, m) => sum + m.lessons.length, 0) ?? 0;

    // Goal-type row: surfaces predicted vs classified + confidence at-a-
    // glance so an inventory pass over `output/` can flag mismatches
    // without reading every Step 2 section. Final goalType reflects
    // post-override state when the chip was toggled (course.goalType is
    // updated by the cascade); the persona's predictedGoalType is the
    // ground truth for the *original* classification.
    const finalGoalType = course?.goalType ?? null;
    const finalConfidence = course?.goalTypeConfidence ?? null;
    const goalTypeMatch =
      this.persona && finalGoalType
        ? finalGoalType === this.persona.predictedGoalType
          ? 'match'
          : 'MISMATCH'
        : 'N/A';

    // Insert summary right after header
    const summary = `## Run Summary
| Metric | Value |
|--------|-------|
| Course ID | \`${this.courseId || 'N/A'}\` |
| Total Duration | ${fmtDuration(totalDurationMs)} |
| Status | ${status} |
| Course Name | ${course?.name ?? 'N/A'} |
| Domain | ${course?.domain ?? 'N/A'} |
| Goal Type (predicted / final / confidence) | ${this.persona?.predictedGoalType ?? 'N/A'} / ${finalGoalType ?? 'N/A'} / ${finalConfidence ?? 'N/A'} (${goalTypeMatch}) |
| Depth Selected | ${course?.depth ?? 'N/A'} |
| Modules | ${course?.structure?.modules.length ?? 'N/A'} |
| Total Lessons | ${totalLessons || 'N/A'} |
${failedStep ? `| Failed Step | ${failedStep.step} — ${failedStep.name} |\n` : ''}${lessonsGenerated !== undefined ? `| Lessons Generated | ${lessonsGenerated} |\n` : ''}${quizzesAttempted !== undefined ? `| Quizzes Attempted | ${quizzesAttempted} |\n` : ''}${recallReviewed !== undefined ? `| Recall cards Reviewed | ${recallReviewed} |\n` : ''}${costSummary ? `| Credits Spent (this persona) | ${fmtCredits(costSummary.totalSpent)} |\n` : ''}${error ? `| Error | ${escapeCell(truncate({ str: error, maxLen: 500 }))} |` : ''}
`;

    // Insert after the header (index 0)
    this.sections.splice(1, 0, summary);
  }

  /**
   * Append the cost-breakdown section. Analytics-only (NOT scored by the
   * assessment rubric) — surfaced so cost-per-step is visible in the same
   * markdown that already carries every other run signal. Skipped silently
   * when the tracker has no events (e.g. /api/billing/summary unreachable).
   */
  addCostBreakdown(costSummary: CostSummary): void {
    if (costSummary.events.length === 0) {
      this.sections.push(`---

## Cost Breakdown

_No cost events recorded — billing snapshot endpoint may have been unreachable during this run._
`);
      return;
    }

    const rows = costSummary.events
      .map((e, i) => {
        const deltaCell = e.deltaCredits > 0 ? `−${fmtCredits(e.deltaCredits)}` : e.deltaCredits < 0 ? `+${fmtCredits(-e.deltaCredits)}` : '0';
        return `| ${i + 1} | ${escapeCell(e.label)} | ${fmtCredits(e.balanceBefore)} | ${fmtCredits(e.balanceAfter)} | ${deltaCell} |`;
      })
      .join('\n');

    this.sections.push(`---

## Cost Breakdown

Snapshots taken at every step boundary against \`/api/billing/summary\`. \`Δ credits\` is the spend attributable to that step (positive = debit, "+" = refund). Credits are in account units (1 credit ≈ $0.005 vendor cost; users pay 1.9–4.0× markup). This section is for analytics — the assessment rubric ignores it.

**Persona total: ${fmtCredits(costSummary.totalSpent)} credits** (start ${fmtCredits(costSummary.startBalance)} → end ${fmtCredits(costSummary.endBalance)})

| # | Step | Balance Before | Balance After | Δ credits |
|---|------|---------------:|--------------:|----------:|
${rows}
`);
  }

  addFailure({ failedStep, error }: { failedStep: { step: number; name: string } | null; error: string }): void {
    const header = failedStep
      ? `## Failure — Step ${failedStep.step}: ${failedStep.name}`
      : `## Failure — before any step started`;

    this.sections.push(`---

${header}

\`\`\`
${error}
\`\`\`
`);
  }

  async writeToFile(outputDir: string): Promise<string> {
    await mkdir(outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const slug = (this.persona?.name ?? 'unknown')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 50);

    const filename = `${timestamp}_${slug}.md`;
    const filepath = path.join(outputDir, filename);

    await writeFile(filepath, this.sections.join('\n'), 'utf-8');
    return filepath;
  }
}

/**
 * Format a credit value for display in the markdown report. Two decimal
 * places — the production credit unit is fractional (1 credit = ~$0.005)
 * and per-step debits are commonly in the 0.1–10 range.
 */
function fmtCredits(value: number): string {
  return value.toFixed(2);
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate({ str, maxLen }: { str: string; maxLen: number }): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '...';
}

function escapeCell(str: string): string {
  // Replace markdown-table-breaking chars with safe equivalents.
  return str.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatMentorTurn(turn: {
  turnNumber: number;
  question: string;
  questionRationale: string;
  response: string;
  durationMs: number;
  error?: string;
}): string {
  let md = `**Turn ${turn.turnNumber}** — ${fmtDuration(turn.durationMs)}\n\n`;
  if (turn.error) {
    md += `_Error:_ \`${turn.error}\`\n\n`;
    return md;
  }
  md += `**Persona:**\n> ${turn.question.replace(/\n/g, '\n> ')}\n\n`;
  md += `_Why this question:_ ${turn.questionRationale}\n\n`;
  md += `**Mentor (${turn.response.length} chars):**\n\n`;
  md += `${turn.response.split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
  return md;
}

function formatLessonMentorProbe(probe: LessonMentorRecord): string {
  // Inlined under each lesson (rather than a separate section) so the
  // assessor reads the conversation right next to the lesson it's about.
  // `<details>` collapsed by default — keeps the report scannable.
  let md = `<details>\n<summary>🎓 Lesson Mentor probe — ${probe.turns.length} turn(s) (${fmtDuration(probe.totalDurationMs)})</summary>\n\n`;
  md += `_Ended: ${probe.endedReason}_\n\n`;
  if (probe.turns.length === 0) {
    md += `_No turns recorded — see ended reason above._\n\n`;
  } else {
    for (const t of probe.turns) {
      md += formatMentorTurn(t);
    }
  }
  md += `</details>\n\n`;
  return md;
}

function formatBlock(block: ILessonBlock): string {
  const meta = block.metadata as Record<string, unknown> | null;
  let md = `**[${block.order}] ${block.type}**`;

  switch (block.type) {
    case 'intro':
    case 'summary':
      md += `\n> ${truncate({ str: block.content.replace(/\n/g, ' '), maxLen: 200 })}\n\n`;
      break;

    case 'section':
      md += `\n> ${truncate({ str: block.content.replace(/\n/g, ' '), maxLen: 500 })}\n\n`;
      break;

    case 'code':
      md += ` (${meta?.language ?? 'unknown'})\n`;
      md += '```' + (meta?.language ?? '') + '\n';
      md += truncate({ str: block.content, maxLen: 500 }) + '\n';
      md += '```\n\n';
      break;

    case 'quiz': {
      const q = meta as { question?: string; options?: string[]; correctIndex?: number; explanation?: string } | null;
      md += '\n';
      md += `- **Question:** ${q?.question ?? block.content}\n`;
      if (q?.options) {
        for (let i = 0; i < q.options.length; i++) {
          const marker = i === q.correctIndex ? ' **(correct)**' : '';
          md += `  - ${q.options[i]}${marker}\n`;
        }
      }
      if (q?.explanation) md += `- **Explanation:** ${q.explanation}\n`;
      md += '\n';
      break;
    }

    case 'exercise': {
      const ex = meta as { language?: string; starterCode?: string; expectedOutput?: string } | null;
      md += ex?.language ? ` (${ex.language})\n` : '\n';
      md += `- **Content:** ${truncate({ str: block.content, maxLen: 150 })}\n`;
      if (ex?.starterCode) {
        md += '```' + (ex.language ?? '') + '\n';
        md += truncate({ str: ex.starterCode, maxLen: 200 }) + '\n';
        md += '```\n';
      }
      if (ex?.expectedOutput) md += `- **Expected output:** ${ex.expectedOutput}\n`;
      md += '\n';
      break;
    }

    case 'mermaid': {
      const diag = meta as { diagramType?: string } | null;
      md += ` (${diag?.diagramType ?? 'unknown'})\n`;
      md += '```mermaid\n';
      md += truncate({ str: block.content, maxLen: 600 }) + '\n';
      md += '```\n\n';
      break;
    }

    case 'callout': {
      const co = meta as { variant?: string } | null;
      md += ` (${co?.variant ?? 'info'})\n`;
      md += `> ${truncate({ str: block.content.replace(/\n/g, ' '), maxLen: 200 })}\n\n`;
      break;
    }

    case 'links':
      md += '\n' + block.content + '\n\n';
      break;

    case 'image':
      md += '\n- ' + truncate({ str: block.content, maxLen: 200 }) + '\n\n';
      break;

    default:
      md += '\n> ' + truncate({ str: block.content, maxLen: 200 }) + '\n\n';
  }

  return md;
}
