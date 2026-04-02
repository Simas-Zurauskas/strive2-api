import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import { JUDGE0_API_KEY, JUDGE0_API_URL } from '@conf/env';

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

  console.log(`[API] Executing ${language} code (${code.length} chars)`.cyan);

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
    console.error(`[API] Judge0 error: ${response.status} ${text}`.red);
    res.status(502);
    throw new Error('Code execution service error');
  }

  const result = await response.json();

  // Decode base64 outputs
  const decode = (val: string | null) => (val ? Buffer.from(val, 'base64').toString('utf-8') : null);

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
