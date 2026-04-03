const getEnv = (key: string): string => {
  const value = process.env[key];

  if (!value) {
    console.error(`Error: Required environment variable ${key} is missing`);
    process.exit(1);
  }

  return value;
};

export const ENVIRONMENT = getEnv('ENVIRONMENT'); // development|production
export const OPENAI_API_KEY = getEnv('OPENAI_API_KEY');
export const ANTHROPIC_API_KEY = getEnv('ANTHROPIC_API_KEY');
export const MONGO_URI = getEnv('MONGO_URI');
export const JWT_SECRET = getEnv('JWT_SECRET');
export const FRONTEND_URL = getEnv('FRONTEND_URL');
export const GOOGLE_CLIENT_ID = getEnv('GOOGLE_CLIENT_ID');
export const MAILJET_API_KEY = getEnv('MAILJET_API_KEY');
export const MAILJET_API_SECRET = getEnv('MAILJET_API_SECRET');
export const TAVILY_API_KEY = getEnv('TAVILY_API_KEY');

export const JUDGE0_API_KEY = getEnv('JUDGE0_API_KEY');
export const JUDGE0_API_URL = getEnv('JUDGE0_API_URL');

export const AWS_S3_BUCKET = getEnv('AWS_S3_BUCKET');
export const AWS_S3_REGION = getEnv('AWS_S3_REGION');
export const AWS_ACCESS_KEY_ID = getEnv('AWS_ACCESS_KEY_ID');
export const AWS_SECRET_ACCESS_KEY = getEnv('AWS_SECRET_ACCESS_KEY');

export const PORT = process.env.PORT || 4000;
export const API_URL = process.env.API_URL || `http://localhost:${PORT}`;
