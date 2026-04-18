import pLimit from 'p-limit';
import { createApiClient } from './apiClient';
import { runPersonaFlow } from './courseFlow';
import { MarkdownRecorder } from './markdownRecorder';
import type { Persona, PersonaRun, OrchestratorConfig } from './types';

export async function runAll({
  personas,
  token,
  config,
}: {
  personas: Persona[];
  token: string;
  config: OrchestratorConfig;
}): Promise<PersonaRun[]> {
  const limit = pLimit(config.concurrency);

  console.log(`\n${'='.repeat(60).dim}`);
  console.log(`Starting ${personas.length} persona flows (concurrency: ${config.concurrency})`.cyan);
  console.log(`API: ${config.apiUrl}`.gray);
  console.log(`Chat review: ${config.enableChatReview ? 'enabled'.green : 'disabled'.yellow}`.gray);
  console.log(`Lessons: ${config.maxLessons === 0 ? 'skipped'.yellow : String(config.maxLessons)}`.gray);
  console.log(`Output: ${config.outputDir}`.gray);
  console.log(`${'='.repeat(60).dim}\n`);

  const results = await Promise.allSettled(
    personas.map((persona, index) =>
      limit(async () => {
        const label = `Persona ${index + 1}/${personas.length} (${persona.name})`;
        console.log(`[${label}]`.cyan + ' Starting...');

        const client = createApiClient({ baseUrl: config.apiUrl, token });
        const recorder = new MarkdownRecorder();

        return runPersonaFlow({ persona, client, recorder, config, label });
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

  return runs;
}
