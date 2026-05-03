import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { TavilySearch } from '@langchain/tavily';
import { TAVILY_API_KEY } from '@conf/env';
import { searchProductKb } from '@services/productKbRagService';
import { readUrl } from '@lib/jinaReader';

// ── search_product_kb ─────────────────────────────────────
//
// Vector search over the product knowledge base. Returns the top-5 ranked
// chunks with their source article slug + section heading, so the agent
// can paraphrase + cite. Empty result is the agent's signal to fall back
// to "I don't know — try support" rather than to confabulate.

export const searchProductKbTool = tool(
  async (input) => {
    const results = await searchProductKb({
      query: input.query,
      topK: 5,
    });

    if (results.length === 0) {
      return JSON.stringify({
        results: [],
        note: 'No KB match. The knowledge base may not cover this topic — say so honestly rather than inventing details.',
      });
    }

    return JSON.stringify({
      results: results.map((r) => ({
        articleTitle: r.articleTitle,
        sectionPath: r.sectionPath,
        href: r.href,
        score: Math.round(r.score * 1000) / 1000,
        text: r.text.length > 1500 ? r.text.slice(0, 1500) + '…' : r.text,
      })),
    });
  },
  {
    name: 'search_product_kb',
    description:
      "Search the Strive product knowledge base via vector similarity. Use for any question about Strive's features, pricing, billing, account, learning techniques, course creation, lessons, mentor chat, or any product behavior. Returns up to 5 ranked excerpts, each tagged with the source article's title, section heading, and href (use the href as a markdown link target in your reply for citations).",
    schema: z.object({
      query: z
        .string()
        .describe('A natural-language question or concept. Phrase as the visitor would.'),
    }),
  },
);

// ── web_search ────────────────────────────────────────────

export const webSearch = new TavilySearch({
  maxResults: 3,
  tavilyApiKey: TAVILY_API_KEY,
  name: 'web_search',
  description:
    'Search the web for current external information. Use ONLY when the visitor asks about something not covered by the product KB AND the question is genuinely external (e.g., comparison to a third-party tool, current news). Prefer search_product_kb for any product question.',
});

// ── fetch_url ─────────────────────────────────────────────

const READ_URL_ERROR_MESSAGES: Record<string, string> = {
  invalid_url: 'The URL is missing or malformed.',
  unsafe_url: 'That URL is not safe to fetch (private network or non-http(s) scheme).',
  timeout: 'The page took too long to load (>10s).',
  http_error: 'The page returned an HTTP error.',
  empty_body: 'The page returned no readable content.',
};

export const fetchUrlTool = tool(
  async (input) => {
    const result = await readUrl({ url: input.url, action: 'productKb:fetch_url' });

    if (!result.ok) {
      return JSON.stringify({
        url: input.url,
        error: result.error,
        message: READ_URL_ERROR_MESSAGES[result.error] ?? 'Could not fetch the page.',
      });
    }

    return JSON.stringify({
      url: result.data.url,
      tokens: result.data.tokens,
      truncated: result.data.truncated,
      text: result.data.text,
    });
  },
  {
    name: 'fetch_url',
    description:
      'Fetch the main-text content of a public web page via Jina Reader. Use when the visitor pastes a URL and asks you to discuss it. Returns up to 8K chars. Do NOT use for product-internal questions — prefer search_product_kb.',
    schema: z.object({
      url: z.string().describe('A fully-qualified http(s) URL of a public web page.'),
    }),
  },
);

// ── Export ────────────────────────────────────────────────

export const TOOLS = [searchProductKbTool, webSearch, fetchUrlTool];
