import { lifecycleLog } from '@lib/loggers';

const getEnv = (key: string): string => {
  const value = process.env[key];

  if (!value) {
    lifecycleLog.error(`env:missing key=${key} — refusing to boot`);
    process.exit(1);
  }

  return value;
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
export const GOOGLE_TTS_CREDENTIALS_JSON = getEnv('GOOGLE_TTS_CREDENTIALS_JSON');

export const AWS_S3_BUCKET = getEnv('AWS_S3_BUCKET');
export const AWS_S3_REGION = getEnv('AWS_S3_REGION');
export const AWS_ACCESS_KEY_ID = getEnv('AWS_ACCESS_KEY_ID');
export const AWS_SECRET_ACCESS_KEY = getEnv('AWS_SECRET_ACCESS_KEY');

export const PORT = process.env.PORT || 4000;
export const API_URL = process.env.API_URL || `http://localhost:${PORT}`;

export const SENTRY_DSN = getEnv('SENTRY_DSN');

// Build identification — set by CI at deploy time.
//   - RELEASE_SHA: full git commit SHA of the running build. Used by Sentry
//     for release tagging + by the /version endpoint. Set in CI from the
//     platform's commit env var (GITHUB_SHA, CODEBUILD_RESOLVED_SOURCE_VERSION,
//     VERCEL_GIT_COMMIT_SHA, etc.) or via `git rev-parse HEAD` in a build script.
//   - BUILD_TIME: ISO timestamp of when the artifact was built. Lets ops see
//     "this server is running a 3-day-old build" at a glance via /version.
//
// Both are optional: undefined → endpoint reports "unknown" rather than
// crashing. Setting them is a CI hygiene win, not a launch blocker.
export const RELEASE_SHA = process.env.RELEASE_SHA;
export const BUILD_TIME = process.env.BUILD_TIME;

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
