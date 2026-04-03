import { END, START, StateGraph } from '@langchain/langgraph';
import { QuizStateAnnotation } from './state';
import { contextLoad, quizGeneration } from './nodes';

// ── Graph construction ────────────────────────────────────
//
// Flow:
//   START → contextLoad → quizGeneration → END
//
// contextLoad aggregates all lesson summaries for the module
// quizGeneration produces 5-8 synthesis questions via structured output

const graph = new StateGraph(QuizStateAnnotation)
  .addNode('contextLoad', contextLoad)
  .addNode('quizGeneration', quizGeneration)
  .addEdge(START, 'contextLoad')
  .addEdge('contextLoad', 'quizGeneration')
  .addEdge('quizGeneration', END);

export const quizGenerationAgent = graph.compile();
