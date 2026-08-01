import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AWS_S3_BUCKET, AWS_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } from '@conf/env';

// ⚠ Keys are currently scoped by `courseId` only (e.g.
// `lessons/{courseId}/{moduleIndex}/{lessonIndex}/hero.png`). Course ids
// are ObjectIds and aren't exposed across tenants, so today this is safe.
// For defense in depth, moving the scheme to `lessons/{userId}/{courseId}/…`
// would keep presigned URLs tightly bound to a user even if a courseId ever
// leaks into a shared context. Deferred because it requires coordinated
// migration of existing stored keys.
const s3 = new S3Client({
  region: AWS_S3_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

const SEVEN_DAYS = 7 * 24 * 60 * 60;

export const uploadBuffer = async ({ key, body, contentType }: { key: string; body: Buffer; contentType: string }): Promise<string> => {
  await s3.send(new PutObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return key;
};

export const getPresignedUrl = async ({ key, expiresIn = SEVEN_DAYS }: { key: string; expiresIn?: number }): Promise<string> => {
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: key,
  }), { expiresIn });
};

/**
 * True when an object exists at `key`. Used by content-addressed dedup
 * paths (e.g. hero-image hash cache) to short-circuit expensive generation
 * calls when a previous run already produced an identical artefact.
 *
 * Propagates non-404 errors so auth / bucket misconfigurations surface
 * instead of silently falling through to the paid regeneration path.
 */
export const objectExists = async ({ key }: { key: string }): Promise<boolean> => {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key }));
    return true;
  } catch (e: unknown) {
    const meta = e as { $metadata?: { httpStatusCode?: number }; name?: string } | undefined;
    if (meta?.$metadata?.httpStatusCode === 404 || meta?.name === 'NotFound' || meta?.name === 'NoSuchKey') {
      return false;
    }
    throw e;
  }
};

/**
 * Resolves a heroImageUrl value to a displayable URL.
 * - S3 keys (e.g. "lessons/...") → presigned URL
 * - Legacy base64 data URIs ("data:...") → returned as-is
 * - null → null
 */
export const resolveImageUrl = async (value: string | null): Promise<string | null> => {
  if (!value) return null;
  if (value.startsWith('data:')) return value;
  return getPresignedUrl({ key: value });
};

/**
 * Server-side copy within the bucket. Used by the CSAM hash-screen
 * quarantine path (`hashScreen.ts`) to preserve evidence under
 * `quarantine/…` before the original is removed — the bytes never
 * round-trip through this process.
 */
export const copyObject = async ({ sourceKey, destinationKey }: { sourceKey: string; destinationKey: string }): Promise<string> => {
  await s3.send(new CopyObjectCommand({
    Bucket: AWS_S3_BUCKET,
    // CopySource is URL-encoded per the S3 API; keep the path slashes.
    CopySource: `${AWS_S3_BUCKET}/${encodeURIComponent(sourceKey).replace(/%2F/g, '/')}`,
    Key: destinationKey,
  }));
  return destinationKey;
};

/** Delete a single object by key (prefix-wide cleanup uses deleteByPrefix). */
export const deleteObject = async ({ key }: { key: string }): Promise<void> => {
  await s3.send(new DeleteObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key }));
};

/**
 * Fetch an object's full body as a Buffer. Used by the document-ingest job
 * to pull raw uploads back for extraction (uploads are ≤50 MB by the
 * multer cap, so buffering in memory matches the upload path's posture).
 */
export const getObjectBuffer = async ({ key }: { key: string }): Promise<Buffer> => {
  const res = await s3.send(new GetObjectCommand({ Bucket: AWS_S3_BUCKET, Key: key }));
  if (!res.Body) throw new Error(`S3 object ${key} has no body`);
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes);
};

/**
 * List all object keys under a prefix (paginated). Used by the
 * debug-ingest harness's zero-orphan proof; keep results small — this
 * loads every key into memory.
 */
export const listKeysByPrefix = async (prefix: string): Promise<string[]> => {
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: AWS_S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const obj of list.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);

  return keys;
};

/**
 * Deletes all S3 objects under a given prefix (e.g. "lessons/{courseId}/").
 * Handles pagination for prefixes with more than 1000 objects.
 */
export const deleteByPrefix = async (prefix: string): Promise<number> => {
  let deleted = 0;
  let continuationToken: string | undefined;

  do {
    const list = await s3.send(new ListObjectsV2Command({
      Bucket: AWS_S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));

    const objects = list.Contents;
    if (!objects || objects.length === 0) break;

    await s3.send(new DeleteObjectsCommand({
      Bucket: AWS_S3_BUCKET,
      Delete: { Objects: objects.map((o) => ({ Key: o.Key! })) },
    }));

    deleted += objects.length;
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);

  return deleted;
};
