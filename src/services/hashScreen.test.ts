import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Types } from 'mongoose';

const { copyObjectMock, deleteObjectMock } = vi.hoisted(() => ({
  copyObjectMock: vi.fn(),
  deleteObjectMock: vi.fn(),
}));

vi.mock('@services/s3Service', () => ({
  copyObject: copyObjectMock,
  deleteObject: deleteObjectMock,
}));

import { setupTestDb } from '../../test-helpers/db';
import SourceDocumentModel from '@models/SourceDocumentModel';
import ContentFlagModel, { CONTENT_FLAG_RETENTION_DAYS } from '@models/ContentFlagModel';
import { hashScreenImages, isHashScreenEnabled, QUARANTINE_PREFIX } from './hashScreen';
import { tinyPng } from './documentExtraction/__fixtures__/builders';

setupTestDb();

const fetchMock = vi.fn();

const photoDnaResponse = (isMatch: boolean) => ({
  ok: true,
  status: 200,
  json: async () => ({ IsMatch: isMatch, TrackingId: 'track-1', ContentId: 'content-1', Status: { Code: 3000 } }),
});

const makeDoc = async () => {
  const userId = new Types.ObjectId();
  const courseId = new Types.ObjectId();
  const doc = await SourceDocumentModel.create({
    userId,
    courseId,
    kind: 'file',
    filename: 'photo.png',
    mimeType: 'image/png',
    byteSize: 68,
    sha256: 'a'.repeat(64),
    s3Key: `uploads/${userId}/${courseId}/raw-object`,
    status: 'parsing',
  });
  return { userId, courseId, doc };
};

beforeEach(() => {
  fetchMock.mockReset();
  copyObjectMock.mockReset();
  deleteObjectMock.mockReset();
  copyObjectMock.mockResolvedValue('quarantine-key');
  deleteObjectMock.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fetchMock);
  delete process.env.PHOTODNA_API_KEY;
  delete process.env.PHOTODNA_ENDPOINT;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PHOTODNA_API_KEY;
  delete process.env.PHOTODNA_ENDPOINT;
});

const enable = () => {
  process.env.PHOTODNA_API_KEY = 'test-key';
  process.env.PHOTODNA_ENDPOINT = 'https://photodna.example/v1.0/Match';
};

describe('isHashScreenEnabled', () => {
  it('is disabled unless BOTH env vars are present (day-one state)', () => {
    expect(isHashScreenEnabled()).toBe(false);
    process.env.PHOTODNA_API_KEY = 'k';
    expect(isHashScreenEnabled()).toBe(false);
    process.env.PHOTODNA_ENDPOINT = 'https://photodna.example/v1.0/Match';
    expect(isHashScreenEnabled()).toBe(true);
  });
});

describe('hashScreenImages', () => {
  it('no-ops when disabled: {screened:false}, no HTTP call, no mutations', async () => {
    const { userId, courseId, doc } = await makeDoc();
    const result = await hashScreenImages({
      images: [{ buffer: tinyPng(), mimeType: 'image/png' }],
      userId: userId.toString(),
      courseId: courseId.toString(),
      documentId: doc._id.toString(),
      s3Key: doc.s3Key,
    });
    expect(result).toEqual({ screened: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(copyObjectMock).not.toHaveBeenCalled();
  });

  it('enabled + no match → screened, nothing quarantined', async () => {
    enable();
    fetchMock.mockResolvedValue(photoDnaResponse(false));
    const { userId, courseId, doc } = await makeDoc();

    const result = await hashScreenImages({
      images: [
        { buffer: tinyPng(), mimeType: 'image/png' },
        { buffer: tinyPng(), mimeType: 'image/jpeg' },
      ],
      userId: userId.toString(),
      courseId: courseId.toString(),
      documentId: doc._id.toString(),
      s3Key: doc.s3Key,
    });

    expect(result).toEqual({ screened: true, matched: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(copyObjectMock).not.toHaveBeenCalled();
    expect(deleteObjectMock).not.toHaveBeenCalled();

    const fresh = await SourceDocumentModel.findById(doc._id).lean();
    expect(fresh?.status).toBe('parsing');
    expect(await ContentFlagModel.countDocuments({})).toBe(0);
  });

  it('enabled + match → quarantine move, audit row, opaque generic reason', async () => {
    enable();
    fetchMock.mockResolvedValue(photoDnaResponse(true));
    const { userId, courseId, doc } = await makeDoc();

    const result = await hashScreenImages({
      images: [{ buffer: tinyPng(), mimeType: 'image/png' }],
      userId: userId.toString(),
      courseId: courseId.toString(),
      documentId: doc._id.toString(),
      s3Key: doc.s3Key,
    });

    expect(result).toEqual({ screened: true, matched: true, rejectionReason: 'policy' });

    // (1) Evidence moved to the quarantine prefix (outside uploads/) and
    // the original removed.
    const quarantineKey = `${QUARANTINE_PREFIX}${userId.toString()}/${doc._id.toString()}`;
    expect(quarantineKey.startsWith('uploads/')).toBe(false);
    expect(copyObjectMock).toHaveBeenCalledWith({ sourceKey: doc.s3Key, destinationKey: quarantineKey });
    expect(deleteObjectMock).toHaveBeenCalledWith({ key: doc.s3Key });

    // (2) Doc rejected with the OPAQUE reason — never discloses detection.
    const fresh = await SourceDocumentModel.findById(doc._id).lean();
    expect(fresh?.status).toBe('rejected');
    expect(fresh?.rejectionReason).toBe('policy');
    expect(JSON.stringify(fresh)).not.toMatch(/photodna|csam|hash/i);

    // (3) Audit row with ~1y retention (REPORT Act evidence window).
    const flag = await ContentFlagModel.findOne({ documentId: doc._id }).lean();
    expect(flag).toBeTruthy();
    expect(flag?.provider).toBe('photodna');
    expect(flag?.s3QuarantineKey).toBe(quarantineKey);
    expect(flag?.matchMeta).toMatchObject({ trackingId: 'track-1' });
    const expectedRetention = Date.now() + CONTENT_FLAG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    expect(Math.abs((flag?.retentionUntil as Date).getTime() - expectedRetention)).toBeLessThan(60_000);
  });

  it('sends the subscription key and raw bytes to the configured endpoint', async () => {
    enable();
    fetchMock.mockResolvedValue(photoDnaResponse(false));
    const { userId, courseId, doc } = await makeDoc();
    await hashScreenImages({
      images: [{ buffer: tinyPng(), mimeType: 'image/png' }],
      userId: userId.toString(),
      courseId: courseId.toString(),
      documentId: doc._id.toString(),
      s3Key: doc.s3Key,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://photodna.example/v1.0/Match');
    expect(init.method).toBe('POST');
    expect(init.headers['Ocp-Apim-Subscription-Key']).toBe('test-key');
    expect(init.headers['Content-Type']).toBe('image/png');
  });

  it('enabled + API down → fails CLOSED (throws; no pass-through, no mutations)', async () => {
    enable();
    fetchMock.mockRejectedValue(new Error('network down'));
    const { userId, courseId, doc } = await makeDoc();

    await expect(
      hashScreenImages({
        images: [{ buffer: tinyPng(), mimeType: 'image/png' }],
        userId: userId.toString(),
        courseId: courseId.toString(),
        documentId: doc._id.toString(),
        s3Key: doc.s3Key,
      }),
    ).rejects.toThrow();

    const fresh = await SourceDocumentModel.findById(doc._id).lean();
    expect(fresh?.status).toBe('parsing');
    expect(copyObjectMock).not.toHaveBeenCalled();
    expect(await ContentFlagModel.countDocuments({})).toBe(0);
  });

  it('treats a non-2xx PhotoDNA response as failure (fail closed)', async () => {
    enable();
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { userId, courseId, doc } = await makeDoc();
    await expect(
      hashScreenImages({
        images: [{ buffer: tinyPng(), mimeType: 'image/png' }],
        userId: userId.toString(),
        courseId: courseId.toString(),
        documentId: doc._id.toString(),
        s3Key: doc.s3Key,
      }),
    ).rejects.toThrow();
  });
});

describe('ContentFlagModel', () => {
  it('declares a TTL index on retentionUntil (AbuseLog pattern)', () => {
    const indexes = ContentFlagModel.schema.indexes() as Array<
      [Record<string, unknown>, { expireAfterSeconds?: number }]
    >;
    const ttlIndex = indexes.find(([fields]) => fields.retentionUntil !== undefined);
    expect(ttlIndex).toBeTruthy();
    expect(ttlIndex?.[1].expireAfterSeconds).toBe(0);
  });
});
