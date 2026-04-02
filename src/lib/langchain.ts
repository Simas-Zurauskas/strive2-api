import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { OPENAI_API_KEY, ANTHROPIC_API_KEY } from '@conf/env';

// Clarify questions — needs good domain knowledge for discriminating questions
const clarifyModel = new ChatOpenAI({
  model: 'gpt-4o',
  temperature: 0.7,
  apiKey: OPENAI_API_KEY,
  timeout: 60000,
});

// Structure generation — needs strong reasoning, long output, complex constraint adherence
const structureModel = new ChatAnthropic({
  model: 'claude-sonnet-4-6',
  temperature: 0.7,
  anthropicApiKey: ANTHROPIC_API_KEY,
  maxTokens: 16384,
  clientOptions: { timeout: 600000 }, // 10 minutes
});

// Agent chat — not used directly for LLM calls (chat node uses raw Anthropic SDK
// for proper per-token streaming). Kept for potential non-streaming fallback.
const agentModel = new ChatAnthropic({
  model: 'claude-sonnet-4-6',
  temperature: 0.7,
  anthropicApiKey: ANTHROPIC_API_KEY,
  maxTokens: 4096,
  streaming: true,
  clientOptions: { timeout: 120000 },
});

// Lesson content generation — best long-form educational writing, slight creativity
const lessonModel = new ChatAnthropic({
  model: 'claude-sonnet-4-6',
  temperature: 0.3,
  anthropicApiKey: ANTHROPIC_API_KEY,
  maxTokens: 16384,
  clientOptions: { timeout: 600000 }, // 10 minutes
});

// Interactive element generation (quizzes, exercises) — fast, structured extraction
const interactiveModel = new ChatAnthropic({
  model: 'claude-haiku-4-5-20251001',
  temperature: 0,
  anthropicApiKey: ANTHROPIC_API_KEY,
  maxTokens: 4096,
  clientOptions: { timeout: 60000 },
});

export const getClarifyModel = () => clarifyModel;
export const getStructureModel = () => structureModel;
export const getAgentModel = () => agentModel;
export const getLessonModel = () => lessonModel;
export const getInteractiveModel = () => interactiveModel;
