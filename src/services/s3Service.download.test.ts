/**
 * `getPresignedUrl` gained an optional `downloadFilename`. The point of
 * these two tests is the FIRST one: every existing call site omits the
 * parameter, and must keep producing exactly the URL it produced before.
 */

import { describe, test, expect } from 'vitest';
import { getPresignedUrl } from './s3Service';

describe('getPresignedUrl', () => {
  test('without downloadFilename the URL has no content-disposition — unchanged for existing callers', async () => {
    const url = await getPresignedUrl({ key: 'lessons/audio/abc.mp3' });
    expect(url).not.toContain('response-content-disposition');
    expect(url).toContain('X-Amz-Signature');
  });

  test('with downloadFilename the parameter is present AND signed', async () => {
    const url = await getPresignedUrl({
      key: 'lessons/audio/abc.mp3',
      downloadFilename: 'my-lesson.mp3',
    });
    expect(url).toContain('response-content-disposition');
    expect(decodeURIComponent(url)).toContain('attachment; filename="my-lesson.mp3"');

    // It must be COVERED by the signature, or S3 rejects the request.
    // `X-Amz-SignedHeaders` proves nothing here — SigV4 emits it on every
    // presigned URL regardless. What proves coverage is that changing the
    // filename changes the signature: SigV4 signs the whole canonical
    // query string, so a disposition outside the signature would leave it
    // identical.
    const other = await getPresignedUrl({
      key: 'lessons/audio/abc.mp3',
      downloadFilename: 'different-name.mp3',
    });
    const sig = (u: string) => /X-Amz-Signature=([a-f0-9]+)/.exec(u)?.[1];
    expect(sig(url)).toBeDefined();
    expect(sig(other)).toBeDefined();
    expect(sig(url)).not.toBe(sig(other));
  });
});
