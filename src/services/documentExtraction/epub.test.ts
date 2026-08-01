import { describe, it, expect } from 'vitest';
import { extractEpub } from './epub';
import { buildEpub, buildZipBomb, buildZip } from './__fixtures__/builders';

const opts = { mode: 'triage' as const };
const input = (buffer: Buffer) => ({
  buffer,
  mimeType: 'application/epub+zip',
  filename: 'book.epub',
  kind: 'file' as const,
});

describe('extractEpub', () => {
  it('reads spine-ordered chapters into blocks with chapter headingPath', async () => {
    const epub = buildEpub([
      { title: 'Getting Started', body: 'Chapter one body about fundamentals and first principles.' },
      { title: 'Advanced Topics', body: 'Chapter two body about deeper material and practice.' },
    ]);
    const result = await extractEpub(input(epub), opts);
    expect(result.markdown).toContain('fundamentals');
    expect(result.markdown).toContain('deeper material');
    // Spine order preserved.
    expect(result.markdown.indexOf('fundamentals')).toBeLessThan(result.markdown.indexOf('deeper material'));
    const ch2 = result.blocks.find((b) => b.markdown.includes('deeper material'));
    expect(ch2!.headingPath).toContain('Advanced Topics');
  });

  it('rejects a zip bomb', async () => {
    await expect(extractEpub(input(buildZipBomb()), opts)).rejects.toMatchObject({
      reason: 'zip_bomb',
    });
  });

  it('rejects garbage as zip_invalid', async () => {
    await expect(extractEpub(input(Buffer.from('not an epub')), opts)).rejects.toMatchObject({
      reason: 'zip_invalid',
    });
  });

  it('rejects a zip without an OPF spine as epub_parse_failed', async () => {
    const notEpub = buildZip([{ name: 'mimetype', data: 'application/epub+zip' }]);
    await expect(extractEpub(input(notEpub), opts)).rejects.toMatchObject({
      reason: 'epub_parse_failed',
    });
  });
});
