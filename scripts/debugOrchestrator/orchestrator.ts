import pLimit from 'p-limit';
import { createApiClient } from './apiClient';
import { runPersonaFlow } from './courseFlow';
import { MarkdownRecorder } from './markdownRecorder';
import { createVerifiedTestUser, deleteTestUser } from './testUser';
import { GOAL_TYPES } from '@lib/constants';
import type { GoalType } from '@lib/constants';
import type { Persona, PersonaRun, OrchestratorConfig } from './types';

const slugifyPersonaName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40) || 'persona';

export async function runAll({
  personas,
  config,
}: {
  personas: Persona[];
  config: OrchestratorConfig;
}): Promise<PersonaRun[]> {
  const limit = pLimit(config.concurrency);

  // One runId per orchestrator invocation — scopes test-account emails so
  // parallel local runs (or leftover orphans) don't collide.
  const runId = Date.now().toString(36);

  console.log(`\n${'='.repeat(60).dim}`);
  console.log(`Starting ${personas.length} persona flows (concurrency: ${config.concurrency})`.cyan);
  console.log(`API: ${config.apiUrl}`.gray);
  console.log(`Run ID: ${runId}`.gray);
  console.log(`Chat review: ${config.enableChatReview ? 'enabled'.green : 'disabled'.yellow}`.gray);
  console.log(`Lessons: ${config.maxLessons === 0 ? 'skipped'.yellow : String(config.maxLessons)}`.gray);
  console.log(`Quizzes: ${config.enableQuiz ? 'enabled'.green : 'disabled'.yellow}`.gray);
  console.log(`Recall cards: ${config.enableRecall ? 'enabled (review all returned)'.green : 'disabled'.yellow}`.gray);
  console.log(`Mentor probes: ${config.enableMentor ? 'enabled (course + lesson)'.green : 'disabled'.yellow}`.gray);
  console.log(`Output: ${config.outputDir}`.gray);
  console.log(`${'='.repeat(60).dim}\n`);

  const results = await Promise.allSettled(
    personas.map((persona, index) =>
      limit(async () => {
        const label = `Persona ${index + 1}/${personas.length} (${persona.name})`;
        console.log(`[${label}]`.cyan + ' Starting...');

        const personaSlug = slugifyPersonaName(persona.name);
        const testUser = await createVerifiedTestUser({
          baseUrl: config.apiUrl,
          runId,
          personaSlug,
        });
        console.log(`[${label}]`.cyan + ` Provisioned test user ${testUser.email}`.gray);

        const client = createApiClient({ baseUrl: config.apiUrl, token: testUser.token });
        const recorder = new MarkdownRecorder();

        try {
          return await runPersonaFlow({ persona, client, recorder, config, label, runId, personaSlug });
        } finally {
          await deleteTestUser({ client, password: testUser.password, email: testUser.email });
          console.log(`[${label}]`.cyan + ` Cleaned up test user ${testUser.email}`.gray);
        }
      }),
    ),
  );

  // Print summary
  console.log(`\n${'='.repeat(60).dim}`);
  console.log('ORCHESTRATOR COMPLETE'.cyan);
  console.log(`${'='.repeat(60).dim}`);

  const runs: PersonaRun[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const persona = personas[i];
    if (r.status === 'fulfilled') {
      const run = r.value;
      runs.push(run);
      const icon = run.status === 'completed' ? '[OK]'.green : '[FAIL]'.red;
      console.log(`  ${icon} ${persona.name} → ${(run.totalDurationMs / 1000).toFixed(1)}s`.gray + ` (course: ${run.courseId})`.dim);
    } else {
      console.log(`  ${'[ERR]'.red} ${persona.name} → ${r.reason}`);
    }
  }

  const succeeded = runs.filter((r) => r.status === 'completed').length;
  const failed = runs.filter((r) => r.status === 'failed').length;
  const errored = results.filter((r) => r.status === 'rejected').length;
  console.log(`\nResults: ${String(succeeded).green} completed, ${String(failed).yellow} failed, ${String(errored).red} errored`);

  // Cohort cost: sum of every persona's totalSpent. Includes failed runs
  // because a partial run still incurs spend up to the failing step. Per-
  // persona breakdown is in each run's markdown report; this line is the
  // headline number for the orchestrator session.
  const costRuns = runs.filter((r) => r.costSummary !== undefined);
  if (costRuns.length > 0) {
    const totalCredits = costRuns.reduce((sum, r) => sum + (r.costSummary?.totalSpent ?? 0), 0);
    const avgPerPersona = totalCredits / costRuns.length;
    console.log(
      `${'Cohort spend:'.cyan} ${totalCredits.toFixed(2)} credits across ${costRuns.length} persona(s) ` +
        `(avg ${avgPerPersona.toFixed(2)}/persona, includes ${failed} failed run(s) up to their failing step)`,
    );
    console.log(
      '  per-persona:'.dim +
        '\n' +
        costRuns
          .map((r) => `    ${r.persona.name.padEnd(38)} ${(r.costSummary?.totalSpent ?? 0).toFixed(2)} credits`.gray)
          .join('\n'),
    );
  }

  // Goal-type cohort matrix — per-bucket × per-metric. Surfaces drift
  // that's invisible in a flat aggregate: a regression that breaks only
  // `pass` exam-mock shaping or only `build` project-spine ordering
  // would otherwise pass cleanly because the other 4 buckets compensate.
  // Read directly from PersonaRun.assertions + .metrics (populated by
  // courseFlow as steps complete) — no notes-string parsing.
  if (runs.length > 0) {
    printCohortMatrix(runs);
  }

  return runs;
}

interface BucketStats {
  predicted: number;
  classifierMatches: number;
  classifierScored: number;
  cuePass: number;
  cueScored: number;
  structurePass: number;
  structureScored: number;
  totalDurationMs: number[];
  structureGenMs: number[];
  lessonsGenerated: number[];
  quizScoreAvg: number[];
  overrideAttempted: number;
}

function emptyStats(): BucketStats {
  return {
    predicted: 0,
    classifierMatches: 0,
    classifierScored: 0,
    cuePass: 0,
    cueScored: 0,
    structurePass: 0,
    structureScored: 0,
    totalDurationMs: [],
    structureGenMs: [],
    lessonsGenerated: [],
    quizScoreAvg: [],
    overrideAttempted: 0,
  };
}

function printCohortMatrix(runs: PersonaRun[]): void {
  const byBucket = new Map<GoalType, BucketStats>();
  for (const t of GOAL_TYPES) byBucket.set(t, emptyStats());

  let totalOverride = 0;
  for (const run of runs) {
    const p = run.persona.predictedGoalType;
    const b = byBucket.get(p)!;
    b.predicted += 1;

    // Classifier match — keep the existing notes-parse so this stays
    // backward-compatible if courseFlow's typed-fields roll forward.
    const step2 = run.steps.find((s) => s.name === 'Clarify Questions');
    const step2b = run.steps.find((s) => s.name?.startsWith('Goal-Type Override'));
    if (step2b) {
      b.overrideAttempted += 1;
      totalOverride += 1;
    }
    if (step2?.notes) {
      const matchToken = step2.notes.includes('MISMATCH') ? false : step2.notes.includes('match');
      const hasClassifierTag = /classifier:\s*\w+\//.test(step2.notes);
      if (hasClassifierTag) {
        b.classifierScored += 1;
        if (matchToken) b.classifierMatches += 1;
      }
    }

    // Cue + structure assertions — read from PersonaRun.assertions.
    if (run.assertions?.cue && run.assertions.cue.verdict !== 'n-a') {
      b.cueScored += 1;
      if (run.assertions.cue.verdict === 'pass') b.cuePass += 1;
    }
    if (run.assertions?.structure && run.assertions.structure.verdict !== 'n-a') {
      b.structureScored += 1;
      if (run.assertions.structure.verdict === 'pass') b.structurePass += 1;
    }

    // Latency / volume metrics (only for completed runs — failed runs
    // lack representative timing).
    if (run.status === 'completed') {
      b.totalDurationMs.push(run.totalDurationMs);
    }
    if (run.metrics?.structureGenMs !== undefined) b.structureGenMs.push(run.metrics.structureGenMs);
    if (run.metrics?.lessonsGenerated !== undefined) b.lessonsGenerated.push(run.metrics.lessonsGenerated);
    if (run.metrics?.quizScoreAvg !== undefined) b.quizScoreAvg.push(run.metrics.quizScoreAvg);
  }

  console.log(`\n${'Goal-type cohort matrix:'.cyan}`);
  console.log(
    '  bucket    n  classifier  cue       structure  median total  median struct-gen  avg lessons  avg quiz'
      .gray,
  );
  console.log('  '.padEnd(2) + '─'.repeat(96).gray);

  for (const t of GOAL_TYPES) {
    const b = byBucket.get(t)!;
    if (b.predicted === 0) {
      const line = `  ${t.padEnd(9)} 0  —           —         —          —             —                  —            —`;
      console.log(line.gray);
      continue;
    }
    const classifierCell = formatRatio(b.classifierMatches, b.classifierScored);
    const cueCell = b.cueScored > 0 ? formatRatio(b.cuePass, b.cueScored) : 'n-a       ';
    const structureCell = b.structureScored > 0 ? formatRatio(b.structurePass, b.structureScored) : 'n-a       ';
    const medianTotal = b.totalDurationMs.length > 0 ? `${(median(b.totalDurationMs) / 1000).toFixed(1)}s` : '—';
    const medianStruct = b.structureGenMs.length > 0 ? `${(median(b.structureGenMs) / 1000).toFixed(1)}s` : '—';
    const avgLessons = b.lessonsGenerated.length > 0 ? avg(b.lessonsGenerated).toFixed(1) : '—';
    const avgQuiz = b.quizScoreAvg.length > 0 ? avg(b.quizScoreAvg).toFixed(1) : '—';
    console.log(
      `  ${t.padEnd(9)} ${String(b.predicted).padEnd(2)} ${classifierCell.padEnd(11)} ${cueCell.padEnd(9)} ${structureCell.padEnd(10)} ${medianTotal.padEnd(13)} ${medianStruct.padEnd(18)} ${avgLessons.padEnd(12)} ${avgQuiz}`,
    );
  }

  console.log('  '.padEnd(2) + '─'.repeat(96).gray);
  console.log(`  override-attempted: ${totalOverride} persona(s)`.dim);
  console.log(
    `  Legend: classifier = predicted vs api match. cue = clarify-answer cue presence. structure = per-bucket structural conformance. n-a appears where master rows return no assertion (no special tilt).`
      .dim,
  );
}

function formatRatio(num: number, denom: number): string {
  if (denom === 0) return 'n-a';
  const pct = ((num / denom) * 100).toFixed(0);
  return `${num}/${denom} (${pct}%)`;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
