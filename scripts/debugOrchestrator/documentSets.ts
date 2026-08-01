import fs from 'fs';
import path from 'path';

/**
 * Document-set plumbing for the orchestrator's documents mode.
 *
 * A document set is a folder under `scripts/debugOrchestrator/documentSets/`
 * containing real files (pdf/docx/md/csv/…) plus an optional `manifest.json`:
 *
 *   {
 *     "urls": ["https://…"],          // added via POST /documents/url
 *     "note": "one-line description of what this corpus is",
 *     "expectedTopics": ["…"]         // ground truth for the K2 rubric row
 *   }
 *
 * The folder contents are gitignored (like `output/`); the committed
 * `documentSets/generate-sample-sets.ts` script rebuilds the sample sets on
 * demand from the api's documentExtraction fixture builders.
 *
 * Everything here is pure/deterministic so it can be unit-tested without a
 * server: CLI flag resolution, folder loading + manifest parsing, and the
 * needs-preparation predicate mirrored from the client contract.
 */

// ── Types ────────────────────────────────────────────────

export interface DocumentSetManifest {
  /** Public article URLs to register via POST /documents/url. */
  urls: string[];
  /** One-line human description of what this corpus is. */
  note: string | null;
  /**
   * Ground-truth topic list for the assessment rubric's K2 (analysis
   * honesty) row — what the corpus is genuinely about, written by the
   * set author. Never sent to the API.
   */
  expectedTopics: string[];
}

export interface DocumentSetFile {
  filename: string;
  absolutePath: string;
  byteSize: number;
  /** ~400-char text preview (raw slice for text formats, printable-run scan for binary). */
  preview: string;
}

export interface LoadedDocumentSet {
  name: string;
  dir: string;
  files: DocumentSetFile[];
  manifest: DocumentSetManifest | null;
}

// ── CLI flag resolution ──────────────────────────────────

export type DocumentSetSelection =
  | { ok: true; setNames: string[] | null }
  | { ok: false; error: string };

/**
 * Resolve `--documents` / `--document-set` / `--document-sets` into a
 * per-persona set-name list (length === personaCount) or null (goal mode).
 * Pure so the CLI contract is unit-testable; index.ts prints `error` and
 * exits on `ok: false`.
 */
export const resolveDocumentSetSelection = ({
  documentsMode,
  single,
  multi,
  personaCount,
}: {
  documentsMode: boolean;
  single: string | undefined;
  multi: string | undefined;
  personaCount: number;
}): DocumentSetSelection => {
  if (!documentsMode) {
    if (single || multi) {
      return {
        ok: false,
        error:
          '--document-set/--document-sets require --documents (they choose the corpus for documents mode).',
      };
    }
    return { ok: true, setNames: null };
  }

  if (single && multi) {
    return { ok: false, error: '--document-set and --document-sets are mutually exclusive.' };
  }
  if (!single && !multi) {
    return {
      ok: false,
      error:
        '--documents requires a set: --document-set <name> (same set for every persona) or --document-sets "a,b,…" (one per persona).',
    };
  }

  if (single) {
    return { ok: true, setNames: Array.from({ length: personaCount }, () => single) };
  }

  const names = multi!
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length !== personaCount) {
    return {
      ok: false,
      error: `--document-sets lists ${names.length} set(s) but --personas is ${personaCount} — counts must match (one set per persona).`,
    };
  }
  return { ok: true, setNames: names };
};

// ── Folder loading ───────────────────────────────────────

export const DEFAULT_DOCUMENT_SETS_DIR = path.resolve(__dirname, 'documentSets');

const MANIFEST_FILENAME = 'manifest.json';
const PREVIEW_MAX_CHARS = 400;

/** Files that are never part of a set's corpus. */
const IGNORED_SET_FILES = new Set([MANIFEST_FILENAME, '.DS_Store', 'README.md']);
const IGNORED_SET_EXTENSIONS = new Set(['.ts', '.js']);

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.html']);

/**
 * Best-effort human-readable preview of a set file. NOT an extractor —
 * just enough signal for the persona generator to know what the corpus is
 * about (the real extraction happens server-side during ingest).
 *
 * Three strategies, in order of specificity:
 *   1. text formats  → raw utf-8 slice.
 *   2. pdf           → the parenthesised strings of `Tj` text operators.
 *   3. ooxml/epub    → `<w:t>` / `<a:t>` / `<p>` runs when the zip entries
 *                      are stored uncompressed (the fixture builders'
 *                      default), else the generic scan below.
 *   4. anything else → printable-ASCII run scan (strings(1)-style),
 *                      dropping runs that look like markup/format noise.
 */
export const extractTextPreview = (
  buffer: Buffer,
  filename: string,
  maxLen: number = PREVIEW_MAX_CHARS,
): string => {
  const ext = path.extname(filename).toLowerCase();
  const tidy = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, maxLen);

  if (TEXT_EXTENSIONS.has(ext)) {
    return tidy(buffer.toString('utf-8'));
  }

  const latin = buffer.toString('latin1');

  if (ext === '.pdf') {
    // `(escaped text) Tj` — the builders emit uncompressed content streams.
    const tj = latin.match(/\((?:\\.|[^()\\])*\)\s*Tj/g) ?? [];
    const text = tj
      .map((m) => m.replace(/\s*Tj$/, '').slice(1, -1).replace(/\\([()\\])/g, '$1'))
      .join('');
    if (text.trim().length > 0) return tidy(text);
  }

  if (['.docx', '.pptx', '.epub', '.odt', '.odp'].includes(ext)) {
    // Stored (uncompressed) zip entries leave the XML greppable.
    const runs = latin.match(/<(?:w:t|a:t|text:p)[^>]*>([^<]+)</g) ?? [];
    const text = runs.map((m) => m.slice(m.indexOf('>') + 1, -1)).join(' ');
    if (text.trim().length > 0) return tidy(text);
  }

  // Printable-ASCII run scan. Runs ≥ 6 chars with letters, minus the
  // obvious markup/format noise so prose surfaces first.
  const scanned = (latin.match(/[\x20-\x7e]{6,}/g) ?? []).filter(
    (run) => /[a-zA-Z]{3,}/.test(run) && !/[<>{}]|xmlns|Content_Types|\bobj\b|endobj|PK\x03\x04/.test(run),
  );
  return tidy(scanned.join(' '));
};

const parseManifest = ({ raw, setName }: { raw: string; setName: string }): DocumentSetManifest => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Document set "${setName}": manifest.json is not valid JSON (${e instanceof Error ? e.message : String(e)}).`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Document set "${setName}": manifest.json must be a JSON object.`);
  }
  const m = parsed as Record<string, unknown>;

  const urls: string[] = [];
  if (m.urls !== undefined) {
    if (!Array.isArray(m.urls) || m.urls.some((u) => typeof u !== 'string')) {
      throw new Error(`Document set "${setName}": manifest "urls" must be an array of strings.`);
    }
    for (const u of m.urls as string[]) {
      if (!/^https?:\/\//i.test(u)) {
        throw new Error(`Document set "${setName}": manifest url "${u}" must be http(s).`);
      }
      urls.push(u);
    }
  }

  let note: string | null = null;
  if (m.note !== undefined) {
    if (typeof m.note !== 'string') {
      throw new Error(`Document set "${setName}": manifest "note" must be a string.`);
    }
    note = m.note;
  }

  let expectedTopics: string[] = [];
  if (m.expectedTopics !== undefined) {
    if (!Array.isArray(m.expectedTopics) || m.expectedTopics.some((t) => typeof t !== 'string')) {
      throw new Error(`Document set "${setName}": manifest "expectedTopics" must be an array of strings.`);
    }
    expectedTopics = m.expectedTopics as string[];
  }

  return { urls, note, expectedTopics };
};

const listAvailableSets = (baseDir: string): string[] => {
  try {
    return fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
};

/**
 * Load one document set from disk. Throws with actionable messages —
 * these surface directly as CLI usage errors before any persona spends
 * money.
 */
export const loadDocumentSet = ({
  name,
  baseDir = DEFAULT_DOCUMENT_SETS_DIR,
}: {
  name: string;
  baseDir?: string;
}): LoadedDocumentSet => {
  const dir = path.join(baseDir, name);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    const available = listAvailableSets(baseDir);
    throw new Error(
      `Document set "${name}" not found at ${dir}. ` +
        (available.length > 0
          ? `Available sets: ${available.join(', ')}.`
          : `No sets exist yet — run \`yarn debug:orchestrator:sets\` to build the samples.`),
    );
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: DocumentSetFile[] = [];
  let manifest: DocumentSetManifest | null = null;

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    if (entry.name === MANIFEST_FILENAME) {
      manifest = parseManifest({ raw: fs.readFileSync(path.join(dir, entry.name), 'utf-8'), setName: name });
      continue;
    }
    if (IGNORED_SET_FILES.has(entry.name) || entry.name.startsWith('.')) continue;
    if (IGNORED_SET_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const absolutePath = path.join(dir, entry.name);
    const buffer = fs.readFileSync(absolutePath);
    files.push({
      filename: entry.name,
      absolutePath,
      byteSize: buffer.length,
      preview: extractTextPreview(buffer, entry.name),
    });
  }

  if (files.length === 0 && (manifest?.urls.length ?? 0) === 0) {
    throw new Error(
      `Document set "${name}" (${dir}) contains no corpus files and no manifest urls — nothing to upload. ` +
        `Run \`yarn debug:orchestrator:sets\` to (re)build the samples or add files to the folder.`,
    );
  }

  return { name, dir, files, manifest };
};

// ── Needs-preparation predicate ──────────────────────────

/**
 * Subset of the GET /documents row the predicate reads. Mirrors the
 * client contract documented on `toClientSourceDocument`
 * (api/src/services/sourceDocumentService.ts): a document needs the
 * debited `prepare_corpus` pass when it has unescalated scanned pages or
 * an untranscribed audio tail.
 */
export interface PreparationSignals {
  scannedPageCount?: number | null;
  escalatedPages?: number[] | null;
  audioDurationSec?: number | null;
  transcribedSec?: number | null;
}

export const documentNeedsPreparation = (doc: PreparationSignals): boolean => {
  const scanned = doc.scannedPageCount ?? 0;
  const escalated = doc.escalatedPages?.length ?? 0;
  if (scanned > escalated) return true;
  if (doc.audioDurationSec != null && (doc.transcribedSec ?? 0) < doc.audioDurationSec) return true;
  return false;
};

/** Human explanation for the Corpus Preparation report section. */
export const describePreparationNeed = (doc: PreparationSignals): string => {
  const reasons: string[] = [];
  const scanned = doc.scannedPageCount ?? 0;
  const escalated = doc.escalatedPages?.length ?? 0;
  if (scanned > escalated) {
    reasons.push(`${scanned - escalated} of ${scanned} scanned page(s) not yet vision-transcribed`);
  }
  if (doc.audioDurationSec != null && (doc.transcribedSec ?? 0) < doc.audioDurationSec) {
    reasons.push(
      `${Math.round(doc.audioDurationSec - (doc.transcribedSec ?? 0))}s of ${Math.round(doc.audioDurationSec)}s audio not yet transcribed`,
    );
  }
  return reasons.length > 0 ? reasons.join('; ') : 'fully extracted during ingest';
};

// ── Persona-generator summary ────────────────────────────

/**
 * Compact text block describing a set for the persona generator — enough
 * for Sonnet to invent a plausible owner (filenames, manifest note,
 * short previews) without leaking assessment ground truth
 * (`expectedTopics` stays out on purpose: it's the rubric's honesty
 * anchor, not persona context).
 */
export const summarizeSetForPersona = (set: LoadedDocumentSet): string => {
  const lines: string[] = [`Document set "${set.name}"`];
  if (set.manifest?.note) lines.push(`What it is: ${set.manifest.note}`);
  for (const f of set.files) {
    const kb = (f.byteSize / 1024).toFixed(1);
    lines.push(`- ${f.filename} (${kb} KB): ${f.preview ? `"${f.preview.slice(0, 300)}"` : '(binary, no preview)'}`);
  }
  for (const url of set.manifest?.urls ?? []) {
    lines.push(`- URL: ${url}`);
  }
  return lines.join('\n');
};
