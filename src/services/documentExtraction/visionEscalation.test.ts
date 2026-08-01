import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createMock, recordUsageMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  recordUsageMock: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: createMock };
  },
}));

vi.mock('@services/usageService', () => ({ recordUsage: recordUsageMock }));

import { transcribePdfPages, transcribeImages, selectTriagePages, VISION_BATCH_PAGES } from './visionEscalation';
import { buildPdf, tinyPng } from './__fixtures__/builders';

const anthropicResponse = (text: string) => ({
  content: [{ type: 'text', text }],
  usage: {
    input_tokens: 1_000,
    output_tokens: 200,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 500,
  },
});

beforeEach(() => {
  createMock.mockReset();
  recordUsageMock.mockReset();
  createMock.mockResolvedValue(anthropicResponse('--- PAGE 2 ---\nTranscribed page two text.'));
});

describe('transcribePdfPages', () => {
  const pdf = buildPdf(['one', '', 'three']);

  it('sends one batched call and returns per-page text blocks with pageRange', async () => {
    const result = await transcribePdfPages({ pdf, pages: [2], pageCount: 3, filename: 'f.pdf' });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.transcribedPages).toEqual([2]);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({
      type: 'text',
      pageRange: { start: 2, end: 2 },
    });
    expect(result.blocks[0].markdown).toContain('Transcribed page two text');
  });

  it('records usage through the cost pipeline (service anthropic, action doc:vision)', async () => {
    await transcribePdfPages({ pdf, pages: [2], pageCount: 3, filename: 'f.pdf' });
    expect(recordUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'anthropic', action: 'doc:vision' }),
    );
    const call = recordUsageMock.mock.calls[0][0];
    expect(call.costMicroCents).toBeGreaterThan(0);
  });

  it('batches ~20 pages per call', async () => {
    const pages = Array.from({ length: 45 }, (_, i) => i + 1);
    const bigPdf = buildPdf(Array.from({ length: 45 }, () => ''));
    await transcribePdfPages({ pdf: bigPdf, pages, pageCount: 45, filename: 'f.pdf' });
    expect(createMock).toHaveBeenCalledTimes(Math.ceil(45 / VISION_BATCH_PAGES));
  });

  it('honors the per-call page budget and warns when truncating', async () => {
    const pages = Array.from({ length: 30 }, (_, i) => i + 1);
    const bigPdf = buildPdf(Array.from({ length: 30 }, () => ''));
    const result = await transcribePdfPages({
      pdf: bigPdf,
      pages,
      pageCount: 30,
      filename: 'f.pdf',
      budget: 10,
    });
    expect(result.transcribedPages.length).toBeLessThanOrEqual(10);
    expect(result.warnings.some((w) => w.includes('budget'))).toBe(true);
  });

  it('refuses PDFs beyond the Anthropic page limit with a typed warning, zero calls', async () => {
    const result = await transcribePdfPages({
      pdf,
      pages: [101],
      pageCount: 150,
      filename: 'big.pdf',
    });
    expect(createMock).not.toHaveBeenCalled();
    expect(result.transcribedPages).toEqual([]);
    expect(result.warnings.some((w) => w.includes('100'))).toBe(true);
  });

  it('falls back to a single batch-spanning block when the model omits page markers', async () => {
    createMock.mockResolvedValue(anthropicResponse('Plain transcription without any markers.'));
    const result = await transcribePdfPages({ pdf, pages: [1, 3], pageCount: 3, filename: 'f.pdf' });
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].pageRange).toEqual({ start: 1, end: 3 });
  });
});

describe('transcribeImages', () => {
  it('returns a figure block and records usage', async () => {
    createMock.mockResolvedValue(anthropicResponse('A whiteboard listing three study techniques.'));
    const result = await transcribeImages({
      images: [{ data: tinyPng(), mediaType: 'image/png' }],
      label: 'notes.png',
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].type).toBe('figure');
    expect(result.blocks[0].markdown).toContain('whiteboard');
    expect(recordUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'anthropic', action: 'doc:vision' }),
    );
  });
});

describe('selectTriagePages', () => {
  it('samples first page + TOC-ish page + up to 3 interior pages, max 5', () => {
    const scanned = Array.from({ length: 40 }, (_, i) => i + 1);
    const picks = selectTriagePages({ scannedPages: scanned, pageCount: 40 });
    expect(picks.length).toBeLessThanOrEqual(5);
    expect(picks[0]).toBe(1);
    expect(picks.some((p) => p >= 2 && p <= 6)).toBe(true);
    expect(picks).toEqual([...picks].sort((a, b) => a - b));
  });

  it('returns every page when few are scanned', () => {
    expect(selectTriagePages({ scannedPages: [4, 9], pageCount: 12 })).toEqual([4, 9]);
  });

  it('returns empty for no scanned pages', () => {
    expect(selectTriagePages({ scannedPages: [], pageCount: 10 })).toEqual([]);
  });
});
