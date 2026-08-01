// ── Course ────────────────────────────────────────────────

export const COURSE_DEPTHS = ['overview', 'comprehensive', 'deep_dive'] as const;
export type CourseDepth = (typeof COURSE_DEPTHS)[number];

export const COURSE_STATUSES = ['creating', 'ready', 'archived'] as const;
export type CourseStatus = (typeof COURSE_STATUSES)[number];

export const COURSE_DOMAINS = [
  'programming',
  'stem',
  'humanities',
  'language',
  'creative',
  'business',
  'practical',
  'practical-ai',
  'life-skills',
  'other',
] as const;
export type CourseDomain = (typeof COURSE_DOMAINS)[number];

// Orthogonal to `domain` — describes the learner's INTENT shape, which steers
// module/lesson scope decisions (action checklists vs. mock exams vs. project
// spine vs. comprehensive ladder). Classified by a pre-flight Haiku call inside
// the `clarify` job; user-overridable via the chip on the ClarifyStep. Existing
// pre-feature courses persist `null` and read as `master` semantics.
export const GOAL_TYPES = ['master', 'monetize', 'pass', 'build', 'fluency'] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

export const GOAL_TYPE_CONFIDENCES = ['high', 'medium', 'low'] as const;
export type GoalTypeConfidence = (typeof GOAL_TYPE_CONFIDENCES)[number];

// ── Course source documents ───────────────────────────────

// Course origin. Null on every pre-feature row and on goal-typed courses —
// null reads as "started from a typed goal" everywhere (same back-compat
// idiom as `goalType`).
export const COURSE_SOURCES = ['documents'] as const;
export type CourseSource = (typeof COURSE_SOURCES)[number];

// Server-side placeholder goal for `source: 'documents'` courses created
// before the ingest assessment synthesizes a suggested goal (A2). The
// wizard PATCHes the confirmed/edited goal over it later.
export const DOCUMENTS_PLACEHOLDER_GOAL = 'Course from documents';

// A9: at most this many `source: documents` courses per user per trailing
// 24h — the free-ingest abuse bound that pairs with the ≤3 ingest runs /
// course / day cap (see ingestDocumentsController). Counted over Course
// rows (no TTL, so the count never under-counts). Tunable.
export const MAX_DOC_COURSES_PER_USER_PER_DAY = 5;

// Per-upload lifecycle: `uploaded` (raw bytes in S3, not yet processed) →
// `parsing` (ingest job working) → `parsed` | `rejected` (moderation hit,
// category-level reason only) | `failed` (extraction error, retryable).
export const SOURCE_DOCUMENT_STATUSES = ['uploaded', 'parsing', 'parsed', 'rejected', 'failed'] as const;
export type SourceDocumentStatus = (typeof SOURCE_DOCUMENT_STATUSES)[number];

// How tightly generation sticks to the uploaded material: `strict` (only
// what the documents say), `guided` (default — documents lead, AI fills
// gaps), `enrich` (documents as a seed, AI expands freely).
export const SOURCE_FIDELITIES = ['strict', 'guided', 'enrich'] as const;
export type SourceFidelity = (typeof SOURCE_FIDELITIES)[number];

export const SOURCE_DOCUMENT_KINDS = ['file', 'url'] as const;
export type SourceDocumentKind = (typeof SOURCE_DOCUMENT_KINDS)[number];

// Chunk granularity for the document RAG corpus. Tables and figures are
// kept atomic (never split mid-chunk) so retrieval returns them whole.
export const SOURCE_CHUNK_TYPES = ['text', 'table', 'figure'] as const;
export type SourceChunkType = (typeof SOURCE_CHUNK_TYPES)[number];

// ── URL rights reservation (DSM Art. 4) ───────────────────

// Category-level rejection reason for a URL the rightsholder has reserved
// from automated use (robots.txt `Disallow` for our token, or a TDMRep
// reservation), or whose reservation we could not read and therefore could
// not honour. Doubles as an `ExtractionFailureReason` member and as the
// persisted `SourceDocument.rejectionReason` — never echoes page content.
// The gate that produces it is `services/urlReservationCheck.ts`.
export const URL_BLOCKED_BY_RESERVATION = 'url_blocked_by_reservation';

// Declared platform-wide ceiling on how often ONE source domain may be
// fetched per day, so no aggregate pattern of ours can be characterised as
// crawling that domain (research §1.8 rule 9). NOT YET ENFORCED: a truthful
// bound needs a durable counter (an in-process count resets on every deploy
// and would under-report), which is a later phase. Until then this is the
// number the policy is written against, in one place, so the enforcement
// change is a wiring job and not a fresh decision.
export const MAX_URL_FETCHES_PER_DOMAIN_PER_DAY = 5;

// ── URL snapshot retention (PUBLISHED PROMISE) ────────────
//
// ⚠ These two numbers are PUBLISHED in Terms of Service §6.2 and Privacy
// Policy §5 ("we delete the fetched text 90 days after your course finishes
// generating — 30 days where the page comes from a news or press site").
// Changing either number here without changing BOTH documents recreates the
// documentary contradiction this sweep exists to close. The enforcement
// point is `sweepExpiredUrlSnapshots` in `services/courseCleanupService`.

/** Default window for a fetched page snapshot, in days. */
export const URL_SNAPSHOT_RETENTION_DAYS = 90;

/** Shorter window for pages fetched from a news or press site, in days. */
export const URL_SNAPSHOT_PRESS_RETENTION_DAYS = 30;

/**
 * Hostname suffixes treated as "a news or press site" for the shorter
 * window above. A match is `host === suffix` or `host` ends with
 * `'.' + suffix`, so `www.` / `edition.` / `amp.` subdomains are covered.
 *
 * DELIBERATELY a hand-written list, not a classifier and not an LLM call:
 * a wrong automated verdict is unauditable, and the only direction that
 * can breach the promise is failing to shorten a window we said we would
 * shorten. This list is therefore **NON-EXHAUSTIVE BY CONSTRUCTION** —
 * anything it does not match falls back to the 90-day rule, which is the
 * promise we make by default. It is a best-effort courtesy to the largest
 * press publishers, not a claim to recognise every news site on the web.
 * Extend it freely; never make it the basis of any other decision.
 */
export const PRESS_DOMAIN_SUFFIXES = [
  // Wires & international
  'reuters.com',
  'apnews.com',
  'afp.com',
  'bloomberg.com',
  'aljazeera.com',
  'euronews.com',
  'euractiv.com',
  'politico.eu',
  'politico.com',
  'dw.com',
  'france24.com',
  // UK & Ireland
  'bbc.com',
  'bbc.co.uk',
  'theguardian.com',
  'ft.com',
  'telegraph.co.uk',
  'thetimes.co.uk',
  'independent.co.uk',
  'dailymail.co.uk',
  'mirror.co.uk',
  'economist.com',
  'sky.com',
  'irishtimes.com',
  'rte.ie',
  // United States
  'nytimes.com',
  'washingtonpost.com',
  'wsj.com',
  'usatoday.com',
  'latimes.com',
  'nypost.com',
  'cnn.com',
  'nbcnews.com',
  'cbsnews.com',
  'abcnews.go.com',
  'foxnews.com',
  'npr.org',
  'cnbc.com',
  'marketwatch.com',
  'forbes.com',
  'businessinsider.com',
  'axios.com',
  'thehill.com',
  'newsweek.com',
  'time.com',
  'theatlantic.com',
  'newyorker.com',
  'vox.com',
  'slate.com',
  'huffpost.com',
  'propublica.org',
  // Continental Europe
  'lemonde.fr',
  'lefigaro.fr',
  'liberation.fr',
  'spiegel.de',
  'zeit.de',
  'faz.net',
  'sueddeutsche.de',
  'welt.de',
  'handelsblatt.com',
  'elpais.com',
  'elmundo.es',
  'corriere.it',
  'repubblica.it',
  'nrc.nl',
  'volkskrant.nl',
  'dn.se',
  'svd.se',
  'hs.fi',
  'yle.fi',
  'nrk.no',
  'aftenposten.no',
  'politiken.dk',
  'dr.dk',
  'err.ee',
  'lsm.lv',
  // Lithuania (home market)
  'lrt.lt',
  'delfi.lt',
  '15min.lt',
  'lrytas.lt',
  'vz.lt',
  'tv3.lt',
  'diena.lt',
  'alfa.lt',
  'bns.lt',
  'respublica.lt',
  // Asia-Pacific & Americas
  'scmp.com',
  'japantimes.co.jp',
  'straitstimes.com',
  'thehindu.com',
  'indiatimes.com',
  'smh.com.au',
  'theage.com.au',
  'abc.net.au',
  'cbc.ca',
  'globeandmail.com',
  'thestar.com',
  // Technology press
  'techcrunch.com',
  'theverge.com',
  'arstechnica.com',
  'wired.com',
  'engadget.com',
  'zdnet.com',
  'venturebeat.com',
  'theregister.com',
] as const;

// Assessment verdict on what course size the corpus supports:
// `source_only` (enough substance as-is), `needs_supplement` (thin — AI
// must fill), `multi_course` (too much for one course; a split is proposed
// but only one course is generated).
export const SOURCE_ANALYSIS_MODES = ['source_only', 'needs_supplement', 'multi_course'] as const;
export type SourceAnalysisMode = (typeof SOURCE_ANALYSIS_MODES)[number];

// ── Jobs ──────────────────────────────────────────────────

export const JOB_TYPES = ['clarify', 'generate_structure', 'refine_structure', 'generate_lesson', 'generate_depth_previews', 'generate_module_quiz', 'regenerate_hero', 'regenerate_links', 'regenerate_recall', 'lesson_narration', 'ingest_documents', 'prepare_corpus'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['pending', 'processing', 'completed', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// ── Questions ─────────────────────────────────────────────

export const QUESTION_TYPES = ['multiple_choice', 'multiple_select', 'text'] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

// ── Chat ─────────────────────────────────────────────────

export const CHAT_ROLES = ['user', 'assistant'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

// ── Progress ─────────────────────────────────────────────

export const LESSON_PROGRESS_STATUSES = ['not_started', 'in_progress', 'completed'] as const;
export type LessonProgressStatus = (typeof LESSON_PROGRESS_STATUSES)[number];

// ── Module Quiz ─────────────────────────────────────────

export const QUIZ_MASTERY_TIERS = ['needs_review', 'passed', 'mastered'] as const;
export type QuizMasteryTier = (typeof QUIZ_MASTERY_TIERS)[number];

// ── Spaced Review ───────────────────────────────────────

export const REVIEW_INITIAL_INTERVALS: Record<QuizMasteryTier, number> = {
  mastered: 7,
  passed: 3,
  needs_review: 1,
};

export const REVIEW_PROGRESSION_GAPS: Record<QuizMasteryTier, number> = {
  needs_review: 1,
  passed: 2,
  mastered: 3,
};

export const REVIEW_MAX_INTERVAL_DAYS = 90;
export const REVIEW_MIN_INTERVAL_DAYS = 1;

// ── Marketing email ───────────────────────────────────────

// Lawful basis recorded per contact in `MarketingContact`.
//
//   - `soft_opt_in`: ePrivacy Art. 13(2) — an existing customer relationship
//     plus a clear objection route on every message. This is what the
//     migrated user base and every new signup get.
//   - `consent`: the user affirmatively ticked the profile toggle. Outranks
//     soft opt-in.
//
// We never write `consent` for a consent nobody created — only the profile
// toggle may produce it (PLAN A2, pinned by the seed tests).
export const MARKETING_BASES = ['soft_opt_in', 'consent'] as const;
export type MarketingBasis = (typeof MARKETING_BASES)[number];

// Which surface produced the ledger row.
export const MARKETING_SOURCES = ['registration', 'signup', 'profile_toggle'] as const;
export type MarketingSource = (typeof MARKETING_SOURCES)[number];

// The notice/memo a contact's basis rests on. Stored verbatim on the row so
// "which notice was in force when this address entered the audience" is
// answerable years later (data-protection §8.1 — a basis is a record with a
// version, not a boolean).
//
//   - SEEDED_COHORT: users who registered BEFORE the at-collection notice
//     existed. Their inclusion rests on the documented residual-risk
//     decision, not on a notice they were shown — claiming otherwise would
//     be a fabricated provenance record.
//   - SIGNUP_NOTICE: shown under the sign-up form from v1 of that notice on.
//   - PROFILE_TOGGLE: the user ticked the box themselves.
export const MARKETING_EVIDENCE = {
  SEEDED_COHORT: 'pre-notice-residual-risk-memo-2026-07',
  SIGNUP_NOTICE: 'signup-notice-v1',
  PROFILE_TOGGLE: 'profile-toggle-v1',
} as const;

// Closed set of campaign keys. A send endpoint validates against this and
// pins the template server-side per campaign, so an operator cannot aim an
// arbitrary template at an arbitrary audience.
export const MARKETING_CAMPAIGNS = ['documents-feature-2026-08'] as const;
export type MarketingCampaign = (typeof MARKETING_CAMPAIGNS)[number];

// Per-recipient state in `MarketingSend`. Closed set; every member has a
// live emit site in `sendMarketingCampaign`.
//
//   - `claiming`: the CAS claim landed, Mailjet has not confirmed yet. A row
//     stuck here is a STRANDED claim (a process killed mid-send) and is what
//     `GET /marketing/claims` surfaces and `POST /marketing/reclaim` frees.
//   - `sent`: Mailjet accepted the message. Terminal.
//   - `failed`: the send failed transiently; the claim was rolled back so the
//     next batch retries the address.
//   - `hard_bounced`: the address was rejected as undeliverable. Terminal,
//     and excluded from every LATER campaign too (PLAN A13) — Mailjet
//     suppresses at its end and re-offering the address only damages the
//     sender reputation we are protecting.
export const MARKETING_SEND_STATUSES = ['claiming', 'sent', 'failed', 'hard_bounced'] as const;
export type MarketingSendStatus = (typeof MARKETING_SEND_STATUSES)[number];

// Per-recipient outcome reported back to the operator for one batch. Wider
// than the stored status because it also names the reasons a recipient was
// never claimed at all.
export const MARKETING_SEND_RESULTS = [
  'sent',
  'already_sent',
  'not_in_audience',
  'suppressed',
  'failed',
  'deferred',
] as const;
export type MarketingSendResult = (typeof MARKETING_SEND_RESULTS)[number];

// ── Auth ──────────────────────────────────────────────────

export const AUTH_PROVIDERS = ['GOOGLE', 'CREDENTIALS'] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
export const AuthProvider = {
  GOOGLE: 'GOOGLE',
  CREDENTIALS: 'CREDENTIALS',
} as const satisfies Record<string, AuthProvider>;
