import Mailjet, { type LibraryResponse } from 'node-mailjet';
import pLimit from 'p-limit';
import { MAILJET_API_KEY, MAILJET_API_SECRET } from '@conf/env';
import { integrationLog } from '@lib/loggers';
import { captureError } from '@lib/errorReporter';
import { resolvePromotionalListId } from './mailjetContactService';

// **Bulk** suppression read for the Mailjet promotional list.
//
// Supersedes per-recipient `getPromotionalSubscribed` calls for both
// seeding and sending. Two reasons (PLAN A0, design target 1,000 users):
//
//   1. Per-recipient does not survive the audience. One sequential HTTP
//      round trip per address inside a single request is minutes of
//      wall-clock at 1,000 recipients, and `getPromotionalSubscribed`
//      *rethrows on any non-404* — one Mailjet hiccup two-thirds of the way
//      through aborts the whole run.
//   2. A seed-time snapshot goes stale. Read immediately before each
//      campaign (and, in the send path, before each batch), this is both
//      cheaper and fresher than a stored mirror of Mailjet's state — which
//      is the design the wiki explicitly warns against, because Mailjet's
//      hosted unsubscribe page writes there without telling us.
//
// **Fails closed, always.** Every error path throws
// `MailjetSuppressionUnavailableError` rather than returning a short set.
// A partial suppression set is not a degraded answer — it silently
// reclassifies every address it missed as "safe to mail", which is exactly
// the resurrection of an unsubscriber that PLAN A2b forbids.
//
// Egress note (data-protection §5.1): this call is inbound-only. It reads
// addresses Mailjet already holds; nothing about our users leaves here.

const mailjet = new Mailjet({
  apiKey: MAILJET_API_KEY,
  apiSecret: MAILJET_API_SECRET,
});

/** Mailjet's maximum page size on the v3 REST collections. */
export const SUPPRESSION_PAGE_SIZE = 1000;

/**
 * Hard ceiling on pages per collection. Guards against a broken `Offset`
 * filter (or a list that grew past anything we planned for) turning the
 * read into an unbounded loop. Hitting it is a fail-closed condition, not a
 * truncation — a truncated set is the failure mode this module exists to
 * prevent.
 */
const MAX_PAGES = 100;

/**
 * Ceiling on the targeted `GET /contact/{id}` lookups used to resolve
 * unsubscribers the bulk contact listing did not return (see the join
 * comment below). This is bounded by the number of people who UNSUBSCRIBED,
 * not by audience size, so it stays a small fraction of the 1,000-user
 * design target — the per-recipient pattern A0 rejects is one call per
 * *recipient*, which is a different order of magnitude. Exceeding the cap
 * is a fail-closed condition.
 */
const MAX_TARGETED_LOOKUPS = 1000;

/** Concurrency for those targeted lookups — polite to Mailjet, still fast. */
const TARGETED_LOOKUP_CONCURRENCY = 5;

export class MailjetSuppressionUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MailjetSuppressionUnavailableError';
  }
}

export interface PromotionalSuppressionSet {
  /** Lowercased addresses that MUST NOT receive promotional mail. */
  suppressed: ReadonlySet<string>;
  listId: number;
  /** Contacts on the list, suppressed or not — a sanity number for logs. */
  membershipCount: number;
  fetchedAt: Date;
}

interface ContactRow {
  ID?: number;
  Email?: string;
  /** Mailjet's account-wide exclusion list (global unsubscribe). */
  IsExcludedFromCampaigns?: boolean;
  IsSpamComplaining?: boolean;
}

interface ListRecipientRow {
  ContactID?: number;
  IsUnsubscribed?: boolean;
  /** Older payloads spell it this way; read both rather than guess. */
  IsUnsub?: boolean;
}

/**
 * Page one v3 collection to exhaustion. Any non-array `Data`, any thrown
 * request, or a stream that never shortens is a hard failure.
 */
const readAllPages = async <T>(resource: string, filters: Record<string, unknown>): Promise<T[]> => {
  const rows: T[] = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * SUPPRESSION_PAGE_SIZE;
    type Resp = { Count?: number; Total?: number; Data?: T[] };

    const res = (await mailjet
      .get(resource, { version: 'v3' })
      .request({ ...filters, Limit: SUPPRESSION_PAGE_SIZE, Offset: offset })) as LibraryResponse<Resp>;

    const data = res?.body?.Data;
    if (!Array.isArray(data)) {
      throw new MailjetSuppressionUnavailableError(
        `Mailjet ${resource} page ${page} returned no readable Data array`,
      );
    }

    rows.push(...data);
    // A short page is the end of the collection. A full page means there
    // may be more — keep going until the cap.
    if (data.length < SUPPRESSION_PAGE_SIZE) return rows;
  }

  throw new MailjetSuppressionUnavailableError(
    `Mailjet ${resource} did not terminate within ${MAX_PAGES} pages — refusing to treat a truncated read as complete`,
  );
};

/** Resolve one contact id to its address. Throws (fail closed) if Mailjet
 *  cannot tell us — an unsubscriber we cannot name is an unsubscriber we
 *  would otherwise mail. */
const resolveContactEmail = async (contactId: number): Promise<string> => {
  try {
    type Resp = { Data?: { Email?: string }[] };
    const res = (await mailjet
      .get('contact', { version: 'v3' })
      .id(contactId)
      .request()) as LibraryResponse<Resp>;
    const email = res?.body?.Data?.[0]?.Email;
    if (typeof email !== 'string' || email.length === 0) {
      throw new Error('no Email on the contact record');
    }
    return email.toLowerCase().trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MailjetSuppressionUnavailableError(
      `Could not resolve the address of unsubscribed Mailjet contact ${contactId}: ${message}`,
      { cause: err },
    );
  }
};

/**
 * Read the promotional list's membership and return every address that must
 * be excluded from a send: unsubscribed from the list, excluded account-wide,
 * or a recorded spam complainant.
 *
 * Throws `MailjetSuppressionUnavailableError` on any failure. Callers MUST
 * abort the seed/campaign on that error rather than proceeding with an
 * empty set.
 */
export const fetchPromotionalSuppression = async (): Promise<PromotionalSuppressionSet> => {
  try {
    const listId = await resolvePromotionalListId();

    // Two bulk reads, joined on ContactID:
    //   - `listrecipient?ContactsList` is the AUTHORITATIVE per-list
    //     unsubscribe state, but identifies contacts numerically.
    //   - `contact` carries addresses plus the account-wide exclusion
    //     flags, but no per-list state.
    //
    // Neither Mailjet collection listing is trustworthy as a complete
    // address book, which is the trap here and was found live rather than
    // reasoned about:
    //   - `contact?ContactsList=<id>` returns only the list's *subscribed*
    //     members, i.e. it hides exactly the people this function exists to
    //     find, so the filter is deliberately omitted;
    //   - even unfiltered, `contact` came back with `Total: 10` on an
    //     account holding far more, while `GET /contact/{id}` resolved a
    //     missing id immediately.
    //
    // So the bulk contact read is treated as an OPPORTUNISTIC map, not as
    // ground truth: it saves lookups where it happens to have the row, and
    // anything it misses is resolved one id at a time below. `listrecipient`
    // remains the only thing we rely on for "who unsubscribed".
    //
    // `allSettled`, not `all`: with `all`, a rejection from the first
    // collection leaves the second one's eventual rejection unhandled, and
    // Node reports that as a process-level warning rather than as this
    // function's failure.
    const [contactsResult, recipientsResult] = await Promise.allSettled([
      readAllPages<ContactRow>('contact', {}),
      readAllPages<ListRecipientRow>('listrecipient', { ContactsList: listId }),
    ]);
    if (contactsResult.status === 'rejected') throw contactsResult.reason;
    if (recipientsResult.status === 'rejected') throw recipientsResult.reason;
    const contacts = contactsResult.value;
    const recipients = recipientsResult.value;

    const emailById = new Map<number, string>();
    const suppressed = new Set<string>();

    for (const row of contacts) {
      if (typeof row.ID !== 'number' || typeof row.Email !== 'string' || row.Email.length === 0) {
        throw new MailjetSuppressionUnavailableError(
          'Mailjet contact page contained a row without a usable ID/Email pair',
        );
      }
      const email = row.Email.toLowerCase().trim();
      emailById.set(row.ID, email);
      // Account-wide exclusion (Mailjet's global unsubscribe / hard-bounce
      // list) and spam complaints suppress regardless of list membership.
      // Opportunistic, per the note above — Mailjet enforces these on its
      // own side regardless, so anything the listing omits still cannot be
      // delivered to. Including what we do see makes our set a superset of
      // "unsubscribed from the promotional list", which is the safe
      // direction to be wrong in.
      if (row.IsExcludedFromCampaigns === true || row.IsSpamComplaining === true) {
        suppressed.add(email);
      }
    }

    const unsubIds: number[] = [];
    for (const row of recipients) {
      const isUnsub = row.IsUnsubscribed === true || row.IsUnsub === true;
      if (!isUnsub) continue;
      if (typeof row.ContactID !== 'number') {
        throw new MailjetSuppressionUnavailableError(
          'Mailjet listrecipient reported an unsubscribe with no ContactID',
        );
      }
      unsubIds.push(row.ContactID);
    }

    if (unsubIds.length > MAX_TARGETED_LOOKUPS) {
      throw new MailjetSuppressionUnavailableError(
        `Mailjet reported ${unsubIds.length} unsubscribers, above the ${MAX_TARGETED_LOOKUPS} lookup ceiling — refusing to resolve a partial set`,
      );
    }

    const limit = pLimit(TARGETED_LOOKUP_CONCURRENCY);
    const resolved = await Promise.all(
      unsubIds.map((id) =>
        limit(async () => emailById.get(id) ?? (await resolveContactEmail(id))),
      ),
    );
    for (const email of resolved) suppressed.add(email);

    integrationLog.info(
      `mailjet:suppression:fetch ok listId=${listId} members=${recipients.length} contacts=${contacts.length} unsubs=${unsubIds.length} suppressed=${suppressed.size}`,
    );

    return {
      suppressed,
      listId,
      membershipCount: recipients.length,
      fetchedAt: new Date(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    integrationLog.error(`mailjet:suppression:fetch fail reason=${message}`);
    captureError(err, {
      tags: { mailjet_contact: 'suppression_sync' },
      fingerprint: ['mailjet_contact', 'suppression_sync'],
    });
    if (err instanceof MailjetSuppressionUnavailableError) throw err;
    throw new MailjetSuppressionUnavailableError(
      `Could not read the Mailjet promotional suppression set: ${message}`,
      { cause: err },
    );
  }
};
