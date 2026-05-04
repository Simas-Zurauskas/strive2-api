import fs from 'fs';
import path from 'path';
import { CompiledGraph } from '@langchain/langgraph';
import { ENVIRONMENT } from '@conf/env';
import { courseDesignAgent } from './courseDesign';
import { lessonGenerationAgent } from './lessonGeneration';
import { quizGenerationAgent } from './quizGeneration';
import { lessonMentorAgent } from './lessonMentor';
import { courseMentorAgent } from './courseMentor';
import { lifecycleLog } from '@lib/loggers';
import { captureError } from '@lib/errorReporter';

const OUTPUT_DIR = path.resolve(__dirname, '../../../../graphs');

const saveGraphImage = async ({ graph, name }: { graph: CompiledGraph<any>; name: string }) => {
  try {
    const drawable = await graph.getGraphAsync({ xray: true });
    const blob = await drawable.drawMermaidPng({ curveStyle: 'basis' });
    const arrayBuffer = await blob.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    fs.writeFileSync(path.join(OUTPUT_DIR, `${name}.png`), buffer);
    lifecycleLog.info(`graphs:save ok name=${name}.png`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    lifecycleLog.error(`graphs:save fail name=${name} reason=${reason}`);
    captureError(err, {
      tags: { area: 'graphs.save' },
      extra: { name },
      fingerprint: ['graphs', 'save', name],
    });
  }
};

export const printGraphImages = async () => {
  if (ENVIRONMENT !== 'development') return;

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  await Promise.all([
    saveGraphImage({ graph: courseDesignAgent, name: 'courseDesignAgent' }),
    saveGraphImage({ graph: lessonGenerationAgent, name: 'lessonGenerationAgent' }),
    saveGraphImage({ graph: quizGenerationAgent, name: 'quizGenerationAgent' }),
    saveGraphImage({ graph: lessonMentorAgent, name: 'lessonMentorAgent' }),
    saveGraphImage({ graph: courseMentorAgent, name: 'courseMentorAgent' }),
  ]);
};
