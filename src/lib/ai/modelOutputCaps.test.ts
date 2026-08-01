/**
 * Unit tests for the normalize-then-validate helper behind BUG 1 (a Zod cap
 * the tool schema never advertised, re-sent identically by withRetry, killing
 * a paid job over a cosmetic overrun).
 *
 * Pins: the cap walker on both schema dialects (z.toJSONSchema output and a
 * hand-written Anthropic input_schema), the parity diff in both directions,
 * and the clamp boundary — strings/arrays clamped, everything else left for
 * Zod to reject.
 *
 * Run: yarn test modelOutputCaps
 */

import { describe, test, expect } from 'vitest';
import { z } from 'zod';
import {
  capsFromZodSchema,
  collectSchemaCaps,
  clampToCaps,
  clampModelToolPayload,
  diffAdvertisedCaps,
} from './modelOutputCaps';
import * as metrics from '@lib/metrics';

const schema = z.object({
  title: z.string().min(1).max(10),
  tags: z.array(z.string().min(1).max(5)).max(2),
  score: z.number().min(0).max(1),
  mode: z.enum(['a', 'b']),
  nested: z.object({
    notes: z.array(z.object({ id: z.string().max(4), lines: z.array(z.string().max(3)).max(1) })).max(2),
  }),
});

describe('collectSchemaCaps', () => {
  test('collects caps by path from a Zod-derived JSON schema', () => {
    const caps = capsFromZodSchema(schema);
    expect(caps.get('title')).toMatchObject({ minLength: 1, maxLength: 10 });
    expect(caps.get('tags')).toMatchObject({ maxItems: 2 });
    expect(caps.get('tags[]')).toMatchObject({ maxLength: 5 });
    expect(caps.get('score')).toMatchObject({ minimum: 0, maximum: 1 });
    expect(caps.get('mode')?.enum).toEqual(['a', 'b']);
    expect(caps.get('nested.notes[].lines[]')).toMatchObject({ maxLength: 3 });
  });

  test('reads a hand-written Anthropic input_schema with the same walker', () => {
    const caps = collectSchemaCaps({
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 10 },
        tags: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 5 } },
      },
    });
    expect(caps.get('title')?.maxLength).toBe(10);
    expect(caps.get('tags[]')?.maxLength).toBe(5);
  });

  test('walks union branches without losing the non-null branch caps', () => {
    const caps = collectSchemaCaps({
      type: 'object',
      properties: {
        options: { anyOf: [{ type: 'array', maxItems: 6, items: { type: 'string', maxLength: 40 } }, { type: 'null' }] },
      },
    });
    expect(caps.get('options')?.maxItems).toBe(6);
    expect(caps.get('options[]')?.maxLength).toBe(40);
  });
});

describe('diffAdvertisedCaps', () => {
  test('reports an un-advertised cap (the exact BUG-1 shape)', () => {
    const zodCaps = capsFromZodSchema(z.object({ topics: z.array(z.string().max(80)).max(12) }));
    const toolCaps = collectSchemaCaps({
      type: 'object',
      properties: { topics: { type: 'array', maxItems: 12, items: { type: 'string' } } },
    });
    const problems = diffAdvertisedCaps(zodCaps, toolCaps);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('topics[]');
    expect(problems[0]).toContain('maxLength');
  });

  test('reports a mismatched value and a missing enum', () => {
    const zodCaps = capsFromZodSchema(z.object({ a: z.string().max(80), m: z.enum(['x', 'y']) }));
    const toolCaps = collectSchemaCaps({
      type: 'object',
      properties: { a: { type: 'string', maxLength: 50 }, m: { type: 'string' } },
    });
    expect(diffAdvertisedCaps(zodCaps, toolCaps).join(' | ')).toMatch(/maxLength=50.*maxLength=80|missing the closed enum/s);
    expect(diffAdvertisedCaps(zodCaps, toolCaps)).toHaveLength(2);
  });

  test('passes when the tool advertises everything (extra tool-only guidance is fine)', () => {
    const zodCaps = capsFromZodSchema(z.object({ a: z.string().min(1).max(80) }));
    const toolCaps = collectSchemaCaps({
      type: 'object',
      properties: { a: { type: 'string', minLength: 1, maxLength: 80, pattern: '^x' } },
    });
    expect(diffAdvertisedCaps(zodCaps, toolCaps)).toEqual([]);
  });
});

describe('clampToCaps — the boundary', () => {
  const caps = capsFromZodSchema(schema);

  test('trims over-long strings and slices over-long arrays, reporting each clamp', () => {
    const { value, clamps } = clampToCaps(
      {
        title: 'x'.repeat(30),
        tags: ['aaaaaaa', 'bb', 'cc'],
        nested: { notes: [{ id: 'abcdef', lines: ['xxxx', 'yyyy'] }] },
      },
      caps,
    );
    const out = value as { title: string; tags: string[]; nested: { notes: { id: string; lines: string[] }[] } };
    expect(out.title).toHaveLength(10);
    expect(out.tags).toEqual(['aaaaa', 'bb']);
    expect(out.nested.notes[0].id).toBe('abcd');
    expect(out.nested.notes[0].lines).toEqual(['xxx']);
    // title, tags count, tags[0], notes[0].id, lines count, lines[0].
    expect(clamps.length).toBe(6);
  });

  test('ignores Zod .int() safe-integer bounds (representational, not product caps)', () => {
    const intCaps = capsFromZodSchema(z.object({ n: z.number().int() }));
    expect(intCaps.get('n')?.maximum).toBeUndefined();
    expect(intCaps.get('n')?.minimum).toBeUndefined();
    // A real range is still collected.
    expect(capsFromZodSchema(z.object({ n: z.number().int().min(0).max(200) })).get('n')).toMatchObject({
      minimum: 0,
      maximum: 200,
    });
  });

  test('leaves an in-cap payload untouched and reports no clamps', () => {
    const input = { title: 'short', tags: ['a'], score: 0.5, mode: 'a', nested: { notes: [] } };
    const { value, clamps } = clampToCaps(input, caps);
    expect(value).toEqual(input);
    expect(clamps).toEqual([]);
  });

  test('never rewrites numbers, booleans, nulls or enum values (Zod still decides)', () => {
    const input = { title: 'ok', score: 42, mode: 'zzz', tags: null, extra: true };
    const { value, clamps } = clampToCaps(input, caps);
    expect(value).toEqual(input);
    expect(clamps).toEqual([]);
  });

  test('whitespace-only bounded strings become empty so minLength can reject them', () => {
    const { value } = clampToCaps({ title: '   ' }, caps);
    expect((value as { title: string }).title).toBe('');
    expect(schema.safeParse({ ...{ title: '' } }).success).toBe(false);
  });

  test('preserves unknown keys (Zod strips them, as before)', () => {
    const { value } = clampToCaps({ title: 'ok', unknownKey: 'kept' }, caps);
    expect((value as Record<string, unknown>).unknownKey).toBe('kept');
  });
});

describe('clampModelToolPayload', () => {
  test('bumps the per-label metric only when a clamp fires', () => {
    const caps = capsFromZodSchema(schema);
    const label = 'test:clamp-metric';
    const before = metrics.modelOutputClampedTotal[label] ?? 0;

    clampModelToolPayload({ raw: { title: 'short' }, caps, label });
    expect(metrics.modelOutputClampedTotal[label] ?? 0).toBe(before);

    clampModelToolPayload({ raw: { title: 'x'.repeat(99) }, caps, label });
    expect(metrics.modelOutputClampedTotal[label]).toBe(before + 1);
  });
});
