# indexProductKb — Help-Center Article Ingestion

Reads the help-center markdown corpus at `client/src/content/kb/`, embeds each article via OpenAI, and upserts the chunks into the `product-kb` namespace in Pinecone (with chunk text mirrored in Mongo for citation hydration). The output is what the floating help-center chat (`/help` FAB) and the cross-agent `search_product_kb` tool query at runtime.

The script is idempotent and diff-driven: only articles whose content has actually changed get re-embedded. Removed articles get cleaned up. Unchanged articles are skipped — no wasted vendor calls on a no-op run.

## Prerequisites

- `MONGO_URI` set in `api/.env` — script connects directly; no API server needed
- `OPENAI_API_KEY` set — used for embedding (`text-embedding-3-small`, 1536 dims)
- `PINECONE_API_KEY` + `PINECONE_INDEX_NAME` set — same shared index that hosts the lesson-RAG vectors; corpora are kept apart by a `namespace` metadata field

If any of those are missing the underlying RAG service no-ops gracefully — the script still runs, but `result.reason === 'disabled'` will surface for every article.

## Usage

```bash
cd api

# Diff against persisted state and apply the plan (writes to Pinecone + Mongo).
yarn kb:index

# Verbose: print every article that will be re-indexed or deleted.
yarn kb:index --verbose

# Re-embed every article regardless of hash match. Use after an embedding-
# model swap or when a metadata-shape change invalidates the corpus.
yarn kb:index --force

# Read-only diff: exit 0 if in sync, 1 if drift exists. Wire into CI.
yarn kb:check
```

Typical run output:

```
[product-kb] indexing
[product-kb] 11 article(s) on disk
[product-kb] 9 article(s) currently indexed
[product-kb] plan:
  re-index: 2
  delete:   0
  skip:     9
[product-kb] indexed how-strive-teaches/how-spaced-review-works (5 chunks)
[product-kb] indexed plans-and-account/your-privacy-on-strive (6 chunks)
[product-kb] done — 2 indexed, 0 deleted, 9 unchanged, 11 chunks written
```

## Authoring contract

Every `.md` file under `client/src/content/kb/<topic>/<slug>.md` must:

- Start with YAML frontmatter containing **at minimum** `title`, `slug`, `topic`, `summary`. Optional: `tags`, `order`, `updated`, `related`. See [`client/src/lib/kb/types.ts`](../../../client/src/lib/kb/types.ts) for the full shape.
- Have `slug` matching the filename (without `.md`)
- Have `topic` matching the parent folder name
- Have `topic` registered in [`client/src/lib/kb/topics.ts`](../../../client/src/lib/kb/topics.ts)

Files prefixed with `_` (e.g. `_topic.md`) are ignored — reserved for future per-topic metadata. Any frontmatter validation failure exits the script with a clear error and a non-zero status.

## How the diff works

For each on-disk article the script computes `sha256(JSON.stringify(frontmatter) + "\n" + body)` and compares it to the `contentHash` persisted on the article's first chunk in Mongo. The four outcomes:

| Disk state | Persisted state | Action |
| --- | --- | --- |
| Present, hash matches | Present, same hash | **Skip** |
| Present, hash differs | Present, old hash | **Re-index** (wipe prior chunks → re-chunk → re-embed → upsert) |
| Present | Absent | **Re-index** (new article) |
| Absent | Present | **Delete** (drop Mongo + Pinecone vectors) |

Wipe-before-write is the same dance the lesson-RAG path uses — Pinecone serverless can't metadata-delete, so we read the prior `vectorId` set out of Mongo and call `deleteMany({ ids })` before upserting the new vectors.

## Vector layout

- **Vector ID:** `product-kb:${slug}:${chunkIndex}` (slugs are globally unique across topics by construction)
- **Pinecone metadata:** `{ namespace: 'product-kb', topic, articleSlug, articleTitle, sectionPath, chunkIndex }`
- **Mongo collection:** `ProductKbChunk` — full chunk text + denormalized frontmatter + content hash, joined back to Pinecone hits via `vectorId`

Chunking splits the markdown body on H2 headings first; long sections fall through to paragraph splitting with a 150-char overlap. Code fences and table rows stay atomic regardless of length. Implementation lives in [`api/src/services/productKbRagService.ts`](../../src/services/productKbRagService.ts).

## CI integration

`yarn kb:check` is the contract for "the index is in sync with disk". Wire it into the deploy pipeline before the production cutover so an editor who forgets to run `kb:index` after authoring an article gets a loud build failure instead of a quietly-stale chat.

## Cost

Per article re-index: one embedding batch (~500–600 tokens for a typical article ≈ ¢0.001) + one Pinecone upsert (5 WU minimum ≈ ¢0.0002). The full 11-article corpus re-indexes for well under a cent. Skipped articles cost nothing.

Costs are recorded via the same `recordUsage` pipeline as lesson RAG, with action labels `embedding:index` and `upsert:product-kb` for ledger separation.

## Troubleshooting

- **"frontmatter.slug=X ≠ filename=Y"** — rename the file or the frontmatter `slug` so they match. The validator catches this at load time.
- **"Topic X is not registered in topics.ts"** — add a config entry to `client/src/lib/kb/topics.ts`. The validator refuses to write chunks for an unregistered topic so the help-center UI can never surface an article whose folder it doesn't know how to render.
- **All articles report `reason=disabled`** — `OPENAI_API_KEY` or `PINECONE_*` env vars are missing. Check `api/.env`.
- **`yarn kb:check` fails in CI but `yarn kb:index` succeeds locally** — the manifest in Mongo is ahead of the deployed snapshot. Run `kb:index` against the production database (or the deploy-time database) before cutover.
