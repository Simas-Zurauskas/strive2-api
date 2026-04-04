import type { CourseData } from './types';

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

export function createApiClient(baseUrl: string, token: string) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  async function request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${method} ${path} → ${res.status}: ${text}`);
    }

    return res.json() as Promise<ApiResponse<T>>;
  }

  async function pollJob(jobId: string): Promise<JobStatus> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let iterations = 0;

    while (Date.now() < deadline) {
      iterations++;
      const { data } = await request<JobStatus>('GET', `/api/course/job/${jobId}`);

      if (data.status === 'completed') return data;
      if (data.status === 'failed') {
        throw new Error(`Job ${jobId} failed: ${data.error ?? 'unknown error'}`);
      }

      await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(`Job ${jobId} timed out after ${POLL_TIMEOUT_MS / 1000}s (${iterations} polls)`);
  }

  async function postSSE(path: string, body: unknown): Promise<string> {
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
    post: <T = unknown>(path: string, body?: unknown) => request<T>('POST', path, body),
    get: <T = unknown>(path: string) => request<T>('GET', path),
    patch: <T = unknown>(path: string, body: unknown) => request<T>('PATCH', path, body),
    pollJob,
    postSSE,

    async createCourse(goal: string): Promise<string> {
      const { data } = await request<{ courseId: string }>('POST', '/api/course', { goal });
      return data.courseId;
    },

    async getCourse(courseId: string): Promise<CourseData> {
      const { data } = await request<CourseData>('GET', `/api/course/${courseId}`);
      return data;
    },

    async submitJob(courseId: string, path: string): Promise<string> {
      const { data } = await request<{ jobId: string }>('POST', `/api/course/${courseId}/${path}`, {});
      return data.jobId;
    },

    async updateCourse(courseId: string, updates: Record<string, unknown>): Promise<CourseData> {
      const { data } = await request<CourseData>('PATCH', `/api/course/${courseId}`, updates);
      return data;
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function authenticate(baseUrl: string, email: string, password: string): Promise<string> {
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
