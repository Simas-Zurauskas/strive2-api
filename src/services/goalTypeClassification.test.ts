import { describe, it, expect } from 'vitest';
import { GOAL_TYPES } from '@lib/constants';
import {
  goalTypeClassificationSchema,
  GOAL_TYPE_GUIDANCE,
  fallbackClassification,
} from './goalTypeClassification';

describe('goalTypeClassificationSchema', () => {
  it('accepts a valid classification', () => {
    const parsed = goalTypeClassificationSchema.parse({
      goalType: 'monetize',
      confidence: 'high',
      noun: 'your YouTube channel',
    });
    expect(parsed.goalType).toBe('monetize');
    expect(parsed.confidence).toBe('high');
    expect(parsed.noun).toBe('your YouTube channel');
  });

  it('rejects an unknown goalType', () => {
    const result = goalTypeClassificationSchema.safeParse({
      goalType: 'side-hustle',
      confidence: 'high',
      noun: 'a thing',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown confidence', () => {
    const result = goalTypeClassificationSchema.safeParse({
      goalType: 'master',
      confidence: 'absolute',
      noun: 'a thing',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an empty noun', () => {
    const result = goalTypeClassificationSchema.safeParse({
      goalType: 'master',
      confidence: 'low',
      noun: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a noun over 80 chars', () => {
    const result = goalTypeClassificationSchema.safeParse({
      goalType: 'master',
      confidence: 'low',
      noun: 'a'.repeat(81),
    });
    expect(result.success).toBe(false);
  });
});

describe('GOAL_TYPE_GUIDANCE', () => {
  it('has an entry for every goalType (compile-time enforced; runtime double-check)', () => {
    for (const t of GOAL_TYPES) {
      expect(GOAL_TYPE_GUIDANCE[t]).toBeTruthy();
      expect(typeof GOAL_TYPE_GUIDANCE[t]).toBe('string');
    }
    expect(Object.keys(GOAL_TYPE_GUIDANCE).sort()).toEqual([...GOAL_TYPES].sort());
  });
});

describe('fallbackClassification', () => {
  it('returns master/low for any goal', () => {
    const result = fallbackClassification('become a YouTuber');
    expect(result.goalType).toBe('master');
    expect(result.confidence).toBe('low');
  });

  it('truncates long goals to fit the noun field', () => {
    const result = fallbackClassification('a'.repeat(200));
    expect(result.noun.length).toBeLessThanOrEqual(80);
  });

  it("falls back to 'this topic' for an empty goal", () => {
    const result = fallbackClassification('');
    expect(result.noun).toBe('this topic');
  });

  it('produces a schema-valid result', () => {
    const result = fallbackClassification('learn React');
    expect(goalTypeClassificationSchema.parse(result)).toEqual(result);
  });
});
