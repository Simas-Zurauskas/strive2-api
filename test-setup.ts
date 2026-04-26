/**
 * Vitest setup file — wired via vitest.config.ts `setupFiles`. Runs once per
 * test worker BEFORE any test module is imported, so any `@conf/env` import
 * downstream sees a populated env.
 *
 * Real values come from `.env` if present (process.env is already populated
 * by the time vitest starts); the `||` fallbacks keep CI/dev runs green
 * without a .env file. None of these stubs are exercised against real
 * services — every test that needs vendor calls stubs the relevant client.
 */

const stub = (key: string, value: string) => {
  if (!process.env[key]) process.env[key] = value;
};

stub('ENVIRONMENT', 'test');
stub('MONGO_URI', 'mongodb://localhost/test');
stub('JWT_SECRET', 'test-secret');
stub('FRONTEND_URL', 'http://localhost:3000');
stub('GOOGLE_CLIENT_ID', 'test');
stub('MAILJET_API_KEY', 'test');
stub('MAILJET_API_SECRET', 'test');
stub('ANTHROPIC_API_KEY', 'test');
stub('TAVILY_API_KEY', 'test');
stub('JINA_API_KEY', 'test');
stub('BFL_API_KEY', 'test');
stub('JUDGE0_API_KEY', 'test');
stub('JUDGE0_API_URL', 'http://localhost/judge0');
stub('AWS_S3_BUCKET', 'test');
stub('AWS_S3_REGION', 'test');
stub('AWS_ACCESS_KEY_ID', 'test');
stub('AWS_SECRET_ACCESS_KEY', 'test');
stub('STRIPE_SECRET_KEY', 'sk_test_stub');
stub('STRIPE_WEBHOOK_SECRET', 'whsec_stub');

// Subscription Stripe price IDs — only used by stripeService tests, but
// stubbed here so any module that pulls them in at load time also sees them.
stub('STRIPE_PRICE_ID_STARTER_MONTHLY', 'price_starter_mo');
stub('STRIPE_PRICE_ID_STARTER_ANNUAL', 'price_starter_yr');
stub('STRIPE_PRICE_ID_PRO_MONTHLY', 'price_pro_mo');
stub('STRIPE_PRICE_ID_PRO_ANNUAL', 'price_pro_yr');
stub('STRIPE_PRICE_ID_STUDIO_MONTHLY', 'price_studio_mo');
stub('STRIPE_PRICE_ID_STUDIO_ANNUAL', 'price_studio_yr');

// Silence the domain loggers — production stdout is great for triage but
// during tests the volume hides actual failures. Loggers can still be
// re-enabled per-test via `monetization.enabled = true` if a test wants
// to assert on a log line.
import { monetization } from '@lib/loggers';
monetization.enabled = false;
