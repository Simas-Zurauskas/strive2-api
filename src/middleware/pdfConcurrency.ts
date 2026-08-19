import { Request, Response, NextFunction } from 'express';
import { pdfLog } from '@lib/loggers';

/**
 * GLOBAL cap on concurrent PDF renders — per process, not per user.
 *
 * A per-user rate limit is the wrong tool here and the two are not
 * interchangeable. Rendering a course PDF is CPU-bound JavaScript:
 * `pdfmake.getBuffer()` and the mermaid renderer are synchronous, so the
 * work does not yield, and this service is single-instance by design
 * (`wiki-strive/AGENTS/invariants.md`) — the same process carries every
 * Socket.io lesson stream, the in-process job runner and the in-process
 * event bus. Ten users each within their own hourly allowance can still
 * arrive at the same moment.
 *
 * Measured on this machine with the real builders, six sections of prose
 * plus maths, one production flowchart and a code block per lesson:
 *
 *   26 lessons @  8k chars  build  664ms  render 1229ms  total 1.9s  346MB RSS
 *   26 lessons @ 25k chars  build  268ms  render 1820ms  total 2.1s  494MB RSS
 *   69 lessons @ 25k chars  build  587ms  render 4322ms  total 4.9s  906MB RSS
 *
 * So the worst case is seconds of stall and ~1GB of peak RSS, not the
 * ~1s an earlier comment claimed. Serialising renders does not make any
 * single one faster, but it stops N of them stacking into an N× stall and
 * an N× memory peak, which is the difference between a slow download and
 * an unresponsive server.
 *
 * A queue was considered and rejected: holding requests open on a
 * 60-second nginx `proxy_read_timeout` (the EB default, not overridden in
 * `.platform/`) converts a stall into a timeout. Refusing fast with a 429
 * and a `Retry-After` is the honest answer, and the client already renders
 * 429s from these routes as "try again shortly".
 *
 * When the deployment splits, this in-memory counter is the thing to
 * replace — the same note applies to `streamConcurrency.ts`.
 */

const MAX_CONCURRENT_RENDERS = 2;

/** Guards against a render that never fires `close` or `finish`. */
const STALE_ENTRY_MS = 5 * 60 * 1000;

type Entry = { startedAt: number; userId: string };

/**
 * Keyed on a process-local counter, NOT on `req.id`.
 *
 * `req.id` is caller-controlled: `middleware/requestId.ts:25-27` accepts any
 * inbound `X-Request-ID` matching `^[A-Za-z0-9_-]{1,128}$`. Keying on it
 * means a client that repeats one header value overwrites its own entry on
 * every request, `active.size` never passes 1, and the gate admits
 * everything — while the first response to finish deletes the shared key out
 * from under every render still running. A counter cannot be forged.
 */
const active = new Map<number, Entry>();
let nextSlotId = 0;

const sweepStaleEntries = (): void => {
  const now = Date.now();
  for (const [id, entry] of active.entries()) {
    if (now - entry.startedAt > STALE_ENTRY_MS) {
      pdfLog.error(`concurrency:stale-release slot=${id} user=${entry.userId}`);
      active.delete(id);
    }
  }
};

const sweepHandle = setInterval(sweepStaleEntries, 60 * 1000);
sweepHandle.unref();

/**
 * Mount BEFORE a PDF controller. Releases on `close` (client disconnect)
 * or `finish` (response fully written), whichever comes first.
 */
export const limitPdfConcurrency = (req: Request, res: Response, next: NextFunction): void => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  if (active.size >= MAX_CONCURRENT_RENDERS) {
    pdfLog.info(
      `concurrency:refused active=${active.size} user=${userId} path=${req.method} ${req.originalUrl}`,
    );
    res.status(429).set('Retry-After', '30').json({
      message: 'Strive is building another PDF right now. Try again in a moment.',
    });
    return;
  }

  const id = nextSlotId++;
  active.set(id, { startedAt: Date.now(), userId });

  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    active.delete(id);
  };
  res.on('close', releaseOnce);
  res.on('finish', releaseOnce);

  next();
};

/** Test/diagnostic surface — not part of the public API. */
export const _internalsForTests = { active, sweepStaleEntries, MAX_CONCURRENT_RENDERS };
