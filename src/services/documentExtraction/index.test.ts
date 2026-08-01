import { describe, it, expect, vi, beforeEach } from 'vitest';

const { transcribePdfPagesMock, selectTriagePagesActual } = vi.hoisted(() => ({
  transcribePdfPagesMock: vi.fn(),
  selectTriagePagesActual: { fn: null as null | ((args: { scannedPages: number[]; pageCount: number }) => number[]) },
}));

vi.mock('./visionEscalation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./visionEscalation')>();
  selectTriagePagesActual.fn = actual.selectTriagePages;
  return {
    ...actual,
    transcribePdfPages: transcribePdfPagesMock,
  };
});

import { extractDocument, resolveExtractorForTest } from './index';
import { ExtractionError } from './types';
import { buildPdf } from './__fixtures__/builders';
import { ALLOWED_MIME_TYPES } from '@middleware/documentUpload';

const LONG = 'A meaningful paragraph with plenty of characters for the density detector to count. '.repeat(3);

beforeEach(() => {
  transcribePdfPagesMock.mockReset();
  transcribePdfPagesMock.mockResolvedValue({
    blocks: [
      { type: 'text', markdown: 'Vision transcription of the scanned page.', pageRange: { start: 2, end: 2 }, headingPath: [] },
    ],
    transcribedPages: [2],
    warnings: [],
  });
});

describe('extractDocument router', () => {
  it('routes txt to the text path and returns the stable contract', async () => {
    const result = await extractDocument(
      { buffer: Buffer.from('Some plain notes for the course.'), mimeType: 'text/plain', filename: 'n.txt', kind: 'file' },
      { mode: 'triage' },
    );
    expect(result.markdown).toContain('plain notes');
    expect(result.blocks[0]).toMatchObject({ type: 'text', headingPath: [] });
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('rejects an empty file with empty_file', async () => {
    await expect(
      extractDocument(
        { buffer: Buffer.alloc(0), mimeType: 'text/plain', filename: 'x.txt', kind: 'file' },
        { mode: 'triage' },
      ),
    ).rejects.toMatchObject({ name: 'ExtractionError', reason: 'empty_file' });
  });

  it('rejects an unknown mime with unsupported_format', async () => {
    await expect(
      extractDocument(
        { buffer: Buffer.from('x'), mimeType: 'application/x-msdownload', filename: 'a.exe', kind: 'file' },
        { mode: 'triage' },
      ),
    ).rejects.toMatchObject({ reason: 'unsupported_format' });
  });

  // Regression (Phase 7 E2E): a wav uploaded from the browser is sniffed as
  // `audio/vnd.wave`, which the upload allowlist accepted but the router did
  // not know — the document uploaded fine and then failed extraction with
  // `unsupported_format`. Every mime the upload gate lets in must resolve to
  // an extractor here, or the same silent gap reopens for another format.
  it('routes every upload-allowlisted mime to an extractor (no unsupported_format)', () => {
    const unroutable = [...ALLOWED_MIME_TYPES].filter(
      (mime) => resolveExtractorForTest({ buffer: Buffer.alloc(0), mimeType: mime, filename: 'f', kind: 'file' }) === null,
    );
    expect(unroutable).toEqual([]);
  });

  it('pdf: escalates sampled scanned pages in triage mode and merges blocks in page order', async () => {
    const pdf = buildPdf([LONG, '', LONG]);
    const result = await extractDocument(
      { buffer: pdf, mimeType: 'application/pdf', filename: 'mixed.pdf', kind: 'file' },
      { mode: 'triage', visionPageBudget: 50 },
    );
    expect(transcribePdfPagesMock).toHaveBeenCalledTimes(1);
    const callArgs = transcribePdfPagesMock.mock.calls[0][0];
    // Triage sampling was applied to the scanned pages.
    expect(callArgs.pages).toEqual(selectTriagePagesActual.fn!({ scannedPages: [2], pageCount: 3 }));
    expect(callArgs.budget).toBe(50);
    expect(result.scannedPages).toEqual([2]);
    // Vision block for page 2 is merged between page 1 and page 3 text.
    const order = result.blocks.map((b) => b.pageRange!.start);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(result.markdown).toContain('Vision transcription');
  });

  it('pdf: vision failure degrades to text + warning instead of failing the document', async () => {
    transcribePdfPagesMock.mockRejectedValue(new ExtractionError('vision_failed', 'api down'));
    const pdf = buildPdf([LONG, '', LONG]);
    const result = await extractDocument(
      { buffer: pdf, mimeType: 'application/pdf', filename: 'mixed.pdf', kind: 'file' },
      { mode: 'triage' },
    );
    expect(result.markdown).toContain('meaningful paragraph');
    expect(result.warnings.some((w) => w.includes('vision'))).toBe(true);
  });

  it('pdf: all-scanned document with failed vision fails honestly with pdf_no_text', async () => {
    transcribePdfPagesMock.mockRejectedValue(new ExtractionError('vision_failed', 'api down'));
    const pdf = buildPdf(['', '']);
    await expect(
      extractDocument(
        { buffer: pdf, mimeType: 'application/pdf', filename: 'scan.pdf', kind: 'file' },
        { mode: 'full' },
      ),
    ).rejects.toMatchObject({ reason: 'pdf_no_text' });
  });

  it('pdf: full mode escalates ALL scanned pages (no sampling)', async () => {
    const pdf = buildPdf(['', LONG, '']);
    await extractDocument(
      { buffer: pdf, mimeType: 'application/pdf', filename: 'mixed.pdf', kind: 'file' },
      { mode: 'full' },
    );
    const callArgs = transcribePdfPagesMock.mock.calls[0][0];
    expect(callArgs.pages).toEqual([1, 3]);
  });
});
