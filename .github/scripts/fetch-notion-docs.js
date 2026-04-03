const { Client } = require('@notionhq/client');
const fs = require('fs');
const path = require('path');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DOCS_DIR = path.resolve(__dirname, '../../_docs');
const DELAY_MS = 350; // stay under Notion's 3 req/s limit

// Page IDs to skip entirely (belong to other repos)
const SKIP_PAGE_IDS = new Set(process.env.SKIP_PAGE_IDS?.split(',') || []);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Notion page tree walker (same pattern as notion-sync.js)
// ---------------------------------------------------------------------------

async function fetchPageTree(blockId, pathSegments = []) {
  const pages = [];
  let cursor;
  do {
    await sleep(DELAY_MS);
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const block of res.results) {
      if (block.type === 'child_page') {
        if (SKIP_PAGE_IDS.has(block.id)) continue;
        const title = block.child_page.title;
        const segments = [...pathSegments, title];
        pages.push({ id: block.id, title, path: segments.join(' > '), segments });
        const children = await fetchPageTree(block.id, segments);
        pages.push(...children);
      }
    }
    cursor = res.next_cursor;
  } while (cursor);
  return pages;
}

// ---------------------------------------------------------------------------
// Block → markdown conversion
// ---------------------------------------------------------------------------

function richTextToMarkdown(richTexts) {
  if (!richTexts) return '';
  return richTexts
    .map((rt) => {
      let text = rt.plain_text || '';
      if (rt.annotations?.bold) text = `**${text}**`;
      if (rt.annotations?.italic) text = `*${text}*`;
      if (rt.annotations?.code) text = `\`${text}\``;
      if (rt.annotations?.strikethrough) text = `~~${text}~~`;
      if (rt.href) text = `[${text}](${rt.href})`;
      return text;
    })
    .join('');
}

function blockToMarkdown(block) {
  const type = block.type;
  const data = block[type];
  if (!data) return '';

  switch (type) {
    case 'paragraph':
      return richTextToMarkdown(data.rich_text);
    case 'heading_1':
      return `# ${richTextToMarkdown(data.rich_text)}`;
    case 'heading_2':
      return `## ${richTextToMarkdown(data.rich_text)}`;
    case 'heading_3':
      return `### ${richTextToMarkdown(data.rich_text)}`;
    case 'bulleted_list_item':
      return `- ${richTextToMarkdown(data.rich_text)}`;
    case 'numbered_list_item':
      return `1. ${richTextToMarkdown(data.rich_text)}`;
    case 'to_do':
      return `- [${data.checked ? 'x' : ' '}] ${richTextToMarkdown(data.rich_text)}`;
    case 'toggle':
      return `> ${richTextToMarkdown(data.rich_text)}`;
    case 'code':
      return `\`\`\`${data.language || ''}\n${richTextToMarkdown(data.rich_text)}\n\`\`\``;
    case 'callout': {
      const emoji = data.icon?.emoji || '';
      return `> ${emoji} ${richTextToMarkdown(data.rich_text)}`;
    }
    case 'quote':
      return `> ${richTextToMarkdown(data.rich_text)}`;
    case 'divider':
      return '---';
    case 'table_row':
      return `| ${(data.cells || []).map((cell) => richTextToMarkdown(cell)).join(' | ')} |`;
    case 'child_page':
      return `📄 **[${data.title}]** (child page)`;
    case 'bookmark':
      return data.url ? `🔗 ${data.url}` : '';
    case 'image': {
      const url = data.file?.url || data.external?.url || '';
      const caption = richTextToMarkdown(data.caption);
      return url ? `![${caption}](${url})` : '';
    }
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Fetch all blocks for a page and convert to markdown
// ---------------------------------------------------------------------------

async function fetchPageContent(pageId) {
  const blocks = [];
  let cursor;
  do {
    await sleep(DELAY_MS);
    const res = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...res.results);
    cursor = res.next_cursor;
  } while (cursor);

  const lines = [];
  let inTable = false;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];

    // Handle table: emit header separator after first row
    if (block.type === 'table') {
      inTable = true;
      // Fetch table rows (children of the table block)
      const tableRows = [];
      let tc;
      do {
        await sleep(DELAY_MS);
        const res = await notion.blocks.children.list({
          block_id: block.id,
          start_cursor: tc,
          page_size: 100,
        });
        tableRows.push(...res.results);
        tc = res.next_cursor;
      } while (tc);

      for (let r = 0; r < tableRows.length; r++) {
        lines.push(blockToMarkdown(tableRows[r]));
        if (r === 0 && tableRows.length > 1) {
          const colCount = (tableRows[r].table_row?.cells || []).length;
          lines.push(`| ${Array(colCount).fill('---').join(' | ')} |`);
        }
      }
      inTable = false;
      continue;
    }

    const md = blockToMarkdown(block);
    if (md !== undefined) lines.push(md);
  }

  return lines.join('\n\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const rootId = process.env.NOTION_TECHNICAL_ROOT_ID;
  if (!rootId) throw new Error('NOTION_TECHNICAL_ROOT_ID is required');

  // Clean and create output directory
  if (fs.existsSync(DOCS_DIR)) fs.rmSync(DOCS_DIR, { recursive: true });
  fs.mkdirSync(DOCS_DIR, { recursive: true });

  console.log('Fetching Notion page tree…');
  const pages = await fetchPageTree(rootId);
  console.log(`Found ${pages.length} pages`);

  const manifest = [];

  for (const page of pages) {
    try {
      console.log(`  Fetching: ${page.path}`);
      const content = await fetchPageContent(page.id);

      // Build file path from segments: _docs/Client/Overview.md
      const dirSegments = page.segments.slice(0, -1); // parent folders
      const fileName = `${page.segments[page.segments.length - 1]}.md`;
      const dirPath = path.join(DOCS_DIR, ...dirSegments);
      const filePath = path.join(dirPath, fileName);

      fs.mkdirSync(dirPath, { recursive: true });
      fs.writeFileSync(filePath, `# ${page.title}\n\n${content}`);

      manifest.push({
        id: page.id,
        title: page.title,
        path: page.path,
        file: path.relative(path.resolve(__dirname, '../..'), filePath),
      });
    } catch (err) {
      console.warn(`  ⚠ Failed to fetch "${page.title}": ${err.message}`);
    }
  }

  // Write manifest
  const manifestPath = path.join(DOCS_DIR, '_index.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nWrote ${manifest.length} pages to ${DOCS_DIR}/`);
  console.log(`Manifest: ${manifestPath}`);
}

main().catch((err) => {
  console.error('Fetch failed:', err.message);
  process.exit(1);
});
