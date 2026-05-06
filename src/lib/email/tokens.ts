// Brand tokens for email rendering.
//
// Email clients (notably Gmail and Outlook) strip <style> blocks and most
// CSS variables, so we hex-code everything inline. Values mirror the light
// scheme in `client/src/theme/theme.ts` — keep in sync when the app palette
// shifts so transactional mail doesn't drift visually from the product.

export const brand = {
  name: 'Strive',
  legalName: 'Strive Learning',
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
