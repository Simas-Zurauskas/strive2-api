const getEnv = (key: string): string => {
  const value = process.env[key];

  if (!value) {
    console.error(`Error: Required environment variable ${key} is missing`);
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

export const AWS_S3_BUCKET = getEnv('AWS_S3_BUCKET');
export const AWS_S3_REGION = getEnv('AWS_S3_REGION');
export const AWS_ACCESS_KEY_ID = getEnv('AWS_ACCESS_KEY_ID');
export const AWS_SECRET_ACCESS_KEY = getEnv('AWS_SECRET_ACCESS_KEY');

// Google Cloud Text-to-Speech credentials. Either:
//   GOOGLE_TTS_CREDENTIALS_JSON — full JSON service-account key as a single
//     env var (preferred for hosted envs where mounting a credentials file
//     is awkward).
//   GOOGLE_APPLICATION_CREDENTIALS — standard Google SDK env pointing to a
//     credentials file path; auto-picked up by the SDK if set.
// At least one must be provided; the TTS client throws on first synth call
// if neither is reachable. Optional at server boot so dev environments
// without TTS still start.
export const GOOGLE_TTS_CREDENTIALS_JSON = process.env.GOOGLE_TTS_CREDENTIALS_JSON;

export const PORT = process.env.PORT || 4000;
export const API_URL = process.env.API_URL || `http://localhost:${PORT}`;

export const STRIPE_SECRET_KEY = getEnv('STRIPE_SECRET_KEY');
export const STRIPE_WEBHOOK_SECRET = getEnv('STRIPE_WEBHOOK_SECRET');
export const STRIPE_PRICE_ID_STARTER_MONTHLY = getEnv('STRIPE_PRICE_ID_STARTER_MONTHLY');
export const STRIPE_PRICE_ID_STARTER_ANNUAL = getEnv('STRIPE_PRICE_ID_STARTER_ANNUAL');
export const STRIPE_PRICE_ID_PRO_MONTHLY = getEnv('STRIPE_PRICE_ID_PRO_MONTHLY');
export const STRIPE_PRICE_ID_PRO_ANNUAL = getEnv('STRIPE_PRICE_ID_PRO_ANNUAL');
export const STRIPE_PRICE_ID_STUDIO_MONTHLY = getEnv('STRIPE_PRICE_ID_STUDIO_MONTHLY');
export const STRIPE_PRICE_ID_STUDIO_ANNUAL = getEnv('STRIPE_PRICE_ID_STUDIO_ANNUAL');
