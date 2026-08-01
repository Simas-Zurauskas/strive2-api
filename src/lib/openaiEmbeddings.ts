import OpenAI from 'openai';
import { OPENAI_API_KEY } from '@conf/env';
import { recordUsage } from '@services/usageService';
import { priceLlmUsage } from '@lib/pricing';
import { ragLog } from '@lib/loggers';

/**
 * OpenAI embeddings client used by the lesson-RAG path.
 *
 * Singleton + lazy init so a missing OPENAI_API_KEY (dev environments
 * without the feature configured) doesn't crash at boot. `isEnabled()`
 * gates every call site — when it returns false, indexing/search
 * gracefully no-ops and the mentor falls back to system-prompt injection.
 *
 * Cost is recorded via `recordUsage({ service: 'openai', ... })`. The
 * `usage.prompt_tokens` returned by the API is the canonical source
 * (no estimation). Each batch call records one row tagged with
 * action='embedding:index' or 'embedding:query' for downstream attribution.
 */

const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;

let client: OpenAI | null = null;

/**
 * The one lazily-initialised OpenAI client for the whole api. Exported so
 * other OpenAI surfaces (document moderation's `omni-moderation-latest`
 * calls) reuse this singleton instead of growing divergent client
 * patterns. Null when the key is absent — callers decide whether that is
 * a graceful no-op (embeddings) or a fail-closed error (moderation).
 */
export const getOpenAIClient = (): OpenAI | null => {
  if (!OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: OPENAI_API_KEY });
  return client;
};

const getClient = getOpenAIClient;

export const isEmbeddingsEnabled = (): boolean => Boolean(OPENAI_API_KEY);

/**
 * Embed a batch of texts. Returns null on any failure (missing key,
 * network error, malformed response) so callers can fall through. The
 * caller is responsible for deciding what an empty/null result means in
 * its own context — search returns no hits; indexing skips persisting.
 *
 * Records token cost on success. Failure path does NOT record — we don't
 * pay for failed calls.
 */
export const embedBatch = async (
  texts: string[],
  { action }: { action: 'embedding:index' | 'embedding:query' },
): Promise<number[][] | null> => {
  if (texts.length === 0) return [];
  const c = getClient();
  if (!c) return null;

  try {
    const response = await c.embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts,
    });

    const tokens = response.usage?.prompt_tokens ?? 0;
    if (tokens > 0) {
      const cost = priceLlmUsage({
        model: 'openai-text-embedding-3-small',
        cacheRead: 0,
        cacheCreation5m: 0,
        cacheCreation1h: 0,
        uncached: tokens,
        output: 0,
      });
      recordUsage({
        service: 'openai',
        action,
        costMicroCents: cost,
        metadata: { model: EMBEDDING_MODEL, tokens, batchSize: texts.length },
      });
      ragLog.info(
        `embed:${action} ok inputs=${texts.length} tokens=${tokens} cost=µ¢${cost}`,
      );
    }

    return response.data.map((d) => d.embedding);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ragLog.error(`embed:${action} fail msg=${message}`);
    return null;
  }
};

export const embedQuery = async (text: string): Promise<number[] | null> => {
  const result = await embedBatch([text], { action: 'embedding:query' });
  return result?.[0] ?? null;
};
