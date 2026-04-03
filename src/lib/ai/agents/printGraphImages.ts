import fs from 'fs';
import path from 'path';
import * as Sentry from '@sentry/node';
import { CompiledGraph } from '@langchain/langgraph';
import { ENVIRONMENT } from '@conf/env';
import { courseDesignAgent } from './courseDesign';
import { lessonGenerationAgent } from './lessonGeneration';

const OUTPUT_DIR = path.resolve(__dirname, '../../../../graphs');

const saveGraphImage = async (graph: CompiledGraph<any>, name: string) => {
  try {
    const drawable = await graph.getGraphAsync({ xray: true });
    const blob = await drawable.drawMermaidPng({ curveStyle: 'basis' });
    const arrayBuffer = await blob.arrayBuffer();
    const buffer = new Uint8Array(arrayBuffer);
    fs.writeFileSync(path.join(OUTPUT_DIR, `${name}.png`), buffer);
    console.log(`[graphs] ✓ ${name}.png saved`.green);
  } catch (err) {
    console.error(`[graphs] ✗ Failed to generate ${name}:`, err);
    Sentry.captureException(err);
  }
};

export const printGraphImages = async () => {
  if (ENVIRONMENT !== 'development') return;

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  await Promise.all([
    saveGraphImage(courseDesignAgent, 'courseDesignAgent'),
    saveGraphImage(lessonGenerationAgent, 'lessonGenerationAgent'),
  ]);
};
