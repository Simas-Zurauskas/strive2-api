/**
 * Unit tests for the orchestrator's documents-mode plumbing:
 *   - CLI flag resolution (--documents / --document-set / --document-sets),
 *   - the document-set folder loader + manifest parsing,
 *   - the needs-preparation predicate mirrored from the client contract.
 *
 * All three are pure, so no server, no Mongo, no network. Colocated with
 * the module under test, matching prng.test.ts / quizNoise.test.ts.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'vitest';
import {
  describePreparationNeed,
  documentNeedsPreparation,
  extractTextPreview,
  loadDocumentSet,
  resolveDocumentSetSelection,
  summarizeSetForPersona,
} from './documentSets';

// ── CLI flag resolution ──────────────────────────────────

describe('resolveDocumentSetSelection', () => {
  test('goal mode (no --documents) returns null set names', () => {
    const r = resolveDocumentSetSelection({ documentsMode: false, single: undefined, multi: undefined, personaCount: 3 });
    assert.deepEqual(r, { ok: true, setNames: null });
  });

  test('set flags without --documents is a usage error', () => {
    const r = resolveDocumentSetSelection({ documentsMode: false, single: 'sample-basic', multi: undefined, personaCount: 1 });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.error : '', /require --documents/);
  });

  test('--documents without a set flag is a usage error', () => {
    const r = resolveDocumentSetSelection({ documentsMode: true, single: undefined, multi: undefined, personaCount: 2 });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.error : '', /--documents requires a set/);
  });

  test('--document-set and --document-sets are mutually exclusive', () => {
    const r = resolveDocumentSetSelection({
      documentsMode: true,
      single: 'sample-basic',
      multi: 'sample-basic,sample-mixed',
      personaCount: 2,
    });
    assert.equal(r.ok, false);
    assert.match(r.ok === false ? r.error : '', /mutually exclusive/);
  });

  test('--document-set repeats the single set once per persona', () => {
    const r = resolveDocumentSetSelection({ documentsMode: true, single: 'sample-basic', multi: undefined, personaCount: 3 });
    assert.deepEqual(r, { ok: true, setNames: ['sample-basic', 'sample-basic', 'sample-basic'] });
  });

  test('--document-sets maps one set per persona (whitespace tolerated)', () => {
    const r = resolveDocumentSetSelection({
      documentsMode: true,
      single: undefined,
      multi: ' a , b ,c ',
      personaCount: 3,
    });
    assert.deepEqual(r, { ok: true, setNames: ['a', 'b', 'c'] });
  });

  test('--document-sets count mismatch is a usage error naming both counts', () => {
    const r = resolveDocumentSetSelection({ documentsMode: true, single: undefined, multi: 'a,b', personaCount: 3 });
    assert.equal(r.ok, false);
    const err = r.ok === false ? r.error : '';
    assert.match(err, /lists 2 set\(s\)/);
    assert.match(err, /--personas is 3/);
  });

  test('--document-sets with trailing comma still counts real entries', () => {
    const r = resolveDocumentSetSelection({ documentsMode: true, single: undefined, multi: 'a,b,', personaCount: 2 });
    assert.deepEqual(r, { ok: true, setNames: ['a', 'b'] });
  });
});

// ── Folder loader + manifest parsing ─────────────────────

describe('loadDocumentSet', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsets-'));
  });

  afterEach(() => {
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  const writeSet = (name: string, files: Record<string, string>) => {
    const dir = path.join(baseDir, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [filename, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, filename), content);
    }
    return dir;
  };

  test('missing folder throws, naming the path and the generator script', () => {
    assert.throws(
      () => loadDocumentSet({ name: 'nope', baseDir }),
      (err: Error) => /not found at/.test(err.message) && /debug:orchestrator:sets/.test(err.message),
    );
  });

  test('missing folder lists available sets when some exist', () => {
    writeSet('alpha', { 'a.md': 'alpha content' });
    writeSet('beta', { 'b.md': 'beta content' });
    assert.throws(
      () => loadDocumentSet({ name: 'gamma', baseDir }),
      (err: Error) => /Available sets: alpha, beta/.test(err.message),
    );
  });

  test('loads corpus files with sizes and previews, sorted by name', () => {
    writeSet('basic', { 'b.md': 'second file body', 'a.md': 'first file body' });
    const set = loadDocumentSet({ name: 'basic', baseDir });
    assert.equal(set.name, 'basic');
    assert.deepEqual(
      set.files.map((f) => f.filename),
      ['a.md', 'b.md'],
    );
    assert.equal(set.files[0].byteSize, Buffer.byteLength('first file body'));
    assert.equal(set.files[0].preview, 'first file body');
    assert.equal(set.manifest, null);
  });

  test('ignores manifest.json, README.md, dotfiles and .ts/.js helpers', () => {
    writeSet('mixed', {
      'real.md': 'real corpus content',
      'README.md': '# docs',
      '.DS_Store': 'junk',
      'helper.ts': 'export {}',
      'helper.js': 'module.exports={}',
      'manifest.json': JSON.stringify({ note: 'n' }),
    });
    const set = loadDocumentSet({ name: 'mixed', baseDir });
    assert.deepEqual(
      set.files.map((f) => f.filename),
      ['real.md'],
    );
    assert.equal(set.manifest?.note, 'n');
  });

  test('parses a full manifest (urls + note + expectedTopics)', () => {
    writeSet('m', {
      'a.md': 'content',
      'manifest.json': JSON.stringify({
        urls: ['https://example.com/a', 'http://example.org/b'],
        note: 'a corpus',
        expectedTopics: ['t1', 't2'],
      }),
    });
    const set = loadDocumentSet({ name: 'm', baseDir });
    assert.deepEqual(set.manifest, {
      urls: ['https://example.com/a', 'http://example.org/b'],
      note: 'a corpus',
      expectedTopics: ['t1', 't2'],
    });
  });

  test('manifest defaults are empty rather than undefined', () => {
    writeSet('m', { 'a.md': 'content', 'manifest.json': '{}' });
    const set = loadDocumentSet({ name: 'm', baseDir });
    assert.deepEqual(set.manifest, { urls: [], note: null, expectedTopics: [] });
  });

  test('invalid manifest JSON throws with the set name', () => {
    writeSet('m', { 'a.md': 'content', 'manifest.json': '{ not json' });
    assert.throws(
      () => loadDocumentSet({ name: 'm', baseDir }),
      (err: Error) => /Document set "m": manifest.json is not valid JSON/.test(err.message),
    );
  });

  test('non-object manifest throws', () => {
    writeSet('m', { 'a.md': 'content', 'manifest.json': '["a"]' });
    assert.throws(() => loadDocumentSet({ name: 'm', baseDir }), /must be a JSON object/);
  });

  test('non-http manifest url throws', () => {
    writeSet('m', { 'a.md': 'c', 'manifest.json': JSON.stringify({ urls: ['ftp://example.com/x'] }) });
    assert.throws(() => loadDocumentSet({ name: 'm', baseDir }), /must be http\(s\)/);
  });

  test('wrongly-typed manifest fields throw', () => {
    writeSet('m1', { 'a.md': 'c', 'manifest.json': JSON.stringify({ urls: 'https://x.com' }) });
    assert.throws(() => loadDocumentSet({ name: 'm1', baseDir }), /"urls" must be an array of strings/);
    writeSet('m2', { 'a.md': 'c', 'manifest.json': JSON.stringify({ note: 42 }) });
    assert.throws(() => loadDocumentSet({ name: 'm2', baseDir }), /"note" must be a string/);
    writeSet('m3', { 'a.md': 'c', 'manifest.json': JSON.stringify({ expectedTopics: [1, 2] }) });
    assert.throws(() => loadDocumentSet({ name: 'm3', baseDir }), /"expectedTopics" must be an array of strings/);
  });

  test('empty set (no files, no urls) throws', () => {
    writeSet('empty', { 'manifest.json': JSON.stringify({ note: 'nothing here' }) });
    assert.throws(
      () => loadDocumentSet({ name: 'empty', baseDir }),
      /contains no corpus files and no manifest urls/,
    );
  });

  test('url-only set is valid (no local files needed)', () => {
    writeSet('urlonly', { 'manifest.json': JSON.stringify({ urls: ['https://example.com/a'] }) });
    const set = loadDocumentSet({ name: 'urlonly', baseDir });
    assert.equal(set.files.length, 0);
    assert.deepEqual(set.manifest?.urls, ['https://example.com/a']);
  });

  test('summarizeSetForPersona lists files + urls + note, and withholds expectedTopics', () => {
    writeSet('s', {
      'a.md': 'alpha body text',
      'manifest.json': JSON.stringify({
        urls: ['https://example.com/a'],
        note: 'the note',
        expectedTopics: ['SECRET-GROUND-TRUTH'],
      }),
    });
    const summary = summarizeSetForPersona(loadDocumentSet({ name: 's', baseDir }));
    assert.match(summary, /Document set "s"/);
    assert.match(summary, /What it is: the note/);
    assert.match(summary, /a\.md/);
    assert.match(summary, /URL: https:\/\/example\.com\/a/);
    // expectedTopics is the rubric's honesty anchor — it must not leak
    // into the persona prompt.
    assert.ok(!summary.includes('SECRET-GROUND-TRUTH'));
  });
});

// ── Preview extraction ───────────────────────────────────

describe('extractTextPreview', () => {
  test('text formats are returned whitespace-collapsed and capped', () => {
    const out = extractTextPreview(Buffer.from('# Title\n\nSome   body\ttext'), 'notes.md', 40);
    assert.equal(out, '# Title Some body text');
    assert.equal(extractTextPreview(Buffer.from('x'.repeat(100)), 'notes.md', 10).length, 10);
  });

  test('pdf previews read Tj text operators, not object noise', () => {
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\nBT /F1 12 Tf 50 700 Td (Real prose here) Tj ET\n',
      'latin1',
    );
    assert.equal(extractTextPreview(pdf, 'doc.pdf'), 'Real prose here');
  });

  test('ooxml previews read w:t runs', () => {
    const docx = Buffer.from('PK\x03\x04[Content_Types].xml<w:t>Hello</w:t><w:t xml:space="preserve">world</w:t>', 'latin1');
    assert.equal(extractTextPreview(docx, 'doc.docx'), 'Hello world');
  });

  test('unknown binary falls back to a printable-run scan that drops markup', () => {
    const blob = Buffer.from('\x00\x01xmlns:junkfield\x00Genuine sentence content here\x00', 'latin1');
    const out = extractTextPreview(blob, 'thing.bin');
    assert.match(out, /Genuine sentence content here/);
    assert.ok(!out.includes('xmlns'));
  });
});

// ── Needs-preparation predicate ──────────────────────────

describe('documentNeedsPreparation', () => {
  test('a fully-parsed text document needs nothing', () => {
    assert.equal(
      documentNeedsPreparation({ scannedPageCount: 0, escalatedPages: [], audioDurationSec: null, transcribedSec: null }),
      false,
    );
  });

  test('missing/undefined fields (pre-feature rows) need nothing', () => {
    assert.equal(documentNeedsPreparation({}), false);
    assert.equal(documentNeedsPreparation({ scannedPageCount: null, escalatedPages: null }), false);
  });

  test('unescalated scanned pages need preparation', () => {
    assert.equal(documentNeedsPreparation({ scannedPageCount: 6, escalatedPages: [1, 2] }), true);
  });

  test('all scanned pages escalated needs nothing', () => {
    assert.equal(documentNeedsPreparation({ scannedPageCount: 2, escalatedPages: [1, 2] }), false);
  });

  test('escalatedPages missing while scans exist needs preparation', () => {
    assert.equal(documentNeedsPreparation({ scannedPageCount: 3 }), true);
  });

  test('untranscribed audio tail needs preparation', () => {
    assert.equal(documentNeedsPreparation({ audioDurationSec: 900, transcribedSec: 600 }), true);
  });

  test('fully-transcribed audio needs nothing', () => {
    assert.equal(documentNeedsPreparation({ audioDurationSec: 600, transcribedSec: 600 }), false);
  });

  test('audio with null transcribedSec is treated as 0 transcribed', () => {
    assert.equal(documentNeedsPreparation({ audioDurationSec: 120, transcribedSec: null }), true);
  });

  test('audioDurationSec null short-circuits the audio branch', () => {
    assert.equal(documentNeedsPreparation({ audioDurationSec: null, transcribedSec: 0 }), false);
  });

  test('describePreparationNeed explains both branches and the no-op case', () => {
    assert.match(describePreparationNeed({ scannedPageCount: 6, escalatedPages: [1, 2] }), /4 of 6 scanned page/);
    assert.match(describePreparationNeed({ audioDurationSec: 900, transcribedSec: 600 }), /300s of 900s audio/);
    const both = describePreparationNeed({
      scannedPageCount: 2,
      escalatedPages: [],
      audioDurationSec: 60,
      transcribedSec: 10,
    });
    assert.match(both, /scanned page/);
    assert.match(both, /audio/);
    assert.equal(describePreparationNeed({}), 'fully extracted during ingest');
  });
});
