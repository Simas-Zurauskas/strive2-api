import 'colors';
import dotenv from 'dotenv';
import path from 'path';

// Load the API's .env BEFORE importing anything that touches `@conf/env`.
// `@conf/env` reads `process.env` at module-import time, so if we import
// `MONGO_URI` above this line it latches onto unset env vars and throws.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import mongoose from 'mongoose';
import { MONGO_URI } from '@conf/env';
import { GOAL_TYPES } from '@lib/constants';
import type { GoalType } from '@lib/constants';
import { generatePersonas } from './personaGenerator';
import { runAll } from './orchestrator';
import type { OrchestratorConfig } from './types';

// ── CLI arg parsing ──────────────────────────────────────

function parseArgs(): OrchestratorConfig & { personaCount: number } {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  const boolFlags = new Set<string>();

  // Declared bool flags — the parser must never consume the following token as
  // a value for these, otherwise `--recall --chat` would parse `--chat` as
  // the value of `--recall`. Listed explicitly so typos in value flags
  // surface as missing-required errors instead of silent bool coercions.
  const knownBoolFlags = new Set(['chat', 'quizzes', 'recall', 'mentor']);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const name = arg.slice(2);

    if (knownBoolFlags.has(name)) {
      boolFlags.add(name);
      continue;
    }

    if (!args[i + 1]?.startsWith('--') && i + 1 < args.length) {
      flags[name] = args[++i];
    } else {
      boolFlags.add(name);
    }
  }

  // --email and --password are accepted for shell-history backward compat
  // but ignored: each persona gets its own auto-provisioned test account.
  if (flags['email'] || flags['password']) {
    console.warn('[warn] --email/--password are ignored; per-persona test accounts are auto-provisioned'.yellow);
  }

  const concurrency = flags['concurrency'];
  const personas = flags['personas'];
  const lessons = flags['lessons'];

  const missing: string[] = [];
  if (!concurrency) missing.push('--concurrency');
  if (!personas) missing.push('--personas');
  if (lessons === undefined) missing.push('--lessons');

  if (missing.length > 0) {
    console.error('Missing required flags: ' + missing.join(', '));
    console.error('');
    console.error('Usage:');
    console.error('  yarn debug:orchestrator --concurrency <n> --personas <n> --lessons <n> [options]');
    console.error('');
    console.error('Required:');
    console.error('  --concurrency <n>     Max parallel personas');
    console.error('  --personas <n>        Number of personas to generate');
    console.error('  --lessons <n>         Lessons to generate per persona (0 = skip)');
    console.error('');
    console.error('Optional:');
    console.error('  --api-url <url>                API base URL (default: http://localhost:4000)');
    console.error('  --chat                         Include structure review chat step');
    console.error('  --quizzes                      Generate + submit module quizzes after lessons');
    console.error('  --recall                       Review every recall card the queue returns (off by default)');
    console.error('  --mentor                       Probe course-design + lesson mentor chats (1 turn each)');
    console.error('  --goal-type <bucket>           Force every persona into a single bucket');
    console.error('                                 (master | monetize | pass | build | fluency).');
    console.error('  --goal-type-distribution <s>   Per-bucket counts, comma-separated.');
    console.error('                                 Example: "pass=3,build=2". Sum must equal --personas.');
    console.error('');
    console.error('Each persona runs against its own auto-provisioned db user (debug-*@strive-debug.test),');
    console.error('verified in Mongo at provision time and deleted via /api/auth/delete-account on teardown.');
    process.exit(1);
  }

  const personaCount = parseInt(personas, 10);
  const goalTypeDistribution = parseGoalTypeBias({
    single: flags['goal-type'],
    distribution: flags['goal-type-distribution'],
    personaCount,
  });

  return {
    apiUrl: flags['api-url'] ?? 'http://localhost:4000',
    concurrency: parseInt(concurrency, 10),
    personaCount,
    maxLessons: parseInt(lessons, 10),
    outputDir: path.resolve(__dirname, 'output'),
    enableChatReview: boolFlags.has('chat'),
    enableQuiz: boolFlags.has('quizzes'),
    enableRecall: boolFlags.has('recall'),
    enableMentor: boolFlags.has('mentor'),
    goalTypeDistribution,
  };
}

// Parses --goal-type and --goal-type-distribution into a single
// distribution map. Validates bucket names and total count.
// Returns null when neither flag is set (unbiased generation).
function parseGoalTypeBias({
  single,
  distribution,
  personaCount,
}: {
  single: string | undefined;
  distribution: string | undefined;
  personaCount: number;
}): Partial<Record<GoalType, number>> | null {
  if (!single && !distribution) return null;

  if (single && distribution) {
    console.error('--goal-type and --goal-type-distribution are mutually exclusive.');
    process.exit(1);
  }

  const isValidBucket = (s: string): s is GoalType => (GOAL_TYPES as readonly string[]).includes(s);

  if (single) {
    if (!isValidBucket(single)) {
      console.error(`Invalid --goal-type "${single}". Expected one of: ${GOAL_TYPES.join(', ')}`);
      process.exit(1);
    }
    return { [single]: personaCount } as Partial<Record<GoalType, number>>;
  }

  // distribution: "pass=3,build=2"
  const map: Partial<Record<GoalType, number>> = {};
  let total = 0;
  for (const pair of distribution!.split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq < 0) {
      console.error(`Invalid --goal-type-distribution entry "${pair}" (expected key=value).`);
      process.exit(1);
    }
    const key = pair.slice(0, eq).trim();
    const val = parseInt(pair.slice(eq + 1).trim(), 10);
    if (!isValidBucket(key)) {
      console.error(`Invalid bucket "${key}" in --goal-type-distribution. Expected one of: ${GOAL_TYPES.join(', ')}`);
      process.exit(1);
    }
    if (!Number.isFinite(val) || val < 0) {
      console.error(`Invalid count for "${key}" in --goal-type-distribution: "${pair.slice(eq + 1)}"`);
      process.exit(1);
    }
    map[key] = (map[key] ?? 0) + val;
    total += val;
  }
  if (total !== personaCount) {
    console.error(
      `--goal-type-distribution sum (${total}) must equal --personas (${personaCount}).`,
    );
    process.exit(1);
  }
  return map;
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  const { personaCount, ...config } = parseArgs();

  console.log('Debug Orchestrator — Course Creation Flow Testing'.cyan);
  console.log('─'.repeat(50).dim);

  // Direct mongoose connection — not `connectDB()` from @conf/mongo, which
  // runs `cleanupOrphanedJobs()` as a side effect and would mark all
  // in-flight jobs on a live dev server as failed. The orchestrator only
  // needs Mongo to flip `emailVerified=true` on fresh test users.
  console.log('\nConnecting to MongoDB...'.gray);
  await mongoose.connect(MONGO_URI);
  console.log('MongoDB connected.'.green);

  try {
    // Generate personas
    const personas = await generatePersonas(personaCount, config.goalTypeDistribution);

    // Run all persona flows
    const runs = await runAll({ personas, config });

    // Exit code based on results
    const allOk = runs.every((r) => r.status === 'completed');
    process.exitCode = allOk ? 0 : 1;
  } finally {
    await mongoose.disconnect();
    console.log('MongoDB disconnected.'.gray);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
