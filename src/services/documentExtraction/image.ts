import { genLog } from '@lib/loggers';
import { transcribeImages } from './visionEscalation';
import {
  ExtractionError,
  ExtractionInput,
  ExtractionOptions,
  ExtractionResult,
  blocksToMarkdown,
} from './types';

/**
 * Images: png/jpg/webp pass straight through to the Anthropic vision
 * path (there is no free text tier for pixels); heic/heif is converted
 * to jpeg via sharp first (Anthropic does not accept heic).
 *
 * sharp is a native dependency — if this environment's libvips build
 * lacks HEIF support (or sharp fails to load at all), heic degrades
 * gracefully to a typed `heic_unsupported` failure instead of crashing
 * the process; sharp is therefore imported lazily, only on the heic
 * branch.
 */

type VisionMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

const DIRECT_MEDIA_TYPES: Record<string, VisionMediaType> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
};

const heicToJpeg = async (buffer: Buffer): Promise<Buffer> => {
  let sharpModule: typeof import('sharp');
  try {
    sharpModule = (await import('sharp')) as unknown as typeof import('sharp');
  } catch (err) {
    genLog.warn(`doc:image sharp unavailable: ${err instanceof Error ? err.message : err}`);
    throw new ExtractionError('heic_unsupported', 'HEIC conversion is unavailable on this server');
  }
  const sharp = (sharpModule as unknown as { default?: typeof import('sharp') }).default ?? sharpModule;
  try {
    return await sharp(buffer).jpeg({ quality: 85 }).toBuffer();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/heif|heic|plugin|decod/i.test(message)) {
      genLog.warn(`doc:image heic decode unsupported: ${message.slice(0, 200)}`);
      throw new ExtractionError('heic_unsupported', 'HEIC images are not supported on this server');
    }
    throw new ExtractionError('image_convert_failed', 'could not convert the image');
  }
};

export const extractImage = async (
  input: ExtractionInput,
  _opts: ExtractionOptions,
): Promise<ExtractionResult> => {
  const mime = input.mimeType.toLowerCase();

  let data: Buffer;
  let mediaType: VisionMediaType;
  if (mime === 'image/heic' || mime === 'image/heif') {
    data = await heicToJpeg(input.buffer);
    mediaType = 'image/jpeg';
  } else {
    const direct = DIRECT_MEDIA_TYPES[mime];
    if (!direct) throw new ExtractionError('unsupported_format', `unsupported image type ${mime}`);
    data = input.buffer;
    mediaType = direct;
  }

  const { blocks, warnings } = await transcribeImages({
    images: [{ data, mediaType }],
    label: input.filename,
  });

  if (blocks.length === 0) {
    throw new ExtractionError('vision_failed', 'the image produced no transcription');
  }

  return {
    markdown: blocksToMarkdown(blocks),
    blocks,
    warnings,
  };
};
