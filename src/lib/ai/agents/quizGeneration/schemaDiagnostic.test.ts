/**
 * Regression test for the JSON Schema shape Anthropic receives as the
 * quiz-generation tool's `input_schema`.
 *
 * Asserts that the TOP-LEVEL `questions` field is a plain array schema —
 * NOT an `anyOf` union. The anyOf variant (what `jsonish(...)` produced)
 * correlated with a rare Anthropic tool-calling fault where the model
 * emitted `{}` instead of a populated tool input — see the incident
 * documented in `quizOutputSchema` itself.
 *
 * If this test ever fails, someone has likely wrapped the top-level
 * `questions` back in `jsonish(...)` or introduced another union at the
 * tool root. See `zodHelpers.ts:jsonish` for the guidance that forbids
 * this at the tool root specifically.
 *
 * Run: yarn test:quiz-schema-diag
 */

import assert from 'node:assert/strict';
import { z } from 'zod';
import { quizOutputSchema } from './prompts';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`  \u2713 ${name}`);
};

type JsonSchemaNode = {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  required?: string[];
  minItems?: number;
  maxItems?: number;
};

const toJsonSchema = (schema: z.ZodType): JsonSchemaNode => {
  // Zod v4 ships `z.toJSONSchema`. The project is on zod ^4.3.6.
  return (z as unknown as { toJSONSchema: (s: z.ZodType) => JsonSchemaNode }).toJSONSchema(schema);
};

console.log('quizOutputSchema shape regression');

const json = toJsonSchema(quizOutputSchema);

test('root is an object schema', () => {
  assert.equal(json.type, 'object', `expected type="object", got ${JSON.stringify(json.type)}`);
});

test('root has a `questions` property', () => {
  assert.ok(json.properties?.questions, 'missing properties.questions');
});

test('questions is a PLAIN array (no anyOf at tool root)', () => {
  const q = json.properties!.questions!;
  assert.equal(q.type, 'array', `expected type="array", got ${JSON.stringify(q.type)}`);
  assert.equal(q.anyOf, undefined, 'questions must NOT have anyOf at the tool root — see zodHelpers.ts:jsonish guidance');
});

test('questions retains min/max length constraints', () => {
  const q = json.properties!.questions!;
  assert.equal(q.minItems, 5, 'questions must require at least 5 items');
  assert.equal(q.maxItems, 8, 'questions must allow at most 8 items');
});

test('each question item is an object with required fields', () => {
  const q = json.properties!.questions!;
  const item = q.items;
  assert.ok(item, 'questions.items must be defined');
  assert.equal(item.type, 'object');
  const props = item.properties ?? {};
  for (const field of ['id', 'question', 'options', 'correctIndex', 'explanation', 'sourceLessons', 'isInterleaved']) {
    assert.ok(props[field], `question item missing property "${field}"`);
  }
});

test('inner options field CAN still use anyOf (nested union is acceptable)', () => {
  // Documenting the intentional asymmetry: top-level anyOf is banned, but
  // nested field anyOf from jsonish is fine — it's the tool-root that
  // triggers the empty-tool-call fault, not every instance of anyOf.
  const options = json.properties!.questions!.items!.properties!.options;
  assert.ok(options, 'options field must exist');
  const hasAnyOf = Array.isArray(options.anyOf);
  const hasType = typeof options.type === 'string';
  // Either shape is acceptable here — we only care that SOMETHING describes
  // options. If a future refactor removes jsonish from the inner fields too,
  // that's fine; if it keeps it, that's also fine.
  assert.ok(hasAnyOf || hasType, 'options must describe a shape (anyOf or type)');
});

console.log(`\n\u2713 quizOutputSchema shape: ${passed} regression(s) passed`);
