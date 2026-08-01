import { Pinecone, type Index, type RecordMetadata } from '@pinecone-database/pinecone';
import { PINECONE_API_KEY, PINECONE_INDEX_NAME } from '@conf/env';
import { recordUsage } from '@services/usageService';
import { priceFlatUnit } from '@lib/pricing';
import { ragLog } from '@lib/loggers';

/**
 * Pinecone client wrapper used by the lesson-RAG path.
 *
 * Singleton + lazy init so missing credentials (dev environments
 * without RAG configured) don't crash at boot. `isPineconeEnabled()`
 * gates every call site — when false, indexing/search no-op.
 *
 * Index layout:
 *   - One Pinecone serverless index, dimension 1536 (matches
 *     text-embedding-3-small), cosine similarity.
 *   - Records keyed by `${courseId}:${moduleIndex}:${lessonIndex}:${chunkIndex}`.
 *   - Metadata holds courseId / moduleIndex / lessonIndex for filtered
 *     queries (mentor search is always scoped to one course; can also
 *     scope to a module if we want narrower retrieval later).
 *   - Chunk text is NOT stored in Pinecone metadata — that's the
 *     LessonChunkModel's job. Pinecone stores just enough to filter
 *     and identify; we hydrate text via Mongo on the read path.
 *
 * Index creation is a one-time manual step (Pinecone CLI / dashboard).
 * The index name is read from PINECONE_INDEX_NAME env var so dev/staging/
 * prod can each point at a separate index.
 */

export interface ChunkVectorRecord {
  id: string;
  embedding: number[];
  metadata: {
    courseId: string;
    moduleIndex: number;
    lessonIndex: number;
    chunkIndex: number;
    blockType: string;
  };
}

let client: Pinecone | null = null;
let cachedIndex: Index<RecordMetadata> | null = null;

const getClient = (): Pinecone | null => {
  if (!PINECONE_API_KEY || !PINECONE_INDEX_NAME) return null;
  if (!client) client = new Pinecone({ apiKey: PINECONE_API_KEY });
  return client;
};

const getIndex = (): Index<RecordMetadata> | null => {
  if (cachedIndex) return cachedIndex;
  const c = getClient();
  if (!c) return null;
  cachedIndex = c.index(PINECONE_INDEX_NAME);
  return cachedIndex;
};

export const isPineconeEnabled = (): boolean =>
  Boolean(PINECONE_API_KEY && PINECONE_INDEX_NAME);

/**
 * Estimate Pinecone Write Units for an upsert payload. Pinecone bills 1 WU
 * per KB of request body with a 5 WU minimum. We compute the on-the-wire
 * size from the JSON-serialized payload (the same shape the SDK sends).
 *
 * Float arrays serialized to JSON are larger than their binary
 * representation (~12 chars per number vs 4 bytes), so this is the right
 * surface to measure — it matches what Pinecone bills against.
 */
const estimateUpsertWUs = (payload: unknown): number => {
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  const kb = Math.ceil(bytes / 1024);
  return Math.max(5, kb);
};

/**
 * Upsert a batch of chunk vectors. Pinecone's upsert is idempotent on id,
 * so re-indexing the same lesson overwrites in place — no manual delete-
 * then-write dance needed for re-runs of the same `(course, module, lesson)`.
 *
 * Returns true on success, false on any failure (caller can log + continue).
 * On success, records WU cost via `recordUsage({ service: 'pinecone' })` so
 * the active job's spend accumulator captures it for credit debit.
 */
export const upsertChunkVectors = async (records: ChunkVectorRecord[]): Promise<boolean> => {
  if (records.length === 0) return true;
  const idx = getIndex();
  if (!idx) return false;

  const payload = {
    records: records.map((r) => ({
      id: r.id,
      values: r.embedding,
      metadata: r.metadata,
    })),
  };

  try {
    await idx.upsert(payload);

    const wu = estimateUpsertWUs(payload);
    const cost = priceFlatUnit({ sku: 'pinecone_write_unit', units: wu });
    recordUsage({
      service: 'pinecone',
      action: 'upsert',
      costMicroCents: cost,
      metadata: { wu, recordCount: records.length },
    });

    // Sample log of the first id so the operator can verify the namespacing
    // pattern (`${courseId}:${moduleIndex}:${lessonIndex}:${chunkIndex}`) at
    // a glance — useful when chasing isolation bugs.
    ragLog.info(
      `pinecone:upsert ok records=${records.length} wu=${wu} cost=µ¢${cost} firstId=${records[0]?.id}`,
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ragLog.error(`pinecone:upsert fail records=${records.length} msg=${message}`);
    return false;
  }
};

/**
 * Delete all vectors for a (courseId, moduleIndex, lessonIndex). Used on
 * lesson regeneration to wipe stale chunks before re-indexing — keeps
 * Pinecone aligned with the LessonChunkModel collection (which is also
 * deleted before re-chunking).
 *
 * NOTE: Pinecone serverless does NOT support metadata-filtered delete on
 * the main namespace — we have to enumerate chunkIndex to build IDs.
 * Acceptable because we know the prior chunk count from the Mongo store.
 */
export const deleteChunkVectorsByIds = async (ids: string[]): Promise<boolean> => {
  if (ids.length === 0) return true;
  const idx = getIndex();
  if (!idx) return false;

  try {
    await idx.deleteMany({ ids });
    ragLog.info(`pinecone:delete ok ids=${ids.length}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ragLog.error(`pinecone:delete fail ids=${ids.length} msg=${message}`);
    return false;
  }
};

export interface VectorSearchHit {
  id: string;
  score: number;
  metadata: {
    courseId: string;
    moduleIndex: number;
    lessonIndex: number;
    chunkIndex: number;
    blockType: string;
  };
}

// ── Generic upsert/query (used by non-lesson corpora, e.g. product KB) ──
//
// The lesson-specific `upsertChunkVectors` / `queryChunks` above bake in the
// course-scoped metadata shape. Other corpora (the product knowledge base,
// future namespaces) need a more permissive contract: arbitrary scalar
// metadata + arbitrary equality-filter shape on read. The two surfaces
// share the same Pinecone client and the same cost-recording rules, but
// keep their type contracts independent so a metadata-shape change in one
// path can't quietly break the other.

export interface GenericVectorRecord {
  id: string;
  embedding: number[];
  metadata: Record<string, string | number | boolean>;
}

export interface GenericVectorHit {
  id: string;
  score: number;
  metadata: Record<string, string | number | boolean | undefined>;
}

/**
 * Upsert a batch of vectors with arbitrary metadata. Same Pinecone idempotency
 * + cost-recording semantics as `upsertChunkVectors`. Pass an `action` label
 * for cost-attribution analytics — typical values: `'upsert:product-kb'`,
 * `'upsert:course-rag'`. Distinct labels keep the ledger separable per corpus.
 */
export const upsertVectors = async (
  records: GenericVectorRecord[],
  { action }: { action: string },
): Promise<boolean> => {
  if (records.length === 0) return true;
  const idx = getIndex();
  if (!idx) return false;

  const payload = {
    records: records.map((r) => ({
      id: r.id,
      values: r.embedding,
      metadata: r.metadata,
    })),
  };

  try {
    await idx.upsert(payload);

    const wu = estimateUpsertWUs(payload);
    const cost = priceFlatUnit({ sku: 'pinecone_write_unit', units: wu });
    recordUsage({
      service: 'pinecone',
      action,
      costMicroCents: cost,
      metadata: { wu, recordCount: records.length },
    });

    ragLog.info(
      `pinecone:upsert(${action}) ok records=${records.length} wu=${wu} cost=µ¢${cost} firstId=${records[0]?.id}`,
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ragLog.error(`pinecone:upsert(${action}) fail records=${records.length} msg=${message}`);
    return false;
  }
};

/**
 * Query the index with an arbitrary equality filter. Caller specifies the
 * filter shape (e.g. `{ namespace: 'product-kb' }`); the helper handles
 * cost recording + metadata typing. Defense-in-depth filtering should
 * happen in the caller's service layer (re-verify metadata after the
 * Pinecone response, just like `searchLessonContent` does).
 */
export const queryVectors = async ({
  embedding,
  filter,
  topK = 5,
  action,
}: {
  embedding: number[];
  filter: Record<string, string | number | boolean>;
  topK?: number;
  action: string;
}): Promise<GenericVectorHit[]> => {
  const idx = getIndex();
  if (!idx) return [];

  try {
    const result = await idx.query({
      vector: embedding,
      topK,
      filter,
      includeMetadata: true,
    });

    const ru = 0.25;
    const cost = priceFlatUnit({ sku: 'pinecone_read_unit', units: ru });
    recordUsage({
      service: 'pinecone',
      action,
      costMicroCents: cost,
      metadata: { ru, topK, filter },
    });

    const matches = (result.matches ?? [])
      .filter((m) => m.metadata && typeof m.score === 'number')
      .map((m) => ({
        id: m.id,
        score: m.score as number,
        metadata: m.metadata as GenericVectorHit['metadata'],
      }));
    ragLog.info(
      `pinecone:query(${action}) ok filter=${JSON.stringify(filter)} topK=${topK} hits=${matches.length} ru=${ru} cost=µ¢${cost}`,
    );
    return matches;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ragLog.error(`pinecone:query(${action}) fail msg=${message}`);
    return [];
  }
};

/**
 * Delete a batch of vectors by id. Same wire contract as
 * `deleteChunkVectorsByIds` but without the lesson-specific log tagging,
 * so other corpora can reuse it without inheriting lesson-coloured logs.
 */
export const deleteVectorsByIds = async (
  ids: string[],
  { action }: { action: string },
): Promise<boolean> => {
  if (ids.length === 0) return true;
  const idx = getIndex();
  if (!idx) return false;

  try {
    await idx.deleteMany({ ids });
    ragLog.info(`pinecone:delete(${action}) ok ids=${ids.length}`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ragLog.error(`pinecone:delete(${action}) fail ids=${ids.length} msg=${message}`);
    return false;
  }
};

/**
 * Fetch-by-id existence probe: returns the subset of `ids` that exist in
 * the index. Read-only, used by verification harnesses (debug:ingest's
 * zero-orphan proof) — not a retrieval surface, so no cost recording
 * (Pinecone fetches are billed like queries but this only ever runs from
 * operator scripts outside a usage scope).
 */
export const fetchVectorIds = async (ids: string[]): Promise<string[]> => {
  if (ids.length === 0) return [];
  const idx = getIndex();
  if (!idx) return [];

  try {
    const found: string[] = [];
    // Pinecone caps fetch at ~1000 ids per call; slice defensively.
    for (let i = 0; i < ids.length; i += 500) {
      const res = await idx.fetch({ ids: ids.slice(i, i + 500) });
      found.push(...Object.keys(res.records ?? {}));
    }
    return found;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ragLog.error(`pinecone:fetch fail ids=${ids.length} msg=${message}`);
    return [];
  }
};

/**
 * Query the index for the top-K most similar chunks within a course
 * (and optionally a single module). Returns vector ids + scores; the
 * caller hydrates chunk text via LessonChunkModel.
 */
export const queryChunks = async ({
  embedding,
  courseId,
  moduleIndex,
  topK = 5,
}: {
  embedding: number[];
  courseId: string;
  moduleIndex?: number;
  topK?: number;
}): Promise<VectorSearchHit[]> => {
  const idx = getIndex();
  if (!idx) return [];

  const filter: Record<string, unknown> = { courseId };
  if (moduleIndex !== undefined) filter.moduleIndex = moduleIndex;

  try {
    const result = await idx.query({
      vector: embedding,
      topK,
      filter,
      includeMetadata: true,
    });

    // Pinecone RU model: 1 RU per GB of namespace, 0.25 RU minimum per query.
    // The SDK doesn't return RUs in the response, so we use the conservative
    // floor: 0.25 RU per query. Once any single namespace exceeds 0.25 GB
    // (~32k vectors at 1536-dim float32 + small metadata), this will
    // under-bill and we'd need to fetch describeIndexStats() periodically
    // and scale RUs ∝ namespaceSize. For our scale (one shared index across
    // courses, lesson chunks only), 0.25 GB lands somewhere around 30k+
    // chunks total — visible threshold to watch.
    const ru = 0.25;
    const cost = priceFlatUnit({ sku: 'pinecone_read_unit', units: ru });
    recordUsage({
      service: 'pinecone',
      action: 'query',
      costMicroCents: cost,
      metadata: { ru, topK, filter },
    });

    const matches = (result.matches ?? [])
      .filter((m) => m.metadata && typeof m.score === 'number')
      .map((m) => ({
        id: m.id,
        score: m.score as number,
        metadata: m.metadata as VectorSearchHit['metadata'],
      }));
    ragLog.info(
      `pinecone:query ok filter=${JSON.stringify(filter)} topK=${topK} hits=${matches.length} ru=${ru} cost=µ¢${cost}`,
    );
    return matches;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ragLog.error(`pinecone:query fail msg=${message}`);
    return [];
  }
};
