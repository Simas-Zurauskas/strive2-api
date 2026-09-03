import { Types } from 'mongoose';
import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import { JUDGE0_API_KEY, JUDGE0_API_URL } from '@conf/env';
import { priceFlatUnit } from '@lib/pricing';
import { recordUsage } from '@services/usageService';
import { debitActualSpend } from '@services/creditService';
import { bgError } from '@lib/bg';
import { integrationLog } from '@lib/loggers';

// ── Judge0 language IDs ────────────────────────────────
// Full list: https://github.com/judge0/judge0#supported-languages

const LANGUAGE_IDS: Record<string, number> = {
  // Scripting & dynamic
  python: 71,        // Python 3
  javascript: 63,    // Node.js
  typescript: 74,    // TypeScript
  ruby: 72,          // Ruby
  php: 68,           // PHP
  perl: 85,          // Perl
  lua: 64,           // Lua
  r: 80,             // R

  // Systems & compiled
  c: 50,             // C (GCC)
  cpp: 54,           // C++ (GCC)
  'c++': 54,         // alias
  csharp: 51,        // C# (Mono)
  'c#': 51,          // alias
  java: 62,          // Java (OpenJDK)
  go: 60,            // Go
  rust: 73,          // Rust
  swift: 83,         // Swift
  kotlin: 78,        // Kotlin
  scala: 81,         // Scala

  // Functional
  haskell: 61,       // Haskell (GHC)
  elixir: 57,        // Elixir
  clojure: 86,       // Clojure
  fsharp: 87,        // F#
  'f#': 87,          // alias
  ocaml: 65,         // OCaml
  erlang: 58,        // Erlang

  // Shell & data
  bash: 46,          // Bash
  shell: 46,         // alias
  sql: 82,           // SQL (SQLite)

  // Other
  pascal: 67,        // Pascal
  fortran: 59,       // Fortran
  cobol: 77,         // COBOL
  dart: 90,          // Dart
};

// ── Validation ─────────────────────────────────────────

const executeCodeSchema = z.object({
  code: z.string().min(1, 'Code is required').max(50000, 'Code too long'),
  language: z.string().min(1, 'Language is required'),
  stdin: z.string().max(10000).optional(),
});

/**
 * @swagger
 * /api/course/execute-code:
 *   post:
 *     summary: Execute code via Judge0 sandbox
 *     tags:
 *       - Course
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [code, language]
 *             properties:
 *               code:
 *                 type: string
 *               language:
 *                 type: string
 *               stdin:
 *                 type: string
 *     responses:
 *       200:
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [data]
 *               properties:
 *                 data:
 *                   type: object
 *                   required: [stdout, stderr, compile_output, status, time, memory]
 *                   properties:
 *                     stdout:
 *                       type: string
 *                       nullable: true
 *                     stderr:
 *                       type: string
 *                       nullable: true
 *                     compile_output:
 *                       type: string
 *                       nullable: true
 *                     status:
 *                       type: string
 *                     time:
 *                       type: string
 *                       nullable: true
 *                     memory:
 *                       type: number
 *                       nullable: true
 */
export const executeCodeController = asyncHandler(async (req, res) => {
  if (!JUDGE0_API_KEY) {
    res.status(503);
    throw new Error('Code execution is not configured');
  }

  const { code, language, stdin } = executeCodeSchema.parse(req.body);

  const languageId = LANGUAGE_IDS[language.toLowerCase()];
  if (!languageId) {
    res.status(400);
    throw new Error(`Unsupported language: ${language}. Supported: ${Object.keys(LANGUAGE_IDS).join(', ')}`);
  }

  const execStart = Date.now();
  integrationLog.info(`judge0:exec start lang=${language} chars=${code.length}`);

  // Detect RapidAPI vs self-hosted/CE based on URL
  const isRapidApi = JUDGE0_API_URL.includes('rapidapi.com');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isRapidApi) {
    headers['X-RapidAPI-Key'] = JUDGE0_API_KEY;
    headers['X-RapidAPI-Host'] = new URL(JUDGE0_API_URL).host;
  }

  // Submit to Judge0 with wait=true (synchronous, blocks until done)
  const response = await fetch(`${JUDGE0_API_URL}/submissions?base64_encoded=true&wait=true`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      source_code: Buffer.from(code).toString('base64'),
      language_id: languageId,
      stdin: stdin ? Buffer.from(stdin).toString('base64') : undefined,
      cpu_time_limit: 5,     // 5 seconds max
      memory_limit: 128000,  // 128MB max
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    integrationLog.error(`judge0:exec fail status=${response.status} body=${text.slice(0, 200)}`);
    res.status(502);
    throw new Error('Code execution service error');
  }

  const result = await response.json();

  recordUsage({
    service: 'judge0',
    action: 'code:exec',
    costMicroCents: priceFlatUnit({ sku: 'judge0_rapidapi' }),
    metadata: {
      language,
      languageId,
      codeLength: code.length,
      status: result.status?.description ?? 'Unknown',
      time: result.time ?? null,
    },
  });

  // The route is gated by `requireCredits()` but, until 2026-09-02, nothing
  // here ever DEBITED — so the balance could never fall and that gate could
  // never close. A user at 1 credit could run this indefinitely (bounded only
  // by the 30/min rate limit) while Judge0 billed us for every call. Realised
  // loss to date is negligible, but an unclosable credit gate is a structural
  // defect, not a rounding error, and the one-time onboarding grant keeps it
  // open ~5x longer per account.
  //
  // Debited AFTER success only: a 502 from Judge0 above returns before this
  // point, and recordUsage never ran either, so a failed execution is free —
  // matching how every other action treats provider failure.
  //
  // No minMicroCents floor: unlike a streamed mentor turn there is no
  // partial-delivery case to forgive. The call either ran and cost us, or it
  // did not happen at all.
  await debitActualSpend({
    userId: req.userId as string,
    jobId: new Types.ObjectId(),
    jobType: 'code_exec',
  }).catch(bgError('executeCode.debit'));

  // Decode base64 outputs and clamp to a sane upper bound. A program that
  // logs megabytes would otherwise be decoded in full and buffered into the
  // response JSON — a cheap way to spike API memory use or fill the wire
  // with useless bytes. 1 MB per stream is plenty for lesson exercises;
  // anything larger is truncated with an explicit marker so the learner
  // knows the output was cut.
  const OUTPUT_CAP_BYTES = 1_000_000;
  const TRUNCATE_MARKER = '\n\n[output truncated — exceeded 1 MB]';
  const decode = (val: string | null): string | null => {
    if (!val) return null;
    const raw = Buffer.from(val, 'base64').toString('utf-8');
    if (Buffer.byteLength(raw, 'utf-8') <= OUTPUT_CAP_BYTES) return raw;
    return raw.slice(0, OUTPUT_CAP_BYTES) + TRUNCATE_MARKER;
  };

  integrationLog.info(
    `judge0:exec done lang=${language} status="${result.status?.description ?? 'Unknown'}" judge0Time=${result.time ?? 'na'} ms=${Date.now() - execStart}`,
  );

  res.status(200).json({
    data: {
      stdout: decode(result.stdout),
      stderr: decode(result.stderr),
      compile_output: decode(result.compile_output),
      status: result.status?.description ?? 'Unknown',
      time: result.time,
      memory: result.memory,
    },
  });
});
