/**
 * Mixpanel server wrapper. Used for state-of-record events that must
 * survive ad-blockers, browser tabs closing mid-flow, or server-only
 * sources (Stripe webhooks, jobRunner finalisation hooks):
 *
 *   import { analytics } from '@lib/analytics';
 *   analytics.track(userId, 'signup_completed', { auth_method });
 *
 * Distinct ID convention: server passes `User._id` directly. The same
 * value is what the client wrapper calls `mixpanel.identify(userId)` with,
 * so events from both surfaces stitch onto one timeline with no merge.
 *
 * The wrapper is the only place that imports `mixpanel`. Swapping
 * providers later is a one-file change.
 *
 * Disabled in `ENVIRONMENT === 'test'` so vitest doesn't emit real HTTP
 * traffic against Mixpanel's ingest. In dev/prod the SDK is always live;
 * `getEnv` already prevents boot without a token.
 */

import Mixpanel from 'mixpanel';
import { ENVIRONMENT, MIXPANEL_PROJECT_TOKEN } from '@conf/env';
import { integrationLog } from '@lib/loggers';

const enabled = ENVIRONMENT !== 'test';

const mp = enabled
  ? Mixpanel.init(MIXPANEL_PROJECT_TOKEN, { host: 'api-eu.mixpanel.com' })
  : null;

/**
 * Wrap an SDK call so a misbehaving Mixpanel client (e.g. transient
 * network blip, malformed property) can never bring down a request
 * handler. Mixpanel's Node SDK already swallows network errors, but a
 * defensive try/catch protects against future regressions and makes
 * intent explicit.
 */
const safe = (op: string, fn: () => void): void => {
  if (!mp) return;
  try {
    fn();
  } catch (err) {
    integrationLog.warn(`mixpanel:${op}_failed err=${(err as Error).message}`);
  }
};

export const analytics = {
  track: (
    userId: string,
    event: string,
    props: Record<string, unknown> = {},
  ): void => {
    if (!userId) return;
    safe('track', () => mp!.track(event, { distinct_id: userId, ...props }));
  },

  /** Set people properties (`$set`). Use for plan, billing_cycle, etc. */
  setUserProps: (
    userId: string,
    props: Record<string, unknown>,
  ): void => {
    if (!userId) return;
    safe('set', () => mp!.people.set(userId, props));
  },

  /**
   * Increment a numeric people property. Used for cumulative counters
   * like `total_courses_created` that shouldn't require a query-time
   * aggregation to use as a cohort filter.
   */
  incrementUserProp: (userId: string, prop: string, by = 1): void => {
    if (!userId) return;
    safe('increment', () => mp!.people.increment(userId, prop, by));
  },

  /**
   * Hard-delete the user's profile + events from Mixpanel. Wire into the
   * account-deletion cascade in `controlers/auth/deleteAccount.ts` to
   * satisfy GDPR right-to-erasure.
   */
  deleteUser: (userId: string): void => {
    if (!userId) return;
    safe('delete_user', () => mp!.people.delete_user(userId));
  },
};
