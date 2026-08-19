/**
 * Hero images, cropped and sized for a page.
 *
 * ## Aspect
 *
 * The PDF must show the hero at the SAME shape the reader saw in the app,
 * and that is not the shape of the stored file. The web hero is
 * `object-fit: cover` inside a column capped at `max-width: 740px`, with the
 * image capped at `max-height: 380px`
 * (`client/.../LessonContent.styles.ts:7`, `.../LessonHero.styles.ts:37-39`),
 * so on a desktop it renders 740 x 380 — measured in the browser, not
 * inferred. Drawing the uncropped file instead made the PDF hero markedly
 * taller than the app's.
 *
 * The stored originals are NOT 16:9, whatever they were asked to be.
 * `assetsGeneration.ts:203` requests `aspect_ratio: '16:9'`, but sampling 25
 * of the 85 distinct hero objects in S3 returned **1024x768 (4:3) for every
 * single one** — the vendor does not honour it. So the crop below is doing
 * real work on every image, not just correcting the odd outlier.
 *
 * ## Size
 *
 * The originals are multi-megabyte PNGs — the generation code's own comment
 * says "Typical BFL images are 2-4 MB"
 * (`lib/ai/agents/lessonGeneration/nodes/assetsGeneration.ts:234-236`).
 * Embedding 26 of those in a course PDF would mean ~78 MB of S3 reads and a
 * ~78 MB file, so each one is downscaled to a ~1200 px JPEG first.
 *
 * That derivative is CACHED back into S3 beside the original. Hero keys are
 * already content-addressed (`lessons/hero/{hash}.png`), so the derivative
 * key falls out of the hash and any course sharing that hero — the cache is
 * global, not per-course — reuses it. First export pays; every later one is
 * a small GET.
 *
 * Two older key shapes still exist and both are handled:
 *   - `lessons/{courseId}/{m}/{l}/hero.png` — pre-content-addressing. There
 *     is no hash to derive a derivative key from, so those are resized
 *     without caching. The hero still appears; it is just recomputed.
 *   - `data:` URIs — legacy inline images, decoded in place.
 *
 * Every failure path returns `null`. A missing picture must never fail an
 * export.
 */

import sharp from 'sharp';
import { getObjectBuffer, objectExists, uploadBuffer } from '@services/s3Service';
import { pdfLog } from '@lib/loggers';

/** Wide enough to look sharp on paper at ~120 mm, small enough to embed. */
const TARGET_WIDTH = 1200;
const JPEG_QUALITY = 78;

/**
 * The app's rendered hero shape, from the two client constants that produce
 * it: a 740 px content column and a 380 px height cap. Kept as the division
 * rather than a rounded decimal so the provenance survives.
 */
const HERO_ASPECT = 740 / 380;

export interface HeroImage {
  /** JPEG bytes, ready for pdfmake's `image` node as a data URI. */
  dataUri: string;
  cached: boolean;
}

/**
 * `lessons/hero/{hash}.png` → `lessons/hero/{hash}.pdf-v2.jpg`, else null.
 *
 * The `-v2` is load-bearing, not decoration. The first version of this cache
 * stored UNCROPPED derivatives under `.pdf.jpg`; every one of those is still
 * sitting in S3. Keeping the old key would mean each hero already exported
 * once keeps serving its 4:3 derivative forever and the crop appears only on
 * heroes nobody has exported yet — a bug that shows up as "it works on some
 * lessons". Any renderer change that alters the derivative's PIXELS has to
 * bump this token.
 */
const derivativeKeyFor = (key: string): string | null => {
  const m = /^lessons\/hero\/([0-9a-f]{8,})\.(png|jpe?g|webp)$/i.exec(key);
  return m ? `lessons/hero/${m[1]}.pdf-v2.jpg` : null;
};

const toDataUri = (buf: Buffer): string => `data:image/jpeg;base64,${buf.toString('base64')}`;

/**
 * Downscale and centre-crop to the app's hero shape.
 *
 * The width is clamped to the source's own width rather than passing
 * `withoutEnlargement`, because that flag and an explicit `height` interact
 * badly: sharp honours the no-enlarge rule by shrinking the whole target
 * box, so the output silently stops matching the aspect it was asked for.
 * Deriving both dimensions here keeps the ratio exact at any source size and
 * still never upscales.
 */
const downscale = async (input: Buffer): Promise<Buffer> => {
  const { width: sourceWidth } = await sharp(input).metadata();
  const width = Math.min(TARGET_WIDTH, sourceWidth ?? TARGET_WIDTH);
  return sharp(input)
    .resize({
      width,
      height: Math.round(width / HERO_ASPECT),
      // `object-fit: cover; object-position: center` in PDF terms.
      fit: 'cover',
      position: 'centre',
    })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
    .toBuffer();
};

/**
 * Resolve a stored `heroImageUrl` to embeddable JPEG bytes.
 *
 * @param heroImageUrl the value persisted on `LessonContent.heroImageUrl` —
 *   an S3 key, a legacy `data:` URI, or null.
 */
export const heroJpeg = async (heroImageUrl: string | null | undefined): Promise<HeroImage | null> => {
  if (!heroImageUrl) return null;

  try {
    // Legacy inline image — decode and downscale, nothing to cache.
    if (heroImageUrl.startsWith('data:')) {
      const b64 = heroImageUrl.slice(heroImageUrl.indexOf(',') + 1);
      const out = await downscale(Buffer.from(b64, 'base64'));
      return { dataUri: toDataUri(out), cached: false };
    }

    const derivativeKey = derivativeKeyFor(heroImageUrl);

    if (derivativeKey && (await objectExists({ key: derivativeKey }))) {
      const cachedBuf = await getObjectBuffer({ key: derivativeKey });
      return { dataUri: toDataUri(cachedBuf), cached: true };
    }

    const original = await getObjectBuffer({ key: heroImageUrl });
    const out = await downscale(original);

    if (derivativeKey) {
      // Content-addressed, so two concurrent misses write identical bytes
      // to the same key — last-write-wins is harmless here.
      //
      // Caught separately from the decode above: by this point the JPEG
      // already exists, and a throttled or policy-denied PUT is a lost
      // CACHE ENTRY, not a lost image. Letting it fall into the outer
      // handler would return null and drop the hero from every lesson of
      // an export over a problem that costs only the next render's time.
      try {
        await uploadBuffer({ key: derivativeKey, body: out, contentType: 'image/jpeg' });
      } catch (e) {
        pdfLog.error(
          `hero:cache-write-failed key=${derivativeKey} msg=${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } else {
      pdfLog.info(`hero:legacy-key no-cache key=${heroImageUrl}`);
    }

    return { dataUri: toDataUri(out), cached: false };
  } catch (e) {
    // A hero is decoration. Losing one must never cost the reader the lesson.
    pdfLog.error(`hero:failed key=${heroImageUrl} msg=${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};
