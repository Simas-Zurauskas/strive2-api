/**
 * Structural net over EVERY router, with no HTTP and no database.
 *
 * The per-router wiring files each drive a hand-written table of routes.
 * That table cannot know about a route added tomorrow — which is exactly when
 * the mistake happens. This file walks `router.stack` instead, so it sees
 * every route the moment it is registered, and fails on the two shapes that
 * are invisible in review:
 *
 *   1. **A route registered ABOVE its router's `router.use(...)` gate.** In
 *      Express the gate applies to layers registered after it, so a route
 *      added at the top of the file — the natural place to put a new one —
 *      is silently PUBLIC on a router where every other route is protected.
 *      Nothing about the code looks wrong.
 *   2. **A parameterised path registered before a static path it swallows.**
 *      `GET /:id` before `GET /favorites` means `/favorites` never reaches
 *      its own handler; it reaches the course-fetch handler with
 *      `id="favorites"` and returns "course not found". No 404, no 500, no
 *      alarm — just an endpoint that quietly stopped existing.
 *
 * Cheap (milliseconds, no fixtures) and it is the file that catches what the
 * per-router HTTP tests structurally cannot.
 *
 * Run: yarn test routeTable
 */

import { describe, test, expect } from 'vitest';
import type { Router } from 'express';
import { adminRoutes } from '@routes/adminRoutes';
import { authRoutes } from '@routes/authRoutes';
import { billingRoutes } from '@routes/billingRoutes';
import { courseRoutes } from '@routes/courseRoutes';
import { devRoutes } from '@routes/devRoutes';
import { gamificationRoutes } from '@routes/gamificationRoutes';
import { productKbRoutes } from '@routes/productKbRoutes';
import { recallRoutes } from '@routes/recallRoutes';
import { usageRoutes } from '@routes/usageRoutes';
import { protect, requireAdmin, requireVerified } from '@middleware/authMiddleware';

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  handle: unknown;
}
const layersOf = (router: Router): Layer[] => (router as unknown as { stack: Layer[] }).stack;

/** The eight routers mounted under `/api/*` in `src/index.ts`. */
const API_ROUTERS: [string, Router][] = [
  ['/api/auth', authRoutes],
  ['/api/billing', billingRoutes],
  ['/api/course', courseRoutes],
  ['/api/gamification', gamificationRoutes],
  ['/api/recall', recallRoutes],
  ['/api/product-kb', productKbRoutes],
  ['/api/usage', usageRoutes],
  ['/api/admin', adminRoutes],
];

/** Routers whose gate is router-wide, and the gates each one must carry. */
const GATED_ROUTERS: [string, Router, unknown[]][] = [
  ['courseRoutes', courseRoutes, [protect, requireVerified]],
  ['recallRoutes', recallRoutes, [protect, requireVerified]],
  ['gamificationRoutes', gamificationRoutes, [protect, requireVerified]],
  ['usageRoutes', usageRoutes, [protect, requireVerified, requireAdmin]],
  ['adminRoutes', adminRoutes, [protect, requireVerified, requireAdmin]],
];

describe('every gated router registers its gate BEFORE any route', () => {
  test.each(GATED_ROUTERS)('%s', (_name, router, gates) => {
    const layers = layersOf(router);
    const firstRouteIdx = layers.findIndex((l) => l.route);
    expect(firstRouteIdx).toBeGreaterThan(0);

    let previous = -1;
    for (const gate of gates) {
      const idx = layers.findIndex((l) => !l.route && l.handle === gate);
      expect(idx, 'gate is not mounted on this router at all').toBeGreaterThanOrEqual(0);
      expect(idx, 'gate is registered after the first route — routes above it are public').toBeLessThan(firstRouteIdx);
      // Order matters: protect → requireVerified → requireAdmin. A flipped
      // pair changes which status a caller sees and, for requireAdmin before
      // protect, would dereference an unset req.userId.
      expect(idx).toBeGreaterThan(previous);
      previous = idx;
    }
  });
});

describe('no parameterised path shadows a static path registered after it', () => {
  /** `/:courseId/documents/ingest` → /^\/[^/]+\/documents\/ingest$/ */
  const toMatcher = (path: string) =>
    new RegExp(
      `^${path
        .split('/')
        .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('/')}$`,
    );

  /** A concrete URL this route would be reached by: `:param` → a sentinel. */
  const sampleOf = (path: string) =>
    path
      .split('/')
      .map((seg) => (seg.startsWith(':') ? '__param__' : seg))
      .join('/');

  const ALL_ROUTERS: [string, Router][] = [...API_ROUTERS, ['/dev', devRoutes]];

  test.each(ALL_ROUTERS)('%s', (_mount, router) => {
    const routes = layersOf(router)
      .filter((l) => l.route)
      .map((l) => ({ path: l.route!.path, methods: Object.keys(l.route!.methods) }));

    const shadowed: string[] = [];
    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        if (routes[i].path === routes[j].path) continue;
        const sharedMethod = routes[i].methods.some((m) => routes[j].methods.includes(m));
        if (!sharedMethod) continue;
        if (toMatcher(routes[i].path).test(sampleOf(routes[j].path))) {
          shadowed.push(`${routes[i].path} (registered first) swallows ${routes[j].path}`);
        }
      }
    }
    expect(shadowed).toEqual([]);
  });

  test('the shadow detector actually detects — a deliberately mis-ordered pair is caught', () => {
    // Guards the detector itself: an empty result above must mean "no
    // shadowing", not "the matcher never matches anything".
    expect(toMatcher('/:id').test(sampleOf('/favorites'))).toBe(true);
    expect(toMatcher('/:courseId/documents/:documentId').test(sampleOf('/:courseId/documents/ingest'))).toBe(true);
    expect(toMatcher('/favorites').test(sampleOf('/:id'))).toBe(false);
    expect(toMatcher('/job/:jobId').test(sampleOf('/:id'))).toBe(false);
  });
});

describe('the route module inventory', () => {
  test('all eight /api/* routers exist and are Express routers', () => {
    expect(API_ROUTERS).toHaveLength(8);
    for (const [mount, router] of API_ROUTERS) {
      expect(typeof router, `${mount} is not a router`).toBe('function');
      expect(Array.isArray(layersOf(router)), `${mount} has no layer stack`).toBe(true);
    }
  });

  test('the mount paths are unique and all under /api/', () => {
    const mounts = API_ROUTERS.map(([m]) => m);
    expect(new Set(mounts).size).toBe(mounts.length);
    for (const m of mounts) expect(m.startsWith('/api/')).toBe(true);
  });

  test('devRoutes is the ninth module and is NOT under /api/ — it is mounted at /dev, non-production only', () => {
    expect(typeof devRoutes).toBe('function');
    expect(API_ROUTERS.map(([, r]) => r)).not.toContain(devRoutes);
  });

  test('every router registers at least one route', () => {
    for (const [mount, router] of [...API_ROUTERS, ['/dev', devRoutes] as [string, Router]]) {
      expect(layersOf(router).filter((l) => l.route).length, `${mount} registers no routes`).toBeGreaterThan(0);
    }
  });
});
