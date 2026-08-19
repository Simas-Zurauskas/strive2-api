/**
 * The OpenAPI `paths` object is produced by `swagger-jsdoc` scanning
 * `./src/controlers/**\/*.ts` (`swagger.ts:24`) — NOT by `schemas.ts`, which
 * only supplies `components.schemas`.
 *
 * That distinction is easy to get wrong, and getting it wrong is silent on
 * this side: the api works perfectly, and the failure only appears in the
 * other repo when `yarn codegen` produces no types for the new routes and
 * `yarn build` fails on a missing index. This file makes it fail here.
 */

import { describe, test, expect } from 'vitest';
import swaggerSpec from './index';

const spec = swaggerSpec as {
  paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, unknown> }> }>>;
  components?: { schemas?: Record<string, unknown> };
};

const LESSON = '/api/course/{courseId}/lesson/{moduleIndex}/{lessonIndex}';

describe('the export routes are in the served spec', () => {
  test.each([
    ['/api/course/{courseId}/pdf', 'application/pdf'],
    [`${LESSON}/pdf`, 'application/pdf'],
    [`${LESSON}/narration/transcript`, 'text/plain'],
    [`${LESSON}/narration/download`, 'application/json'],
  ])('%s declares a 200 with %s', (path, mediaType) => {
    const op = spec.paths?.[path]?.get;
    expect(op, `missing path: ${path}`).toBeDefined();
    expect(Object.keys(op!.responses?.['200']?.content ?? {})).toContain(mediaType);
  });

  test('the narration download response schema is a registered component', () => {
    expect(spec.components?.schemas?.NarrationDownload).toBeDefined();
  });

  test('adding these did not drop any existing path', () => {
    // 88 before this task; the four new ones make 92. A regression in the
    // JSDoc of an untouched controller would show up here as a shortfall.
    expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThanOrEqual(92);
  });
});
