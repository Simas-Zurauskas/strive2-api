import type { ILessonBlock } from '@models/LessonContentModel';
import type { JobType } from '@lib/constants';
import type { GeneratedInsight } from '@services/insightContentService';
import type { CreditLedgerReason } from '@models/CreditLedgerModel';

// Canonical shapes for the Socket.io events the API emits. Mirrored by the
// OpenAPI schemas in middleware/swagger/schemas.ts so client codegen gets
// the same union — the two must stay in sync. If you add or change a
// variant here, update the matching schema (and vice versa).

// ── job:started ───────────────────────────────────────────

export interface JobStartedEvent {
  jobId: string;
  courseId: string;
  type: JobType;
  moduleIndex?: number;
  lessonIndex?: number;
}

// ── job:status ────────────────────────────────────────────

export interface JobStatusEvent {
  jobId: string;
  status: 'completed' | 'failed';
  error?: string | null;
  courseId: string;
  type: JobType;
  moduleIndex?: number;
  lessonIndex?: number;
}

// ── job:progress (inner writer payloads) ──────────────────

export type LessonPlaceholderType = 'quiz' | 'exercise';

export interface LessonPlaceholderBlock {
  id: string;
  type: LessonPlaceholderType;
  order: number;
}

export type LessonProgressEvent =
  | { type: 'block'; block: ILessonBlock }
  | { type: 'hero_image'; url: string; s3Key?: string }
  | { type: 'content_ready'; placeholders: LessonPlaceholderBlock[] }
  | { type: 'insight'; insight: GeneratedInsight }
  | { type: 'insights_saved'; count: number }
  | { type: 'narration_started' }
  | { type: 'narration_ready'; cached: boolean; voiceId: string };

// ── job:progress (outer envelope) ─────────────────────────

export interface JobProgressEvent {
  jobId: string;
  courseId: string;
  type: JobType;
  moduleIndex?: number;
  lessonIndex?: number;
  event: LessonProgressEvent;
}

// Writer function injected into LangGraph agent nodes via
// `config.configurable.writer`. Nodes call it to emit progress — the lesson
// generation path threads it through `trackingWriter` in jobRunner, which
// fans it out to Socket.io (via jobSocketBridge) and to debounced DB saves.
export type LessonProgressWriter = (event: LessonProgressEvent) => void;

// ── credits:updated ───────────────────────────────────────

export interface CreditsUpdatedEvent {
  allowance: number;
  bonus: number;
  total: number;
  /** Signed delta that caused the update (for nudging UI toast/animation). */
  delta: number;
  reason: CreditLedgerReason;
  /** Optional: actionType when reason is debit/refund. */
  actionType?: string;
}
