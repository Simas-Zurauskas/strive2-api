import { END, START, StateGraph } from '@langchain/langgraph';
import { LessonStateAnnotation } from './state';
import { contextLoad, contentGeneration, contentValidation, interactiveGeneration, imageGeneration, linksGeneration, merge } from './nodes';

// ── Graph construction ────────────────────────────────────
//
// Flow:
//   START → contextLoad ─┬── contentGeneration → contentValidation ─┬── interactiveGeneration ──┬── merge → END
//                         │                                          └── linksGeneration ────────┘
//                         └── imageGeneration ──────────────────────────────────────────────────┘
//
// imageGeneration starts immediately (parallel with content) — only needs lesson name
// contentGeneration streams blocks one-by-one via config.writer()
// contentValidation checks structural integrity (required blocks, metadata, mermaid syntax)
// After validation: interactive + links run in parallel (both only need content blocks)
// merge waits for interactive + links + image to complete (fan-in)

const graph = new StateGraph(LessonStateAnnotation)
  .addNode('contextLoad', contextLoad)
  .addNode('contentGeneration', contentGeneration)
  .addNode('contentValidation', contentValidation)
  .addNode('interactiveGeneration', interactiveGeneration)
  .addNode('imageGeneration', imageGeneration)
  .addNode('linksGeneration', linksGeneration)
  .addNode('merge', merge)
  .addEdge(START, 'contextLoad')
  // Fan-out: content + image start in parallel
  .addEdge('contextLoad', 'contentGeneration')
  .addEdge('contextLoad', 'imageGeneration')
  // Content → validation → fan-out to interactive + links
  .addEdge('contentGeneration', 'contentValidation')
  .addEdge('contentValidation', 'interactiveGeneration')
  .addEdge('contentValidation', 'linksGeneration')
  // Fan-in: merge waits for interactive + links + image
  .addEdge('interactiveGeneration', 'merge')
  .addEdge('linksGeneration', 'merge')
  .addEdge('imageGeneration', 'merge')
  .addEdge('merge', END);

export const lessonGenerationAgent = graph.compile();
