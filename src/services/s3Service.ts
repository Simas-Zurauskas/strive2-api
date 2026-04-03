import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { AWS_S3_BUCKET, AWS_S3_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } from '@conf/env';

const s3 = new S3Client({
  region: AWS_S3_REGION,
  credentials: {
    accessKeyId: AWS_ACCESS_KEY_ID,
    secretAccessKey: AWS_SECRET_ACCESS_KEY,
  },
});

const SEVEN_DAYS = 7 * 24 * 60 * 60;

export const uploadBuffer = async (key: string, body: Buffer, contentType: string): Promise<string> => {
  await s3.send(new PutObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return key;
};

export const getPresignedUrl = async (key: string, expiresIn = SEVEN_DAYS): Promise<string> => {
  return getSignedUrl(s3, new GetObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: key,
  }), { expiresIn });
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
  return getPresignedUrl(value);
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
