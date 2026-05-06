import Mailjet, { type LibraryResponse } from 'node-mailjet';
import { MAILJET_API_KEY, MAILJET_API_SECRET } from '@conf/env';
import { integrationLog } from '@lib/loggers';
import { captureError } from '@lib/errorReporter';

// Wraps Mailjet's Contact + ContactsList REST APIs for the marketing
// opt-in toggle in profile settings.
//
// Source of truth for "is this user opted into marketing?" lives in
// Mailjet's Contact DB, not our Mongo. The two paths a user can change
// state — clicking the unsubscribe link in a promotional email (Mailjet's
// hosted page) and toggling the checkbox in profile settings (this
// service) — both write to the same Mailjet record, so they stay
// consistent without sync logic.
//
// Trade-off: every settings render does a Mailjet round trip. Acceptable
// at our scale; if it ever isn't, mirror the flag locally with a
// background reconcile.

const mailjet = new Mailjet({
  apiKey: MAILJET_API_KEY,
  apiSecret: MAILJET_API_SECRET,
});

// The list name as it appears in the Mailjet dashboard. Resolved to a
// numeric ID at runtime (cached) so a rename in Mailjet that doesn't
// preserve the ID would break loudly here rather than silently misroute.
const PROMOTIONAL_LIST_NAME = 'promotional';

let cachedListId: number | null = null;

const resolvePromotionalListId = async (): Promise<number> => {
  if (cachedListId !== null) return cachedListId;

  type ListsResp = { Data: { ID: number; Name: string }[] };
  const res = (await mailjet
    .get('contactslist', { version: 'v3' })
    .request({ Name: PROMOTIONAL_LIST_NAME })) as LibraryResponse<ListsResp>;

  // Filter to an exact name match — Mailjet's `?Name=` filter is a
  // substring match on some endpoints, and matching the wrong list here
  // would silently route every read/write to a different audience.
  const exact = (res.body.Data ?? []).find((l) => l.Name === PROMOTIONAL_LIST_NAME);
  if (!exact) {
    throw new Error(
      `Mailjet contact list named "${PROMOTIONAL_LIST_NAME}" not found — create it in the Mailjet dashboard.`,
    );
  }
  cachedListId = exact.ID;
  integrationLog.info(`mailjet:contact:list-resolved name=${exact.Name} id=${exact.ID}`);
  return cachedListId;
};

// Returns whether the email address is currently opted into the
// promotional list. Default semantics:
//   - Never seen by Mailjet, or never on the list  → opted in (true).
//     New users default-in until they explicitly opt out — opt-out, not
//     opt-in, is the marketing-list convention this app ships with.
//   - On the list, IsUnsubscribed=false             → opted in (true).
//   - On the list, IsUnsubscribed=true              → opted out (false).
//
// 404s from the Mailjet API are treated as "contact not found, default
// in" — we never want a missing contact to flip the checkbox to off and
// confuse the user.
export const getPromotionalSubscribed = async (email: string): Promise<boolean> => {
  try {
    const listId = await resolvePromotionalListId();
    // `contact/{email}/getcontactslists` is keyed directly on the email
    // (Mailjet treats it as a unique resource id), unlike the generic
    // `listrecipient` filter endpoint whose `Contact` parameter expects a
    // numeric contact id and silently returns nothing on a string email.
    type ContactListsResp = {
      Data: { ListID: number; IsUnsub: boolean; IsActive: boolean }[];
    };
    const res = (await mailjet
      .get('contact', { version: 'v3' })
      .id(email)
      .action('getcontactslists')
      .request()) as LibraryResponse<ContactListsResp>;

    const row = res.body.Data?.find((r) => r.ListID === listId);
    if (!row) {
      integrationLog.info(`mailjet:contact:get-subscribed not-on-list email=${email}`);
      return true; // Never on the list → default opted in.
    }
    integrationLog.info(
      `mailjet:contact:get-subscribed ok email=${email} isUnsub=${row.IsUnsub} isActive=${row.IsActive}`,
    );
    return !row.IsUnsub;
  } catch (err) {
    const status = (err as { statusCode?: number; ErrorMessage?: string })?.statusCode;
    // 404 = contact does not exist yet in Mailjet's DB. Default to opted in.
    if (status === 404) {
      integrationLog.info(`mailjet:contact:get-subscribed contact-not-found email=${email}`);
      return true;
    }
    integrationLog.warn(
      `mailjet:contact:get-subscribed fail email=${email} reason=${(err as Error).message}`,
    );
    captureError(err, {
      tags: { mailjet_contact: 'get_subscribed' },
      extra: { email },
      fingerprint: ['mailjet_contact', 'get_subscribed'],
    });
    throw err;
  }
};

// Subscribes / unsubscribes the contact via the list-scoped managecontact
// endpoint, which creates the Mailjet contact in the same call if it
// doesn't already exist. The `contact/{email}/managecontactslists` form
// returns 404 when the contact is unknown, which is exactly the case we
// hit on the user's first settings toggle.
//
//   - `addforce`: upserts the contact and clears IsUnsubscribed on this list.
//   - `unsub`   : marks IsUnsubscribed=true on this list (matches what the
//                 email-link unsubscribe writes on Mailjet's hosted page).
export const setPromotionalSubscribed = async (params: {
  email: string;
  subscribed: boolean;
}): Promise<void> => {
  try {
    const listId = await resolvePromotionalListId();
    const action = params.subscribed ? 'addforce' : 'unsub';

    type ManageContactResp = { Count: number; Data: { ContactID: number; Email: string }[] };
    const res = (await mailjet
      .post('contactslist', { version: 'v3' })
      .id(listId)
      .action('managecontact')
      .request({ Email: params.email, Action: action })) as LibraryResponse<ManageContactResp>;

    const contactId = res.body.Data?.[0]?.ContactID;
    integrationLog.info(
      `mailjet:contact:set-subscribed ok email=${params.email} subscribed=${params.subscribed} listId=${listId} contactId=${contactId ?? '-'}`,
    );
  } catch (err) {
    integrationLog.warn(
      `mailjet:contact:set-subscribed fail email=${params.email} subscribed=${params.subscribed} reason=${(err as Error).message}`,
    );
    captureError(err, {
      tags: { mailjet_contact: 'set_subscribed' },
      extra: { email: params.email, subscribed: params.subscribed },
      fingerprint: ['mailjet_contact', 'set_subscribed'],
    });
    throw err;
  }
};
