import { Types } from 'mongoose';
import LessonChunkModel from '@models/LessonChunkModel';
import type { ILessonBlock } from '@models/LessonContentModel';
import { embedBatch, embedQuery, isEmbeddingsEnabled } from '@lib/openaiEmbeddings';
import {
  upsertChunkVectors,
  deleteChunkVectorsByIds,
  queryChunks,
  isPineconeEnabled,
  type ChunkVectorRecord,
} from '@lib/pinecone';
import { bgError } from '@lib/bg';
import { ragLog } from '@lib/loggers';

/**
 * Lesson-level RAG orchestration.
 *
 * Two entry points:
 *   - `indexLessonContent(...)` — invoked from the jobRunner after
 *     generate_lesson completes successfully. Chunks the lesson blocks,
 *     embeds them, persists to Mongo + Pinecone. Idempotent: re-running
 *     for the same (course, module, lesson) wipes prior chunks first.
 *   - `searchLessonContent(...)` — invoked by the mentor agent's
 *     `search_lesson_content` tool. Embeds the query, queries Pinecone,
 *     hydrates chunk text from Mongo, returns formatted results.
 *
 * Both no-op gracefully when OpenAI or Pinecone are not configured.
 *
 * Chunking strategy (v1):
 *   - Each LessonContent block becomes one chunk if its content fits in
 *     the soft-cap (CHUNK_TARGET_CHARS). Long sections split on paragraph
 *     boundaries. Non-text block types (image, mermaid, links) are
 *     skipped — searching against them returns garbage.
 *   - The block id + type are preserved on each chunk so the mentor can
 *     surface "from the section about X" when synthesizing answers.
 */

const CHUNK_TARGET_CHARS = 1500; // ~375 tokens; well under the 8k embed limit
const CHUNK_OVERLAP_CHARS = 150; // bridge boundary context for long blocks

const INDEXABLE_BLOCK_TYPES = new Set(['intro', 'section', 'code', 'callout', 'summary']);

interface LessonChunkInput {
  blockId: string;
  blockType: string;
  text: string;
}

/**
 * Split a single block into chunks at paragraph boundaries when it
 * exceeds the target size. For typical lesson blocks (a few paragraphs)
 * this is a no-op — the whole block goes through as one chunk. Code
 * blocks are kept whole regardless of length, since splitting code mid-
 * function destroys retrieval value.
 */
const splitBlockIntoChunks = (block: ILessonBlock): LessonChunkInput[] => {
  const text = block.content?.trim() ?? '';
  if (!text) return [];

  if (block.type === 'code' || text.length <= CHUNK_TARGET_CHARS) {
    return [{ blockId: block.id, blockType: block.type, text }];
  }

  // Split on double-newline (paragraphs); fall back to single-newline if a
  // block is one giant wall of text.
  const paragraphs = text.split(/\n\n+/).flatMap((p) => (p.length > CHUNK_TARGET_CHARS ? p.split(/\n+/) : [p]));

  const chunks: LessonChunkInput[] = [];
  let buffer = '';

  for (const para of paragraphs) {
    if (buffer.length + para.length + 2 > CHUNK_TARGET_CHARS && buffer.length > 0) {
      chunks.push({ blockId: block.id, blockType: block.type, text: buffer.trim() });
      // Carry overlap so the next chunk has context from the prior one.
      buffer = buffer.slice(-CHUNK_OVERLAP_CHARS) + '\n\n' + para;
    } else {
      buffer = buffer ? buffer + '\n\n' + para : para;
    }
  }
  if (buffer.trim()) chunks.push({ blockId: block.id, blockType: block.type, text: buffer.trim() });
  return chunks;
};

const buildVectorId = ({
  courseId,
  moduleIndex,
  lessonIndex,
  chunkIndex,
}: {
  courseId: string;
  moduleIndex: number;
  lessonIndex: number;
  chunkIndex: number;
}): string => `${courseId}:${moduleIndex}:${lessonIndex}:${chunkIndex}`;

/**
 * Index a freshly-generated lesson. Safe to call without any
 * pre-checks — no-ops when RAG is disabled or no indexable blocks
 * exist. Errors are logged + swallowed; failure to index never
 * blocks the user-facing lesson generation.
 */
export const indexLessonContent = async ({
  courseId,
  moduleIndex,
  lessonIndex,
  blocks,
}: {
  courseId: string;
  moduleIndex: number;
  lessonIndex: number;
  blocks: ILessonBlock[];
}): Promise<void> => {
  const coord = `${courseId}/${moduleIndex}/${lessonIndex}`;

  if (!isEmbeddingsEnabled() || !isPineconeEnabled()) {
    ragLog.info(`index:skip lesson=${coord} reason=disabled (missing OPENAI/PINECONE keys)`);
    return;
  }

  const t0 = Date.now();
  const courseObjectId = new Types.ObjectId(courseId);

  // Build chunk inputs from indexable blocks, preserving block-relative order.
  const indexableBlocks = blocks.filter((b) => INDEXABLE_BLOCK_TYPES.has(b.type));
  const chunkInputs: LessonChunkInput[] = indexableBlocks
    .sort((a, b) => a.order - b.order)
    .flatMap(splitBlockIntoChunks);

  ragLog.info(
    `index:start lesson=${coord} blocks=${blocks.length} indexable=${indexableBlocks.length} chunks=${chunkInputs.length}`,
  );

  if (chunkInputs.length === 0) {
    ragLog.info(`index:skip lesson=${coord} reason=no_indexable_content`);
    return;
  }

  // Wipe prior chunks (Mongo) + their vectors (Pinecone). Pinecone needs
  // explicit ids since serverless doesn't support metadata-filtered delete.
  const priorChunks = await LessonChunkModel.find({
    courseId: courseObjectId,
    moduleIndex,
    lessonIndex,
  })
    .select('vectorId')
    .lean();

  if (priorChunks.length > 0) {
    ragLog.info(`index:wipe-prior lesson=${coord} chunks=${priorChunks.length}`);
    await Promise.all([
      LessonChunkModel.deleteMany({ courseId: courseObjectId, moduleIndex, lessonIndex }).catch(
        bgError('lessonRag.deleteMongoChunks'),
      ),
      deleteChunkVectorsByIds(priorChunks.map((c) => c.vectorId)).catch(
        bgError('lessonRag.deletePineconeChunks') as (e: unknown) => boolean,
      ),
    ]);
  }

  // Embed in one batch — OpenAI accepts up to 2048 inputs per call and a
  // typical lesson produces 5-20 chunks. If we ever exceed the limit,
  // chunking the API request itself goes here.
  const totalChars = chunkInputs.reduce((sum, c) => sum + c.text.length, 0);
  const embedT0 = Date.now();
  const embeddings = await embedBatch(
    chunkInputs.map((c) => c.text),
    { action: 'embedding:index' },
  );
  if (!embeddings) {
    ragLog.warn(`index:embed-fail lesson=${coord} chunks=${chunkInputs.length} chars=${totalChars}`);
    return;
  }
  ragLog.info(
    `index:embed-ok lesson=${coord} vectors=${embeddings.length} dim=${embeddings[0]?.length ?? 0} chars=${totalChars} ms=${Date.now() - embedT0}`,
  );

  const now = new Date();
  const records: ChunkVectorRecord[] = [];
  const chunkDocs = chunkInputs.map((input, chunkIndex) => {
    const vectorId = buildVectorId({ courseId, moduleIndex, lessonIndex, chunkIndex });
    records.push({
      id: vectorId,
      embedding: embeddings[chunkIndex],
      metadata: {
        courseId,
        moduleIndex,
        lessonIndex,
        chunkIndex,
        blockType: input.blockType,
      },
    });
    return {
      courseId: courseObjectId,
      moduleIndex,
      lessonIndex,
      chunkIndex,
      blockId: input.blockId,
      blockType: input.blockType,
      text: input.text,
      // Approximation: chars/4 ~= tokens for English. Used for analytics
      // only; cost is recorded from the actual API response usage.
      tokenCount: Math.ceil(input.text.length / 4),
      embeddedAt: now,
      vectorId,
    };
  });

  // Upsert vectors first; if Pinecone fails we don't want orphan Mongo
  // chunks (they'd point at non-existent vectorIds). Mongo write is
  // committed only on Pinecone success.
  const upserted = await upsertChunkVectors(records);
  if (!upserted) {
    ragLog.warn(`index:abort lesson=${coord} reason=pinecone_upsert_failed`);
    return;
  }

  const inserted = await LessonChunkModel.insertMany(chunkDocs).catch((e) => {
    bgError('lessonRag.insertMongoChunks')(e);
    return null;
  });

  ragLog.info(
    `index:done lesson=${coord} chunks=${chunkInputs.length} mongo=${inserted ? inserted.length : 'fail'} ms=${Date.now() - t0}`,
  );
};

/**
 * Wipe every chunk + Pinecone vector for a course. Called from
 * `cleanupCourseContent` so course deletion / structure regeneration /
 * user account deletion all cascade through this single primitive.
 *
 * Mongo holds the source-of-truth list of vectorIds. We pull that, delete
 * Pinecone vectors by id (the only delete shape the serverless tier
 * supports without metadata-filtered delete), then drop the Mongo rows.
 *
 * Returns counts so the caller can include them in its cleanup report.
 * No-ops gracefully when there are no chunks for the course.
 */
export const deleteLessonChunksForCourse = async (
  courseId: string,
): Promise<{ chunksDeleted: number; vectorsDeleted: number }> => {
  const courseObjectId = new Types.ObjectId(courseId);

  const chunks = await LessonChunkModel.find({ courseId: courseObjectId })
    .select('vectorId')
    .lean();

  if (chunks.length === 0) {
    return { chunksDeleted: 0, vectorsDeleted: 0 };
  }

  const vectorIds = chunks.map((c) => c.vectorId);

  // Delete in parallel — failure of either path is logged but doesn't abort
  // the other. An orphan Mongo row pointing at a missing Pinecone vector
  // is recoverable (search just won't return it); the inverse is also
  // recoverable (a Pinecone vector with no Mongo row gets filtered out
  // during search hydration).
  const [mongoResult, pineconeOk] = await Promise.all([
    LessonChunkModel.deleteMany({ courseId: courseObjectId }),
    deleteChunkVectorsByIds(vectorIds),
  ]);

  ragLog.info(
    `cleanup:course course=${courseId} chunks=${mongoResult.deletedCount} vectors=${pineconeOk ? vectorIds.length : 0}`,
  );

  return {
    chunksDeleted: mongoResult.deletedCount,
    vectorsDeleted: pineconeOk ? vectorIds.length : 0,
  };
};

export interface LessonRagSearchResult {
  blockType: string;
  text: string;
  moduleIndex: number;
  lessonIndex: number;
  score: number;
}

/**
 * Search across all indexed lesson chunks for a course (or one module).
 * Returns the chunks ranked by similarity — caller formats them for the
 * mentor's tool result. Returns empty array when RAG is disabled, the
 * embed call fails, or there are no chunks for the course.
 */
export const searchLessonContent = async ({
  courseId,
  query,
  moduleIndex,
  topK = 5,
}: {
  courseId: string;
  query: string;
  moduleIndex?: number;
  topK?: number;
}): Promise<LessonRagSearchResult[]> => {
  const scope = `${courseId}${moduleIndex !== undefined ? `/m${moduleIndex}` : ''}`;

  if (!isEmbeddingsEnabled() || !isPineconeEnabled()) {
    ragLog.info(`query:skip scope=${scope} reason=disabled`);
    return [];
  }

  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    ragLog.info(`query:skip scope=${scope} reason=empty_query`);
    return [];
  }

  const t0 = Date.now();
  ragLog.info(`query:start scope=${scope} q="${trimmedQuery.slice(0, 80)}${trimmedQuery.length > 80 ? '…' : ''}" topK=${topK}`);

  const queryEmbedding = await embedQuery(trimmedQuery);
  if (!queryEmbedding) {
    ragLog.warn(`query:embed-fail scope=${scope}`);
    return [];
  }

  const hits = await queryChunks({
    embedding: queryEmbedding,
    courseId,
    moduleIndex,
    topK,
  });
  if (hits.length === 0) {
    ragLog.info(`query:miss scope=${scope} ms=${Date.now() - t0}`);
    return [];
  }

  // Defense-in-depth: even though queryChunks always passes filter:{courseId},
  // explicitly verify every hit's metadata.courseId matches before returning.
  // A drift between Pinecone filter behavior and this expectation would be
  // a critical isolation bug — make it visible.
  const stray = hits.filter((h) => h.metadata.courseId !== courseId);
  if (stray.length > 0) {
    ragLog.error(
      `query:isolation-violation scope=${scope} foreign=${stray.length} ids=${stray.map((s) => s.id).join(',')}`,
    );
  }
  const safeHits = hits.filter((h) => h.metadata.courseId === courseId);

  const chunks = await LessonChunkModel.find({ vectorId: { $in: safeHits.map((h) => h.id) } })
    .select('vectorId blockType text moduleIndex lessonIndex')
    .lean();

  // Preserve Pinecone's ranking order by joining via vectorId.
  const byVectorId = new Map(chunks.map((c) => [c.vectorId, c]));
  const results = safeHits
    .map((h) => {
      const c = byVectorId.get(h.id);
      if (!c) return null;
      return {
        blockType: c.blockType,
        text: c.text,
        moduleIndex: c.moduleIndex,
        lessonIndex: c.lessonIndex,
        score: h.score,
      };
    })
    .filter((r): r is LessonRagSearchResult => r !== null);

  const topScore = results[0]?.score ?? 0;
  ragLog.info(
    `query:hits scope=${scope} hits=${results.length}/${hits.length} topScore=${topScore.toFixed(3)} ms=${Date.now() - t0}`,
  );

  return results;
};
