import type {
  CourseData,
  ILessonContent,
  LessonContentStats,
  ModuleQuizForLearner,
  QuizAttemptResult,
} from './types';
import type { GetInsightQueueResult, InsightStats } from '@services/insightQueueService';
import type { GradeResult } from '@services/insightGradingService';
import type { InsightMode, InsightRating } from '@lib/insightConstants';
import type { IUserInsightProgress } from '@models/UserInsightProgressModel';

interface ApiResponse<T = unknown> {
  data: T;
  message?: string;
}

interface JobStatus {
  status: 'pending' | 'processing' | 'completed' | 'failed';
  type: string;
  error: string | null;
  courseId: string;
}

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 300_000; // 5 minutes
export const LESSON_POLL_TIMEOUT_MS = 600_000; // 10 minutes — lesson generation is slow
/**
 * 10 minutes. Quiz + structure generation both invoke `withRetry` (3 retries,
 * exponential backoff) around a Sonnet call with a 120s per-attempt timeout,
 * so worst-case server time is ~4×120s + backoff ≈ 8 min. Bump to 10 min so
 * the client doesn't time out mid-retry — a real failure now surfaces as
 * `Job failed:` with the actual error, not `timed out after 300s`.
 * Structure generation additionally does a second full generation pass via
 * Phase 4's cap-retry, so the headroom is genuinely needed.
 */
export const WITH_RETRY_POLL_TIMEOUT_MS = 600_000;

export function createApiClient({ baseUrl, token }: { baseUrl: string; token: string }) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  async function request<T>({ method, path, body }: { method: string; path: string; body?: unknown }): Promise<ApiResponse<T>> {
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      // Try to parse structured JSON error bodies so callers can branch on
      // `code` (e.g. DEPTH_OVERRIDE_REQUIRES_ACK). Fall back to the string
      // body for plain-text errors.
      let parsedBody: unknown = text;
      try {
        parsedBody = JSON.parse(text);
      } catch {
        /* non-JSON body — keep text as-is */
      }
      const err = new Error(`${method} ${path} → ${res.status}: ${text}`) as Error & {
        status: number;
        data: unknown;
      };
      err.status = res.status;
      err.data = parsedBody;
      throw err;
    }

    // DELETE endpoints (e.g. /api/auth/delete-account) return JSON, but future
    // 204-style responses would have empty bodies. Guard by content-length.
    if (res.status === 204 || res.headers.get('content-length') === '0') {
      return { data: undefined as unknown as T };
    }

    return res.json() as Promise<ApiResponse<T>>;
  }

  async function pollJob({ jobId, timeoutMs = POLL_TIMEOUT_MS }: { jobId: string; timeoutMs?: number }): Promise<JobStatus> {
    const deadline = Date.now() + timeoutMs;
    let iterations = 0;

    while (Date.now() < deadline) {
      iterations++;
      const { data } = await request<JobStatus>({ method: 'GET', path: `/api/course/job/${jobId}` });

      if (data.status === 'completed') return data;
      if (data.status === 'failed') {
        throw new Error(`Job ${jobId} failed: ${data.error ?? 'unknown error'}`);
      }

      await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(`Job ${jobId} timed out after ${timeoutMs / 1000}s (${iterations} polls)`);
  }

  async function postSSE({ path, body }: { path: string; body: unknown }): Promise<string> {
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST SSE ${path} → ${res.status}: ${text}`);
    }

    let fullText = '';
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') continue;
        try {
          const event = JSON.parse(payload);
          if (event.type === 'text-delta') fullText += event.delta;
        } catch {
          // ignore parse errors for non-JSON SSE lines
        }
      }
    }

    return fullText;
  }

  return {
    post: <T = unknown>({ path, body }: { path: string; body?: unknown }) => request<T>({ method: 'POST', path, body }),
    get: <T = unknown>(path: string) => request<T>({ method: 'GET', path }),
    patch: <T = unknown>({ path, body }: { path: string; body: unknown }) => request<T>({ method: 'PATCH', path, body }),
    pollJob,
    postSSE,

    async createCourse(goal: string): Promise<string> {
      const { data } = await request<{ courseId: string }>({ method: 'POST', path: '/api/course', body: { goal } });
      return data.courseId;
    },

    async getCourse(courseId: string): Promise<CourseData> {
      const { data } = await request<CourseData>({ method: 'GET', path: `/api/course/${courseId}` });
      return data;
    },

    async submitJob({ courseId, path }: { courseId: string; path: string }): Promise<string> {
      const { data } = await request<{ jobId: string }>({ method: 'POST', path: `/api/course/${courseId}/${path}`, body: {} });
      return data.jobId;
    },

    async updateCourse({ courseId, updates }: { courseId: string; updates: Record<string, unknown> }): Promise<CourseData> {
      const { data } = await request<CourseData>({ method: 'PATCH', path: `/api/course/${courseId}`, body: updates });
      return data;
    },

    async generateLesson({
      courseId,
      moduleIndex,
      lessonIndex,
      includeImage,
      includeLinks,
    }: {
      courseId: string;
      moduleIndex: number;
      lessonIndex: number;
      includeImage?: boolean;
      includeLinks?: boolean;
    }): Promise<string> {
      const { data } = await request<{ jobId: string }>({
        method: 'POST',
        path: `/api/course/${courseId}/generate-lesson`,
        body: { moduleIndex, lessonIndex, includeImage, includeLinks },
      });
      return data.jobId;
    },

    async getLessonContent({ courseId, moduleIndex, lessonIndex }: { courseId: string; moduleIndex: number; lessonIndex: number }): Promise<ILessonContent> {
      const { data } = await request<ILessonContent>({
        method: 'GET',
        path: `/api/course/${courseId}/lesson-content/${moduleIndex}/${lessonIndex}`,
      });
      return data;
    },

    async getLessonContentStats({
      courseId,
      moduleIndex,
      lessonIndex,
    }: {
      courseId: string;
      moduleIndex: number;
      lessonIndex: number;
    }): Promise<LessonContentStats> {
      const { data } = await request<LessonContentStats>({
        method: 'GET',
        path: `/api/course/${courseId}/lesson-content/${moduleIndex}/${lessonIndex}/stats`,
      });
      return data;
    },

    async completeLessonProgress({ courseId, moduleIndex, lessonIndex }: { courseId: string; moduleIndex: number; lessonIndex: number }): Promise<void> {
      await request({
        method: 'POST',
        path: `/api/course/${courseId}/progress/${moduleIndex}/${lessonIndex}`,
        body: { status: 'completed' },
      });
    },

    // ── Module quiz ─────────────────────────────────────
    async generateModuleQuiz({ courseId, moduleIndex }: { courseId: string; moduleIndex: number }): Promise<string> {
      const { data } = await request<{ jobId: string }>({
        method: 'POST',
        path: `/api/course/${courseId}/module-quiz/${moduleIndex}/generate`,
        body: {},
      });
      return data.jobId;
    },

    async getModuleQuiz({ courseId, moduleIndex }: { courseId: string; moduleIndex: number }): Promise<ModuleQuizForLearner> {
      const { data } = await request<ModuleQuizForLearner>({
        method: 'GET',
        path: `/api/course/${courseId}/module-quiz/${moduleIndex}`,
      });
      return data;
    },

    async submitModuleQuiz({
      courseId,
      moduleIndex,
      responses,
    }: {
      courseId: string;
      moduleIndex: number;
      responses: { questionId: string; selectedOption: number }[];
    }): Promise<QuizAttemptResult> {
      const { data } = await request<QuizAttemptResult>({
        method: 'POST',
        path: `/api/course/${courseId}/module-quiz/${moduleIndex}/submit`,
        body: { responses },
      });
      return data;
    },

    // ── Insights ────────────────────────────────────────
    async getInsightQueue(): Promise<GetInsightQueueResult> {
      const { data } = await request<GetInsightQueueResult>({ method: 'GET', path: '/api/insight/queue' });
      return data;
    },

    async getInsightStats(): Promise<InsightStats> {
      const { data } = await request<InsightStats>({ method: 'GET', path: '/api/insight/stats' });
      return data;
    },

    async setInsightMode({ insightId, mode }: { insightId: string; mode: InsightMode }): Promise<{ mode: InsightMode }> {
      const { data } = await request<{ mode: InsightMode }>({
        method: 'POST',
        path: `/api/insight/${insightId}/mode`,
        body: { mode },
      });
      return data;
    },

    async gradeInsight({ insightId, userAnswer }: { insightId: string; userAnswer: string }): Promise<GradeResult> {
      const { data } = await request<GradeResult>({
        method: 'POST',
        path: `/api/insight/${insightId}/grade`,
        body: { userAnswer },
      });
      return data;
    },

    async rateInsight({
      insightId,
      rating,
      typedMatch,
    }: {
      insightId: string;
      rating: InsightRating;
      typedMatch?: number | null;
    }): Promise<Pick<IUserInsightProgress, 'box' | 'state' | 'reps' | 'lapses' | 'nextDue' | 'lastReview'>> {
      const body: { rating: InsightRating; typedMatch?: number | null } = { rating };
      if (typedMatch !== undefined) body.typedMatch = typedMatch;
      const { data } = await request<Pick<IUserInsightProgress, 'box' | 'state' | 'reps' | 'lapses' | 'nextDue' | 'lastReview'>>({
        method: 'POST',
        path: `/api/insight/${insightId}/rate`,
        body,
      });
      return data;
    },

    async skipInsight({ insightId }: { insightId: string }): Promise<{ nextDue: Date }> {
      const { data } = await request<{ nextDue: Date }>({
        method: 'POST',
        path: `/api/insight/${insightId}/skip`,
        body: {},
      });
      return data;
    },

    // ── Auth (account teardown) ─────────────────────────
    async deleteAccount({ password }: { password: string }): Promise<void> {
      await request({
        method: 'DELETE',
        path: '/api/auth/delete-account',
        body: { password },
      });
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function authenticate({ baseUrl, email, password }: { baseUrl: string; email: string; password: string }): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/signin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Authentication failed (${res.status}): ${text}`);
  }

  const body = (await res.json()) as { data: string };
  return body.data;
}

/**
 * POST /api/auth/signup. Returns the JWT directly (the signup controller
 * issues a token before email verification — see the `⚠` comment in
 * `signUp.ts`). For the debug orchestrator this is convenient: we use the
 * signup-response token throughout the persona flow without a signin
 * round-trip, and flip `emailVerified=true` directly in Mongo so the
 * `requireVerified` middleware lets feature routes through.
 */
export async function signup({ baseUrl, email, password }: { baseUrl: string; email: string; password: string }): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Signup failed (${res.status}): ${text}`);
  }

  const body = (await res.json()) as { data: string };
  return body.data;
}
