import { Pinecone, type Index, type RecordMetadata } from '@pinecone-database/pinecone';
import { PINECONE_API_KEY, PINECONE_INDEX_NAME } from '@conf/env';
import { recordUsage } from '@services/usageService';
import { priceFlatUnit } from '@lib/pricing';

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
    console.log(
      `[pinecone] upsert OK — ${records.length} records, ${wu} WU (${cost} μ¢ vendor), first id=${records[0]?.id}`.gray,
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pinecone] upsert FAILED (${records.length} records): ${message}`.red);
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
    console.log(`[pinecone] delete OK — ${ids.length} ids`.gray);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pinecone] delete FAILED (${ids.length} ids): ${message}`.red);
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
    console.log(
      `[pinecone] query OK — filter=${JSON.stringify(filter)} topK=${topK} → ${matches.length} matches, ${ru} RU (${cost} μ¢ vendor)`.gray,
    );
    return matches;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pinecone] query FAILED: ${message}`.red);
    return [];
  }
};
