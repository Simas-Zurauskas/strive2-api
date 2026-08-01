import { describe, it, expect } from 'vitest';
import { extractPdfText } from './pdf';
import { ExtractionError, SCANNED_PAGE_CHAR_THRESHOLD } from './types';
import { buildPdf, buildEncryptedPdf } from './__fixtures__/builders';

const LONG = 'The quick brown fox jumps over the lazy dog near the riverbank every single morning. '.repeat(3);

describe('pdf extraction', () => {
  it('extracts per-page text with pageCount and charsPerPage', async () => {
    const pdf = buildPdf([LONG, LONG + ' second page marker.']);
    const result = await extractPdfText(pdf);
    expect(result.pageCount).toBe(2);
    expect(result.charsPerPage).toHaveLength(2);
    expect(result.charsPerPage[0]).toBeGreaterThan(SCANNED_PAGE_CHAR_THRESHOLD);
    expect(result.scannedPages).toEqual([]);
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0].type).toBe('text');
    expect(result.blocks[0].pageRange).toEqual({ start: 1, end: 1 });
    expect(result.blocks[1].markdown).toContain('second page marker');
  });

  it('detects scanned pages (< threshold chars) on a mixed fixture', async () => {
    const pdf = buildPdf([LONG, '', LONG]);
    const result = await extractPdfText(pdf);
    expect(result.pageCount).toBe(3);
    expect(result.scannedPages).toEqual([2]);
    expect(result.charsPerPage[1]).toBeLessThan(SCANNED_PAGE_CHAR_THRESHOLD);
    // Blank page yields no text block.
    expect(result.blocks.every((b) => b.pageRange!.start !== 2)).toBe(true);
  });

  it('flags an all-scanned pdf: every page in scannedPages, zero blocks', async () => {
    const pdf = buildPdf(['', '']);
    const result = await extractPdfText(pdf);
    expect(result.scannedPages).toEqual([1, 2]);
    expect(result.blocks).toHaveLength(0);
  });

  it('rejects a corrupt pdf with pdf_parse_failed', async () => {
    const corrupt = Buffer.from('%PDF-1.4\nthis is not really a pdf body at all');
    await expect(extractPdfText(corrupt)).rejects.toMatchObject({
      name: 'ExtractionError',
      reason: 'pdf_parse_failed',
    });
  });

  it('rejects a password-protected pdf with pdf_password_protected', async () => {
    const locked = buildEncryptedPdf();
    let caught: unknown;
    try {
      await extractPdfText(locked);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExtractionError);
    expect((caught as ExtractionError).reason).toBe('pdf_password_protected');
  });
});
