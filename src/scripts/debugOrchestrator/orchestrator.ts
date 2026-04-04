import pLimit from 'p-limit';
import { createApiClient } from './apiClient';
import { runPersonaFlow } from './courseFlow';
import { MarkdownRecorder } from './markdownRecorder';
import type { Persona, PersonaRun, OrchestratorConfig } from './types';

export async function runAll(
  personas: Persona[],
  token: string,
  config: OrchestratorConfig,
): Promise<PersonaRun[]> {
  const limit = pLimit(config.concurrency);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Starting ${personas.length} persona flows (concurrency: ${config.concurrency})`);
  console.log(`API: ${config.apiUrl}`);
  console.log(`Chat review: ${config.enableChatReview ? 'enabled' : 'disabled'}`);
  console.log(`Output: ${config.outputDir}`);
  console.log(`${'='.repeat(60)}\n`);

  const results = await Promise.allSettled(
    personas.map((persona, index) =>
      limit(async () => {
        const label = `Persona ${index + 1}/${personas.length} (${persona.name})`;
        console.log(`[${label}] Starting...`);

        const client = createApiClient(config.apiUrl, token);
        const recorder = new MarkdownRecorder();

        return runPersonaFlow(persona, client, recorder, config, label);
      }),
    ),
  );

  // Print summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('ORCHESTRATOR COMPLETE');
  console.log(`${'='.repeat(60)}`);

  const runs: PersonaRun[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const persona = personas[i];
    if (r.status === 'fulfilled') {
      const run = r.value;
      runs.push(run);
      const icon = run.status === 'completed' ? 'OK' : 'FAIL';
      console.log(`  [${icon}] ${persona.name} → ${(run.totalDurationMs / 1000).toFixed(1)}s (course: ${run.courseId})`);
    } else {
      console.log(`  [ERR] ${persona.name} → ${r.reason}`);
    }
  }

  const succeeded = runs.filter((r) => r.status === 'completed').length;
  const failed = runs.filter((r) => r.status === 'failed').length;
  const errored = results.filter((r) => r.status === 'rejected').length;
  console.log(`\nResults: ${succeeded} completed, ${failed} failed, ${errored} errored`);

  return runs;
}
