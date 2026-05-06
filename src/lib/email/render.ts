import { brand } from './tokens';

// Block-based body composition. Templates declare the email as an ordered
// list of typed blocks; the renderer turns them into matching HTML and
// plain-text fragments. Adding a new visual element is one new variant +
// two render arms — no template needs to know the styling rules.

export type EmailBlock =
  | { type: 'eyebrow'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'lede'; text: string }
  | { type: 'cta'; url: string; label: string }
  | { type: 'code'; value: string }
  | { type: 'divider' }
  | { type: 'fineprint'; text: string };

// Two distinct shell treatments — they signal stream identity to the reader
// before they read a word. Transactional = constrained white card on cream
// (focused, banking-app feel). Promotional = full-bleed editorial column on
// cream, left-aligned with a larger hero, an eyebrow categoriser, and short
// editorial rules between sections (long-form-article feel).
export type EmailVariant = 'transactional' | 'promotional';

export type EmailRenderInput = {
  // Inbox preview line shown next to the subject in Gmail/Apple Mail. Without
  // it, clients fall back to the first visible body text — usually the title
  // duplicated, which wastes the only piece of pre-open real estate we get.
  preheader: string;
  title: string;
  body: EmailBlock[];
  // Promotional templates set this so the renderer adds an unsubscribe row
  // to the footer. Transactional templates (verification, password reset,
  // security codes) leave it false — those are operational replies to a
  // user action, not marketing, and don't carry an opt-out surface.
  //
  // The link itself is injected by Mailjet as `[[UNSUB_LINK_EN]]`, swapped
  // server-side when `TemplateLanguage: true` is set on the Mailjet
  // message. Mailjet hosts the unsubscribe + re-subscribe page and tracks
  // opt-out state in their Contact DB; we don't host or persist any of it.
  showUnsubscribe?: boolean;
  variant?: EmailVariant;
};

export type RenderedEmail = {
  html: string;
  text: string;
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });

// CTA URLs always come from server-built strings (verification links, reset
// links), so this is defence-in-depth rather than a primary boundary. Allow
// only http(s); anything else collapses to `#` so a malformed input never
// becomes an attribute-context injection vector.
const safeUrl = (url: string): string => {
  if (/^https?:\/\//i.test(url)) return escapeHtml(url);
  return '#';
};

const renderHtmlBlock = (block: EmailBlock, variant: EmailVariant): string => {
  const c = brand.colors;
  const promo = variant === 'promotional';
  switch (block.type) {
    case 'eyebrow':
      return `<p style="margin:0 0 14px;font-family:${brand.fonts.body};font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:${c.tertiary};">${escapeHtml(block.text)}</p>`;
    case 'paragraph':
      return `<p style="margin:0 0 18px;font-family:${brand.fonts.body};font-size:16px;line-height:1.65;color:${c.foreground};">${escapeHtml(block.text)}</p>`;
    case 'lede':
      return `<p style="margin:0 0 24px;font-family:${brand.fonts.body};font-size:19px;line-height:1.55;color:${c.foreground};">${escapeHtml(block.text)}</p>`;
    case 'cta': {
      const padding = promo ? '16px 32px' : '14px 28px';
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:32px 0 8px;"><tr><td style="border-radius:6px;background:${c.accent};box-shadow:0 1px 3px rgba(0,0,0,0.12),0 1px 2px rgba(0,0,0,0.08);"><a href="${safeUrl(block.url)}" style="display:inline-block;padding:${padding};color:${c.accentForeground};text-decoration:none;font-family:${brand.fonts.body};font-size:13px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;border-radius:6px;">${escapeHtml(block.label)}</a></td></tr></table>`;
    }
    case 'code':
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0;"><tr><td style="font-family:${brand.fonts.mono};font-size:34px;letter-spacing:10px;font-weight:600;color:${c.foreground};padding:24px;text-align:center;">${escapeHtml(block.value)}</td></tr></table>`;
    case 'divider':
      // Promotional uses a short left-aligned editorial rule for section
      // breaks — the long-form-article pattern. Transactional gets a quiet
      // full-width rule.
      if (promo) {
        return `<div style="margin:32px 0;line-height:0;font-size:0;"><span style="display:inline-block;width:56px;height:1px;background:${c.border};">&nbsp;</span></div>`;
      }
      return `<div style="margin:24px 0;border-top:1px solid ${c.border};line-height:1;font-size:0;">&nbsp;</div>`;
    case 'fineprint':
      return `<p style="margin:24px 0 0;font-family:${brand.fonts.body};font-size:13px;line-height:1.65;color:${c.fineprint};">${escapeHtml(block.text)}</p>`;
  }
};

const renderTextBlock = (block: EmailBlock): string => {
  switch (block.type) {
    case 'eyebrow':
      return block.text.toUpperCase();
    case 'paragraph':
    case 'lede':
      return block.text;
    case 'cta':
      return `${block.label}: ${block.url}`;
    case 'code':
      return block.value;
    case 'divider':
      return '——';
    case 'fineprint':
      return block.text;
  }
};

// Hidden span at the very top of the body. Email clients pull the inbox
// preview text from the first visible characters; this trick keeps the
// preheader visible to the snippet logic while invisible to the recipient
// once the message is open. The trailing &nbsp; padding stops Gmail from
// appending body text after our preheader in the snippet.
const renderPreheader = (text: string): string =>
  `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">${escapeHtml(text)}${'&nbsp;'.repeat(80)}</div>`;

const renderTransactionalShell = (params: {
  preheader: string;
  title: string;
  blocksHtml: string;
  unsubscribePart: string;
  year: number;
}): string => {
  const c = brand.colors;
  const { preheader, title, blocksHtml, unsubscribePart, year } = params;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${c.background};color:${c.foreground};">
${renderPreheader(preheader)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${c.background};">
  <tr>
    <td align="center" style="padding:56px 16px 40px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr>
          <td style="padding:0 8px 28px;font-family:${brand.fonts.serif};">
            <span style="font-family:${brand.fonts.serif};font-style:italic;font-size:22px;color:${c.foreground};letter-spacing:-0.2px;">${brand.name}</span>
          </td>
        </tr>
        <tr>
          <td style="background:${c.surface};border:1px solid ${c.border};border-radius:12px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding:48px 48px 40px;font-family:${brand.fonts.body};">
                  <h1 style="margin:0 0 24px;font-family:${brand.fonts.body};font-weight:600;font-size:26px;color:${c.foreground};line-height:1.25;letter-spacing:-0.2px;">${escapeHtml(title)}</h1>
                  ${blocksHtml}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 8px 0;font-family:${brand.fonts.body};font-size:12px;line-height:1.6;color:${c.muted};">
            &copy; ${year} ${escapeHtml(brand.legalName)} &middot; ${escapeHtml(brand.tagline)}${unsubscribePart}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
};

const renderPromotionalShell = (params: {
  preheader: string;
  title: string;
  blocksHtml: string;
  unsubscribePart: string;
  year: number;
}): string => {
  const c = brand.colors;
  const { preheader, title, blocksHtml, unsubscribePart, year } = params;
  // Full-bleed editorial column — no card frame, left-aligned, larger hero.
  // The shell renders the wordmark + h1 itself; templates supply optional
  // eyebrow + body blocks above/below. Generous outer breathing room.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${c.background};color:${c.foreground};">
${renderPreheader(preheader)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${c.background};">
  <tr>
    <td align="center" style="padding:64px 20px 56px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr>
          <td style="padding:0 0 56px;font-family:${brand.fonts.serif};">
            <span style="font-family:${brand.fonts.serif};font-style:italic;font-size:22px;color:${c.foreground};letter-spacing:-0.2px;">${brand.name}</span>
          </td>
        </tr>
        <tr>
          <td style="font-family:${brand.fonts.body};">
            ${blocksHtml}
          </td>
        </tr>
        <tr>
          <td style="padding:72px 0 0;font-family:${brand.fonts.body};font-size:12px;line-height:1.6;color:${c.muted};">
            &copy; ${year} ${escapeHtml(brand.legalName)} &middot; ${escapeHtml(brand.tagline)}${unsubscribePart}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
};

// Promotional templates render their own headline as the first block so it
// sits in the same content column as eyebrow, lede, and body — letting the
// template control the hero composition (eyebrow → headline → lede). The
// shell only handles the wordmark and footer.
const promotionalHeroBlock = (title: string): string => {
  const c = brand.colors;
  return `<h1 style="margin:0 0 24px;font-family:${brand.fonts.body};font-weight:600;font-size:40px;color:${c.foreground};line-height:1.1;letter-spacing:-0.7px;">${escapeHtml(title)}</h1>`;
};

export const renderEmail = (input: EmailRenderInput): RenderedEmail => {
  const c = brand.colors;
  const { preheader, title, body, showUnsubscribe } = input;
  const variant: EmailVariant = input.variant ?? 'transactional';
  const promo = variant === 'promotional';

  const renderedBlocks = body.map((b) => renderHtmlBlock(b, variant));
  // In promotional, the hero h1 is interleaved with body blocks so the
  // template can choose to place an eyebrow before the title. Convention:
  // a leading `eyebrow` block (if any) prefixes the title; everything else
  // follows it.
  let blocksHtml: string;
  if (promo) {
    const firstIsEyebrow = body[0]?.type === 'eyebrow';
    const eyebrowHtml = firstIsEyebrow ? renderedBlocks[0] : '';
    const restHtml = (firstIsEyebrow ? renderedBlocks.slice(1) : renderedBlocks).join(
      '\n            ',
    );
    blocksHtml = [eyebrowHtml, promotionalHeroBlock(title), restHtml]
      .filter(Boolean)
      .join('\n            ');
  } else {
    blocksHtml = renderedBlocks.join('\n          ');
  }

  const blocksText = body.map(renderTextBlock).join('\n\n');
  const year = new Date().getUTCFullYear();

  const unsubscribePart = showUnsubscribe
    ? ` &middot; <a href="[[UNSUB_LINK_EN]]" style="color:${c.muted};text-decoration:underline;">Unsubscribe</a>`
    : '';
  const unsubscribeRowText = showUnsubscribe
    ? `\n\nDon't want emails like this? Unsubscribe: [[UNSUB_LINK_EN]]`
    : '';

  const shell = promo ? renderPromotionalShell : renderTransactionalShell;
  const html = shell({ preheader, title, blocksHtml, unsubscribePart, year });
  const text = `${title}\n\n${blocksText}\n\n— ${brand.name}\n© ${year} ${brand.legalName}${unsubscribeRowText}`;

  return { html, text };
};
