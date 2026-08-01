import { lookup } from 'node:dns/promises';
import { isSafeHttpsUrl } from '@lib/urlSafety';
import { integrationLog } from '@lib/loggers';

/**
 * Pre-fetch rights-reservation gate for user-supplied URLs.
 *
 * WHY THIS EXISTS (legal, not cosmetic). Fetching a page server-side is
 * *our* reproduction, and the only exception that covers it in the EU is
 * DSM Art. 4 (general TDM) — which is disapplied the moment the
 * rightsholder has expressly reserved the use "in an appropriate manner,
 * such as machine-readable means". Ignoring a machine-readable
 * reservation therefore does not breach the signal; it removes our only
 * defence and leaves a bare unlicensed copy. So the two signals a
 * reasonable 2026 implementer is expected to read are read here, BEFORE
 * anything fetches the page:
 *
 *   1. `/robots.txt`               — RFC 9309, matched against our own
 *                                    declared product token.
 *   2. `/.well-known/tdmrep.json` — W3C TDM Reservation Protocol.
 *
 * `Content-Signal:` (Cloudflare, Sept 2025) is deliberately NOT read: it
 * is a per-URL *response* header, invisible without fetching the page we
 * are deciding whether to fetch, and incompatible with a per-host cache.
 * Recorded as a known limitation (plan §7 deferred).
 *
 * ── Verdict split (plan A9) ─────────────────────────────────
 * Getting this backwards refuses nearly every real URL, so it is spelled
 * out rather than left to the reader:
 *
 *   | Signal                             | Verdict          |
 *   |------------------------------------|------------------|
 *   | no robots.txt (404/4xx) + no tdm   | ALLOW            |
 *   | robots.txt with no matching rule   | ALLOW            |
 *   | tdmrep with `tdm-reservation: 0`   | ALLOW            |
 *   | `Disallow` matching our UA or `*`  | BLOCK            |
 *   | tdmrep reservation over the path   | BLOCK            |
 *   | 429 / 5xx / timeout / net error    | BLOCK fail-closed|
 *   | robots.txt past the body cap       | BLOCK fail-closed|
 *   | malformed tdmrep JSON document     | BLOCK fail-closed|
 *   | host unsafe or resolves private    | BLOCK            |
 *
 * An ABSENT document is not a reservation (RFC 9309 §2.3.1.3 treats a 4xx
 * as "unavailable ⇒ allow all"). An UNDECIDABLE answer is: we cannot say
 * we honoured a reservation we never managed to read, so we do not fetch
 * (`resilience.md` §11 — the failure direction of a gate is a decision,
 * and this gate's direction differs by signal *on purpose*).
 *
 * ── SSRF posture ────────────────────────────────────────────
 * The article body still goes exclusively through Jina Reader; nothing
 * here ever dereferences the user's path. These two well-known paths are
 * fixed strings appended to the origin, and each request passes three
 * independent layers (`security.md` §5.4):
 *
 *   (a) `isSafeHttpsUrl` — scheme allowlist + literal private/loopback
 *       ranges (`lib/urlSafety`, shared with `jinaReader`);
 *   (b) resolved-address check — every A/AAAA answer must be public
 *       unicast, which is what catches a public hostname pointed at
 *       169.254.169.254 or a bracketed IPv6 ULA literal;
 *   (c) `redirect: 'manual'` with a 2-hop cap, re-running (a) and (b) on
 *       every hop, plus a 64 KB body cap and an explicit deadline.
 *
 * Residual, accepted: (b) is a pre-connect check, so a DNS answer that
 * changes between the lookup and the socket (rebinding) is not closed by
 * it. Closing that needs a pinned-address dialer; out of scope here and
 * unreachable without also defeating (a).
 *
 * ── Why not route this through the reader ────────────────────
 * `jinaReader.readUrl` collapses every non-2xx into one `http_error`, so
 * a 404 (⇒ allow) and a 503 (⇒ block) arrive indistinguishable — the A9
 * split is not expressible through it. It also bills per call and returns
 * main-content *extraction*, which is not a faithful robots.txt or JSON
 * document. Hence a direct, capped request to two fixed paths.
 */

// ── Public contract ───────────────────────────────────────

export type ReservationSignal =
  | 'no_reservation'
  | 'robots_disallow'
  | 'tdm_reservation'
  | 'robots_unavailable'
  | 'tdm_unavailable'
  | 'tdm_malformed'
  | 'unsafe_host'
  | 'host_unresolvable';

export interface UrlReservationVerdict {
  allowed: boolean;
  /** Which machine-readable signal decided it — persisted as the audit trail. */
  signal: ReservationSignal;
  /** Category-level, operator/user-safe. NEVER derived from fetched bytes. */
  reason?: string;
  /**
   * When the reservation documents this verdict rests on were read. Equal
   * to the cache-fill time on a cached verdict, which is the honest audit
   * fact ("this is when we last read their reservation").
   */
  checkedAt: Date;
}

/** Audit pair persisted on `SourceDocument` (see the model's two fields). */
export interface UrlReservationAudit {
  signal: ReservationSignal;
  checkedAt: Date;
}

/**
 * Our declared identity. The product token is what robots.txt groups are
 * matched against; RFC 9309 matching is case-insensitive but EXACT — a
 * `User-agent: Fetch` group (Wikipedia ships one) must not capture us.
 */
export const STRIVE_FETCH_UA_TOKEN = 'StriveFetch';
export const STRIVE_FETCH_USER_AGENT = `${STRIVE_FETCH_UA_TOKEN}/1.0 (+https://strive-learning.com)`;

/** Body cap for either well-known document. */
export const RESERVATION_MAX_BYTES = 64 * 1024;
/** Redirect hops followed before failing closed. */
export const RESERVATION_MAX_REDIRECTS = 2;
/**
 * Per-request deadline. Strictly shorter than the 30 s URL snapshot fetch
 * that follows it (`resilience.md` §2.2 — inner budget under outer).
 */
export const RESERVATION_FETCH_TIMEOUT_MS = 5_000;
/** Successful (decided) documents are re-read at most once a day per host. */
export const RESERVATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Fail-closed outcomes are cached far shorter: a single 503 must not brand
 * a host unusable for a day, but a burst of URLs from one host must not
 * hammer it either.
 */
export const RESERVATION_ERROR_CACHE_TTL_MS = 5 * 60 * 1000;
/** Bounds memory on a long-lived single-instance process. */
export const RESERVATION_MAX_CACHED_HOSTS = 500;
/** Rule-count ceiling; a robots.txt past it is undecidable, not permissive. */
const ROBOTS_MAX_RULES = 2_000;

/**
 * Category-level block reasons, keyed by signal. The message shown for a
 * refusal is LOOKED UP here, never assembled from the fetched document —
 * that is what makes "no third-party content in an error" structural.
 */
export const RESERVATION_BLOCK_REASONS: Record<Exclude<ReservationSignal, 'no_reservation'>, string> = {
  robots_disallow: 'the site asks automated systems not to use this page (robots.txt)',
  tdm_reservation: 'the site reserves text-and-data-mining rights for this page (TDM reservation)',
  robots_unavailable: 'the site’s robots.txt could not be read, so its rules could not be honoured',
  tdm_unavailable: 'the site’s TDM reservation file could not be read, so it could not be honoured',
  tdm_malformed: 'the site’s TDM reservation file could not be understood, so it could not be honoured',
  unsafe_host: 'the address is not a public web host',
  host_unresolvable: 'the address could not be resolved',
};

// ── Robots.txt (RFC 9309) ─────────────────────────────────

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

interface RobotsGroup {
  tokens: string[];
  rules: RobotsRule[];
}

/**
 * Group-aware robots.txt parse. Unparseable lines are ignored (RFC 9309
 * §2.2) — which is also why a soft-404 HTML page at /robots.txt yields
 * zero rules and therefore reads as "no reservation", not as malformed.
 * Returns null when the file carries more rules than we will evaluate,
 * so the caller can fail closed instead of judging a partial file.
 */
export const parseRobotsTxt = (body: string): RobotsGroup[] | null => {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let sawRule = false;
  let ruleCount = 0;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const sep = line.indexOf(':');
    if (sep <= 0) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === 'user-agent') {
      if (!value) continue;
      // A user-agent line after rule lines starts a NEW group.
      if (!current || sawRule) {
        current = { tokens: [], rules: [] };
        groups.push(current);
        sawRule = false;
      }
      current.tokens.push(value.toLowerCase());
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') continue;
    if (!current) continue; // rule outside any group — ignored per RFC
    sawRule = true;
    // `Disallow:` with an empty value is an explicit no-op, not "block /".
    if (!value) continue;
    if (++ruleCount > ROBOTS_MAX_RULES) return null;
    current.rules.push({ allow: field === 'allow', pattern: value });
  }

  return groups;
};

/**
 * Full-match glob with `*`, iterative with a single backtrack pointer.
 * Deliberately NOT a RegExp: the pattern is third-party input, and
 * `.*`-heavy translations of a hostile robots.txt backtrack
 * catastrophically. This is O(pattern × path) worst case.
 */
const globMatches = (pattern: string, text: string): boolean => {
  let p = 0;
  let t = 0;
  let star = -1;
  let tStar = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      tStar = t;
      continue;
    }
    if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
      continue;
    }
    if (star >= 0) {
      p = star + 1;
      t = ++tStar;
      continue;
    }
    return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
};

/** RFC 9309 §2.2.2 path matching: prefix by default, `$` anchors the end. */
const ruleMatches = (pattern: string, path: string): boolean => {
  const anchored = pattern.endsWith('$');
  return globMatches(anchored ? pattern.slice(0, -1) : `${pattern}*`, path);
};

/**
 * Select the governing group (our exact product token if present, else
 * `*`; all groups naming the same token are merged) and apply
 * longest-match-wins with Allow beating Disallow on an equal-length tie.
 */
export const robotsAllows = (groups: RobotsGroup[], path: string): boolean => {
  const token = STRIVE_FETCH_UA_TOKEN.toLowerCase();
  let rules = groups.filter((g) => g.tokens.includes(token)).flatMap((g) => g.rules);
  if (rules.length === 0 && !groups.some((g) => g.tokens.includes(token))) {
    rules = groups.filter((g) => g.tokens.includes('*')).flatMap((g) => g.rules);
  }

  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(rule.pattern, path)) continue;
    if (!best || rule.pattern.length > best.pattern.length) {
      best = rule;
    } else if (rule.pattern.length === best.pattern.length && rule.allow) {
      best = rule; // tie ⇒ Allow wins
    }
  }
  return best ? best.allow : true;
};

// ── TDMRep (/.well-known/tdmrep.json) ─────────────────────

interface TdmEntry {
  /** Normalised to a leading slash. */
  location: string;
  reserved: boolean;
}

/**
 * The W3C TDMRep well-known file is a JSON ARRAY of
 * `{ location, tdm-reservation, tdm-policy? }`. Strict on purpose:
 * anything that claims to be this document but is not understandable is
 * a reservation we cannot honour, so it fails closed upstream. Returns
 * null for "not understandable".
 */
export const parseTdmRep = (body: string): TdmEntry[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const entries: TdmEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) return null;
    const record = item as Record<string, unknown>;
    const location = record.location;
    const reservation = record['tdm-reservation'];
    if (typeof location !== 'string' || !location) return null;
    if (reservation !== 0 && reservation !== 1) return null;
    entries.push({
      location: location.startsWith('/') ? location : `/${location}`,
      reserved: reservation === 1,
    });
  }
  return entries;
};

/** Longest-prefix location wins; a tie resolves conservatively to reserved. */
export const tdmReserves = (entries: TdmEntry[], path: string): boolean => {
  let best: TdmEntry | null = null;
  for (const entry of entries) {
    if (!path.startsWith(entry.location)) continue;
    if (!best || entry.location.length > best.location.length) best = entry;
    else if (entry.location.length === best.location.length && entry.reserved) best = entry;
  }
  return best?.reserved ?? false;
};

// ── Resolved-address safety (SSRF layer b) ────────────────

const V4_BLOCKED: [RegExp, string][] = [
  [/^0\./, 'this-network'],
  [/^10\./, 'private'],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, 'cgnat'],
  [/^127\./, 'loopback'],
  [/^169\.254\./, 'link-local'],
  [/^172\.(1[6-9]|2\d|3[01])\./, 'private'],
  [/^192\.0\.0\./, 'ietf-protocol'],
  [/^192\.0\.2\./, 'documentation'],
  [/^192\.88\.99\./, '6to4-relay'],
  [/^192\.168\./, 'private'],
  [/^198\.1[89]\./, 'benchmarking'],
  [/^198\.51\.100\./, 'documentation'],
  [/^203\.0\.113\./, 'documentation'],
  [/^(22[4-9]|23\d)\./, 'multicast'],
  [/^(24\d|25[0-5])\./, 'reserved'],
];

/** True only for a globally routable unicast address. */
export const isPublicUnicastAddress = (address: string): boolean => {
  const addr = address.trim().toLowerCase().split('%')[0]; // drop any zone id
  if (!addr) return false;

  if (addr.includes(':')) {
    // IPv4-mapped / NAT64-embedded: judge the embedded IPv4.
    const embedded = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
    if (embedded) return isPublicUnicastAddress(embedded[1]);
    if (addr === '::' || addr === '::1') return false;
    if (/^f[cd]/.test(addr)) return false; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(addr)) return false; // fe80::/10 link-local
    if (/^ff/.test(addr)) return false; // ff00::/8 multicast
    if (/^2001:0*db8/.test(addr)) return false; // documentation
    return true;
  }

  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr)) return false;
  return !V4_BLOCKED.some(([re]) => re.test(addr));
};

type HostSafety = 'ok' | 'unsafe_host' | 'host_unresolvable';

const resolveHostSafety = async (hostname: string): Promise<HostSafety> => {
  try {
    const answers = await lookup(hostname, { all: true });
    if (answers.length === 0) return 'host_unresolvable';
    return answers.every((a) => isPublicUnicastAddress(a.address)) ? 'ok' : 'unsafe_host';
  } catch {
    // DNS failure is undecidable, not permission (§11 fail-closed).
    return 'host_unresolvable';
  }
};

// ── The capped, redirect-bounded well-known fetch ─────────

type WellKnownResult =
  | { kind: 'body'; text: string; jsonish: boolean }
  | { kind: 'absent' } // 4xx other than 429 ⇒ the document does not exist
  | { kind: 'unavailable' } // 429 / 5xx / timeout / network / oversize / hop cap
  | { kind: 'unsafe'; safety: Exclude<HostSafety, 'ok'> };

const JSON_CONTENT_TYPE = /application\/(?:[\w.+-]+\+)?json|text\/json/i;

const readCapped = async (res: Response): Promise<{ text: string; truncated: boolean }> => {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > RESERVATION_MAX_BYTES) return { text: '', truncated: true };
  if (!res.body) return { text: '', truncated: false };

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > RESERVATION_MAX_BYTES) {
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    // Cleanup of an already-finished or abandoned stream; a throw here
    // carries no information the caller can act on.
    await reader.cancel().catch(() => undefined);
  }
  return { text: Buffer.concat(chunks).toString('utf-8'), truncated };
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const fetchWellKnown = async (origin: string, path: string): Promise<WellKnownResult> => {
  let target = `${origin}${path}`;

  for (let hop = 0; hop <= RESERVATION_MAX_REDIRECTS; hop++) {
    // Layers (a) + (b), re-run on EVERY hop — a redirect is a new host.
    if (!isSafeHttpsUrl(target)) return { kind: 'unsafe', safety: 'unsafe_host' };
    const safety = await resolveHostSafety(new URL(target).hostname);
    if (safety !== 'ok') return { kind: 'unsafe', safety };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESERVATION_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(target, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': STRIVE_FETCH_USER_AGENT,
          accept: 'text/plain, application/json;q=0.9, */*;q=0.1',
        },
      });
    } catch {
      // Timeout, reset, TLS failure — all undecidable (never "allowed").
      return { kind: 'unavailable' };
    } finally {
      clearTimeout(timer);
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location');
      if (!location) return { kind: 'unavailable' };
      try {
        target = new URL(location, target).toString();
      } catch {
        return { kind: 'unavailable' };
      }
      continue;
    }

    if (res.status === 429 || res.status >= 500) return { kind: 'unavailable' };
    // RFC 9309 §2.3.1.3: 4xx means the document is unavailable ⇒ no rules.
    if (res.status >= 400) return { kind: 'absent' };
    if (res.status < 200 || res.status >= 300) return { kind: 'unavailable' };

    const { text, truncated } = await readCapped(res);
    if (truncated) return { kind: 'unavailable' };
    return { kind: 'body', text, jsonish: JSON_CONTENT_TYPE.test(res.headers.get('content-type') ?? '') };
  }

  // Redirect budget exhausted — we never read the document.
  return { kind: 'unavailable' };
};

// ── Per-host cache ────────────────────────────────────────

type RobotsState =
  | { kind: 'groups'; groups: RobotsGroup[] }
  | { kind: 'absent' }
  | { kind: 'unavailable' };

type TdmState =
  | { kind: 'entries'; entries: TdmEntry[] }
  | { kind: 'absent' }
  | { kind: 'unavailable' }
  | { kind: 'malformed' };

type HostRecord =
  | { kind: 'unsafe'; signal: Exclude<HostSafety, 'ok'> }
  | { kind: 'checked'; robots: RobotsState; tdm: TdmState };

interface CacheEntry {
  record: HostRecord;
  checkedAt: number;
  expiresAt: number;
}

/**
 * Process-local, keyed by origin (scheme + host + port) — the scope
 * robots.txt and the well-known path are themselves defined over. The
 * service is single-instance by design, so a module-level Map is the
 * house pattern (see `links/searchCache.ts`); a second replica would
 * merely miss cache, never mis-decide.
 */
const hostCache = new Map<string, CacheEntry>();

/** Test seam — also usable as an ops lever if a host's rules change. */
export const clearReservationCacheForTest = (): void => hostCache.clear();

const evictExpiredAndOverflow = (now: number): void => {
  for (const [origin, entry] of hostCache) {
    if (entry.expiresAt <= now) hostCache.delete(origin);
  }
  if (hostCache.size <= RESERVATION_MAX_CACHED_HOSTS) return;
  const ordered = [...hostCache.entries()].sort((a, b) => a[1].checkedAt - b[1].checkedAt);
  for (let i = 0; i < hostCache.size - RESERVATION_MAX_CACHED_HOSTS; i++) hostCache.delete(ordered[i][0]);
};

const isDecided = (record: HostRecord): boolean =>
  record.kind === 'checked' &&
  (record.robots.kind === 'groups' || record.robots.kind === 'absent') &&
  (record.tdm.kind === 'entries' || record.tdm.kind === 'absent');

const loadHostRecord = async (origin: string): Promise<CacheEntry> => {
  const now = Date.now();
  const cached = hostCache.get(origin);
  if (cached && cached.expiresAt > now) return cached;

  const [robotsRes, tdmRes] = await Promise.all([
    fetchWellKnown(origin, '/robots.txt'),
    fetchWellKnown(origin, '/.well-known/tdmrep.json'),
  ]);

  let record: HostRecord;
  if (robotsRes.kind === 'unsafe' || tdmRes.kind === 'unsafe') {
    const safety = robotsRes.kind === 'unsafe' ? robotsRes.safety : (tdmRes as { safety: Exclude<HostSafety, 'ok'> }).safety;
    record = { kind: 'unsafe', signal: safety };
  } else {
    let robots: RobotsState;
    if (robotsRes.kind === 'body') {
      const groups = parseRobotsTxt(robotsRes.text);
      robots = groups ? { kind: 'groups', groups } : { kind: 'unavailable' };
    } else {
      robots = { kind: robotsRes.kind };
    }

    let tdm: TdmState;
    if (tdmRes.kind === 'body') {
      const entries = parseTdmRep(tdmRes.text);
      if (entries) tdm = { kind: 'entries', entries };
      // A non-JSON body at this path is a soft-404 page, i.e. absence —
      // only a document that *claims* to be JSON and isn't is malformed.
      else tdm = tdmRes.jsonish ? { kind: 'malformed' } : { kind: 'absent' };
    } else {
      tdm = { kind: tdmRes.kind };
    }
    record = { kind: 'checked', robots, tdm };
  }

  const entry: CacheEntry = {
    record,
    checkedAt: now,
    expiresAt: now + (isDecided(record) ? RESERVATION_CACHE_TTL_MS : RESERVATION_ERROR_CACHE_TTL_MS),
  };
  evictExpiredAndOverflow(now);
  hostCache.set(origin, entry);
  return entry;
};

// ── The gate ──────────────────────────────────────────────

const block = (signal: Exclude<ReservationSignal, 'no_reservation'>, checkedAt: Date): UrlReservationVerdict => ({
  allowed: false,
  signal,
  reason: RESERVATION_BLOCK_REASONS[signal],
  checkedAt,
});

const decide = (record: HostRecord, path: string, checkedAt: Date): UrlReservationVerdict => {
  if (record.kind === 'unsafe') return block(record.signal, checkedAt);

  // robots.txt first: it is the de facto anchor and the cheapest to read.
  if (record.robots.kind === 'unavailable') return block('robots_unavailable', checkedAt);
  if (record.robots.kind === 'groups' && !robotsAllows(record.robots.groups, path)) {
    return block('robots_disallow', checkedAt);
  }

  if (record.tdm.kind === 'unavailable') return block('tdm_unavailable', checkedAt);
  if (record.tdm.kind === 'malformed') return block('tdm_malformed', checkedAt);
  if (record.tdm.kind === 'entries' && tdmReserves(record.tdm.entries, path)) {
    return block('tdm_reservation', checkedAt);
  }

  return { allowed: true, signal: 'no_reservation', checkedAt };
};

/**
 * Decide whether we may fetch `rawUrl`. Never throws: a gate that throws
 * turns an undecidable answer into a 500 instead of a refusal.
 */
export const checkUrlReservation = async (rawUrl: string): Promise<UrlReservationVerdict> => {
  const now = new Date();
  if (!rawUrl || typeof rawUrl !== 'string' || !isSafeHttpsUrl(rawUrl)) return block('unsafe_host', now);

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return block('unsafe_host', now);
  }

  // RFC 9309 matches against the path AND query of the request.
  const path = `${url.pathname}${url.search}` || '/';
  const entry = await loadHostRecord(url.origin);
  const verdict = decide(entry.record, path, new Date(entry.checkedAt));

  // Host + signal only. The fetched documents never reach a log line.
  integrationLog.info(
    `reservation:check host=${url.host} signal=${verdict.signal} allowed=${verdict.allowed}`,
  );
  return verdict;
};
