# Debug Orchestrator — End-to-End Learning Flow Testing

Generates AI personas with different learning needs and walks each one through the full learner journey — course wizard, lesson generation, module quizzes, and spaced-repetition recall reviews — recording every input/output to per-persona markdown reports.

Each persona runs against its own auto-provisioned db user, so gamification, recall queues, and per-user state are genuinely isolated between runs.

## Prerequisites

- API dev server running (`yarn dev` in `api/`)
- `MONGO_URI` set in `api/.env` — the orchestrator connects directly to flip `emailVerified` on fresh test users
- `ANTHROPIC_API_KEY` set in `api/.env` (used for persona AI decisions and typed-recall grading — Claude Sonnet 4.6 for the orchestrator, Haiku 4.5 for the grader)

## Usage

```bash
cd api

# Minimal — 1 persona, wizard only (no lessons)
yarn debug:orchestrator --concurrency 1 --personas 1 --lessons 0

# Wizard + lessons + recall review
yarn debug:orchestrator --concurrency 3 --personas 5 --chat --lessons 2 --recall

# Full end-to-end: wizard + lessons + quizzes + recall review + mentor probes
yarn debug:orchestrator --concurrency 5 --personas 5 --chat --lessons 4 --quizzes --recall --mentor
```

No user credentials are passed — the orchestrator creates and tears down a separate account per persona.

## Options

| Flag            | Type     | Description                                                     |
| --------------- | -------- | --------------------------------------------------------------- |
| `--concurrency` | required | Max personas running simultaneously                             |
| `--personas`    | required | Number of personas to generate                                  |
| `--lessons`     | required | Lessons to generate per persona (0 = skip)                      |
| `--api-url`     | optional | API base URL (default: `http://localhost:4000`)                 |
| `--chat`        | optional | Include structure review chat step (off by default)             |
| `--quizzes`     | optional | Generate + submit module quizzes after lessons (off by default) |
| `--recall`    | optional | Review every recall the queue returns (off by default)         |
| `--mentor`      | optional | Probe course-design + lesson mentor chats with up to 3 persona-driven turns each (off by default) |

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
- Run summary (duration, status, course domain, **goal type predicted/final/confidence + match flag**, lesson/quiz/recall counts)
- Each step with timing, API responses, AI reasoning
- Generated lesson content: block breakdown by type, code, mermaid diagrams, exercises (collapsible)
- Module quiz: per-module score, mastery tier, next-review interval, and every question with selected vs correct option + explanation (collapsible)
- Recall queue snapshot + per-card review log: mode, user answer (typed-recall), grade score + verdict, final rating, new Leitner box, next due date

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
2. The agent is a **dispatcher** — it fans out one sub-agent per persona file in parallel (one sub-agent per `YYYY-MM-DDTHH-mm-ss_*.md`), each scoring the same 33-criterion rubric.
3. Each sub-agent returns a structured scorecard (stable handoff schema defined in the prompt's §12).
4. The dispatcher runs a cross-persona drift check, synthesizes, and writes a single `output/_ASSESSMENT_<YYYY-MM-DDTHH-mm>.md` with:
   - Inventory (one row per persona)
   - Per-persona scorecards (inlined verbatim from sub-agents)
   - Judge-calibration notes (any criterion where a persona's score differs from the median by ≥2)
   - Cross-report synthesis + top-5 RICE-prioritized product roadmap
   - Confidence statement

**Rubric structure:** 10 domains, 43 criteria, 4-point ordinal scale (rubric v7). Grounded in constructive alignment (Biggs), Bloom's revised taxonomy, Mayer's multimedia principles, CLT (Sweller), ICAP, Haladyna MCQ rules, SuperMemo 20 rules of knowledge formulation. Domain J (goal-type axis) scores classification accuracy, confidence calibration, and whether the clarify questions + structure shape reflect the classified `goalType` (J42/J43 are `n/a` when the classifier emitted `master` since that's the no-special-shape default). Sub-agents are instructed to guard against leniency, position bias, halo effect, and self-preference.

**Signal discipline:** structural scores (alignment, MCQ quality, persona-grounding) are trusted; behavioral scores (would-continue, quiz scores) are treated as hypotheses because personas systematically over-perform on quizzes (they can see the lesson text). Confidence on synthetic-only evidence is capped at 80 % in the RICE roadmap.

The assessment file is gitignored along with the rest of `output/`.

## Files

```
debugOrchestrator/
  index.ts              — Entry point, CLI args, Mongo connect
  orchestrator.ts       — p-limit concurrency wrapper, per-persona lifecycle
  testUser.ts           — createVerifiedTestUser + deleteTestUser helpers
  personaGenerator.ts   — Claude Sonnet 4.6 persona generation
  courseFlow.ts         — 14-step pipeline + AI-as-persona functions
  apiClient.ts          — HTTP client (fetch, job polling, SSE, auth helpers)
  markdownRecorder.ts   — Per-persona markdown report builder
  types.ts              — Shared TypeScript interfaces
  assessmentPrompt.md   — Evaluator prompt (dispatcher + parallel sub-agents, rubric v2)
  output/               — Generated reports + _ASSESSMENT_*.md (gitignored)
```
