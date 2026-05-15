import { createPrivateKey, createSign } from 'node:crypto';
import { lifecycleLog } from '@lib/loggers';

const getEnv = (key: string): string => {
  const value = process.env[key];

  if (!value) {
    lifecycleLog.error(`env:missing key=${key} — refusing to boot`);
    process.exit(1);
  }

  return value;
};

// Validate the runtime PEM is well-formed at boot, so a misconfigured EB env
// var fails loud at startup rather than per-request inside the gRPC stack
// (where it surfaces as the opaque `DECODER routines::unsupported`, see
// Sentry issue API-E). Production-only — dev/test stubs use a literal
// 'test-key' placeholder that wouldn't parse and shouldn't.
//
// We deliberately do NOT log the key or any subset of its bytes — only its
// length and the BEGIN/END markers, which are non-sensitive. The check itself
// uses `createPrivateKey` (parses the PEM) and discards the result.
const validateGoogleTtsPrivateKey = (pem: string, envName: string): void => {
  if (envName !== 'production') return;
  const len = pem.length;
  const begin = pem.slice(0, 35);
  const endTrim = pem.trimEnd();
  const trailingWs = pem.length - endTrim.length;
  const containsLiteralBackslashN = pem.includes('\\n');
  // After the env.ts replace, the runtime value should contain real newlines,
  // not literal `\n` sequences. If it still does, the env var was probably
  // stored with double-escaping (e.g. JSON-encoded twice) and the replace
  // missed it.
  if (containsLiteralBackslashN) {
    lifecycleLog.error(
      `env:invalid key=GOOGLE_TTS_PRIVATE_KEY shape=literal-\\n-still-present len=${len} — the env var is double-escaped; re-store with single \\n sequences`,
    );
    process.exit(1);
  }
  let parsed;
  try {
    parsed = createPrivateKey({ key: pem, format: 'pem' });
  } catch (e) {
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    lifecycleLog.error(
      `env:invalid key=GOOGLE_TTS_PRIVATE_KEY parse-failed reason="${reason}" len=${len} trailingWs=${trailingWs} beginMarker="${begin}"`,
    );
    process.exit(1);
  }
  // Exercise the same OpenSSL signing path the Google Cloud auth library hits
  // when it signs the JWT for service-account authentication. A PEM can pass
  // `createPrivateKey` (structurally valid) but still fail to SIGN under
  // Node's bundled OpenSSL — that's exactly the failure mode behind Sentry
  // API-E (`error:1E08010C:DECODER routines::unsupported` raised from inside
  // gRPC-js when it tries to attach signed credentials to the request
  // metadata). Signing a 32-byte buffer with RSA-SHA256 takes <1ms and
  // produces no network traffic, so this is cheap defence at boot.
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(Buffer.from('strive-tts-key-bootcheck'));
    signer.sign(parsed);
  } catch (e) {
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    lifecycleLog.error(
      `env:invalid key=GOOGLE_TTS_PRIVATE_KEY sign-failed reason="${reason}" len=${len} keyType="${parsed.asymmetricKeyType ?? 'unknown'}" — key parses but cannot sign; Google auth handshake will fail`,
    );
    process.exit(1);
  }
  lifecycleLog.info(
    `env:tts-key-ok len=${len} trailingWs=${trailingWs} beginsWithMarker=${begin.startsWith('-----BEGIN ')} keyType=${parsed.asymmetricKeyType ?? 'unknown'}`,
  );
};

export const ENVIRONMENT = getEnv('ENVIRONMENT'); // development|production
export const BFL_API_KEY = getEnv('BFL_API_KEY');
export const ANTHROPIC_API_KEY = getEnv('ANTHROPIC_API_KEY');
export const MONGO_URI = getEnv('MONGO_URI');
export const JWT_SECRET = getEnv('JWT_SECRET');
export const FRONTEND_URL = getEnv('FRONTEND_URL');
export const GOOGLE_CLIENT_ID = getEnv('GOOGLE_CLIENT_ID');
export const MAILJET_API_KEY = getEnv('MAILJET_API_KEY');
export const MAILJET_API_SECRET = getEnv('MAILJET_API_SECRET');
export const TAVILY_API_KEY = getEnv('TAVILY_API_KEY');
export const JINA_API_KEY = getEnv('JINA_API_KEY');
export const JUDGE0_API_KEY = getEnv('JUDGE0_API_KEY');
export const JUDGE0_API_URL = getEnv('JUDGE0_API_URL');
export const OPENAI_API_KEY = getEnv('OPENAI_API_KEY');
export const PINECONE_API_KEY = getEnv('PINECONE_API_KEY');
export const PINECONE_INDEX_NAME = getEnv('PINECONE_INDEX_NAME');
// Only the private_key field of the Google service-account JSON. The rest of
// the credentials object (client_email, project_id) is non-secret metadata
// hardcoded in googleTtsService.ts. Splitting it this way keeps the env var
// under EB's 4096-char CloudFormation parameter ceiling. Newlines must be
// literal `\n` in the env value; we restore them here.
export const GOOGLE_TTS_PRIVATE_KEY = getEnv('GOOGLE_TTS_PRIVATE_KEY').replace(/\\n/g, '\n');
validateGoogleTtsPrivateKey(GOOGLE_TTS_PRIVATE_KEY, process.env.ENVIRONMENT ?? '');

export const AWS_S3_BUCKET = getEnv('AWS_S3_BUCKET');
export const AWS_S3_REGION = getEnv('AWS_S3_REGION');
export const AWS_ACCESS_KEY_ID = getEnv('AWS_ACCESS_KEY_ID');
export const AWS_SECRET_ACCESS_KEY = getEnv('AWS_SECRET_ACCESS_KEY');

export const PORT = process.env.PORT || 4000;
export const API_URL = process.env.API_URL || `http://localhost:${PORT}`;

// Required in production so misconfiguration fails loud at boot. Optional in
// development where Sentry init is intentionally skipped (see conf/sentry.ts).
export const SENTRY_DSN =
  ENVIRONMENT === 'development' ? process.env.SENTRY_DSN : getEnv('SENTRY_DSN');

// Optional shared secret guarding the unauthenticated `/metrics` endpoint.
// When set, scrapers must send `X-Metrics-Token: <value>` on every request
// or the endpoint returns 401. When unset, the endpoint stays open — this
// preserves operational continuity during rollout: ops sets the env var
// and updates the scraper config in coordinated steps. Defence-in-depth on
// top of the network ACL that already restricts `/metrics` to private
// scrapers.
export const METRICS_TOKEN = process.env.METRICS_TOKEN;

export const STRIPE_SECRET_KEY = getEnv('STRIPE_SECRET_KEY');
export const STRIPE_WEBHOOK_SECRET = getEnv('STRIPE_WEBHOOK_SECRET');
// Toggles Stripe's automatic tax computation + customer address collection at
// Checkout. Required for EU consumer sales (VAT under OSS rules from euro one).
// Must be set to "true" in production AFTER the Stripe Dashboard has Stripe
// Tax enabled and the relevant tax registrations (Lithuania home + EU OSS)
// configured. Default is "false" for dev / testing where the test account
// usually has no tax setup.
export const STRIPE_TAX_ENABLED = process.env.STRIPE_TAX_ENABLED === 'true';
export const STRIPE_PRICE_ID_STARTER_MONTHLY = getEnv('STRIPE_PRICE_ID_STARTER_MONTHLY');
export const STRIPE_PRICE_ID_STARTER_ANNUAL = getEnv('STRIPE_PRICE_ID_STARTER_ANNUAL');
export const STRIPE_PRICE_ID_PRO_MONTHLY = getEnv('STRIPE_PRICE_ID_PRO_MONTHLY');
export const STRIPE_PRICE_ID_PRO_ANNUAL = getEnv('STRIPE_PRICE_ID_PRO_ANNUAL');
export const STRIPE_PRICE_ID_STUDIO_MONTHLY = getEnv('STRIPE_PRICE_ID_STUDIO_MONTHLY');
export const STRIPE_PRICE_ID_STUDIO_ANNUAL = getEnv('STRIPE_PRICE_ID_STUDIO_ANNUAL');

export const MIXPANEL_PROJECT_TOKEN = getEnv('MIXPANEL_PROJECT_TOKEN');
export const MIXPANEL_SECRET = getEnv('MIXPANEL_SECRET');
