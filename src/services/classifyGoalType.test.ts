/**
 * Tests for the safe-fallback contract documented at
 * `courseService.ts:46-52` (header for `classifyGoalType`):
 *
 *   "Failure mode is graceful: any error or schema-validation miss
 *    returns the safe default `{ goalType: 'master', confidence: 'low', ... }`
 *    so a Haiku hiccup never fails the clarify job."
 *
 * This contract is load-bearing for the entire course-creation flow: a
 * Haiku outage MUST NOT break clarify. Without these tests, a regression
 * that lets the Anthropic exception escape (or that returns a malformed
 * payload without falling back) would silently take down course creation
 * for everyone the next time Haiku has a bad day.
 *
 * Strategy: stub the Anthropic SDK at module level (the singleton in
 * courseService.ts:37 is constructed at import time, so we replace its
 * `messages.create` per-test) and assert the public contract.
 *
 * Run: yarn test classifyGoalType
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { classifyGoalType } from '@services/courseService';

// Spy holder — we replace the Anthropic prototype's `messages.create` per
// test so the singleton instance constructed in courseService.ts picks up
// our mock.
let createSpy: ReturnType<typeof vi.spyOn> | null = null;

const stubAnthropicResponse = (impl: () => Promise<unknown>) => {
  // The Anthropic SDK's `messages` lives on the instance, not the prototype.
  // Patch via mocking the SDK's `Messages` class prototype if available, OR
  // just monkey-patch the singleton's messages.create via a getter on the
  // module. The simplest path is to replace the prototype method.
  createSpy = vi.spyOn(Anthropic.Messages.prototype, 'create').mockImplementation(impl as never);
};

beforeEach(() => {
  createSpy = null;
});

afterEach(() => {
  createSpy?.mockRestore();
  createSpy = null;
});

describe('classifyGoalType — safe-fallback contract', () => {
  test('successful tool_use with valid schema → returns parsed result', async () => {
    stubAnthropicResponse(async () => ({
      content: [
        {
          type: 'tool_use',
          name: 'classify_goal_type',
          id: 't1',
          input: { goalType: 'master', confidence: 'high', noun: 'functional programming' },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    }));
    const result = await classifyGoalType({ goal: 'master functional programming in Haskell' });
    expect(result.goalType).toBe('master');
    expect(result.confidence).toBe('high');
    expect(result.noun).toBe('functional programming');
  });

  test('Anthropic throws (vendor outage) → fallback master/low; no rethrow', async () => {
    stubAnthropicResponse(async () => {
      throw new Error('529 overloaded');
    });
    const result = await classifyGoalType({ goal: 'learn to ship a SaaS' });
    expect(result.goalType).toBe('master');
    expect(result.confidence).toBe('low');
    // Noun falls back to the goal text (truncated). Critical bit: the
    // function returns successfully — never bubbles the vendor error.
    expect(result.noun).toBe('learn to ship a SaaS');
  });

  test('model emits no tool_use block → fallback master/low', async () => {
    stubAnthropicResponse(async () => ({
      content: [{ type: 'text', text: 'sorry, I cannot do that' }],
      usage: { input_tokens: 10, output_tokens: 10 },
    }));
    const result = await classifyGoalType({ goal: 'pass my CPA exam' });
    expect(result.goalType).toBe('master');
    expect(result.confidence).toBe('low');
    expect(result.noun).toBe('pass my CPA exam');
  });

  test('tool_use input fails Zod schema (wrong enum) → fallback master/low', async () => {
    stubAnthropicResponse(async () => ({
      content: [
        {
          type: 'tool_use',
          name: 'classify_goal_type',
          id: 't1',
          input: { goalType: 'banana', confidence: 'high', noun: 'something' },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    }));
    const result = await classifyGoalType({ goal: 'something specific' });
    expect(result.goalType).toBe('master');
    expect(result.confidence).toBe('low');
  });

  test('tool_use input is missing required fields → fallback', async () => {
    stubAnthropicResponse(async () => ({
      content: [
        {
          type: 'tool_use',
          name: 'classify_goal_type',
          id: 't1',
          input: { goalType: 'master' }, // missing confidence + noun
        },
      ],
      usage: { input_tokens: 10, output_tokens: 10 },
    }));
    const result = await classifyGoalType({ goal: 'something' });
    expect(result.goalType).toBe('master');
    expect(result.confidence).toBe('low');
  });

  test('empty goal text → fallback returns "this topic" as the noun', async () => {
    stubAnthropicResponse(async () => {
      throw new Error('any failure');
    });
    const result = await classifyGoalType({ goal: '' });
    expect(result.noun).toBe('this topic');
  });

  test('long goal → fallback noun is truncated to ≤60 chars', async () => {
    stubAnthropicResponse(async () => {
      throw new Error('any failure');
    });
    const longGoal = 'a'.repeat(200);
    const result = await classifyGoalType({ goal: longGoal });
    expect(result.noun.length).toBeLessThanOrEqual(60);
  });
});
