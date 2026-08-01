# Debug Orchestrator — End-to-End Learning Flow Testing

Generates AI personas with different learning needs and walks each one through the full learner journey — course wizard, lesson generation, module quizzes, and spaced-repetition recall reviews — recording every input/output to per-persona markdown reports.

Two modes:

- **goal mode** (default) — the persona types a learning goal.
- **documents mode** (`--documents`) — the persona *uploads a document set* and the course is built from it (`POST /api/course {source:'documents'}` → upload → free ingest-and-assess → confirm goal + fidelity → the same clarify → depth → structure → lessons pipeline). See [§ Documents mode](#documents-mode).

Each persona runs against its own auto-provisioned db user, so gamification, recall queues, and per-user state are genuinely isolated between runs.

## Prerequisites

- API dev server running (`yarn dev` in `api/`)
- `MONGO_URI` set in `api/.env` — the orchestrator connects directly to flip `emailVerified` on fresh test users
- `ANTHROPIC_API_KEY` set in `api/.env` (used for persona AI decisions and typed-recall grading — Claude Sonnet 4.6 for the orchestrator, Haiku 4.5 for the grader)
- For `--documents` runs: a built document set (`yarn debug:orchestrator:sets` for the samples) and the api's document stack configured (S3, Pinecone, `OPENAI_API_KEY` for embeddings + moderation) — the same environment `yarn debug:ingest` needs

## Usage

```bash
cd api

# Minimal — 1 persona, wizard only (no lessons)
yarn debug:orchestrator --concurrency 1 --personas 1 --lessons 0

# Wizard + lessons + recall review
yarn debug:orchestrator --concurrency 3 --personas 5 --chat --lessons 2 --recall

# Full end-to-end: wizard + lessons + quizzes + recall review + mentor probes
yarn debug:orchestrator --concurrency 5 --personas 5 --chat --lessons 4 --quizzes --recall --mentor

# Everything on — hero images + further-reading links + recall cards generated
# per lesson, structure-review chat, module quizzes, recall queue review, mentor
# probes. Recall-card generation defaults ON; hero and links default OFF
# because both cost real $ — opt in with `--with-hero` and `--links`.
yarn debug:orchestrator \
  --concurrency 5 \
  --personas 5 \
  --lessons 4 \
  --chat \
  --quizzes \
  --recall \
  --mentor \
  --with-hero \
  --links

# Same as above, but pin every persona to a single goal-type bucket
# (useful when iterating on the classifier or per-bucket prompts).
yarn debug:orchestrator --concurrency 3 --personas 5 --lessons 2 \
  --chat --quizzes --recall --mentor --with-hero --links \
  --goal-type pass

# Or split the population across buckets (sum must equal --personas):
yarn debug:orchestrator --concurrency 3 --personas 5 --lessons 2 \
  --chat --quizzes --recall --mentor --with-hero --links \
  --goal-type-distribution "pass=2,build=2,fluency=1"

# ── Documents mode ──
# Build the sample corpora once (idempotent), then run against one:
yarn debug:orchestrator:sets
yarn debug:orchestrator --documents --document-set sample-basic \
  --concurrency 1 --personas 1 --lessons 1

# One set per persona (count must equal --personas). Composes with every
# other flag exactly as goal mode does:
yarn debug:orchestrator --documents --document-sets "sample-basic,sample-mixed" \
  --concurrency 2 --personas 2 --lessons 2 --chat --quizzes --recall --mentor
```

No user credentials are passed — the orchestrator creates and tears down a separate account per persona.

## Options

| Flag                        | Type     | Description                                                                                       |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `--concurrency`             | required | Max personas running simultaneously                                                               |
| `--personas`                | required | Number of personas to generate                                                                    |
| `--lessons`                 | required | Lessons to generate per persona (0 = skip)                                                        |
| `--api-url`                 | optional | API base URL (default: `http://localhost:4000`)                                                   |
| `--chat`                    | optional | Include structure review chat step (off by default)                                               |
| `--quizzes`                 | optional | Generate + submit module quizzes after lessons (off by default)                                   |
| `--recall`                  | optional | Review every recall card the queue returns (off by default)                                       |
| `--mentor`                  | optional | Probe course-design + lesson mentor chats with up to 3 persona-driven turns each (off by default) |
| `--with-hero`               | optional | Generate hero images per lesson (default: off — BFL costs real $)                                 |
| `--links`                   | optional | Curate "further reading" links per lesson (default: off — opt in when grading link quality)        |
| `--no-recall-gen`           | optional | Skip recall-card extraction during lesson gen (default: on). Distinct from `--recall`, which reviews the queue. |
| `--goal-type`               | optional | Force every persona into one bucket: `master`, `monetize`, `pass`, `build`, `fluency`             |
| `--goal-type-distribution`  | optional | Per-bucket counts, e.g. `"pass=3,build=2"`. Sum must equal `--personas`. Mutually exclusive with `--goal-type` |
| `--documents`               | optional | Documents mode — every persona builds their course from an uploaded document set instead of a typed goal. Requires `--document-set` or `--document-sets` |
| `--document-set <name>`     | optional | One set (a folder under [`documentSets/`](./documentSets/)) shared by every persona. Requires `--documents` |
| `--document-sets "a,b,…"`   | optional | One set per persona; the count must equal `--personas`. Mutually exclusive with `--document-set`. Requires `--documents` |

Goal-type flags stay valid in documents mode — a persona still has a private learning intent, and the classifier still runs on the confirmed goal.

`--email` and `--password` are accepted (for shell-history backward compatibility) but ignored — a warning is printed if either is passed.

## Per-persona account lifecycle

Each persona is a real, isolated db user for the duration of its run. The lifecycle lives in [`testUser.ts`](./testUser.ts):

1. **Signup** — `POST /api/auth/signup` with a random email `debug-<runId>-<personaSlug>-<rand>@strive-debug.test` and a random password. The response JWT is used throughout the persona flow.
2. **Verify in Mongo** — `UserModel.updateOne({ _id }, { $set: { emailVerified: true }, $unset: { emailVerificationToken, emailVerificationExpiry } })`. Skips the Mailjet round-trip. `requireVerified` middleware live-reads from DB per request, so the change takes effect immediately with the signup-issued token.
3. **Run persona flow** — normal orchestrator steps 1–14 with the persona's own token.
4. **Teardown** — `DELETE /api/auth/delete-account` (wrapped in `try/finally`). Cascades through `Course`, `LessonContent`, `UserLessonProgress`, `ModuleQuizContent`, `UserModuleQuizProgress`, `Recall`, `UserRecallProgress`, `CourseDesignChat`, `LessonMentorChat`, `LessonChunk` (+ matching Pinecone vectors when RAG is configured), `UserGamification`, `User`, and per-course S3 assets (`lessons/{courseId}/`) — see [`services/courseCleanupService.ts`](../../services/courseCleanupService.ts) for the shared primitive.

Emails use the RFC-6761 reserved `.test` TLD so they never collide with real inboxes. The `runId` is a per-invocation timestamp (`Date.now().toString(36)`) so two concurrent orchestrator processes don't clash.

The orchestrator opens Mongo via `mongoose.connect(MONGO_URI)` directly — **not** `connectDB()` from `@conf/mongo`, which runs `cleanupOrphanedJobs()` as a side effect and would mark all in-flight jobs on a live dev server as failed.

## What It Does

For each AI-generated persona, the orchestrator runs the full learner journey:

1. **Create Course** — submits the persona's learning goal
2. **Clarify Questions** — triggers AI question generation, polls until complete. The clarify job *also* runs the pre-flight goal-type classifier (api `classifyGoalType`); the orchestrator captures `course.goalType`, `course.goalTypeConfidence`, and `course.clarifyData.goalTypeNoun` and surfaces them in a `### Goal Type Classification` block alongside the persona's predicted ground truth, so the assessment rubric can score classification accuracy + confidence calibration + clarify-question tilt.
2b. **Goal-Type Override** — _(only fires for personas whose generator set `goalTypeOverrideTarget`)_ the persona toggles the goal-type chip: PATCH `/course/{id}` with the new `goalType`, re-submit a clarify job, capture before/after snapshots + question diff. Tests the chip-cascade end-to-end so a regression where the toggle fails to regenerate questions or persist the user-confirmed confidence flag is visible in the report. Always runs when the persona has a target — there's no opt-out flag.
3. **Answer Questions** — AI answers as the persona would (Claude Sonnet 4.6)
4. **Depth Previews** — triggers depth preview generation, polls until complete
5. **Select Depth** — AI picks a depth level as the persona (overview/comprehensive/deep_dive)
6. **Generate Structure** — triggers course structure generation, polls until complete
7. **Review Structure** — AI reviews and optionally sends one refinement via chat (SSE)
8. **Accept Course** — sets course status to `ready`
8b. **Course Mentor Probe** — _(only with `--mentor`)_ multi-turn conversation against the course-design chat (`POST /api/course/:courseId/chat`). Persona-LLM emits an opening question, then after each mentor reply decides to continue or stop. Up to 3 turns; persona usually settles at 2. Each turn captured with question + rationale + full SSE reply for the rubric's domain I evaluation. The server keeps chat history itself, so per turn the orchestrator sends only the new user message.
9. **Generate Lessons** — sequentially generates up to `--lessons` lessons via the job pipeline, fetches full content (blocks, quizzes, exercises, diagrams), and logs everything _(skipped if `--lessons 0`)_
9b. **Lesson Mentor Probe** — _(only with `--mentor`)_ for each generated lesson, runs the same multi-turn loop against the lesson mentor (`POST /api/course/:courseId/lesson/:m/:l/mentor/chat`). Up to 3 turns. The opening question is grounded in the lesson body the persona just read; follow-ups must reference what the mentor said. Recorded inline under each lesson as a collapsible block.
10. **Complete Lessons** — marks each generated lesson as completed via the progress API
11. **Generate Module Quizzes** — for every module whose lessons were all generated in this run, triggers `POST /module-quiz/:m/generate` and fetches the quiz _(skipped unless `--quizzes`)_
12. **Submit Quiz Attempts** — AI answers each quiz as the persona (Claude Sonnet 4.6, multiple-choice only) and posts to `/submit`; records score, mastery tier, question-by-question correctness, and next review date
13. **Fetch Recall Queue** — GET `/api/recall/queue`; logs due/fresh/learned counts and lists every item the server returned _(skipped unless `--recall`)_
14. **Review Recall cards** — walks every card the queue returned (due first, then fresh) and reviews each one. Mode (`tap-reveal` vs `typed-recall`) is chosen from the persona's `recallReviewStyle`. Tap-reveal runs `rateRecall` directly. Typed-recall generates a typed answer, hits `/grade`, maps the score to an Again/Hard/Good/Easy rating, and submits via `rateRecall` with `typedMatch`. Cards that fit the persona's "skip" profile get one deferral. Queue size is bounded server-side by `RECALL_QUEUE_DUE_LIMIT` + `RECALL_QUEUE_FRESH_LIMIT_DEFAULT`.

Because each persona has a fresh db user, Step 13 on a new run starts with `Learned: 0` — previously it always showed the shared account's accumulated history.

## Documents mode

`--documents` swaps **Step 1 only**. Everything from Step 2 (clarify) onward is the pipeline above, unchanged — the api makes those stages document-aware server-side (clarify sees the source digest, depth previews clamp to the assessment's size band, structure is band-enforced and emits per-lesson `sourceRefs`).

The replaced step becomes four:

1. **Create Course (documents)** — `POST /api/course {source:'documents'}`. No goal is typed; the server persists a placeholder until the analysis suggests one.
2. **Upload Documents** — every file in the set via multipart `POST /:courseId/documents` (field `file`), then every `manifest.json` URL via `POST /:courseId/documents/url`. Per-file status/warnings are recorded. **A rejected file is recorded and the run continues** (a deliberately-rejected file is a legitimate set member); the run only aborts if *every* upload was rejected.
3. **Ingest Documents** — `POST /:courseId/documents/ingest` → 202 `{jobId}` → the existing job poller. Free by policy. Then `GET /:courseId/documents` + `GET /:courseId` to capture the per-document rows and the coarse `course.sourceAssessment` (topics, `sizeBand{minLessons,maxLessons,mode}`, `teachableDensity`, `suggestedGoal`, `questions[]`, `warnings[]`, `perDocument[]`). A missing/incomplete assessment fails the run loudly — it means a server-side regression, not a persona problem.
4. **Confirm Goal & Fidelity** — AI-as-persona reviews the analysis exactly as the live analysis screen presents it and decides whether to accept or edit the suggested goal and which fidelity to pick (`strict`/`guided`/`enrich`), honouring the generator's predicted stance unless the analysis gives a concrete reason to deviate. `PATCH /api/course/:id {goal, sourceFidelity}`. Prediction-vs-actual is recorded for both dimensions.

Two more docs-only insertions later in the flow:

- **Step 5b — Prepare Corpus** (before structure generation). The needs-preparation predicate is computed from the documents list, mirroring the client contract: `scannedPageCount > escalatedPages.length || (audioDurationSec != null && (transcribedSec ?? 0) < audioDurationSec)`. When it fires, `POST /:courseId/prepare-corpus` → 202 `{jobId}` → poll (this job is **debited**). When it doesn't, the step records "no preparation needed" — the correct outcome for a text-only corpus, and the endpoint is a fast no-op anyway.
- **Band adherence** (after structure). Compares the generated lesson count against the picked tier's *displayed* `lessonCountRange` and the assessment `sizeBand`, and counts per-lesson `sourceRefs` (grounded vs AI-supplemented). Verdict is `in-band` / `tolerated` (exactly min−1, which the server accepts) / `out-of-band` / `n-a`.

Lesson generation and content fetch are unchanged; each lesson additionally records whether its structure entry carried `sourceRefs`. Quizzes, recall and mentor probes all work in documents mode when flagged.

### Document sets

A set is a folder under [`documentSets/`](./documentSets/) holding real files plus an optional `manifest.json`:

```json
{
  "urls": ["https://en.wikipedia.org/wiki/Standard_error"],
  "note": "one-line description of what this corpus is",
  "expectedTopics": ["descriptive statistics", "confidence intervals"]
}
```

- `urls` are registered through the URL endpoint (public http(s) only).
- `note` is shown to the persona generator (so the persona plausibly *owns* the corpus) and printed in the report.
- `expectedTopics` is **never sent to the API** — it is the set author's ground truth, surfaced in the report so the assessment rubric's K45 (analysis honesty) has something to check the server's detected topics against.

Everything except `manifest.json`, `README.md`, dotfiles and `.ts`/`.js` files counts as a corpus file.

`documentSets/` is gitignored except a committed generator and its README, so corpora are built on demand:

```bash
yarn debug:orchestrator:sets
```

That produces two sets from the api's own extraction fixture builders (`src/services/documentExtraction/__fixtures__/builders.ts` — the same ones the unit tests and `yarn debug:ingest` use):

| Set | Contents | Exercises |
| --- | --- | --- |
| `sample-basic` | text-rich pdf + docx + md on spaced repetition (~3k words) | happy path; no deferred extraction → `prepare_corpus` records "no preparation needed" |
| `sample-mixed` | statistics pdf + docx + md + csv + a **scanned-look** pdf, plus a Wikipedia URL | scanned-page detection → the debited `prepare_corpus` pass; csv extraction; URL ingestion |

Full conventions: [`documentSets/README.md`](./documentSets/README.md).

### Persona generation in documents mode

The generator receives each persona's set summary (filenames, manifest note, ~400-char content previews) and must emit a persona who plausibly **owns** those documents. Docs-mode personas carry a required `documentsProfile`: `ownershipStory`, `predictedFidelity` + reasoning, and `suggestedGoalStance` (`accept` | `edit`) + reasoning. The Step-1d decision is scored against those predictions in the report. Goal-mode persona generation is untouched (separate schema, unchanged prompt).

## Output

Reports are written to `api/scripts/debugOrchestrator/output/` (gitignored).

Each persona gets a markdown file like:

```
output/2026-04-04T14-30-00_alex-career-switching-data-scientist.md
```

Reports include:

- Persona profile (name, background, goal, personality, priorities)
- Predicted goal type — orchestrator's ground-truth bucket for the classifier (master / monetize / pass / build / fluency) plus a one-sentence rationale. When set, the persona's `goalTypeOverrideTarget` is also surfaced ("would switch to X via the chip if given the chance").
- Predicted behavior for all five dimensions (survey / depth / structure / quiz / recall review)
- **Run configuration** — which flags were active for this run (lessons target, chat, quizzes, recall review, mentor probes, per-lesson `hero` / `links` / `recall-gen`). The assessment rubric uses this to disambiguate "feature disabled by flag" (`n/a`) from "feature ran but produced 0" (failure).
- Run summary (duration, status, course domain, **goal type predicted/final/confidence + match flag**, lesson/quiz/recall counts, **credits spent**)
- Each step with timing, API responses, AI reasoning
- Generated lesson content: block breakdown by type, code, mermaid diagrams, exercises (collapsible)
- Module quiz: per-module score, mastery tier, next-review interval, and every question with selected vs correct option + explanation (collapsible)
- Recall queue snapshot + per-card review log: mode, user answer (typed-recall), grade score + verdict, final rating, new Leitner box, next due date
- **Documents-mode sections** _(only in `--documents` runs — goal-mode reports are byte-identical to before)_: `Source Document Set` (set name, per-file inventory + previews, manifest note, expected topics), `Upload & Ingest` (per-upload accept/reject table + post-ingest document rows with page/scan/audio counters and warnings), `Source Analysis` (topics, size band + mode, teachable density, suggested goal, assessment questions, per-doc rows), `Goal & Fidelity Confirmation` (persona reasoning, final PATCH, predicted-vs-actual), `Corpus Preparation` (fired or not, per-doc predicate breakdown, job timing), `Band Adherence` (displayed tier range vs lessons generated vs size band, per-lesson `sourceRefs`). Each lesson also gets a `Source grounding:` line, and the Run Summary gains `Mode` / `Document Set` / `Source Fidelity` / `Size Band` / `Lessons In Band` rows.
- **Cost Breakdown** — per-step `Δ credits` table (snapshots taken at every step boundary against `/api/billing/summary`, including each per-lesson/per-quiz/per-recall sub-step) plus a per-feature rollup by `UsageEvent.action` label (`lesson:content`, `lesson:recall`, `lesson:image`, `lesson:links`, `recall:grade`, etc.). Analytics only — the assessment rubric ignores it. Cohort total is also printed to stdout at end of run.

## Concurrency Notes

- Each persona runs against its own db user — no shared-account contention on gamification, recall progress, or rate-limited endpoints
- Server-side limit: 10 concurrent jobs globally (`jobRunner.ts`)
- Default script concurrency of 3 stays well within this limit
- Lesson generation adds ~30–120s per lesson and quiz generation another ~20–60s per module — plan concurrency accordingly
- Recall grading is rate-limited to 120/hour/user server-side; typed-recall reviews count against this cap. Since each persona has its own user, the cap is per-persona, not shared
- `authLimiter` on `/api/auth/signup` is 30 requests / 10 minutes / IP (see [`routes/authRoutes.ts`](../../routes/authRoutes.ts)). Running 30+ personas in one 10-minute window from the same IP will hit it

## Orphan cleanup

Test accounts are deleted in a `try/finally` block, so orphans should be rare. If the orchestrator process is killed mid-run (SIGKILL, hardware crash), the test user and its course data remain in Mongo until manually removed. To sweep leftover accounts:

```
db.users.find({ email: /@strive-debug\.test$/ })   // enumerate
```

Then call `DELETE /api/auth/delete-account` for each (or drop the matching User + cascade manually — the user model has no TTL index).

## Assessment

After a run, evaluate content quality and learner satisfaction with [`assessmentPrompt.md`](./assessmentPrompt.md).

**How to use it:**

1. Hand the full contents of `assessmentPrompt.md` to an evaluator agent (Claude Code, Cursor agent, etc.) with read + Agent-spawn access to `output/`.
2. The agent is a **dispatcher** — it fans out one sub-agent per persona file in parallel (one sub-agent per `YYYY-MM-DDTHH-mm-ss_*.md`), each scoring the same 49-criterion rubric.
3. Each sub-agent returns a structured scorecard (stable handoff schema defined in the prompt's §12).
4. The dispatcher runs a cross-persona drift check, synthesizes, and writes a single `output/_ASSESSMENT_<YYYY-MM-DDTHH-mm>.md` with:
   - Inventory (one row per persona)
   - Per-persona scorecards (inlined verbatim from sub-agents)
   - Judge-calibration notes (any criterion where a persona's score differs from the median by ≥2)
   - Cross-report synthesis + top-5 RICE-prioritized product roadmap
   - Confidence statement

**Rubric structure:** 11 domains, 49 criteria, 4-point ordinal scale (rubric v8). Grounded in constructive alignment (Biggs), Bloom's revised taxonomy, Mayer's multimedia principles, CLT (Sweller), ICAP, Haladyna MCQ rules, SuperMemo 20 rules of knowledge formulation. Domain J (goal-type axis) scores classification accuracy, confidence calibration, and whether the clarify questions + structure shape reflect the classified `goalType` (J42/J43 are `n/a` when the classifier emitted `master` since that's the no-special-shape default). **Domain K (source grounding, K44–K49) applies to documents-mode runs only** — suggested-goal faithfulness, analysis honesty against the set inventory + `expectedTopics`, band adherence, lesson grounding, fidelity compliance, and provenance-labelling coherence; all six are `n/a` on goal-mode reports, so v7 and v8 scores stay comparable there. Sub-agents are instructed to guard against leniency, position bias, halo effect, and self-preference.

**Signal discipline:** structural scores (alignment, MCQ quality, persona-grounding) are trusted; behavioral scores (would-continue, quiz scores) are treated as hypotheses because personas systematically over-perform on quizzes (they can see the lesson text). Confidence on synthetic-only evidence is capped at 80 % in the RICE roadmap.

The assessment file is gitignored along with the rest of `output/`.

## Files

```
debugOrchestrator/
  index.ts              — Entry point, CLI args, document-set preload, Mongo connect
  orchestrator.ts       — p-limit concurrency wrapper, per-persona lifecycle
  testUser.ts           — createVerifiedTestUser + deleteTestUser helpers
  personaGenerator.ts   — Claude Sonnet 4.6 persona generation (goal + documents variants)
  courseFlow.ts         — 14-step pipeline (+ docs-mode Step 1a–1d, 5b) + AI-as-persona functions
  apiClient.ts          — HTTP client (fetch, job polling, SSE, multipart upload, auth helpers)
  markdownRecorder.ts   — Per-persona markdown report builder
  documentSets.ts       — Set loader + manifest parsing, CLI set resolution, needs-preparation predicate
  documentSets.test.ts  — Unit tests for the three above (pure; no server)
  types.ts              — Shared TypeScript interfaces
  assessmentPrompt.md   — Evaluator prompt (dispatcher + parallel sub-agents, rubric v8)
  documentSets/         — Corpora for documents mode (gitignored except the generator + its README)
    generate-sample-sets.ts  — `yarn debug:orchestrator:sets`
    README.md                — set folder conventions
  output/               — Generated reports + _ASSESSMENT_*.md (gitignored)
```
