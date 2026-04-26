import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ILessonBlock } from '@models/LessonContentModel';
import {
  blocksToNarrationScript,
  hasNarratableContent,
  renderBlockForNarration,
} from './blocksToScript';

const block = (overrides: Partial<ILessonBlock>): ILessonBlock => ({
  id: overrides.id ?? 'b',
  type: overrides.type ?? 'section',
  content: overrides.content ?? '',
  metadata: overrides.metadata ?? null,
  order: overrides.order ?? 0,
});

// ── Per-block rendering ─────────────────────────────────

test('intro block strips markdown and adds terminator', () => {
  const out = renderBlockForNarration(block({
    type: 'intro',
    content: '## Welcome\nThis is **important**: a `key` lesson',
  }));
  assert.equal(out, 'Welcome\nThis is important: a key lesson.');
});

test('section block strips markdown links and keeps label only', () => {
  const out = renderBlockForNarration(block({
    type: 'section',
    content: 'See [the docs](https://example.com) for more.',
  }));
  assert.equal(out, 'See the docs for more.');
});

test('summary block prefixed with "In summary,"', () => {
  const out = renderBlockForNarration(block({
    type: 'summary',
    content: 'we covered three topics today.',
  }));
  assert.equal(out, 'In summary, we covered three topics today.');
});

test('callout info → "Note:" prefix', () => {
  const out = renderBlockForNarration(block({
    type: 'callout',
    content: 'Mongoose v9 needs Node 20.',
    metadata: { variant: 'info' },
  }));
  assert.equal(out, 'Note: Mongoose v9 needs Node 20.');
});

test('callout warning → "Warning:" prefix', () => {
  const out = renderBlockForNarration(block({
    type: 'callout',
    content: 'Rotate the secret.',
    metadata: { variant: 'warning' },
  }));
  assert.equal(out, 'Warning: Rotate the secret.');
});

test('callout success → "Tip:" prefix', () => {
  const out = renderBlockForNarration(block({
    type: 'callout',
    content: 'Use ripgrep instead.',
    metadata: { variant: 'success' },
  }));
  assert.equal(out, 'Tip: Use ripgrep instead.');
});

test('callout without variant has no prefix', () => {
  const out = renderBlockForNarration(block({
    type: 'callout',
    content: 'Plain note.',
    metadata: null,
  }));
  assert.equal(out, 'Plain note.');
});

test('coding exercise replaces code with audio cue, mentions language', () => {
  const out = renderBlockForNarration(block({
    type: 'exercise',
    content: 'Write a function that reverses a string.',
    metadata: { language: 'python', starterCode: 'def reverse(s):\n    pass' },
  }));
  assert.equal(out, 'Exercise: Write a function that reverses a string. The rest is a coding exercise in python.');
});

test('text-only exercise (no starter code) is narrated fully', () => {
  const out = renderBlockForNarration(block({
    type: 'exercise',
    content: 'Compare merge sort and quicksort. Which is better when memory is limited?',
    metadata: null,
  }));
  assert.equal(out, 'Exercise: Compare merge sort and quicksort. Which is better when memory is limited?');
});

test('code block becomes a single audio cue', () => {
  const out = renderBlockForNarration(block({ type: 'code', content: 'print("hi")' }));
  assert.equal(out, 'Code example shown.');
});

test('mermaid block becomes a single audio cue', () => {
  const out = renderBlockForNarration(block({ type: 'mermaid', content: 'graph TD; a-->b' }));
  assert.equal(out, 'Diagram shown.');
});

test('image block reads alt text when present', () => {
  const out = renderBlockForNarration(block({
    type: 'image',
    content: '',
    metadata: { alt: 'A flowchart of the API request lifecycle' },
  }));
  assert.equal(out, 'Image: A flowchart of the API request lifecycle.');
});

test('image block without alt is silent', () => {
  const out = renderBlockForNarration(block({ type: 'image', content: '', metadata: null }));
  assert.equal(out, '');
});

test('quiz block is silent', () => {
  const out = renderBlockForNarration(block({
    type: 'quiz',
    content: 'What is 2 + 2?',
    metadata: { question: 'What is 2+2?', options: ['3', '4'], correctIndex: 1 },
  }));
  assert.equal(out, '');
});

test('links block is silent', () => {
  const out = renderBlockForNarration(block({ type: 'links', content: 'https://example.com' }));
  assert.equal(out, '');
});

// ── Math handling ─────────────────────────────────────

test('inline math becomes "[math expression]"', () => {
  const out = renderBlockForNarration(block({
    type: 'section',
    content: 'The pythagorean theorem says $a^2 + b^2 = c^2$ holds.',
  }));
  assert.equal(out, 'The pythagorean theorem says [math expression] holds.');
});

test('display math becomes "[math expression]"', () => {
  const out = renderBlockForNarration(block({
    type: 'section',
    content: 'Define\n$$\nE = mc^2\n$$\nas energy.',
  }));
  assert.equal(out, 'Define\n[math expression]\nas energy.');
});

// ── End-to-end script assembly ─────────────────────────

test('full script joins narratable blocks in order, skipping silent blocks', () => {
  const blocks: ILessonBlock[] = [
    block({ id: '1', type: 'intro', content: 'Welcome.', order: 1 }),
    block({ id: '2', type: 'section', content: 'First section.', order: 2 }),
    block({ id: '3', type: 'image', content: '', metadata: null, order: 3 }), // skipped
    block({ id: '4', type: 'quiz', content: '?', order: 4 }), // skipped
    block({ id: '5', type: 'callout', content: 'Heads up.', metadata: { variant: 'warning' }, order: 5 }),
    block({ id: '6', type: 'links', content: 'https://...', order: 6 }), // skipped
    block({ id: '7', type: 'summary', content: 'we did the thing.', order: 7 }),
  ];
  const script = blocksToNarrationScript(blocks);
  assert.equal(
    script,
    'Welcome.\n\nFirst section.\n\nWarning: Heads up.\n\nIn summary, we did the thing.',
  );
});

test('blocks out of order are sorted before rendering (deterministic)', () => {
  const blocks: ILessonBlock[] = [
    block({ id: '2', type: 'section', content: 'Second.', order: 2 }),
    block({ id: '1', type: 'intro', content: 'First.', order: 1 }),
    block({ id: '3', type: 'summary', content: 'Last.', order: 3 }),
  ];
  const script = blocksToNarrationScript(blocks);
  assert.equal(script, 'First.\n\nSecond.\n\nIn summary, Last.');
});

test('hasNarratableContent is true with at least one non-empty narratable block', () => {
  const blocks: ILessonBlock[] = [
    block({ type: 'image', metadata: { alt: 'pic' } }),
    block({ type: 'section', content: 'real text' }),
    block({ type: 'quiz', content: '?' }),
  ];
  assert.equal(hasNarratableContent(blocks), true);
});

test('hasNarratableContent is false for a quiz/code/image-only lesson', () => {
  const blocks: ILessonBlock[] = [
    block({ type: 'image', metadata: { alt: 'pic' } }),
    block({ type: 'quiz', content: '?' }),
    block({ type: 'code', content: 'print("hi")' }),
  ];
  assert.equal(hasNarratableContent(blocks), false);
});

// ── Determinism (cache-key invariant) ──────────────────

test('identical input → identical output (cache hash invariant)', () => {
  const blocks: ILessonBlock[] = [
    block({ id: '1', type: 'intro', content: 'Hello world.', order: 1 }),
    block({ id: '2', type: 'section', content: 'Body.', order: 2 }),
  ];
  const a = blocksToNarrationScript(blocks);
  const b = blocksToNarrationScript(blocks);
  assert.equal(a, b);
});
