/**
 * Contract tests for the course-from-documents constants. The OpenAPI
 * schemas spread these `as const` arrays (schemas.ts) and the Mongoose
 * models spread them into enum validators, so the exact member sets ARE
 * the wire contract — a rename or removal here is a breaking change for
 * every consumer, and codegen only surfaces it after the fact.
 *
 * Run: yarn test constants
 */

import { describe, test, expect } from 'vitest';
import {
  COURSE_SOURCES,
  JOB_TYPES,
  SOURCE_ANALYSIS_MODES,
  SOURCE_CHUNK_TYPES,
  SOURCE_DOCUMENT_KINDS,
  SOURCE_DOCUMENT_STATUSES,
  SOURCE_FIDELITIES,
} from '@lib/constants';

describe('source-document constants', () => {
  test('SOURCE_DOCUMENT_STATUSES is the exact lifecycle set', () => {
    expect(SOURCE_DOCUMENT_STATUSES).toEqual([
      'uploaded',
      'parsing',
      'parsed',
      'rejected',
      'failed',
    ]);
  });

  test('SOURCE_FIDELITIES is the exact fidelity-dial set', () => {
    expect(SOURCE_FIDELITIES).toEqual(['strict', 'guided', 'enrich']);
  });

  test('SOURCE_DOCUMENT_KINDS is the exact kind set', () => {
    expect(SOURCE_DOCUMENT_KINDS).toEqual(['file', 'url']);
  });

  test('SOURCE_CHUNK_TYPES is the exact chunk-type set', () => {
    expect(SOURCE_CHUNK_TYPES).toEqual(['text', 'table', 'figure']);
  });

  test('COURSE_SOURCES is the exact course-origin set', () => {
    expect(COURSE_SOURCES).toEqual(['documents']);
  });

  test('SOURCE_ANALYSIS_MODES is the exact assessment-mode set', () => {
    expect(SOURCE_ANALYSIS_MODES).toEqual(['source_only', 'needs_supplement', 'multi_course']);
  });
});

describe('JOB_TYPES', () => {
  test('keeps the 10 pre-existing types unchanged, in order', () => {
    expect(JOB_TYPES.slice(0, 10)).toEqual([
      'clarify',
      'generate_structure',
      'refine_structure',
      'generate_lesson',
      'generate_depth_previews',
      'generate_module_quiz',
      'regenerate_hero',
      'regenerate_links',
      'regenerate_recall',
      'lesson_narration',
    ]);
  });

  test('appends ingest_documents and prepare_corpus (12 total)', () => {
    expect(JOB_TYPES).toContain('ingest_documents');
    expect(JOB_TYPES).toContain('prepare_corpus');
    expect(JOB_TYPES).toHaveLength(12);
  });
});
