/**
 * Contract tests for the course-from-documents provenance fields on
 * Course. `sourceDigest` is server-only (the coarse-metadata-only rule:
 * leaking the digest through course GETs would hand out a free document
 * summarization service) — the hydrated response path must strip it in
 * `toJSON`; the lean path strips it via SERVER_ONLY_COURSE_FIELDS
 * (covered in courseDbService.test.ts). All four new fields default to
 * null so every pre-feature row keeps today's behavior.
 *
 * Run: yarn test CourseModel
 */

import { describe, test, expect } from 'vitest';
import mongoose from 'mongoose';
import CourseModel from '@models/CourseModel';
import { SOURCE_FIDELITIES } from '@lib/constants';

// No DB needed — document instantiation, validateSync and toJSON are all
// connection-free.

const base = () => ({
  userId: new mongoose.Types.ObjectId(),
  goal: 'Learn something useful',
});

describe('Course source provenance fields', () => {
  test('all four default to null (pre-feature rows unaffected)', () => {
    const course = new CourseModel(base());
    expect(course.source).toBeNull();
    expect(course.sourceFidelity).toBeNull();
    expect(course.sourceAssessment).toBeNull();
    expect(course.sourceDigest).toBeNull();
    expect(course.validateSync()).toBeUndefined();
  });

  test('accepts source documents; rejects an unknown source', () => {
    expect(new CourseModel({ ...base(), source: 'documents' }).validateSync()).toBeUndefined();
    expect(
      new CourseModel({ ...base(), source: 'telepathy' }).validateSync()?.errors.source,
    ).toBeDefined();
  });

  test.each([...SOURCE_FIDELITIES])('accepts sourceFidelity %s', (fidelity) => {
    expect(new CourseModel({ ...base(), sourceFidelity: fidelity }).validateSync()).toBeUndefined();
  });

  test('rejects an unknown sourceFidelity', () => {
    expect(
      new CourseModel({ ...base(), sourceFidelity: 'freestyle' }).validateSync()?.errors
        .sourceFidelity,
    ).toBeDefined();
  });
});

describe('Course toJSON', () => {
  test('strips sourceDigest; keeps source, sourceFidelity and sourceAssessment', () => {
    const course = new CourseModel({
      ...base(),
      source: 'documents',
      sourceFidelity: 'guided',
      sourceAssessment: { topics: ['algebra'], teachableDensity: 0.7 },
      sourceDigest: { topicTree: [{ id: 't1', spans: ['doc1:1-4'] }] },
    });
    const json = course.toJSON() as unknown as Record<string, unknown>;
    expect(json).not.toHaveProperty('sourceDigest');
    expect(json.source).toBe('documents');
    expect(json.sourceFidelity).toBe('guided');
    expect(json.sourceAssessment).toEqual({ topics: ['algebra'], teachableDensity: 0.7 });
  });

  test('a null sourceDigest is also absent — never serialized as null noise', () => {
    const json = new CourseModel(base()).toJSON() as unknown as Record<string, unknown>;
    expect(json).not.toHaveProperty('sourceDigest');
  });
});
