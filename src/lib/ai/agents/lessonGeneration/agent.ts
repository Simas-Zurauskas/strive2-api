import { END, START, StateGraph } from '@langchain/langgraph';
import { LessonStateAnnotation } from './state';
import {
  contextLoad,
  contentGeneration,
  contentValidation,
  interactiveGeneration,
  imageGeneration,
  linksGeneration,
  recallCardGeneration,
  merge,
} from './nodes';

// ── Graph construction ────────────────────────────────────
//
// Flow:
//   START → contextLoad ─┬── contentGeneration → contentValidation ─┬── interactiveGeneration ──┬── merge → END
//                         │                                          ├── linksGeneration ─────────┤
//                         │                                          └── recallCardGeneration ───────┤
//                         └── imageGeneration ──────────────────────────────────────────────────────┘
//
// imageGeneration starts immediately (parallel with content) — only needs lesson name
// contentGeneration streams blocks one-by-one via config.writer()
// contentValidation checks structural integrity (required blocks, metadata, mermaid syntax)
// After validation: interactive + links + recall cards run in parallel — all need content blocks only
// merge waits for interactive + links + image + recall cards to complete (fan-in)
// Recall card extraction never blocks the lesson on failure — returns `recallCards: []`.

const graph = new StateGraph(LessonStateAnnotation)
  .addNode('contextLoad', contextLoad)
  .addNode('contentGeneration', contentGeneration)
  .addNode('contentValidation', contentValidation)
  .addNode('interactiveGeneration', interactiveGeneration)
  .addNode('imageGeneration', imageGeneration)
  .addNode('linksGeneration', linksGeneration)
  .addNode('recallCardGeneration', recallCardGeneration)
  .addNode('merge', merge)
  .addEdge(START, 'contextLoad')
  // Fan-out: content + image start in parallel
  .addEdge('contextLoad', 'contentGeneration')
  .addEdge('contextLoad', 'imageGeneration')
  // Content → validation → fan-out to interactive + links + recall cards
  .addEdge('contentGeneration', 'contentValidation')
  .addEdge('contentValidation', 'interactiveGeneration')
  .addEdge('contentValidation', 'linksGeneration')
  .addEdge('contentValidation', 'recallCardGeneration')
  // Fan-in: merge waits for interactive + links + image + recall cards
  .addEdge('interactiveGeneration', 'merge')
  .addEdge('linksGeneration', 'merge')
  .addEdge('imageGeneration', 'merge')
  .addEdge('recallCardGeneration', 'merge')
  .addEdge('merge', END);

export const lessonGenerationAgent = graph.compile();
