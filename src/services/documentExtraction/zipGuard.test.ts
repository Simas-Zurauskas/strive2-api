import { describe, it, expect } from 'vitest';
import { preScanZip, readZipEntry, readZipEntryByName, ZIP_MAX_ENTRIES } from './zipGuard';
import { ExtractionError } from './types';
import { buildZip, buildZipBomb, buildManyEntriesZip } from './__fixtures__/builders';

describe('zipGuard', () => {
  it('pre-scans a valid archive: entries + declared total', () => {
    const zip = buildZip([
      { name: 'a.txt', data: 'hello' },
      { name: 'dir/b.txt', data: 'world!!' },
    ]);
    const scan = preScanZip(zip);
    expect(scan.entries.map((e) => e.name)).toEqual(['a.txt', 'dir/b.txt']);
    expect(scan.totalUncompressed).toBe(5 + 7);
  });

  it('rejects a central directory declaring 1 GB uncompressed as zip_bomb', () => {
    const bomb = buildZipBomb({ declaredBytesPerEntry: 1024 * 1024 * 1024, entries: 1 });
    let caught: unknown;
    try {
      preScanZip(bomb);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExtractionError);
    expect((caught as ExtractionError).reason).toBe('zip_bomb');
  });

  it('rejects archives with more entries than the cap', () => {
    const zip = buildManyEntriesZip(ZIP_MAX_ENTRIES + 1);
    expect(() => preScanZip(zip)).toThrowError(
      expect.objectContaining({ reason: 'zip_bomb' }),
    );
  });

  it('rejects garbage bytes as zip_invalid', () => {
    const garbage = Buffer.from('this is definitely not a zip archive, not even close!!');
    expect(() => preScanZip(garbage)).toThrowError(
      expect.objectContaining({ reason: 'zip_invalid' }),
    );
  });

  it('reads store and deflate entries back byte-identical', () => {
    const text = 'deflate me '.repeat(50);
    const zip = buildZip([
      { name: 'stored.txt', data: 'plain' },
      { name: 'squeezed.txt', data: text, deflate: true },
    ]);
    const scan = preScanZip(zip);
    expect(readZipEntryByName(zip, scan, 'stored.txt')!.toString()).toBe('plain');
    expect(readZipEntryByName(zip, scan, 'squeezed.txt')!.toString()).toBe(text);
  });

  it('bounds ACTUAL inflated bytes: entry inflating past its declared size throws zip_bomb', () => {
    const text = 'a'.repeat(10_000);
    const zip = buildZip([{ name: 'liar.txt', data: text, deflate: true }]);
    const scan = preScanZip(zip);
    // Lie in the central directory: claim it inflates to 10 bytes.
    const entry = { ...scan.entries[0], uncompressedSize: 10 };
    expect(() => readZipEntry(zip, entry)).toThrowError(
      expect.objectContaining({ reason: 'zip_bomb' }),
    );
  });
});
