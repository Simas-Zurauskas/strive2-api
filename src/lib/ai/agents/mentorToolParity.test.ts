/**
 * Mentor tool-registry parity + search_user_documents behavior (Phase 5).
 *
 * The tool duplication trap (codebase-fit "Area: rag"): each mentor agent
 * declares its tools TWICE — the LangChain `TOOLS` array (execution, via
 * ToolNode) and the hand-written `ANTHROPIC_TOOLS` array (what the model
 * sees). Editing one without the other silently ships a tool the model
 * can't call or calls that can't execute. These tests pin name parity for
 * BOTH agents so any future drift fails CI.
 *
 * Also pins the search_user_documents tool contract: untrusted-snippet
 * wrapping on hits, the honest empty-note on goal courses (empty corpus),
 * and the missing-context error.
 *
 * Run: yarn test mentorToolParity
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { searchMock } = vi.hoisted(() => ({ searchMock: vi.fn() }));

vi.mock('@services/sourceDocRagService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@services/sourceDocRagService')>();
  return { ...actual, searchSourceDocuments: searchMock };
});

import { TOOLS as LESSON_TOOLS, searchUserDocumentsTool } from './lessonMentor/tools';
import { ANTHROPIC_TOOLS as LESSON_ANTHROPIC_TOOLS } from './lessonMentor/nodes/chat';
import { TOOLS as COURSE_TOOLS } from './courseMentor/tools';
import { ANTHROPIC_TOOLS as COURSE_ANTHROPIC_TOOLS } from './courseMentor/nodes/chat';

beforeEach(() => {
  searchMock.mockReset();
});

describe('tool-name parity — LangChain TOOLS vs hand-written ANTHROPIC_TOOLS', () => {
  test('lesson mentor: both arrays declare the same tool names', () => {
    const langchainNames = LESSON_TOOLS.map((t) => t.name).sort();
    const anthropicNames = LESSON_ANTHROPIC_TOOLS.map((t) => t.name).sort();
    expect(anthropicNames).toEqual(langchainNames);
  });

  test('course mentor: both arrays declare the same tool names', () => {
    const langchainNames = COURSE_TOOLS.map((t) => t.name).sort();
    const anthropicNames = COURSE_ANTHROPIC_TOOLS.map((t) => t.name).sort();
    expect(anthropicNames).toEqual(langchainNames);
  });

  test('search_user_documents is registered in both agents', () => {
    expect(LESSON_TOOLS.map((t) => t.name)).toContain('search_user_documents');
    expect(LESSON_ANTHROPIC_TOOLS.map((t) => t.name)).toContain('search_user_documents');
    expect(COURSE_TOOLS.map((t) => t.name)).toContain('search_user_documents');
    expect(COURSE_ANTHROPIC_TOOLS.map((t) => t.name)).toContain('search_user_documents');
  });
});

describe('search_user_documents tool behavior', () => {
  test('goal course (empty corpus) → empty-note JSON, the honest idiom', async () => {
    searchMock.mockResolvedValue([]);
    const raw = await searchUserDocumentsTool.invoke(
      { query: 'what do my notes say about entropy' },
      { configurable: { courseId: 'course-1' } },
    );
    const parsed = JSON.parse(raw as string) as { results: unknown[]; note: string };
    expect(parsed.results).toEqual([]);
    expect(parsed.note).toMatch(/not created from documents|not been ingested/);
    expect(searchMock).toHaveBeenCalledWith('course-1', 'what do my notes say about entropy', { topK: 5 });
  });

  test('hits are wrapped as untrusted snippets (topK 5, 1200-char slice)', async () => {
    searchMock.mockResolvedValue([
      {
        documentId: 'd1',
        chunkIndex: 0,
        chunkType: 'text',
        headingPath: ['Ch 1', 'Energy'],
        pageRange: { start: 3, end: 4 },
        text: 'y'.repeat(1500),
        score: 0.87654,
      },
    ]);
    const raw = await searchUserDocumentsTool.invoke(
      { query: 'energy' },
      { configurable: { courseId: 'course-1' } },
    );
    const parsed = JSON.parse(raw as string) as {
      origin: string;
      trust: string;
      results: Array<{ text: string; _untrusted?: boolean; heading: string; pages?: string }>;
    };
    expect(parsed.origin).toBe('rag:user-doc');
    expect(parsed.trust).toBe('untrusted');
    expect(parsed.results[0]._untrusted).toBe(true);
    expect(parsed.results[0].heading).toBe('Ch 1 > Energy');
    expect(parsed.results[0].pages).toBe('3-4');
    // 1200-char slice + ellipsis before wrapping.
    expect(parsed.results[0].text.length).toBeLessThanOrEqual(1210);
  });

  test('missing courseId in tool context → error JSON, no search', async () => {
    const raw = await searchUserDocumentsTool.invoke({ query: 'anything' }, { configurable: {} });
    expect(JSON.parse(raw as string)).toMatchObject({ error: expect.stringContaining('courseId') });
    expect(searchMock).not.toHaveBeenCalled();
  });
});
