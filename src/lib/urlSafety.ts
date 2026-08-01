/**
 * Shared SSRF predicate for every outbound fetch of a user-influenced URL.
 *
 * Lives in its own module rather than in `jinaReader` because the
 * rights-reservation gate (`services/urlReservationCheck`) needs the same
 * predicate, and `jinaReader` now calls the gate — importing the predicate
 * back out of `jinaReader` would make that a cycle.
 *
 * Rejects schemes other than http(s), loopback, and the RFC1918 / link-local
 * ranges. `lessonGeneration/links/fetchContent.ts` keeps its own byte-identical
 * copy for the link-judging batch path; if a range is ever added here, add it
 * there too.
 */
export const isSafeHttpsUrl = (raw: string): boolean => {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    if (!host) return false;
    if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return false;
    if (/^127\./.test(host)) return false;
    if (/^10\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (/^169\.254\./.test(host)) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
};
