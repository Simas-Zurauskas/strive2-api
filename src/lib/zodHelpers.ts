import { z } from 'zod';
import { jsonrepair } from 'jsonrepair';
import * as Sentry from '@sentry/node';

/**
 * Escape `"` characters that appear inside a JSON string value but weren't
 * escaped by the emitter. Anthropic sometimes stringifies a nested array and
 * botches the escape when content contains quoted phrases like
 * `"Yellow: −45"` — the inner quotes terminate the outer string early and
 * strict `JSON.parse` fails. jsonrepair can't disambiguate either because
 * the pattern `…")…` looks like it could be legal structural JSON.
 *
 * Walk the string as a state machine: when inside a string and we hit `"`,
 * peek at the next non-whitespace char. If it's `,` / `:` / `]` / `}` / EOF,
 * it's a closing quote; otherwise it's an unescaped inner quote and we
 * prefix it with a backslash.
 */
const escapeInnerQuotes = (s: string): string => {
  const out: string[] = [];
  let i = 0;
  let inString = false;
  while (i < s.length) {
    const c = s[i];
    if (!inString) {
      out.push(c);
      if (c === '"') inString = true;
      i++;
      continue;
    }
    // Inside a string.
    if (c === '\\' && i + 1 < s.length) {
      out.push(c, s[i + 1]);
      i += 2;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      const next = j < s.length ? s[j] : null;
      if (next === null || next === ':' || next === ',' || next === ']' || next === '}') {
        out.push(c);
        inString = false;
      } else {
        out.push('\\', '"');
      }
      i++;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
};

/**
 * Accept either the expected value or a JSON-encoded string of it.
 *
 * Anthropic structured-output intermittently stringifies nested arrays/objects
 * (e.g. `{ blocks: "[...]" }` instead of `{ blocks: [...] }`). This is a
 * model-side behavior, acknowledged upstream with no fix — see
 * anthropics/claude-agent-sdk-python#510 and langchain-ai/langchainjs#7643.
 * Wrap the schema so those responses parse through instead of being rejected
 * by Zod.
 *
 * Implemented as a `z.union`, not `z.preprocess` / `.pipe()` — LangChain's
 * `toJsonSchema` recursively unwraps pipe schemas to their input type (see
 * `interopZodTransformInputSchema` in `@langchain/core`), which collapses
 * `z.unknown().transform(...).pipe(inner)` to `z.unknown()` and emits an
 * empty `{}` for that field in the tool schema. The model then has no shape
 * to conform to and frequently stringifies the array or drifts field names.
 * A union survives the unwrap: both branches describe the array shape, so
 * Anthropic sees `anyOf: [arraySchema, arraySchema]` and targets the correct
 * structure; the transform only fires at parse time to salvage the string
 * case.
 *
 * Three-stage parse on the string branch: strict `JSON.parse` first (fast
 * path), then `escapeInnerQuotes` + strict parse (recovers from unescaped
 * inner quotes inside content fields), then `jsonrepair` (handles trailing
 * commas, truncated objects, missing braces). If all three fail, Zod
 * reports a normal validation error and the caller's retry layer kicks in.
 */
export const jsonish = <T extends z.ZodTypeAny>(schema: T): T => {
  const wrapped = z.union([
    schema,
    z
      .string()
      .transform((s, ctx) => {
        try {
          return JSON.parse(s);
        } catch (strictErr) {
          try {
            return JSON.parse(escapeInnerQuotes(s));
          } catch {
            try {
              return JSON.parse(jsonrepair(s));
            } catch (repairErr) {
              const strictReason = strictErr instanceof Error ? strictErr.message : String(strictErr);
              const repairReason = repairErr instanceof Error ? repairErr.message : String(repairErr);
              const posMatch = /position (\d+)/.exec(repairReason) ?? /position (\d+)/.exec(strictReason);
              const pos = posMatch ? Number(posMatch[1]) : -1;
              const windowStart = Math.max(0, pos - 80);
              const windowEnd = Math.min(s.length, pos + 80);
              const window = pos >= 0
                ? `…${s.slice(windowStart, pos)}⟦HERE⟧${s.slice(pos, windowEnd)}…`
                : s.slice(0, 200);
              console.warn(
                `[jsonish] parse failed\n  strict: ${strictReason}\n  repair: ${repairReason}\n  length: ${s.length}\n  window around pos ${pos}: ${JSON.stringify(window)}`,
              );
              Sentry.captureMessage('jsonish parse failed — all 3 tiers', {
                level: 'warning',
                tags: { source: 'jsonish' },
                extra: {
                  strict_error: strictReason,
                  repair_error: repairReason,
                  payload_length: s.length,
                  failure_position: pos,
                  window,
                  payload_preview: s.slice(0, 500),
                },
              });
              ctx.issues.push({
                code: 'custom',
                message: `JSON.parse + escapeInnerQuotes + jsonrepair failed: ${repairReason}`,
                input: s,
              });
              return z.NEVER;
            }
          }
        }
      })
      .pipe(schema),
  ]);
  return wrapped as unknown as T;
};
