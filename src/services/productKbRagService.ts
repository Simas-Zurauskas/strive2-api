import ProductKbChunkModel from '@models/ProductKbChunkModel';
import { embedBatch, embedQuery, isEmbeddingsEnabled } from '@lib/openaiEmbeddings';
import {
  deleteVectorsByIds,
  isPineconeEnabled,
  queryVectors,
  upsertVectors,
  type GenericVectorRecord,
} from '@lib/pinecone';
import { bgError } from '@lib/bg';
import { ragLog } from '@lib/loggers';

/**
 * Product knowledge-base RAG orchestration.
 *
 * Mirrors `lessonRagService` for a different corpus: hand-authored markdown
 * articles under `client/src/content/kb/` instead of generated lesson blocks.
 *
 * Two entry points:
 *   - `indexProductKbArticle(...)` — invoked from the ingestion script
 *     (`api/scripts/indexProductKb.ts`) when an article changes. Chunks the
 *     markdown body, embeds, persists to Mongo + Pinecone. Idempotent on slug.
 *   - `searchProductKb(...)` — invoked by the product-KB chat agent's
 *     `search_product_kb` tool (and, in Phase 3, by the lesson mentor +
 *     course-design agents). Embeds the query, queries Pinecone scoped to
 *     the `product-kb` namespace, hydrates chunk text from Mongo.
 *
 * Both no-op gracefully when OpenAI or Pinecone are not configured.
 *
 * Chunking strategy:
 *   - Markdown is split on `## ` H2 headings to preserve narrative section
 *     boundaries (a section is the smallest unit the agent can cite by
 *     name). Long sections split further on paragraph boundaries with
 *     overlap. Fenced code blocks and tables stay whole.
 *   - Each chunk carries its `sectionPath` ("Article title › H2 heading")
 *     so search results render as concrete citations rather than opaque
 *     ranges.
 */

const NAMESPACE = 'product-kb';
const CHUNK_TARGET_CHARS = 1500;
const CHUNK_OVERLAP_CHARS = 150;

interface MarkdownChunk {
  sectionPath: string;
  text: string;
}

/**
 * Split a markdown body into ordered chunks, keyed by their parent H2
 * heading. The article title is treated as the implicit H1 — every chunk
 * carries it as the first segment of its `sectionPath`.
 *
 * Pre-section content (anything before the first `## ` heading) is its own
 * "intro" chunk and gets the article title alone as its sectionPath.
 *
 * Inside a section, content longer than `CHUNK_TARGET_CHARS` is split on
 * blank-line paragraph boundaries with `CHUNK_OVERLAP_CHARS` of bridge
 * carry-over. Code fences and tables are protected: the splitter treats
 * any paragraph starting with ``` or | as atomic.
 */
const splitMarkdownIntoChunks = ({
  articleTitle,
  body,
}: {
  articleTitle: string;
  body: string;
}): MarkdownChunk[] => {
  const trimmed = body.trim();
  if (!trimmed) return [];

  // Pull all H2 sections. Lines starting with `## ` open a new section; the
  // heading text becomes the sectionPath suffix. Higher-order headings (###,
  // ####) stay inside the H2 they live under — the citation granularity is
  // intentionally coarse so the agent has room to quote across them.
  const sections: { heading: string | null; lines: string[] }[] = [
    { heading: null, lines: [] },
  ];

  const lines = trimmed.split('\n');
  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      sections.push({ heading: h2[1], lines: [] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }

  const chunks: MarkdownChunk[] = [];

  for (const section of sections) {
    const sectionText = section.lines.join('\n').trim();
    if (!sectionText) continue;

    const sectionPath = section.heading
      ? `${articleTitle} › ${section.heading}`
      : articleTitle;

    if (sectionText.length <= CHUNK_TARGET_CHARS) {
      chunks.push({ sectionPath, text: sectionText });
      continue;
    }

    // Long section — split on paragraphs (double newline). Code fences and
    // table rows stay atomic regardless of length so retrieval doesn't
    // surface mid-block fragments.
    const paragraphs = sectionText
      .split(/\n\n+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    let buffer = '';
    for (const para of paragraphs) {
      const isAtomic = para.startsWith('```') || para.startsWith('|');
      if (
        buffer.length > 0 &&
        (isAtomic || buffer.length + para.length + 2 > CHUNK_TARGET_CHARS)
      ) {
        chunks.push({ sectionPath, text: buffer.trim() });
        buffer = buffer.slice(-CHUNK_OVERLAP_CHARS) + '\n\n' + para;
      } else {
        buffer = buffer ? buffer + '\n\n' + para : para;
      }
    }
    if (buffer.trim()) chunks.push({ sectionPath, text: buffer.trim() });
  }

  return chunks;
};

const buildVectorId = ({ articleSlug, chunkIndex }: { articleSlug: string; chunkIndex: number }): string =>
  `${NAMESPACE}:${articleSlug}:${chunkIndex}`;

export interface IndexProductKbArticleInput {
  topic: string;
  articleSlug: string;
  articleTitle: string;
  body: string;
  contentHash: string;
}

export interface IndexProductKbArticleResult {
  ok: boolean;
  chunksWritten: number;
  reason?: 'disabled' | 'empty' | 'embed_failed' | 'pinecone_failed';
}

/**
 * Index (or re-index) a single article. Wipes prior chunks for the slug
 * before writing new ones, so this is idempotent and safe to call on every
 * content change. Returns counts so the ingestion script can report drift.
 */
export const indexProductKbArticle = async (
  input: IndexProductKbArticleInput,
): Promise<IndexProductKbArticleResult> => {
  const { topic, articleSlug, articleTitle, body, contentHash } = input;
  const tag = `${NAMESPACE}/${articleSlug}`;

  if (!isEmbeddingsEnabled() || !isPineconeEnabled()) {
    ragLog.info(`pkb:index:skip article=${tag} reason=disabled`);
    return { ok: false, chunksWritten: 0, reason: 'disabled' };
  }

  const chunkInputs = splitMarkdownIntoChunks({ articleTitle, body });
  if (chunkInputs.length === 0) {
    ragLog.info(`pkb:index:skip article=${tag} reason=empty`);
    return { ok: false, chunksWritten: 0, reason: 'empty' };
  }

  const t0 = Date.now();
  ragLog.info(`pkb:index:start article=${tag} chunks=${chunkInputs.length}`);

  // Wipe prior — same dance as lesson RAG. Pinecone deletes by id (the only
  // delete shape serverless supports without metadata-filtered delete), so
  // we read the prior vectorIds out of Mongo first.
  const priorChunks = await ProductKbChunkModel.find({ namespace: NAMESPACE, articleSlug })
    .select('vectorId')
    .lean();

  if (priorChunks.length > 0) {
    await Promise.all([
      ProductKbChunkModel.deleteMany({ namespace: NAMESPACE, articleSlug }).catch(
        bgError('productKbRag.deleteMongoChunks'),
      ),
      deleteVectorsByIds(priorChunks.map((c) => c.vectorId), { action: 'delete:product-kb' }).catch(
        bgError('productKbRag.deletePineconeChunks') as (e: unknown) => boolean,
      ),
    ]);
  }

  const embeddings = await embedBatch(
    chunkInputs.map((c) => c.text),
    { action: 'embedding:index' },
  );
  if (!embeddings) {
    ragLog.warn(`pkb:index:embed-fail article=${tag}`);
    return { ok: false, chunksWritten: 0, reason: 'embed_failed' };
  }

  const now = new Date();
  const records: GenericVectorRecord[] = [];
  const chunkDocs = chunkInputs.map((c, chunkIndex) => {
    const vectorId = buildVectorId({ articleSlug, chunkIndex });
    records.push({
      id: vectorId,
      embedding: embeddings[chunkIndex],
      metadata: {
        namespace: NAMESPACE,
        topic,
        articleSlug,
        articleTitle,
        sectionPath: c.sectionPath,
        chunkIndex,
      },
    });
    return {
      namespace: NAMESPACE,
      topic,
      articleSlug,
      articleTitle,
      sectionPath: c.sectionPath,
      chunkIndex,
      text: c.text,
      tokenCount: Math.ceil(c.text.length / 4),
      embeddedAt: now,
      vectorId,
      contentHash,
    };
  });

  const upserted = await upsertVectors(records, { action: 'upsert:product-kb' });
  if (!upserted) {
    ragLog.warn(`pkb:index:abort article=${tag} reason=pinecone_upsert_failed`);
    return { ok: false, chunksWritten: 0, reason: 'pinecone_failed' };
  }

  const inserted = await ProductKbChunkModel.insertMany(chunkDocs).catch((e) => {
    bgError('productKbRag.insertMongoChunks')(e);
    return null;
  });

  ragLog.info(
    `pkb:index:done article=${tag} chunks=${chunkInputs.length} mongo=${inserted ? inserted.length : 'fail'} ms=${Date.now() - t0}`,
  );

  return { ok: true, chunksWritten: chunkInputs.length };
};

/**
 * Drop every chunk + Pinecone vector for one article. Used by the
 * ingestion script when an article file is removed from disk.
 */
export const deleteProductKbArticle = async (
  articleSlug: string,
): Promise<{ chunksDeleted: number; vectorsDeleted: number }> => {
  const chunks = await ProductKbChunkModel.find({ namespace: NAMESPACE, articleSlug })
    .select('vectorId')
    .lean();

  if (chunks.length === 0) {
    return { chunksDeleted: 0, vectorsDeleted: 0 };
  }

  const vectorIds = chunks.map((c) => c.vectorId);
  const [mongoResult, pineconeOk] = await Promise.all([
    ProductKbChunkModel.deleteMany({ namespace: NAMESPACE, articleSlug }),
    deleteVectorsByIds(vectorIds, { action: 'delete:product-kb' }),
  ]);

  ragLog.info(
    `pkb:cleanup article=${articleSlug} chunks=${mongoResult.deletedCount} vectors=${pineconeOk ? vectorIds.length : 0}`,
  );

  return {
    chunksDeleted: mongoResult.deletedCount,
    vectorsDeleted: pineconeOk ? vectorIds.length : 0,
  };
};

/**
 * Read every (slug → contentHash) pair currently persisted. The
 * ingestion script uses this to compute the diff against on-disk
 * articles: slugs missing from disk get deleted; slugs whose hash
 * doesn't match get re-indexed; everything else is no-op.
 *
 * Returns the FIRST chunk's contentHash per slug (all chunks of a single
 * article share the same hash by construction in `indexProductKbArticle`).
 */
export const listIndexedArticles = async (): Promise<Map<string, string>> => {
  const chunks = await ProductKbChunkModel.find({ namespace: NAMESPACE })
    .select('articleSlug contentHash chunkIndex')
    .lean();

  const map = new Map<string, string>();
  for (const c of chunks) {
    if (c.chunkIndex === 0 || !map.has(c.articleSlug)) {
      map.set(c.articleSlug, c.contentHash);
    }
  }
  return map;
};

export interface ProductKbSearchResult {
  topic: string;
  articleSlug: string;
  articleTitle: string;
  sectionPath: string;
  text: string;
  score: number;
  href: string;
}

/**
 * Vector-search the product KB. Returns up to `topK` ranked chunks scoped
 * to the `product-kb` namespace. Empty array on disabled / empty query /
 * miss / failure — callers use a non-empty result as evidence to ground
 * an answer; an empty result must be treated as "no KB match, say so".
 */
export const searchProductKb = async ({
  query,
  topK = 5,
}: {
  query: string;
  topK?: number;
}): Promise<ProductKbSearchResult[]> => {
  if (!isEmbeddingsEnabled() || !isPineconeEnabled()) {
    ragLog.info(`pkb:query:skip reason=disabled`);
    return [];
  }

  const trimmed = query.trim();
  if (!trimmed) {
    ragLog.info(`pkb:query:skip reason=empty_query`);
    return [];
  }

  const t0 = Date.now();
  ragLog.info(`pkb:query:start q="${trimmed.slice(0, 80)}${trimmed.length > 80 ? '…' : ''}" topK=${topK}`);

  const queryEmbedding = await embedQuery(trimmed);
  if (!queryEmbedding) {
    ragLog.warn(`pkb:query:embed-fail`);
    return [];
  }

  const hits = await queryVectors({
    embedding: queryEmbedding,
    filter: { namespace: NAMESPACE },
    topK,
    action: 'query:product-kb',
  });
  if (hits.length === 0) {
    ragLog.info(`pkb:query:miss ms=${Date.now() - t0}`);
    return [];
  }

  // Defense-in-depth: re-verify namespace on every hit. Mirrors the
  // lesson-RAG isolation check — a drift between Pinecone filter behavior
  // and our expectation would be a critical bug, make it visible.
  const stray = hits.filter((h) => h.metadata.namespace !== NAMESPACE);
  if (stray.length > 0) {
    ragLog.error(
      `pkb:query:isolation-violation foreign=${stray.length} ids=${stray.map((s) => s.id).join(',')}`,
    );
  }
  const safeHits = hits.filter((h) => h.metadata.namespace === NAMESPACE);

  const chunks = await ProductKbChunkModel.find({ vectorId: { $in: safeHits.map((h) => h.id) } })
    .select('vectorId topic articleSlug articleTitle sectionPath text')
    .lean();

  const byVectorId = new Map(chunks.map((c) => [c.vectorId, c]));
  const results = safeHits
    .map((h) => {
      const c = byVectorId.get(h.id);
      if (!c) return null;
      return {
        topic: c.topic,
        articleSlug: c.articleSlug,
        articleTitle: c.articleTitle,
        sectionPath: c.sectionPath,
        text: c.text,
        score: h.score,
        href: `/help/${c.topic}/${c.articleSlug}`,
      };
    })
    .filter((r): r is ProductKbSearchResult => r !== null);

  const topScore = results[0]?.score ?? 0;
  ragLog.info(
    `pkb:query:hits hits=${results.length}/${hits.length} topScore=${topScore.toFixed(3)} ms=${Date.now() - t0}`,
  );

  return results;
};
