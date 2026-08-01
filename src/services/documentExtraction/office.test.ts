import { describe, it, expect } from 'vitest';
import { extractOffice } from './office';
import { buildPptx, buildZipBomb, buildZip } from './__fixtures__/builders';

const opts = { mode: 'triage' as const };
const pptxInput = (buffer: Buffer) => ({
  buffer,
  mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  filename: 'deck.pptx',
  kind: 'file' as const,
});

describe('extractOffice', () => {
  it('extracts a pptx into per-slide blocks with headingPath', async () => {
    const result = await extractOffice(
      pptxInput(buildPptx(['Welcome to the course deck', 'Second slide about spaced repetition'])),
      opts,
    );
    expect(result.markdown).toContain('Welcome to the course deck');
    expect(result.markdown).toContain('spaced repetition');
    const slide1 = result.blocks.find((b) => b.markdown.includes('Welcome to the course deck'));
    expect(slide1).toBeDefined();
    expect(slide1!.headingPath.some((h) => /slide\s*1/i.test(h))).toBe(true);
    const slide2 = result.blocks.find((b) => b.markdown.includes('spaced repetition'));
    expect(slide2!.headingPath.some((h) => /slide\s*2/i.test(h))).toBe(true);
  });

  it('rejects a zip bomb before officeparser runs', async () => {
    await expect(extractOffice(pptxInput(buildZipBomb()), opts)).rejects.toMatchObject({
      name: 'ExtractionError',
      reason: 'zip_bomb',
    });
  });

  it('rejects non-zip garbage as zip_invalid', async () => {
    await expect(
      extractOffice(pptxInput(Buffer.from('definitely not a presentation')), opts),
    ).rejects.toMatchObject({ reason: 'zip_invalid' });
  });

  it('rejects a valid zip that is not an office document as office_parse_failed', async () => {
    const notOffice = buildZip([{ name: 'readme.txt', data: 'plain zip' }]);
    await expect(extractOffice(pptxInput(notOffice), opts)).rejects.toMatchObject({
      reason: 'office_parse_failed',
    });
  });
});
