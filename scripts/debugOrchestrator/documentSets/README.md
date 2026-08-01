# Document sets — orchestrator documents mode

Each subfolder here is one **document set**: a corpus the orchestrator
uploads to a `source: 'documents'` course when run with `--documents`.

```
documentSets/
  generate-sample-sets.ts   ← committed generator (this + README are the only tracked files)
  README.md                 ← you are here
  sample-basic/             ← generated, gitignored
    spaced-repetition-lecture.pdf
    memory-and-retrieval-handout.docx
    study-notes.md
    manifest.json
  sample-mixed/             ← generated, gitignored
    statistics-lecture.pdf
    inference-handout.docx
    lecture-notes.md
    summary-statistics.csv
    scanned-problem-sheets.pdf
    manifest.json
```

## Build the samples

```bash
cd api
yarn debug:orchestrator:sets
```

Idempotent — it wipes and rewrites `sample-basic/` and `sample-mixed/`.
Every byte is produced by the api's own extraction fixture builders
(`src/services/documentExtraction/__fixtures__/builders.ts`), the same ones
the unit tests and `yarn debug:ingest` use, so the formats these sets carry
are formats the extractor router genuinely supports.

| Set | Contents | Exercises |
| --- | --- | --- |
| `sample-basic` | text-rich pdf + docx + md on spaced repetition | happy path; no deferred extraction, so `prepare_corpus` records "no preparation needed" |
| `sample-mixed` | statistics pdf + docx + md + csv + a **scanned-look** pdf, plus a Wikipedia URL in the manifest | scanned-page detection → the debited `prepare_corpus` pass; csv extraction; URL ingestion |

## Adding your own set

Create a folder, drop real files in it, optionally add `manifest.json`:

```json
{
  "urls": ["https://example.com/an-article"],
  "note": "one-line description of what this corpus is",
  "expectedTopics": ["topic a", "topic b"]
}
```

- **`urls`** — registered via `POST /api/course/:id/documents/url` (public
  http(s) only; the server rejects private hosts and IP literals).
- **`note`** — shown to the persona generator so the persona plausibly owns
  the corpus, and printed in the report's *Source Document Set* section.
- **`expectedTopics`** — **not** sent to the API. It is the set author's
  ground truth, surfaced in the report so the assessment rubric's
  Domain-K row K2 (analysis honesty) can compare the server's detected
  topics against what the corpus actually contains.

Everything except `manifest.json`, `README.md`, dotfiles and `.ts`/`.js`
files counts as a corpus file. Uploads that the server rejects (unsupported
type, cap exceeded, bytes/extension mismatch) are **recorded and the run
continues** — a deliberately-rejected file is a valid thing to put in a set.

Then run:

```bash
yarn debug:orchestrator --documents --document-set my-set --concurrency 1 --personas 1 --lessons 1
```

Or one set per persona (count must equal `--personas`):

```bash
yarn debug:orchestrator --documents --document-sets "sample-basic,sample-mixed" --concurrency 2 --personas 2 --lessons 1
```

## Caps to respect (api A9)

≤10 files and ≤10 URLs per course, ≤50 MB per file, ≤300 pages / ~600k
extracted tokens per corpus, ≤3 ingest runs per course per day, ≤5
document courses per user per day. Each persona gets its own fresh test
user, so the per-user caps are effectively per-persona; the per-course caps
bound a single set.
