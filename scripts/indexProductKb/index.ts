import 'colors';
import dotenv from 'dotenv';
import path from 'path';

// Load the API's .env BEFORE importing anything that touches `@conf/env`.
// Same pattern as debugOrchestrator: env is read at module-import time, so
// we can't import any env-consuming module above this line.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { createHash } from 'crypto';
import { readFileSync, readdirSync, statSync } from 'fs';
import matter from 'gray-matter';
import mongoose from 'mongoose';
import { MONGO_URI } from '@conf/env';
import { deleteProductKbArticle, indexProductKbArticle, listIndexedArticles } from '@services/productKbRagService';

// ── Resolve the on-disk article corpus ──────────────────────
//
// This script lives at `api/scripts/indexProductKb/`; the article files
// live at `client/src/content/kb/<topic>/<slug>.md`. We climb out of the
// api repo and read from the sibling client repo.

const KB_ROOT = path.resolve(__dirname, '../../../client/src/content/kb');

// ── CLI flags ──────────────────────────────────────────────

interface Flags {
  check: boolean; // Diff-only: report what would change, no writes. Used in CI.
  force: boolean; // Re-index every article regardless of hash match.
  verbose: boolean;
}

const parseFlags = (): Flags => {
  const args = process.argv.slice(2);
  return {
    check: args.includes('--check'),
    force: args.includes('--force'),
    verbose: args.includes('--verbose') || args.includes('-v'),
  };
};

// ── Disk → ArticleSpec ─────────────────────────────────────

interface ArticleSpec {
  topic: string;
  articleSlug: string;
  articleTitle: string;
  body: string;
  contentHash: string;
}

const computeContentHash = (frontmatter: Record<string, unknown>, body: string): string =>
  createHash('sha256')
    .update(`${JSON.stringify(frontmatter)}\n${body}`)
    .digest('hex');

const loadArticles = (): ArticleSpec[] => {
  const articles: ArticleSpec[] = [];
  const topicDirs = readdirSync(KB_ROOT);
  for (const topic of topicDirs) {
    const topicPath = path.join(KB_ROOT, topic);
    if (!statSync(topicPath).isDirectory()) continue;
    const files = readdirSync(topicPath);
    for (const filename of files) {
      if (filename.startsWith('_') || !filename.endsWith('.md')) continue;
      const slug = filename.replace(/\.md$/, '');
      const filePath = path.join(topicPath, filename);
      const raw = readFileSync(filePath, 'utf8');
      const { data, content } = matter(raw);
      const fm = data as Record<string, unknown>;
      const title = typeof fm.title === 'string' ? fm.title : '';
      const fmSlug = typeof fm.slug === 'string' ? fm.slug : '';
      const fmTopic = typeof fm.topic === 'string' ? fm.topic : '';
      if (!title) {
        console.error(`[error] ${filePath}: missing frontmatter title`.red);
        process.exit(1);
      }
      if (fmSlug !== slug) {
        console.error(`[error] ${filePath}: frontmatter.slug=${fmSlug} ≠ filename=${slug}`.red);
        process.exit(1);
      }
      if (fmTopic !== topic) {
        console.error(`[error] ${filePath}: frontmatter.topic=${fmTopic} ≠ folder=${topic}`.red);
        process.exit(1);
      }
      const body = content.trim();
      articles.push({
        topic,
        articleSlug: slug,
        articleTitle: title,
        body,
        contentHash: computeContentHash(fm, body),
      });
    }
  }
  return articles;
};

// ── Main ───────────────────────────────────────────────────

const main = async () => {
  const flags = parseFlags();
  console.log('[product-kb] indexing'.bold + (flags.check ? ' (--check, no writes)'.dim : ''));

  const onDisk = loadArticles();
  console.log(`[product-kb] ${onDisk.length} article(s) on disk`);

  await mongoose.connect(MONGO_URI, { maxPoolSize: 5, minPoolSize: 1 });

  try {
    const indexed = await listIndexedArticles();
    console.log(`[product-kb] ${indexed.size} article(s) currently indexed`);

    const onDiskSlugs = new Set(onDisk.map((a) => a.articleSlug));

    // Compute the work queues.
    const toIndex: ArticleSpec[] = [];
    const toSkip: ArticleSpec[] = [];
    for (const a of onDisk) {
      const persistedHash = indexed.get(a.articleSlug);
      const changed = !persistedHash || persistedHash !== a.contentHash;
      if (changed || flags.force) {
        toIndex.push(a);
      } else {
        toSkip.push(a);
      }
    }
    const toDelete: string[] = [];
    for (const slug of indexed.keys()) {
      if (!onDiskSlugs.has(slug)) toDelete.push(slug);
    }

    console.log('[product-kb] plan:'.bold);
    console.log(`  re-index: ${toIndex.length}`);
    console.log(`  delete:   ${toDelete.length}`);
    console.log(`  skip:     ${toSkip.length}`);

    if (flags.verbose) {
      for (const a of toIndex) console.log(`    + ${a.topic}/${a.articleSlug}`.green);
      for (const slug of toDelete) console.log(`    - ${slug}`.red);
    }

    // Check mode — exit non-zero on drift, zero otherwise. Used in CI to
    // ensure the manifest matches disk before deploy.
    if (flags.check) {
      const drift = toIndex.length + toDelete.length;
      if (drift > 0) {
        console.error(`[product-kb] ${drift} article(s) out of sync — run \`yarn kb:index\``.red);
        process.exit(1);
      }
      console.log('[product-kb] in sync'.green);
      return;
    }

    let chunkTotal = 0;
    for (const a of toIndex) {
      const result = await indexProductKbArticle(a);
      if (result.ok) {
        chunkTotal += result.chunksWritten;
        console.log(`[product-kb] indexed ${a.topic}/${a.articleSlug} (${result.chunksWritten} chunks)`.green);
      } else {
        console.error(`[product-kb] failed ${a.topic}/${a.articleSlug} reason=${result.reason ?? 'unknown'}`.red);
      }
    }

    for (const slug of toDelete) {
      const r = await deleteProductKbArticle(slug);
      console.log(`[product-kb] deleted ${slug} (${r.chunksDeleted} chunks, ${r.vectorsDeleted} vectors)`.yellow);
    }

    console.log(
      `[product-kb] done — ${toIndex.length} indexed, ${toDelete.length} deleted, ${toSkip.length} unchanged, ${chunkTotal} chunks written`
        .bold,
    );
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((err) => {
  console.error('[product-kb] fatal'.red, err);
  process.exit(1);
});
