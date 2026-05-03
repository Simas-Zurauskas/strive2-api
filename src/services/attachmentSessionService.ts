import crypto from 'node:crypto';
import { Types } from 'mongoose';
import LessonMentorChatModel, {
  type ILessonMentorAttachment,
} from '@models/LessonMentorChatModel';
import { extractAttachmentText, type ExtractionError } from '@services/attachmentService';
import { integrationLog } from '@lib/loggers';

/**
 * Session-scoped attachment lifecycle for the lesson mentor chat.
 *
 * Single source of truth that combines extraction, dedupe, cap
 * enforcement, and persistence. The HTTP handler stays thin — it just
 * accepts a multipart upload and calls into here.
 *
 * Why on the chat session (not a separate collection):
 *   - Attachments are session-bound — if the chat goes, they go.
 *   - Existing cleanup cascades (`clearLessonChatController`,
 *     `cleanupCourseContent`, account deletion) all wipe the chat doc
 *     wholesale, so we inherit cleanup for free.
 *   - Per-doc storage is bounded (5 files × ~50K tokens × ~4 bytes/char
 *     ≈ 1MB) — well under Mongo's 16MB cap.
 *
 * Limits enforced here (in addition to the upstream multer 10MB +
 * `extractAttachmentText` 50K-token caps):
 *   - MAX_ATTACHMENTS_PER_SESSION  — count cap (5)
 *   - MAX_TOTAL_TOKENS_PER_SESSION — cumulative-token cap (120k)
 *
 * Dedupe by SHA-256 of the raw upload buffer: re-uploading the same
 * file returns the existing entry's id. Prevents "I attached this paper
 * already, why is it eating another 30k tokens of cap?" footguns.
 */

export const MAX_ATTACHMENTS_PER_SESSION = 5;
export const MAX_TOTAL_TOKENS_PER_SESSION = 120_000;

export type AttachToSessionError =
  | ExtractionError
  | 'oversize'
  | 'session_count_cap'
  | 'session_token_cap';

export interface AttachToSessionResult {
  id: string;
  filename: string;
  kind: 'pdf' | 'text';
  approxTokens: number;
  /** True when the same file (sha256 match) already existed in this session. */
  dedupedFromExisting: boolean;
}

const PER_FILE_TOKEN_CAP = 50_000;

const sha256Hex = (buffer: Buffer): string =>
  crypto.createHash('sha256').update(buffer).digest('hex');

const generateAttachmentId = (sha256: string): string => `att_${sha256.slice(0, 16)}`;

/**
 * Extract text from the upload, dedupe against the session, enforce
 * caps, persist, and return the metadata the client needs for the chip.
 *
 * Returns a discriminated result so the HTTP handler can map each error
 * to a specific status code + user-facing message.
 */
export const attachToSession = async ({
  userId,
  courseId,
  moduleIndex,
  lessonIndex,
  buffer,
  mimeType,
  filename,
}: {
  userId: string;
  courseId: string;
  moduleIndex: number;
  lessonIndex: number;
  buffer: Buffer;
  mimeType: string;
  filename: string;
}): Promise<{ ok: true; data: AttachToSessionResult } | { ok: false; error: AttachToSessionError }> => {
  const userObjectId = new Types.ObjectId(userId);
  const courseObjectId = new Types.ObjectId(courseId);

  // Dedupe BEFORE extraction so a re-upload skips the parse work entirely.
  const sha256 = sha256Hex(buffer);
  const existingChat = await LessonMentorChatModel.findOne({
    userId: userObjectId,
    courseId: courseObjectId,
    moduleIndex,
    lessonIndex,
  })
    .select('attachments')
    .lean();

  const existingAttachment = existingChat?.attachments?.find((a) => a.sha256 === sha256);
  if (existingAttachment) {
    return {
      ok: true,
      data: {
        id: existingAttachment.id,
        filename: existingAttachment.filename,
        kind: existingAttachment.kind,
        approxTokens: existingAttachment.approxTokens,
        dedupedFromExisting: true,
      },
    };
  }

  // No dedupe hit → extract.
  const extraction = await extractAttachmentText({ buffer, mimeType, filename });
  if (!extraction.ok) return { ok: false, error: extraction.error };

  if (extraction.data.approxTokens > PER_FILE_TOKEN_CAP) {
    return { ok: false, error: 'oversize' };
  }

  // Enforce session caps using the just-loaded `attachments` array. The
  // upsert below uses Mongo's $push + $expr-free guards via a second
  // findOneAndUpdate path; an alternative would be a transaction, but
  // for this single-collection upsert the read-then-write window is
  // dominated by user think-time, not concurrent-paperclip races.
  const currentAttachments = existingChat?.attachments ?? [];
  if (currentAttachments.length >= MAX_ATTACHMENTS_PER_SESSION) {
    return { ok: false, error: 'session_count_cap' };
  }

  const currentTotalTokens = currentAttachments.reduce((sum, a) => sum + a.approxTokens, 0);
  if (currentTotalTokens + extraction.data.approxTokens > MAX_TOTAL_TOKENS_PER_SESSION) {
    return { ok: false, error: 'session_token_cap' };
  }

  const newAttachment: ILessonMentorAttachment = {
    id: generateAttachmentId(sha256),
    filename: extraction.data.filename,
    kind: extraction.data.kind,
    approxTokens: extraction.data.approxTokens,
    text: extraction.data.text,
    sha256,
    createdAt: new Date(),
  };

  // Upsert — $push works whether the doc exists or not, $setOnInsert
  // fills the keying fields on first creation. Ordering: when two
  // attaches race, the second observes the first's $push (Mongo serialises
  // updates on a single doc) so the second's cap check still passes its
  // own race-free `count + 1 ≤ 5` invariant.
  await LessonMentorChatModel.findOneAndUpdate(
    {
      userId: userObjectId,
      courseId: courseObjectId,
      moduleIndex,
      lessonIndex,
    },
    {
      $push: { attachments: newAttachment },
      $setOnInsert: {
        userId: userObjectId,
        courseId: courseObjectId,
        moduleIndex,
        lessonIndex,
      },
    },
    { upsert: true, new: true },
  );

  integrationLog.info(
    `attachment:attached id=${newAttachment.id} kind=${newAttachment.kind} tokens~${newAttachment.approxTokens} lesson=${courseId}/${moduleIndex}/${lessonIndex}`,
  );

  return {
    ok: true,
    data: {
      id: newAttachment.id,
      filename: newAttachment.filename,
      kind: newAttachment.kind,
      approxTokens: newAttachment.approxTokens,
      dedupedFromExisting: false,
    },
  };
};
