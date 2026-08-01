import { describe, it, expect } from 'vitest';
import { extractDocx } from './docx';
import { buildDocx, buildZipBomb, buildZip } from './__fixtures__/builders';

const opts = { mode: 'triage' as const };
const input = (buffer: Buffer) => ({
  buffer,
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  filename: 'doc.docx',
  kind: 'file' as const,
});

describe('extractDocx', () => {
  it('extracts headings, paragraphs and a table block', async () => {
    const result = await extractDocx(input(buildDocx({ withTable: true })), opts);
    expect(result.markdown).toContain('first paragraph of the docx fixture');
    const table = result.blocks.find((b) => b.type === 'table');
    expect(table).toBeDefined();
    expect(table!.markdown).toContain('| Metric | Value |');
    expect(table!.markdown).toContain('| Speed | 42 |');
    // Heading structure flows into headingPath.
    const body = result.blocks.find((b) => b.markdown.includes('first paragraph'));
    expect(body!.headingPath).toContain('Fixture Heading');
  });

  it('rejects a zip bomb BEFORE mammoth runs (central-directory pre-scan)', async () => {
    await expect(extractDocx(input(buildZipBomb()), opts)).rejects.toMatchObject({
      name: 'ExtractionError',
      reason: 'zip_bomb',
    });
  });

  it('rejects non-zip garbage as zip_invalid', async () => {
    await expect(
      extractDocx(input(Buffer.from('garbage garbage garbage garbage garbage')), opts),
    ).rejects.toMatchObject({ reason: 'zip_invalid' });
  });

  it('rejects a valid zip that is not a docx as docx_parse_failed', async () => {
    const notDocx = buildZip([{ name: 'hello.txt', data: 'not a word document' }]);
    await expect(extractDocx(input(notDocx), opts)).rejects.toMatchObject({
      reason: 'docx_parse_failed',
    });
  });
});
