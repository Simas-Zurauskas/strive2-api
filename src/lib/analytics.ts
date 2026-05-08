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
 */

import Mixpanel from 'mixpanel';
import { MIXPANEL_PROJECT_TOKEN } from '@conf/env';

const mp = Mixpanel.init(MIXPANEL_PROJECT_TOKEN, {
  host: 'api-eu.mixpanel.com',
});

export const analytics = {
  track: (
    userId: string,
    event: string,
    props: Record<string, unknown> = {},
  ): void => {
    mp.track(event, { distinct_id: userId, ...props });
  },

  /** Set people properties (`$set`). Use for plan, billing_cycle, etc. */
  setUserProps: (
    userId: string,
    props: Record<string, unknown>,
  ): void => {
    mp.people.set(userId, props);
  },

  /**
   * Increment a numeric people property. Used for cumulative counters
   * like `total_courses_created` that shouldn't require a query-time
   * aggregation to use as a cohort filter.
   */
  incrementUserProp: (userId: string, prop: string, by = 1): void => {
    mp.people.increment(userId, prop, by);
  },

  /**
   * Hard-delete the user's profile + events from Mixpanel. Wire into the
   * account-deletion cascade in `controlers/auth/deleteAccount.ts` to
   * satisfy GDPR right-to-erasure.
   */
  deleteUser: (userId: string): void => {
    mp.people.delete_user(userId);
  },
};
