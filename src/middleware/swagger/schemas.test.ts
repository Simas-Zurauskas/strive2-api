/**
 * Contract tests for the course-from-documents OpenAPI schemas. Two
 * things are pinned here that the type system cannot check:
 *
 * 1. The `document_status` LessonProgressEvent variant is hand-mirrored
 *    from api/src/types/socketEvents.ts in THREE places (variant schema,
 *    oneOf $ref list, discriminator.mapping) — drift is silent until a
 *    client codegen diff, so the mirror is asserted directly.
 * 2. SourceDocument is the client-facing shape: it must never expose
 *    s3Key / sha256 / parsedS3Key (storage internals), and its enums
 *    must spread the runtime constants rather than restate them.
 *
 * Run: yarn test schemas
 */

import { describe, test, expect } from 'vitest';
import type { OpenAPIV3 } from 'openapi-types';
import { schemas } from '@middleware/swagger/schemas';
import {
  SOURCE_ANALYSIS_MODES,
  SOURCE_DOCUMENT_KINDS,
  SOURCE_DOCUMENT_STATUSES,
  SOURCE_FIDELITIES,
} from '@lib/constants';
import { ERROR_CODES } from '@middleware/errorMiddleware';

describe('source-document enum schemas spread the runtime constants', () => {
  test.each([
    ['SourceDocumentStatus', SOURCE_DOCUMENT_STATUSES],
    ['SourceDocumentKind', SOURCE_DOCUMENT_KINDS],
    ['SourceFidelity', SOURCE_FIDELITIES],
    ['SourceAnalysisMode', SOURCE_ANALYSIS_MODES],
  ] as const)('%s', (name, members) => {
    expect(schemas[name]?.enum).toEqual([...members]);
  });

  test('ErrorCode schema carries the four new document codes', () => {
    for (const code of [
      'CONTENT_REJECTED',
      'UNSUPPORTED_FILE_TYPE',
      'DOCUMENT_LIMIT_EXCEEDED',
      'DOCUMENT_EXTRACTION_FAILED',
    ]) {
      expect(ERROR_CODES).toContain(code);
      expect(schemas.ErrorCode?.enum).toContain(code);
    }
  });
});

describe('SourceDocument response schema', () => {
  test('exposes only the client-facing fields — no storage internals', () => {
    const props = schemas.SourceDocument?.properties ?? {};
    for (const field of ['id', 'kind', 'filename', 'mimeType', 'byteSize', 'status', 'rejectionReason', 'pageCount', 'warnings', 'createdAt']) {
      expect(props, `expected field ${field}`).toHaveProperty(field);
    }
    for (const secret of ['s3Key', 'sha256', 'parsedS3Key', 'userId']) {
      expect(props).not.toHaveProperty(secret);
    }
  });
});

describe('SourceAnalysis schema', () => {
  test('has the coarse client-facing shape', () => {
    const props = schemas.SourceAnalysis?.properties ?? {};
    for (const field of ['topics', 'sizeBand', 'teachableDensity', 'suggestedGoal', 'questions', 'warnings', 'perDocument']) {
      expect(props, `expected field ${field}`).toHaveProperty(field);
    }
    const sizeBand = props.sizeBand as OpenAPIV3.SchemaObject;
    for (const field of ['minLessons', 'maxLessons', 'mode']) {
      expect(sizeBand.properties, `expected sizeBand.${field}`).toHaveProperty(field);
    }
  });
});

describe('document_status LessonProgressEvent mirror (3 hand-edits)', () => {
  const variantRef = '#/components/schemas/LessonProgressDocumentStatusEvent';

  test('the variant schema exists, discriminated on type', () => {
    const variant = schemas.LessonProgressDocumentStatusEvent;
    expect(variant).toBeDefined();
    const props = variant?.properties ?? {};
    expect((props.type as OpenAPIV3.SchemaObject)?.enum).toEqual(['document_status']);
    expect(props).toHaveProperty('documentId');
    expect(props).toHaveProperty('status');
    expect(props).toHaveProperty('warnings');
    expect(variant?.required).toEqual(['type', 'documentId', 'status']);
  });

  test('the oneOf list includes the variant $ref', () => {
    const union = schemas.LessonProgressEvent as unknown as { oneOf: { $ref: string }[] };
    expect(union.oneOf.map((r) => r.$ref)).toContain(variantRef);
  });

  test('the discriminator mapping routes document_status to the variant', () => {
    const union = schemas.LessonProgressEvent as unknown as {
      discriminator: { propertyName: string; mapping: Record<string, string> };
    };
    expect(union.discriminator.propertyName).toBe('type');
    expect(union.discriminator.mapping.document_status).toBe(variantRef);
  });

  test('the 7 pre-existing variants are untouched', () => {
    const union = schemas.LessonProgressEvent as unknown as {
      oneOf: { $ref: string }[];
      discriminator: { mapping: Record<string, string> };
    };
    for (const existing of [
      'block',
      'hero_image',
      'content_ready',
      'recall_card',
      'recall_cards_saved',
      'narration_started',
      'narration_ready',
    ]) {
      expect(union.discriminator.mapping).toHaveProperty(existing);
    }
    expect(union.oneOf).toHaveLength(8);
  });
});
