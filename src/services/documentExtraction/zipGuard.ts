import zlib from 'node:zlib';
import { ExtractionError } from './types';

/**
 * Hand-rolled zip central-directory pre-scan + bounded entry reader.
 *
 * Why hand-rolled: `mammoth` (docx) exposes no decompression cap of its
 * own, and epub needs a spine-ordered reader anyway — one ~150-line
 * parser covers both without a new dependency (plan Phase 2). The
 * office formats additionally get `officeparser`'s built-in
 * `decompressionLimits` (enforced on ACTUAL inflated bytes); this
 * pre-scan is the declared-size gate in front of every zip container.
 *
 * Zip-bomb posture (fail closed):
 *   - declared uncompressed total > `maxUncompressedBytes` → `zip_bomb`
 *   - entry count > `maxEntries` → `zip_bomb`
 *   - zip64 size markers (0xFFFFFFFF) → `zip_bomb` (anything that big is
 *     over our 200 MB cap by definition)
 *   - malformed structure → `zip_invalid`
 * The reader additionally bounds ACTUAL inflated bytes per entry via
 * `inflateRawSync`'s `maxOutputLength`, so a lying central directory
 * (declares small, inflates huge) still cannot exhaust memory.
 */

export const ZIP_MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200 MB (plan §3.2)
export const ZIP_MAX_ENTRIES = 5_000;

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
/** EOCD is 22 bytes + up to 65535 bytes of comment. */
const EOCD_SEARCH_WINDOW = 22 + 65_535;

export interface ZipEntry {
  name: string;
  method: number; // 0 = store, 8 = deflate
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export interface ZipScan {
  entries: ZipEntry[];
  totalUncompressed: number;
}

/**
 * Parse the End-Of-Central-Directory record + central directory entries.
 * Throws `ExtractionError('zip_bomb' | 'zip_invalid')`.
 */
export const preScanZip = (
  buffer: Buffer,
  {
    maxUncompressedBytes = ZIP_MAX_UNCOMPRESSED_BYTES,
    maxEntries = ZIP_MAX_ENTRIES,
  }: { maxUncompressedBytes?: number; maxEntries?: number } = {},
): ZipScan => {
  if (buffer.length < 22) throw new ExtractionError('zip_invalid', 'file too small to be a zip archive');

  // EOCD: scan backwards through the comment window for the signature.
  let eocdOffset = -1;
  const searchStart = Math.max(0, buffer.length - EOCD_SEARCH_WINDOW);
  for (let i = buffer.length - 22; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new ExtractionError('zip_invalid', 'no end-of-central-directory record');

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (entryCount > maxEntries) {
    throw new ExtractionError('zip_bomb', `archive declares ${entryCount} entries (max ${maxEntries})`);
  }
  // 0xFFFF entries / 0xFFFFFFFF offsets signal zip64 — over any cap we allow.
  if (entryCount === 0xffff || centralDirOffset === 0xffffffff || centralDirSize === 0xffffffff) {
    throw new ExtractionError('zip_bomb', 'zip64 archive exceeds supported size');
  }
  if (centralDirOffset + centralDirSize > buffer.length) {
    throw new ExtractionError('zip_invalid', 'central directory extends past end of file');
  }

  const entries: ZipEntry[] = [];
  let totalUncompressed = 0;
  let offset = centralDirOffset;

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new ExtractionError('zip_invalid', `malformed central directory entry ${i}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new ExtractionError('zip_bomb', 'zip64 entry exceeds supported size');
    }

    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf-8');
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > maxUncompressedBytes) {
      throw new ExtractionError(
        'zip_bomb',
        `archive declares more than ${Math.round(maxUncompressedBytes / (1024 * 1024))} MB uncompressed`,
      );
    }

    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return { entries, totalUncompressed };
};

/**
 * Read + decompress one entry (store or deflate only — the methods OOXML,
 * ODF and EPUB actually use). Actual inflated bytes are bounded by the
 * declared size: a stream that inflates past `uncompressedSize` throws
 * (`maxOutputLength`), closing the lying-central-directory hole.
 */
export const readZipEntry = (buffer: Buffer, entry: ZipEntry): Buffer => {
  const { localHeaderOffset } = entry;
  if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== LOCAL_SIG) {
    throw new ExtractionError('zip_invalid', `malformed local header for ${entry.name}`);
  }
  const nameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) {
    throw new ExtractionError('zip_invalid', `entry data extends past end of file: ${entry.name}`);
  }
  const raw = buffer.subarray(dataStart, dataEnd);

  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(raw, { maxOutputLength: entry.uncompressedSize + 1 });
    } catch (err) {
      // Node signals a maxOutputLength breach as ERR_BUFFER_TOO_LARGE.
      const code = (err as { code?: string }).code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'ERR_BUFFER_TOO_LARGE' || /larger than|output length/i.test(message)) {
        throw new ExtractionError('zip_bomb', `entry inflates past its declared size: ${entry.name}`);
      }
      throw new ExtractionError('zip_invalid', `failed to inflate ${entry.name}`);
    }
  }
  throw new ExtractionError('zip_invalid', `unsupported compression method ${entry.method} for ${entry.name}`);
};

/** Convenience: find + read a single entry by exact name; null if absent. */
export const readZipEntryByName = (buffer: Buffer, scan: ZipScan, name: string): Buffer | null => {
  const entry = scan.entries.find((e) => e.name === name);
  return entry ? readZipEntry(buffer, entry) : null;
};
