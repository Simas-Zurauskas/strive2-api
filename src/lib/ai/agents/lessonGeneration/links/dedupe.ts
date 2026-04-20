import { SearchCandidate } from './schemas';

// Wikipedia namespaces and similar meta pages that Tavily sometimes surfaces
// for high-level queries. These are never what a learner wants — they're
// editorial infrastructure, not subject-matter content. Tested against the
// pathname (case-insensitive) after URL normalization.
const META_PATH_PATTERNS: RegExp[] = [
  /^\/wiki\/Wikipedia:/i,
  /^\/wiki\/Wikipedia_talk:/i,
  /^\/wiki\/Special:/i,
  /^\/wiki\/Portal:/i,
  /^\/wiki\/Category:/i,
  /^\/wiki\/Help:/i,
  /^\/wiki\/File:/i,
  /^\/wiki\/Template:/i,
  /^\/wiki\/User:/i,
  /^\/wiki\/Draft:/i,
  /^\/wiki\/List_of_/i,
  /^\/wiki\/Lists_of_/i,
  /^\/wiki\/Outline_of_/i,
  /^\/wiki\/Index_of_/i,
];

const TRACKING_PARAM_PREFIXES = ['utm_'];
const TRACKING_PARAM_EXACT = new Set([
  'ref',
  'ref_src',
  'ref_url',
  'source',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'yclid',
  'igshid',
  's_cid',
]);

// Hostname prefixes that route to the same content as the apex (or `www.`)
// host — `www.example.com`, `m.example.com`, `amp.example.com` are the same
// article in 99% of cases. Stripping them lets URL-exact dedup actually catch
// duplicates that today survive because Tavily returns both.
const HOST_PREFIX_NOISE = ['www.', 'm.', 'amp.'];

// Hostnames (or suffixes) we never want a learner routed to — private network
// literals, localhost, file-scheme sneaks, data URIs. This is the SSRF belt
// for the dedup step; the fetch stage has its own belt at the HTTP boundary.
const HOST_BLOCKLIST = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

const isPrivateHost = (host: string): boolean => {
  if (HOST_BLOCKLIST.has(host)) return true;
  // RFC1918 / link-local ranges as string patterns. Good enough for a string
  // of candidate URLs — full CIDR matching is overkill for dropping obvious
  // misroutes.
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  // Bare IP literals — a legitimate educational resource almost never lives
  // on a raw IP. Drop them defensively.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true;
  return false;
};

const stripHostNoise = (host: string): string => {
  for (const prefix of HOST_PREFIX_NOISE) {
    if (host.startsWith(prefix) && host.length > prefix.length) {
      return host.slice(prefix.length);
    }
  }
  return host;
};

// Strip a trailing `/amp` or `/amp/` segment from a path. AMP versions are the
// same article served in a different shell — collapse them into the canonical.
const stripAmpSuffix = (pathname: string): string => {
  if (pathname.endsWith('/amp')) return pathname.slice(0, -'/amp'.length) || '/';
  if (pathname.endsWith('/amp/')) return pathname.slice(0, -'/amp/'.length) || '/';
  return pathname;
};

/** Normalize a URL for deduplication: strip tracking, fragments, default ports, trailing slash. */
const canonicalizeUrl = (raw: string): string | null => {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = stripHostNoise(url.hostname.toLowerCase());
    if (!host || isPrivateHost(host)) return null;

    // Strip tracking params, then alpha-sort the survivors so URLs that differ
    // only in param order (`?a=1&b=2` vs `?b=2&a=1`) collapse to the same key.
    const keep: [string, string][] = [];
    for (const [k, v] of url.searchParams) {
      const lower = k.toLowerCase();
      if (TRACKING_PARAM_EXACT.has(lower)) continue;
      if (TRACKING_PARAM_PREFIXES.some((p) => lower.startsWith(p))) continue;
      keep.push([k, v]);
    }
    keep.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    url.search = '';
    for (const [k, v] of keep) url.searchParams.append(k, v);

    url.hash = '';
    url.hostname = host;
    url.pathname = stripAmpSuffix(url.pathname);
    // Strip default ports.
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }

    // Strip a trailing slash on non-root paths so `/foo/` and `/foo` dedupe.
    let out = url.toString();
    if (out.endsWith('/') && url.pathname !== '/') {
      out = out.slice(0, -1);
    }
    return out;
  } catch {
    return null;
  }
};

const isMetaPage = (pathname: string): boolean =>
  META_PATH_PATTERNS.some((re) => re.test(pathname));

// Collapse a title to a slug for near-dup detection — same article syndicated
// to two domains (Medium → dev.to, content scrapers, mirror sites) usually
// shares the same title even when URLs and host differ. Lowercase, drop
// punctuation, collapse whitespace to single hyphens.
const slugifyTitle = (title: string): string =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

// Fingerprint a candidate by title-slug + first path segment. Two candidates
// with the same fingerprint are almost certainly the same article — different
// hostnames or the same hostname with a wrapper path (`/blog/<slug>` vs
// `/<slug>`) both hit the same cluster bucket.
const titleFingerprint = (candidate: SearchCandidate): string | null => {
  const slug = slugifyTitle(candidate.title);
  if (!slug || slug.length < 8) return null; // titles too short to fingerprint reliably
  let firstSeg = '';
  try {
    firstSeg = new URL(candidate.url).pathname.split('/').filter(Boolean)[0] ?? '';
  } catch {
    return null;
  }
  return `${slug}::${firstSeg}`;
};

interface DedupeInput {
  candidates: SearchCandidate[];
  hostnameCap?: number;
  maxOut?: number;
}

/**
 * Deduplicate, blocklist, and hostname-cap candidate URLs.
 *
 * Pure function — no network, no LLM. Typically runs in <1ms.
 *
 *  - URL canonicalization strips tracking params, fragments, default ports,
 *    trailing slash, AMP path suffix; alpha-sorts query params; collapses
 *    `www.` / `m.` / `amp.` host prefixes onto the apex.
 *  - URL-exact dedup keeps the highest-scored survivor.
 *  - Title-fingerprint near-dup pass collapses syndicated copies of the same
 *    article (Medium mirror, dev.to mirror, content scrapers) where URLs and
 *    hosts differ but the title and topic are identical.
 *  - Meta-page patterns kill known garbage paths (`/wiki/Wikipedia:`,
 *    `/Special:`, `/List_of_`, etc).
 *  - Hostname cap prevents a single site from dominating a lesson's link set.
 *  - URL-validity belt rejects non-http(s), localhost, RFC1918, IP literals.
 */
export const dedupeCandidates = ({
  candidates,
  hostnameCap = 2,
  maxOut = 14,
}: DedupeInput): SearchCandidate[] => {
  // First pass: canonicalize + filter.
  const canonicalized: SearchCandidate[] = [];
  for (const c of candidates) {
    const canonUrl = canonicalizeUrl(c.url);
    if (!canonUrl) continue;
    const url = new URL(canonUrl);
    if (isMetaPage(url.pathname)) continue;
    canonicalized.push({ ...c, url: canonUrl, hostname: url.hostname });
  }

  // Second pass: exact-dedup by canonicalized URL, keeping the highest Tavily score.
  const byUrl = new Map<string, SearchCandidate>();
  for (const c of canonicalized) {
    const prev = byUrl.get(c.url);
    if (!prev || c.score > prev.score) byUrl.set(c.url, c);
  }

  // Third pass: title-fingerprint near-dup. Anything with no usable fingerprint
  // (very short title, malformed URL) flows through untouched.
  const byFingerprint = new Map<string, SearchCandidate>();
  const noFingerprint: SearchCandidate[] = [];
  for (const c of byUrl.values()) {
    const fp = titleFingerprint(c);
    if (!fp) {
      noFingerprint.push(c);
      continue;
    }
    const prev = byFingerprint.get(fp);
    if (!prev || c.score > prev.score) byFingerprint.set(fp, c);
  }
  const deduped = [...byFingerprint.values(), ...noFingerprint];

  // Fourth pass: sort by score desc, apply hostname cap + overall cap.
  const sorted = deduped.sort((a, b) => b.score - a.score);
  const perHost = new Map<string, number>();
  const out: SearchCandidate[] = [];
  for (const c of sorted) {
    if (out.length >= maxOut) break;
    const count = perHost.get(c.hostname) ?? 0;
    if (count >= hostnameCap) continue;
    perHost.set(c.hostname, count + 1);
    out.push(c);
  }
  console.log(`[links.dedupe] ✓ ${out.length} of ${candidates.length} survived (URL canonical + title fingerprint, host cap ${hostnameCap}, max ${maxOut})`.cyan);
  return out;
};
