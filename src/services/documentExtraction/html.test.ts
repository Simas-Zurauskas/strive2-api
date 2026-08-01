import { describe, it, expect, vi } from 'vitest';
import { extractHtml } from './html';
import { htmlArticle } from './__fixtures__/builders';

describe('extractHtml', () => {
  it('extracts an article into heading-structured blocks with a table block', async () => {
    const result = await extractHtml(
      {
        buffer: Buffer.from(htmlArticle()),
        mimeType: 'text/html',
        filename: 'article.html',
        kind: 'file',
      },
      { mode: 'triage' },
    );
    expect(result.markdown).toContain('Leitner');
    expect(result.blocks.length).toBeGreaterThan(1);
    const table = result.blocks.find((b) => b.type === 'table');
    expect(table).toBeDefined();
    expect(table!.markdown).toContain('| Box | Interval |');
    const leitnerBlock = result.blocks.find((b) => b.headingPath.includes('The Leitner System'));
    expect(leitnerBlock).toBeDefined();
  });

  it('is inert against script execution and SSRF-shaped subresources', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await extractHtml(
      {
        buffer: Buffer.from(htmlArticle({ withHostileBits: true })),
        mimeType: 'text/html',
        filename: 'hostile.html',
        kind: 'file',
      },
      { mode: 'triage' },
    );
    // No execution: the script body never ran (linkedom performs no
    // script evaluation by design — this pins the choice).
    expect((globalThis as Record<string, unknown>).__extraction_pwned).toBeUndefined();
    // No egress: the parser performs no fetches by design.
    expect(fetchSpy).not.toHaveBeenCalled();
    // Inert output: neither the script body nor the metadata-endpoint
    // URL survives into the extracted markdown.
    expect(result.markdown).not.toContain('__extraction_pwned');
    expect(result.markdown).not.toContain('169.254.169.254');
    fetchSpy.mockRestore();
  });

  it('rejects markup with no extractable text as html_parse_failed', async () => {
    await expect(
      extractHtml(
        { buffer: Buffer.from('<html><body></body></html>'), mimeType: 'text/html', filename: 'empty.html', kind: 'file' },
        { mode: 'triage' },
      ),
    ).rejects.toMatchObject({ name: 'ExtractionError', reason: 'html_parse_failed' });
  });
});
