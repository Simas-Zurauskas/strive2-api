import { describe, it, expect, vi, beforeEach } from 'vitest';

const { transcribeImagesMock, sharpState } = vi.hoisted(() => ({
  transcribeImagesMock: vi.fn(),
  sharpState: { fail: false as boolean },
}));

vi.mock('./visionEscalation', () => ({ transcribeImages: transcribeImagesMock }));

vi.mock('sharp', () => ({
  default: (buf: Buffer) => {
    if (sharpState.fail) throw new Error('heif: no decoding plugin');
    return {
      jpeg: () => ({ toBuffer: async () => Buffer.concat([Buffer.from('JPEG'), buf.subarray(0, 4)]) }),
    };
  },
}));

import { extractImage } from './image';
import { tinyPng } from './__fixtures__/builders';

beforeEach(() => {
  transcribeImagesMock.mockReset();
  sharpState.fail = false;
  transcribeImagesMock.mockResolvedValue({
    blocks: [{ type: 'figure', markdown: 'A diagram of the water cycle.', headingPath: [] }],
    warnings: [],
  });
});

describe('extractImage', () => {
  it('passes png straight to vision and returns the contract shape', async () => {
    const result = await extractImage(
      { buffer: tinyPng(), mimeType: 'image/png', filename: 'notes.png', kind: 'file' },
      { mode: 'triage' },
    );
    expect(transcribeImagesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ mediaType: 'image/png' })],
      }),
    );
    expect(result.blocks[0].type).toBe('figure');
    expect(result.markdown).toContain('water cycle');
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('converts heic to jpeg via sharp before vision', async () => {
    await extractImage(
      { buffer: tinyPng(), mimeType: 'image/heic', filename: 'photo.heic', kind: 'file' },
      { mode: 'triage' },
    );
    const call = transcribeImagesMock.mock.calls[0][0];
    expect(call.images[0].mediaType).toBe('image/jpeg');
    expect((call.images[0].data as Buffer).subarray(0, 4).toString()).toBe('JPEG');
  });

  it('degrades gracefully when sharp lacks heif support: typed heic_unsupported', async () => {
    sharpState.fail = true;
    await expect(
      extractImage(
        { buffer: tinyPng(), mimeType: 'image/heic', filename: 'photo.heic', kind: 'file' },
        { mode: 'triage' },
      ),
    ).rejects.toMatchObject({ name: 'ExtractionError', reason: 'heic_unsupported' });
    expect(transcribeImagesMock).not.toHaveBeenCalled();
  });
});
