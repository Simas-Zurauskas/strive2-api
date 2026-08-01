// Brand tokens for email rendering.
//
// Email clients (notably Gmail and Outlook) strip <style> blocks and most
// CSS variables, so we hex-code everything inline. Values mirror the light
// scheme in `client/src/theme/theme.ts` — keep in sync when the app palette
// shifts so transactional mail doesn't drift visually from the product.

// Sender identification in email: the entity is named by `legalName` (in the
// footer copyright line and the promo's sign-off block). The registered
// postal address and the Lithuanian legal-entity registration code are
// deliberately NOT carried in the message body — e-Commerce Directive
// Art. 5(1) requires them to be "easily, directly and permanently
// accessible", which the website satisfies, not repeated in every email.
//
// Known, accepted gap (founder decision, 2026-07-30): US CAN-SPAM does
// require a physical postal address in marketing mail, so a US recipient is
// the one case this omission bites. Recorded in PROGRESS.md rather than
// silently absorbed. If a US-facing send is ever planned, add the address
// back to the promotional footer only — transactional mail never needed it.

export const brand = {
  name: 'Strive',
  // Corrected from 'Strive Learning' (PLAN A5 / F20). 'Strive Learning' is
  // the product name, not the controller — the entity behind the service is
  // the Lithuanian small partnership MB Kūrybinis kodas, and the copyright
  // line in every email footer names the entity. Declared exception to the
  // transactional-email freeze: it rewrites the shared footer of all five
  // transactional templates, and is pinned by a render test.
  legalName: 'MB Kūrybinis kodas',
  tagline: 'Personalized AI learning',

  colors: {
    background: '#faf9f7',
    surface: '#ffffff',
    foreground: '#0f172a',
    muted: '#8a8279',
    fineprint: '#a09a91',
    border: '#dfd9d3',
    accent: '#2c5545',
    accentForeground: '#ffffff',
    // Warm gold — used as a single, deliberate brand accent on promotional
    // mail (eyebrow labels). Mirrors `colorsLib.secondary` in the client.
    tertiary: '#96793e',
  },

  fonts: {
    body: `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`,
    // Georgia ships on Windows + macOS + iOS + most Android — safe in mail
    // without the webfont fetch Gmail strips. Used for the wordmark and
    // headlines to echo the product's italic-serif accents.
    serif: `Georgia, 'Times New Roman', Times, serif`,
    mono: `'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`,
  },
} as const;

/**
 * Kept as a no-op so the campaign controller keeps one obvious place to
 * reinstate a pre-send identity check. The postal address / registration
 * number gate was removed by founder decision on 2026-07-30 — see the header
 * comment for what that trades away and when it would need to come back.
 */
export const assertSenderIdentityComplete = (): void => {};
