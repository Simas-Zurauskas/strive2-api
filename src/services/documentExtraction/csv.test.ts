import { describe, it, expect } from 'vitest';
import { extractCsv, CSV_PREVIEW_ROWS } from './csv';

const opts = { mode: 'triage' as const };
const input = (text: string) => ({
  buffer: Buffer.from(text),
  mimeType: 'text/csv',
  filename: 'data.csv',
  kind: 'file' as const,
});

describe('extractCsv', () => {
  it('parses a csv into a single table block', async () => {
    const result = await extractCsv(input('name,age\nalice,30\nbob,25\n'), opts);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].type).toBe('table');
    expect(result.markdown).toContain('| name | age |');
    expect(result.markdown).toContain('| alice | 30 |');
    expect(result.warnings).toEqual([]);
  });

  it('caps preview rows and warns about truncation', async () => {
    const rows = Array.from({ length: CSV_PREVIEW_ROWS + 100 }, (_, i) => `row${i},${i}`).join('\n');
    const result = await extractCsv(input(`label,value\n${rows}\n`), opts);
    const lineCount = result.blocks[0].markdown.split('\n').length;
    // header + separator + capped rows
    expect(lineCount).toBeLessThanOrEqual(CSV_PREVIEW_ROWS + 2);
    expect(result.warnings.some((w) => w.includes('truncated'))).toBe(true);
    expect(result.blocks[0].markdown).not.toContain(`row${CSV_PREVIEW_ROWS + 50},`);
  });

  it('escapes pipe characters so cells cannot break the table', async () => {
    const result = await extractCsv(input('a,b\n"x|y",z\n'), opts);
    expect(result.blocks[0].markdown).toContain('x\\|y');
  });

  it('rejects whitespace-only content as csv_parse_failed', async () => {
    await expect(extractCsv(input('   \n \n'), opts)).rejects.toMatchObject({
      name: 'ExtractionError',
      reason: 'csv_parse_failed',
    });
  });
});
