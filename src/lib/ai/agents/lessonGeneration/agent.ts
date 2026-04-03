import { END, START, StateGraph } from '@langchain/langgraph';
import { LessonStateAnnotation } from './state';
import { contextLoad, contentGeneration, interactiveGeneration, imageGeneration, linksGeneration, merge } from './nodes';

// ── Graph construction ────────────────────────────────────
//
// Flow:
//   START → contextLoad ─┬── contentGeneration → interactiveGeneration → linksGeneration ──┬── merge → END
//                         └── imageGeneration ─────────────────────────────────────────────┘
//
// imageGeneration starts immediately (parallel with content) — only needs lesson name
// contentGeneration streams blocks one-by-one via config.writer()
// interactiveGeneration runs after content (needs content blocks as context)
// linksGeneration runs at the very end (after interactive)
// merge waits for links + image to complete (fan-in)

const graph = new StateGraph(LessonStateAnnotation)
  .addNode('contextLoad', contextLoad)
  .addNode('contentGeneration', contentGeneration)
  .addNode('interactiveGeneration', interactiveGeneration)
  .addNode('imageGeneration', imageGeneration)
  .addNode('linksGeneration', linksGeneration)
  .addNode('merge', merge)
  .addEdge(START, 'contextLoad')
  // Fan-out: content + image start in parallel
  .addEdge('contextLoad', 'contentGeneration')
  .addEdge('contextLoad', 'imageGeneration')
  // Sequential: content → interactive → links (links last)
  .addEdge('contentGeneration', 'interactiveGeneration')
  .addEdge('interactiveGeneration', 'linksGeneration')
  // Fan-in: merge waits for links + image
  .addEdge('linksGeneration', 'merge')
  .addEdge('imageGeneration', 'merge')
  .addEdge('merge', END);

export const lessonGenerationAgent = graph.compile();
