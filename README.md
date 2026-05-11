# Strive API

The Strive backend: an Express 5 + TypeScript service that owns authentication, AI-driven course generation, the credit/billing ledger, the Leitner v0 spaced-review queue, and the realtime channel that pushes progress to the client.

## Stack

- **Runtime** — Node.js 22.x, Yarn 1.22.x, TypeScript 5
- **HTTP** — Express 5, Helmet, `express-rate-limit`, Zod validation, Swagger UI (non-prod)
- **Data** — MongoDB via Mongoose 9
- **Realtime** — Socket.io 4 (in-memory adapter; single-instance)
- **Jobs** — In-process runner with `p-limit(50)`, per-course mutex, AsyncLocalStorage cost attribution
- **AI** — Anthropic Claude via LangChain + LangGraph; OpenAI embeddings; Pinecone for lesson/product RAG; Tavily for web search; BFL for image generation; Judge0 for sandboxed code execution; Google Cloud Text-to-Speech for lesson narration
- **Billing** — Stripe (Checkout + Customer Portal + webhooks)
- **Storage** — AWS S3 (presigned URLs, content-hashed audio dedup)
- **Email** — Mailjet (transactional + contact-list sync)
- **Observability** — Sentry, Mixpanel, Prometheus-compatible `/metrics`

## Getting started

Requires Node 22.x and Yarn 1.22.x. Install dependencies and run the dev server:

```bash
yarn install
yarn dev
```

The dev server defaults to `http://localhost:4000`. Swagger UI is exposed in non-production at `/swagger`; the raw spec is at `/swagger.json`.

To forward Stripe webhook events to the local server during development:

```bash
yarn stripe:webhook
```

## Scripts

| Command | Purpose |
| --- | --- |
| `yarn dev` | Run the dev server with nodemon + ts-node |
| `yarn build` | Compile TypeScript to `build/` and resolve path aliases |
| `yarn start` | Run the compiled `build/index.js` |
| `yarn tsc` | Type-check without emit |
| `yarn test` | Vitest with `mongodb-memory-server` |
| `yarn stripe:webhook` | Forward Stripe events to `http://localhost:4000/api/stripe/webhook` |
| `yarn debug:orchestrator` | End-to-end course-generation harness (see [wiki/reference/api/scripts.md](../wiki/reference/api/scripts.md)) |
| `yarn kb:index` | Re-index product knowledge-base content into Pinecone |
| `yarn kb:check` | Dry-run the product-KB indexer |

## Project structure

```
api/src/
├── index.ts          Bootstrap: middleware order, route mounts, Socket.io init, graceful shutdown
├── conf/             env reader, Mongo connect + orphan reaper, Sentry init, version info
├── routes/           Thin route mounts (9 route files)
├── controlers/       Request validation, ownership checks, job submission
├── services/         Business logic, job runner, agents glue, integrations
├── models/           Mongoose schemas (20 collections)
├── middleware/       protect / requireVerified / requireCredits / requireAdmin / requestId / errorHandler / swagger
├── lib/              Shared primitives (usageContext, jsonish, sanitizers, withRetry, metrics, socket, etc.)
└── types/            Ambient TypeScript declarations
```

## Environment variables

Create a `.env` file in `api/` with the variables below. For local development, you may add a `.env.local` to override individual values.

Variables marked **required** are validated at boot — missing values trigger `process.exit(1)` with a `env:missing` log line (see [conf/env.ts](src/conf/env.ts)).

### Core

- `ENVIRONMENT` — `development` | `production` (required)
- `MONGO_URI` — MongoDB connection string (required)
- `JWT_SECRET` — Secret for JWT signing. **Doubles as the AbuseLog hash salt** — rotating it invalidates every active session and orphans every existing abuse-log record (required)
- `FRONTEND_URL` — Frontend origin used for CORS in production (required)
- `PORT` — Server port (optional, defaults to `4000`)
- `API_URL` — Public API base URL (optional, defaults to `http://localhost:${PORT}`)

### AI providers

- `ANTHROPIC_API_KEY` — Claude (course/lesson/quiz generation, mentor agents) (required)
- `OPENAI_API_KEY` — Embeddings for lesson and product-KB RAG (required)
- `PINECONE_API_KEY` — Vector store for lesson chunks and product KB (required)
- `PINECONE_INDEX_NAME` — Pinecone index name (required)
- `TAVILY_API_KEY` — Web-search tool used by agents (required)
- `JINA_API_KEY` — Web content extraction for ingestion (required)
- `BFL_API_KEY` — Hero-image generation (required)
- `JUDGE0_API_KEY` — Sandboxed code execution in lessons (required)
- `JUDGE0_API_URL` — Judge0 instance base URL (required)

### Auth & email

- `GOOGLE_CLIENT_ID` — Google OAuth client ID (required)
- `MAILJET_API_KEY` — Mailjet transactional + contact-list sync (required)
- `MAILJET_API_SECRET` — Mailjet API secret (required)

### Storage

- `AWS_S3_BUCKET` (required)
- `AWS_S3_REGION` (required)
- `AWS_ACCESS_KEY_ID` (required)
- `AWS_SECRET_ACCESS_KEY` (required)

### Text-to-speech

- `GOOGLE_TTS_PRIVATE_KEY` — Only the `private_key` field of the Google service-account JSON. Newlines must be literal `\n` in the env value; they are restored at read time. The matching `client_email` and `project_id` are hardcoded in [services/googleTtsService.ts](src/services/googleTtsService.ts). This split keeps the value under Elastic Beanstalk's 4096-char CloudFormation parameter ceiling. (required)

### Billing (Stripe)

- `STRIPE_SECRET_KEY` (required)
- `STRIPE_WEBHOOK_SECRET` — Used for raw-body HMAC verification at `/api/stripe/webhook` (required)
- `STRIPE_PRICE_ID_STARTER_MONTHLY` (required)
- `STRIPE_PRICE_ID_STARTER_ANNUAL` (required)
- `STRIPE_PRICE_ID_PRO_MONTHLY` (required)
- `STRIPE_PRICE_ID_PRO_ANNUAL` (required)
- `STRIPE_PRICE_ID_STUDIO_MONTHLY` (required)
- `STRIPE_PRICE_ID_STUDIO_ANNUAL` (required)
- `STRIPE_TAX_ENABLED` — `true` to enable Stripe Tax + address collection at Checkout. Required for EU consumer sales under OSS. Defaults to `false` (optional)

### Observability

- `SENTRY_DSN` — Required outside `development`; in dev, Sentry init is skipped entirely so local runs do not ship to the prod project
- `SENTRY_TRACES_SAMPLE_RATE` — Override the default Sentry sampling rate (optional)
- `MIXPANEL_PROJECT_TOKEN` (required)
- `MIXPANEL_SECRET` (required)
- `METRICS_TOKEN` — Shared secret guarding `/metrics`. When set, scrapers must send `X-Metrics-Token: <value>` or receive 401. When unset, the endpoint stays open (defence-in-depth on top of the network ACL) (optional)

## Operational notes

- **Single-instance deployment.** The job runner, the in-process `EventEmitter` bridge, and Socket.io's in-memory adapter all live in module scope. Horizontal scaling requires a Redis adapter for Socket.io and a distributed job queue. See [wiki/reference/api/architecture.md](../wiki/reference/api/architecture.md).
- **Stripe webhook must remain mounted before the global JSON parser** ([index.ts:74](src/index.ts#L74)) — the HMAC check runs against the exact bytes Stripe sent.
- **Sentry import order** — `import '@conf/sentry'` MUST sit before `express`, `http`, and `mongoose`. Late init silently disables auto-instrumentation.
- **Health endpoints** — `/live` (liveness, dependency-free), `/ready` and `/health` (readiness, pings Mongo with a 2 s race), `/version` (build info from `package.json`), `/metrics` (Prometheus text format).

## Documentation

The wiki under [`/wiki`](../wiki/OVERVIEW.md) is the authoritative reference. Start with:

- [API overview](../wiki/reference/api/OVERVIEW.md)
- [Architecture](../wiki/reference/api/architecture.md)
- [HTTP API surface](../wiki/reference/api/http-api.md)
- [Course generation](../wiki/reference/api/course-generation/OVERVIEW.md)
- [Billing](../wiki/reference/api/billing/OVERVIEW.md)
- [Jobs and realtime](../wiki/reference/api/jobs-and-realtime.md)
