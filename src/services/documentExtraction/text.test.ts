import { describe, it, expect } from 'vitest';
import { extractPlainText } from './text';

const opts = { mode: 'triage' as const };
const input = (buffer: Buffer, mimeType: string, filename: string) => ({
  buffer,
  mimeType,
  filename,
  kind: 'file' as const,
});

describe('extractPlainText', () => {
  it('passes txt through as a single text block', async () => {
    const result = await extractPlainText(
      input(Buffer.from('Just some plain notes.\nSecond line.'), 'text/plain', 'notes.txt'),
      opts,
    );
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0].type).toBe('text');
    expect(result.markdown).toContain('Second line.');
  });

  it('splits markdown into heading-scoped blocks with headingPath', async () => {
    const md = '# One\n\nIntro paragraph.\n\n## Two\n\nNested paragraph.\n';
    const result = await extractPlainText(input(Buffer.from(md), 'text/markdown', 'doc.md'), opts);
    const nested = result.blocks.find((b) => b.markdown.includes('Nested paragraph'));
    expect(nested!.headingPath).toEqual(['One', 'Two']);
    const intro = result.blocks.find((b) => b.markdown.includes('Intro paragraph'));
    expect(intro!.headingPath).toEqual(['One']);
  });

  it('strips zero-width smuggling characters (normalization)', async () => {
    const sneaky = 'before\u200B\u202Eafter';
    const result = await extractPlainText(input(Buffer.from(sneaky), 'text/plain', 'x.txt'), opts);
    expect(result.markdown).toBe('beforeafter');
  });

  it('rejects binary masquerading as text with binary_in_text', async () => {
    const binary = Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 251));
    await expect(
      extractPlainText(input(binary, 'text/plain', 'fake.txt'), opts),
    ).rejects.toMatchObject({ name: 'ExtractionError', reason: 'binary_in_text' });
  });

  it('rejects whitespace-only content as empty_file', async () => {
    await expect(
      extractPlainText(input(Buffer.from('   \n  '), 'text/plain', 'blank.txt'), opts),
    ).rejects.toMatchObject({ reason: 'empty_file' });
  });
});
