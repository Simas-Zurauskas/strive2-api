import { END, START, StateGraph } from '@langchain/langgraph';
import { LessonStateAnnotation } from './state';
import {
  contextLoad,
  contentGeneration,
  contentValidation,
  interactiveGeneration,
  imageGeneration,
  linksGeneration,
  insightGeneration,
  merge,
} from './nodes';

// ── Graph construction ────────────────────────────────────
//
// Flow:
//   START → contextLoad ─┬── contentGeneration → contentValidation ─┬── interactiveGeneration ──┬── merge → END
//                         │                                          ├── linksGeneration ─────────┤
//                         │                                          └── insightGeneration ───────┤
//                         └── imageGeneration ──────────────────────────────────────────────────────┘
//
// imageGeneration starts immediately (parallel with content) — only needs lesson name
// contentGeneration streams blocks one-by-one via config.writer()
// contentValidation checks structural integrity (required blocks, metadata, mermaid syntax)
// After validation: interactive + links + insights run in parallel — all need content blocks only
// merge waits for interactive + links + image + insights to complete (fan-in)
// Insight extraction never blocks the lesson on failure — returns `insights: []`.

const graph = new StateGraph(LessonStateAnnotation)
  .addNode('contextLoad', contextLoad)
  .addNode('contentGeneration', contentGeneration)
  .addNode('contentValidation', contentValidation)
  .addNode('interactiveGeneration', interactiveGeneration)
  .addNode('imageGeneration', imageGeneration)
  .addNode('linksGeneration', linksGeneration)
  .addNode('insightGeneration', insightGeneration)
  .addNode('merge', merge)
  .addEdge(START, 'contextLoad')
  // Fan-out: content + image start in parallel
  .addEdge('contextLoad', 'contentGeneration')
  .addEdge('contextLoad', 'imageGeneration')
  // Content → validation → fan-out to interactive + links + insights
  .addEdge('contentGeneration', 'contentValidation')
  .addEdge('contentValidation', 'interactiveGeneration')
  .addEdge('contentValidation', 'linksGeneration')
  .addEdge('contentValidation', 'insightGeneration')
  // Fan-in: merge waits for interactive + links + image + insights
  .addEdge('interactiveGeneration', 'merge')
  .addEdge('linksGeneration', 'merge')
  .addEdge('imageGeneration', 'merge')
  .addEdge('insightGeneration', 'merge')
  .addEdge('merge', END);

export const lessonGenerationAgent = graph.compile();
