/**
 * Phase 6 — hero image derivative + cache.
 *
 * S3 is mocked; `sharp` is real, so the size and format assertions describe
 * bytes that were actually produced.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import sharp from 'sharp';
import { heroJpeg } from './heroImage';

const getObjectBuffer = vi.fn();
const objectExists = vi.fn();
const uploadBuffer = vi.fn();

vi.mock('@services/s3Service', () => ({
  getObjectBuffer: (...a: unknown[]) => getObjectBuffer(...a),
  objectExists: (...a: unknown[]) => objectExists(...a),
  uploadBuffer: (...a: unknown[]) => uploadBuffer(...a),
}));

// NOTE: `heroJpeg` is imported at the top. `vi.mock` is hoisted above all
// imports, so the S3 mock is registered before that binding resolves.

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const HERO_KEY = `lessons/hero/${HASH}.png`;
const DERIVATIVE_KEY = `lessons/hero/${HASH}.pdf-v2.jpg`;
const LEGACY_KEY = 'lessons/68f0a1b2c3d4e5f607182930/0/0/hero.png';

/**
 * A real 16:9 PNG, wider than the 1200px target so resizing is observable.
 * Deliberately NOT the production shape — every stored hero sampled was
 * 1024x768 — because a fixture that already has the output aspect could not
 * show the crop happening. `wideSourcePng`/`tallSourcePng` below cover the
 * two directions the crop has to work in.
 */
const bigPng = async (): Promise<Buffer> =>
  sharp({ create: { width: 1920, height: 1080, channels: 3, background: { r: 40, g: 85, b: 69 } } })
    .png()
    .toBuffer();

const decode = (dataUri: string): Buffer =>
  Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64');

beforeEach(() => {
  getObjectBuffer.mockReset();
  objectExists.mockReset();
  uploadBuffer.mockReset();
});

describe('cache hit', () => {
  test('reads the derivative and does NOT re-upload', async () => {
    const jpeg = await sharp(await bigPng()).resize({ width: 1200 }).jpeg().toBuffer();
    objectExists.mockResolvedValue(true);
    getObjectBuffer.mockResolvedValue(jpeg);

    const r = await heroJpeg(HERO_KEY);

    expect(r?.cached).toBe(true);
    expect(objectExists).toHaveBeenCalledWith({ key: DERIVATIVE_KEY });
    expect(getObjectBuffer).toHaveBeenCalledWith({ key: DERIVATIVE_KEY });
    expect(uploadBuffer).not.toHaveBeenCalled();
  });
});

describe('cache miss', () => {
  beforeEach(async () => {
    objectExists.mockResolvedValue(false);
    getObjectBuffer.mockResolvedValue(await bigPng());
    uploadBuffer.mockResolvedValue(DERIVATIVE_KEY);
  });

  test('fetches the original and uploads the derivative to the hashed key', async () => {
    const r = await heroJpeg(HERO_KEY);
    expect(r?.cached).toBe(false);
    expect(getObjectBuffer).toHaveBeenCalledWith({ key: HERO_KEY });
    expect(uploadBuffer).toHaveBeenCalledTimes(1);
    expect(uploadBuffer.mock.calls[0][0]).toMatchObject({
      key: DERIVATIVE_KEY,
      contentType: 'image/jpeg',
    });
  });

  test('the result is a JPEG', async () => {
    const r = await heroJpeg(HERO_KEY);
    const bytes = decode(r!.dataUri);
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]); // SOI marker
  });

  test('the derivative is at most 1200px wide', async () => {
    const r = await heroJpeg(HERO_KEY);
    const meta = await sharp(decode(r!.dataUri)).metadata();
    expect(meta.width).toBeLessThanOrEqual(1200);
    expect(meta.width).toBeGreaterThan(0);
  });

  test('a smaller original is not enlarged', async () => {
    const small = await sharp({ create: { width: 400, height: 225, channels: 3, background: '#fff' } }).png().toBuffer();
    getObjectBuffer.mockResolvedValue(small);
    const r = await heroJpeg(HERO_KEY);
    const meta = await sharp(decode(r!.dataUri)).metadata();
    expect(meta.width).toBe(400);
  });
});

/**
 * The PDF hero must be the shape the reader saw in the app: `object-fit:
 * cover` in a 740px column capped at 380px tall.
 *
 * Asserted on the DECODED PIXELS of the produced JPEG, not on the arguments
 * handed to sharp. Checking the call arguments would keep passing if sharp
 * resolved `withoutEnlargement` against an explicit `height` by shrinking the
 * whole target box — which is exactly the trap this code avoids, and which no
 * argument-level assertion can see.
 */
describe('the derivative matches the app’s hero shape', () => {
  const WEB_ASPECT = 740 / 380;
  const ratio = async (png: Buffer): Promise<number> => {
    getObjectBuffer.mockResolvedValue(png);
    const r = await heroJpeg(HERO_KEY);
    const m = await sharp(decode(r!.dataUri)).metadata();
    return m.width! / m.height!;
  };

  beforeEach(() => {
    objectExists.mockResolvedValue(false);
    uploadBuffer.mockResolvedValue(undefined);
  });

  test.each([
    ['the production 4:3 shape — taller than the target, so cropped', 1024, 768],
    ['a 16:9 source — the shape generation asks for and never gets', 1920, 1080],
    ['a source already wider than the target', 1600, 500],
    ['a portrait source', 600, 1400],
    ['a source below the 1200px target width', 400, 300],
  ])('%s', async (_name, w, h) => {
    const png = await sharp({ create: { width: w, height: h, channels: 3, background: '#2c5545' } })
      .png()
      .toBuffer();
    // Within a pixel of rounding at these sizes.
    expect(await ratio(png)).toBeCloseTo(WEB_ASPECT, 1);
  });

  test('cropping never upscales past the source width', async () => {
    const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#2c5545' } })
      .png()
      .toBuffer();
    getObjectBuffer.mockResolvedValue(png);
    const r = await heroJpeg(HERO_KEY);
    const m = await sharp(decode(r!.dataUri)).metadata();
    expect(m.width).toBe(400);
    expect(m.height).toBe(Math.round(400 / WEB_ASPECT));
  });
});

describe('legacy key shapes', () => {
  test('a course-scoped key still yields an image, and caches nothing', async () => {
    // Pre-content-addressing keys have no hash, so there is no derivative
    // key to write. The hero must still appear rather than being dropped.
    getObjectBuffer.mockResolvedValue(await bigPng());
    const r = await heroJpeg(LEGACY_KEY);
    expect(r).not.toBeNull();
    expect(decode(r!.dataUri)[0]).toBe(0xff);
    expect(objectExists).not.toHaveBeenCalled();
    expect(uploadBuffer).not.toHaveBeenCalled();
    expect(getObjectBuffer).toHaveBeenCalledWith({ key: LEGACY_KEY });
  });

  test('a data: URI is decoded in place without touching S3', async () => {
    const png = await bigPng();
    const r = await heroJpeg(`data:image/png;base64,${png.toString('base64')}`);
    expect(r).not.toBeNull();
    expect(decode(r!.dataUri)[0]).toBe(0xff);
    expect(getObjectBuffer).not.toHaveBeenCalled();
    expect(objectExists).not.toHaveBeenCalled();
  });
});

describe('failure never breaks an export', () => {
  test('null / empty input returns null', async () => {
    await expect(heroJpeg(null)).resolves.toBeNull();
    await expect(heroJpeg(undefined)).resolves.toBeNull();
    await expect(heroJpeg('')).resolves.toBeNull();
  });

  test('a failed cache WRITE still returns the image', async () => {
    // The JPEG already exists by this point. A throttled or denied PUT
    // costs a cache entry, not the reader's picture — and dropping it
    // would blank the hero on every lesson of a course export.
    objectExists.mockResolvedValue(false);
    getObjectBuffer.mockResolvedValue(await bigPng());
    uploadBuffer.mockRejectedValue(new Error('SlowDown'));

    const r = await heroJpeg(HERO_KEY);
    expect(r).not.toBeNull();
    expect(decode(r!.dataUri)[0]).toBe(0xff);
  });

  test('an S3 error returns null rather than throwing', async () => {
    objectExists.mockResolvedValue(false);
    getObjectBuffer.mockRejectedValue(new Error('AccessDenied'));
    await expect(heroJpeg(HERO_KEY)).resolves.toBeNull();
  });

  test('undecodable image bytes return null rather than throwing', async () => {
    objectExists.mockResolvedValue(false);
    getObjectBuffer.mockResolvedValue(Buffer.from('not an image at all'));
    await expect(heroJpeg(HERO_KEY)).resolves.toBeNull();
  });
});
