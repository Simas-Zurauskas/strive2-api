import 'colors';
import dotenv from 'dotenv';
import path from 'path';
import { authenticate } from './apiClient';
import { generatePersonas } from './personaGenerator';
import { runAll } from './orchestrator';
import type { OrchestratorConfig } from './types';

// Load the API's .env
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// ── CLI arg parsing ──────────────────────────────────────

function parseArgs(): OrchestratorConfig & { personaCount: number } {
  const args = process.argv.slice(2);
  const flags: Record<string, string> = {};
  const boolFlags = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && !args[i + 1]?.startsWith('--') && i + 1 < args.length) {
      flags[arg.slice(2)] = args[++i];
    } else if (arg.startsWith('--')) {
      boolFlags.add(arg.slice(2));
    }
  }

  const email = flags['email'];
  const password = flags['password'];
  const concurrency = flags['concurrency'];
  const personas = flags['personas'];
  const lessons = flags['lessons'];

  const missing: string[] = [];
  if (!email) missing.push('--email');
  if (!password) missing.push('--password');
  if (!concurrency) missing.push('--concurrency');
  if (!personas) missing.push('--personas');
  if (lessons === undefined) missing.push('--lessons');

  if (missing.length > 0) {
    console.error('Missing required flags: ' + missing.join(', '));
    console.error('');
    console.error('Usage:');
    console.error('  yarn debug:orchestrator --email <email> --password <pass> --concurrency <n> --personas <n> [options]');
    console.error('');
    console.error('Required:');
    console.error('  --email <email>       User email for authentication');
    console.error('  --password <pass>     User password');
    console.error('  --concurrency <n>     Max parallel personas');
    console.error('  --personas <n>        Number of personas to generate');
    console.error('  --lessons <n>         Lessons to generate per persona (0 = skip)');
    console.error('');
    console.error('Optional:');
    console.error('  --api-url <url>       API base URL (default: http://localhost:4000)');
    console.error('  --chat                Include structure review chat step');
    process.exit(1);
  }

  return {
    email,
    password,
    apiUrl: flags['api-url'] ?? 'http://localhost:4000',
    concurrency: parseInt(concurrency, 10),
    personaCount: parseInt(personas, 10),
    maxLessons: parseInt(lessons, 10),
    outputDir: path.resolve(__dirname, 'output'),
    enableChatReview: boolFlags.has('chat'),
  };
}

// ── Main ─────────────────────────────────────────────────

async function main() {
  const { personaCount, ...config } = parseArgs();

  console.log('Debug Orchestrator — Course Creation Flow Testing'.cyan);
  console.log('─'.repeat(50).dim);

  // Authenticate
  console.log(`\nAuthenticating as ${config.email}...`.gray);
  const token = await authenticate(config.apiUrl, config.email, config.password);
  console.log('Authenticated successfully.'.green);

  // Generate personas
  const personas = await generatePersonas(personaCount);

  // Run all persona flows
  const runs = await runAll(personas, token, config);

  // Exit code based on results
  const allOk = runs.every((r) => r.status === 'completed');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
