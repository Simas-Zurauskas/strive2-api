import pLimit from 'p-limit';
import { createApiClient } from './apiClient';
import { runPersonaFlow } from './courseFlow';
import { MarkdownRecorder } from './markdownRecorder';
import { createVerifiedTestUser, deleteTestUser } from './testUser';
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
  console.log(`Insights: ${config.enableInsights ? 'enabled (review all returned)'.green : 'disabled'.yellow}`.gray);
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

  return runs;
}
