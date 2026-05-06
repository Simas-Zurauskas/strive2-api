import { describe, expect, test } from 'vitest';
import { renderEmail } from './render';

describe('renderEmail', () => {
  const baseInput = {
    preheader: 'Confirm your email to get started.',
    title: 'Verify your email',
    body: [
      { type: 'paragraph' as const, text: 'Click the button below.' },
      { type: 'cta' as const, url: 'https://strive-learning.com/verify?token=abc', label: 'Verify' },
      { type: 'fineprint' as const, text: 'Expires in 24 hours.' },
    ],
  };

  test('produces a complete HTML document', () => {
    const { html } = renderEmail(baseInput);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('</html>');
  });

  test('embeds the preheader in the hidden snippet span', () => {
    const { html } = renderEmail(baseInput);
    expect(html).toContain('Confirm your email to get started.');
    expect(html).toContain('display:none');
  });

  test('renders the title as a sans-serif h1 (italic-serif is reserved for the wordmark)', () => {
    const { html } = renderEmail(baseInput);
    expect(html).toMatch(/<h1[^>]*>Verify your email<\/h1>/);
    expect(html).not.toMatch(/<h1[^>]*font-style:italic/);
    expect(html).not.toMatch(/<h1[^>]*font-family:Georgia/);
  });

  test('escapes HTML special characters in user-controlled fields', () => {
    const { html } = renderEmail({
      preheader: '<script>alert(1)</script>',
      title: 'A & B "test"',
      body: [{ type: 'paragraph', text: '<b>bold</b>' }],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('A &amp; B &quot;test&quot;');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  test('renders an https CTA url as a clickable link', () => {
    const { html } = renderEmail(baseInput);
    expect(html).toContain('href="https://strive-learning.com/verify?token=abc"');
    expect(html).toMatch(/>Verify</);
  });

  test('CTA uses uppercase, tracked label styling that matches the app primary button', () => {
    const { html } = renderEmail(baseInput);
    expect(html).toContain('text-transform:uppercase');
    expect(html).toMatch(/letter-spacing:0\.05em/);
  });

  test('collapses non-http(s) CTA urls to # to prevent javascript: injection', () => {
    const { html } = renderEmail({
      preheader: 'p',
      title: 't',
      body: [{ type: 'cta', url: 'javascript:alert(1)', label: 'X' }],
    });
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"');
  });

  test('renders code blocks with the monospace tracked style', () => {
    const { html } = renderEmail({
      preheader: 'p',
      title: 't',
      body: [{ type: 'code', value: '123456' }],
    });
    expect(html).toContain('123456');
    expect(html).toMatch(/letter-spacing:\d+px/);
  });

  test('text version contains title and CTA url plainly', () => {
    const { text } = renderEmail(baseInput);
    expect(text).toContain('Verify your email');
    expect(text).toContain('Click the button below.');
    expect(text).toContain('Verify: https://strive-learning.com/verify?token=abc');
    expect(text).toContain('Expires in 24 hours.');
  });

  test('footer shows the current year and the brand', () => {
    const { html } = renderEmail(baseInput);
    const year = new Date().getUTCFullYear();
    expect(html).toContain(`&copy; ${year}`);
    expect(html).toContain('Strive');
  });

  test('promotional footer carries an unsubscribe link, transactional does not', () => {
    const promo = renderEmail({ ...baseInput, showUnsubscribe: true });
    const txn = renderEmail(baseInput);
    expect(promo.html).toContain('[[UNSUB_LINK_EN]]');
    expect(txn.html).not.toContain('[[UNSUB_LINK_EN]]');
  });

  test('promotional variant uses a wider canvas, larger hero, no card frame', () => {
    const promo = renderEmail({ ...baseInput, variant: 'promotional' });
    const txn = renderEmail(baseInput);
    expect(promo.html).toContain('max-width:600px');
    expect(promo.html).toMatch(/<h1[^>]*font-size:40px/);
    expect(txn.html).toContain('max-width:560px');
    expect(txn.html).toMatch(/<h1[^>]*font-size:26px/);
    // Transactional has the inner card border; promotional does not.
    expect(txn.html).toMatch(/border:1px solid #dfd9d3;border-radius:12px/);
    expect(promo.html).not.toMatch(/border:1px solid #dfd9d3;border-radius:12px/);
  });

  test('eyebrow renders as a tracked uppercase label in the brand gold', () => {
    const { html, text } = renderEmail({
      preheader: 'p',
      title: 't',
      body: [{ type: 'eyebrow', text: 'New version' }],
      variant: 'promotional',
    });
    expect(html).toContain('color:#96793e');
    expect(html).toContain('text-transform:uppercase');
    expect(html).toMatch(/letter-spacing:0\.16em/);
    expect(text).toContain('NEW VERSION');
  });

  test('promotional places a leading eyebrow above the hero headline', () => {
    const { html } = renderEmail({
      preheader: 'p',
      title: 'My headline',
      body: [
        { type: 'eyebrow', text: 'Section' },
        { type: 'paragraph', text: 'Body.' },
      ],
      variant: 'promotional',
    });
    const eyebrowIdx = html.indexOf('Section');
    // <title> in <head> repeats the title text; we need the h1 in body.
    const heroIdx = html.search(/<h1[^>]*>My headline<\/h1>/);
    const bodyIdx = html.indexOf('Body.');
    expect(eyebrowIdx).toBeGreaterThan(0);
    expect(eyebrowIdx).toBeLessThan(heroIdx);
    expect(heroIdx).toBeLessThan(bodyIdx);
  });

  test('lede block renders larger than a standard paragraph', () => {
    const { html, text } = renderEmail({
      preheader: 'p',
      title: 't',
      body: [{ type: 'lede', text: 'A bigger opener.' }],
      variant: 'promotional',
    });
    expect(html).toMatch(/font-size:19px[^>]*>A bigger opener\./);
    expect(text).toContain('A bigger opener.');
  });

  test('divider renders as a short left-aligned editorial rule in promotional', () => {
    const { html } = renderEmail({
      preheader: 'p',
      title: 't',
      body: [{ type: 'divider' }],
      variant: 'promotional',
    });
    expect(html).toMatch(/width:56px;height:1px/);
  });
});
