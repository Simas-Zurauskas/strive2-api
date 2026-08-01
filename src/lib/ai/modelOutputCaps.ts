import { z } from 'zod';
import { genLog } from '@lib/loggers';
import { bumpModelOutputClamped } from '@lib/metrics';

/**
 * Normalize-then-validate for forced-tool model payloads (ai-features.md
 * §4.1 — "a parse failure is an expected outcome with defined behaviour").
 *
 * ── The failure this exists to prevent ─────────────────────
 * A hand-written Anthropic `input_schema` and its Zod counterpart are two
 * copies of the same contract. When the Zod copy is STRICTER (e.g. Zod caps
 * a topic at 80 chars, the tool schema advertises no `maxLength`), the model
 * is never told the limit and a verbose-but-correct answer fails validation.
 * `withRetry` then re-sends the IDENTICAL prompt at temperature 0, so every
 * attempt reproduces the same overrun and the job dies — deterministically,
 * for that corpus, forever. (Observed 2026-07-30 on `doc:assess`: three
 * attempts, all "Too big: expected string to have <=80 characters".)
 *
 * Two halves of the fix, and both are needed:
 *   1. ADVERTISE — the tool schema carries the real caps, so the model is
 *      told. Kept honest by a per-service parity test built on
 *      `diffAdvertisedCaps` (Zod is the source of truth; the hand-written
 *      tool schema must advertise everything Zod enforces).
 *   2. CLAMP — before Zod, over-long strings are trimmed and over-long
 *      arrays are sliced, so a cosmetic overrun can never fail a paid job
 *      even when the model ignores the advertised cap.
 *
 * ── The boundary: what is clamped vs. what still fails ─────
 * CLAMPED (cosmetic — the model answered correctly, just too verbosely):
 *   - a string longer than `maxLength` → trimmed, then cut to the cap;
 *   - an array with more items than `maxItems` → sliced to the cap.
 * NOT CLAMPED (genuinely invalid — the model answered wrongly; Zod fails
 * and the caller's typed failure path runs exactly as before):
 *   - a missing required field, or `null` where a value belongs;
 *   - a wrong type (string where a number belongs, object where an array is);
 *   - a value outside a closed enum;
 *   - a number outside its range (a lesson band of 900 is a claim about the
 *     corpus, not a formatting slip — refusing it is the point);
 *   - an empty or whitespace-only required string (trimming makes this
 *     surface honestly as `minLength` rather than persisting "   ").
 * Rationale for the line: clamping is only ever applied where the model's
 * MEANING survives the edit. Anything that would require guessing what the
 * model meant is a real error and stays a real error.
 *
 * Every clamp bumps `model_output_clamped_total{label=…}` and logs a warn —
 * a silent clamp would hide prompt drift, which is the thing we actually
 * want to see (a rising rate means the prompt or the model moved).
 */

// ── Cap vocabulary ─────────────────────────────────────────

/** The JSON-Schema constraint keywords this module understands. */
export interface FieldCaps {
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  enum?: readonly unknown[];
}

const NUMERIC_CAP_KEYS = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum'] as const;

interface JsonSchemaNode {
  type?: string | string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode | JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  enum?: readonly unknown[];
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Path syntax: dotted object keys with `[]` for "each item of this array",
 * e.g. `topics[]`, `perDocumentNotes[].warnings[]`, `sizeBand.minLessons`.
 * The root object is the empty path.
 */
const childPath = (path: string, key: string): string => (path ? `${path}.${key}` : key);

const mergeCaps = (target: FieldCaps, source: FieldCaps): void => {
  for (const key of NUMERIC_CAP_KEYS) {
    if (source[key] !== undefined && target[key] === undefined) target[key] = source[key];
  }
  if (source.enum !== undefined && target.enum === undefined) target.enum = source.enum;
};

/**
 * Zod's `.int()` renders as the JS safe-integer window
 * (`minimum: -(2^53-1)`, `maximum: 2^53-1`). Those are representational
 * artifacts of "this is an integer", not product caps, and advertising them
 * to a model would be prompt noise — so they are not treated as constraints.
 */
const isSafeIntegerArtifact = (key: (typeof NUMERIC_CAP_KEYS)[number], value: number): boolean =>
  (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) ||
  (key === 'minimum' && value === Number.MIN_SAFE_INTEGER);

const nodeCaps = (node: JsonSchemaNode): FieldCaps => {
  const caps: FieldCaps = {};
  for (const key of NUMERIC_CAP_KEYS) {
    const value = node[key];
    if (typeof value === 'number' && !isSafeIntegerArtifact(key, value)) caps[key] = value;
  }
  if (Array.isArray(node.enum)) caps.enum = node.enum;
  return caps;
};

const hasAnyCap = (caps: FieldCaps): boolean =>
  NUMERIC_CAP_KEYS.some((k) => caps[k] !== undefined) || caps.enum !== undefined;

/**
 * Walk any JSON Schema (the subset `z.toJSONSchema` emits and the subset a
 * hand-written Anthropic `input_schema` uses) and collect the constraints
 * per field path. Works on BOTH sides of the parity check — that symmetry
 * is the point: one walker, two inputs, comparable output.
 */
export const collectSchemaCaps = (
  schema: unknown,
  path = '',
  out: Map<string, FieldCaps> = new Map(),
): Map<string, FieldCaps> => {
  if (!isRecord(schema)) return out;
  const node = schema as JsonSchemaNode;

  const caps = nodeCaps(node);
  if (hasAnyCap(caps)) {
    const existing = out.get(path);
    if (existing) mergeCaps(existing, caps);
    else out.set(path, caps);
  }

  // Union branches (e.g. `options: string[] | null`) contribute their caps
  // at the same path; the `null` branch carries none.
  for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) {
    collectSchemaCaps(branch, path, out);
  }

  if (isRecord(node.properties)) {
    for (const [key, child] of Object.entries(node.properties)) {
      collectSchemaCaps(child, childPath(path, key), out);
    }
  }

  if (Array.isArray(node.items)) {
    for (const item of node.items) collectSchemaCaps(item, `${path}[]`, out);
  } else if (node.items !== undefined) {
    collectSchemaCaps(node.items, `${path}[]`, out);
  }

  return out;
};

/** Caps enforced by a Zod schema — the source of truth for both halves. */
export const capsFromZodSchema = (schema: z.ZodType): Map<string, FieldCaps> =>
  // `io: 'input'` describes what the MODEL may send (pre-`.default()`),
  // which is exactly the payload being clamped and advertised.
  collectSchemaCaps(z.toJSONSchema(schema, { io: 'input' }));

/**
 * Every constraint Zod enforces that the hand-written tool schema does NOT
 * advertise (or advertises differently). `[]` means the model is told the
 * whole truth. Zod → tool only: a tool schema may be stricter or carry
 * extra guidance (e.g. a `pattern`) without failing the check.
 */
export const diffAdvertisedCaps = (
  zodCaps: Map<string, FieldCaps>,
  toolCaps: Map<string, FieldCaps>,
): string[] => {
  const problems: string[] = [];
  for (const [path, expected] of zodCaps) {
    const actual = toolCaps.get(path);
    if (!actual) {
      problems.push(`${path}: tool schema advertises no constraints (Zod enforces ${JSON.stringify(expected)})`);
      continue;
    }
    for (const key of NUMERIC_CAP_KEYS) {
      const want = expected[key];
      if (want === undefined) continue;
      if (actual[key] === undefined) {
        problems.push(`${path}: tool schema is missing ${key} (Zod enforces ${key}=${want})`);
      } else if (actual[key] !== want) {
        problems.push(`${path}: tool schema says ${key}=${actual[key]}, Zod enforces ${key}=${want}`);
      }
    }
    if (expected.enum) {
      const advertised = new Set(actual.enum ?? []);
      const missing = expected.enum.filter((v) => !advertised.has(v));
      if (!actual.enum) problems.push(`${path}: tool schema is missing the closed enum`);
      else if (missing.length > 0) problems.push(`${path}: tool schema enum omits ${JSON.stringify(missing)}`);
    }
  }
  return problems;
};

// ── Clamping ───────────────────────────────────────────────

const clampString = (value: string, max: number): string => value.trim().slice(0, max).trimEnd();

const walk = (value: unknown, path: string, caps: Map<string, FieldCaps>, clamps: string[]): unknown => {
  const cap = caps.get(path);

  if (typeof value === 'string') {
    if (cap?.maxLength !== undefined && value.length > cap.maxLength) {
      clamps.push(`${path} len ${value.length}>${cap.maxLength}`);
      return clampString(value, cap.maxLength);
    }
    // Trim only where a length cap exists (i.e. a bounded free-text field),
    // so whitespace-only output fails `minLength` instead of being stored.
    return cap?.maxLength !== undefined ? value.trim() : value;
  }

  if (Array.isArray(value)) {
    let items = value;
    if (cap?.maxItems !== undefined && items.length > cap.maxItems) {
      clamps.push(`${path} items ${items.length}>${cap.maxItems}`);
      items = items.slice(0, cap.maxItems);
    }
    return items.map((item) => walk(item, `${path}[]`, caps, clamps));
  }

  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = walk(child, childPath(path, key), caps, clamps);
    }
    return out;
  }

  // Numbers, booleans, null, undefined: never rewritten — see the boundary
  // note in the module header. Zod decides.
  return value;
};

/** Test-visible core: the clamp with no logging or metric side effects. */
export const clampToCaps = (
  raw: unknown,
  caps: Map<string, FieldCaps>,
): { value: unknown; clamps: string[] } => {
  const clamps: string[] = [];
  const value = walk(raw, '', caps, clamps);
  return { value, clamps };
};

/**
 * Clamp a model tool payload to the caps its Zod schema enforces, logging
 * and metering whenever a clamp fires. Returns the payload to hand to
 * `safeParse` — always call Zod afterwards; this narrows nothing.
 */
export const clampModelToolPayload = ({
  raw,
  caps,
  label,
}: {
  raw: unknown;
  caps: Map<string, FieldCaps>;
  /** The call-site label already used for retries/usage, e.g. `doc:assess`. */
  label: string;
}): unknown => {
  const { value, clamps } = clampToCaps(raw, caps);
  if (clamps.length > 0) {
    bumpModelOutputClamped(label);
    // Paths + sizes only — never the clamped content (§8.2).
    genLog.warn(`${label} output clamped to schema caps: ${clamps.slice(0, 6).join('; ')}`);
  }
  return value;
};
