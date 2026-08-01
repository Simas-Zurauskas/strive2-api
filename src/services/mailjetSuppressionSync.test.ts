/**
 * Tests for the bulk Mailjet suppression read (PLAN A0 / A2b, Phase 3).
 *
 * This is the mechanism that keeps us from re-subscribing anyone who has
 * already unsubscribed, so the two properties under test are:
 *   1. it pages — a list bigger than one page is read completely;
 *   2. it FAILS CLOSED — any partial failure throws rather than returning
 *      a short set, because a short set silently converts "unsubscribed"
 *      into "subscribed" for everyone it missed.
 *
 * Run: yarn test mailjetSuppressionSync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mailjetGet, mailjetGetById, fakeResolveListId } = vi.hoisted(() => ({
  mailjetGet: vi.fn(),
  mailjetGetById: vi.fn(),
  fakeResolveListId: vi.fn(() => Promise.resolve(42)),
}));

vi.mock('node-mailjet', () => {
  class FakeMailjet {
    get(resource: string) {
      return {
        request: (params?: Record<string, unknown>) => mailjetGet(resource, params),
        id: (id: number) => ({ request: () => mailjetGetById(resource, id) }),
      };
    }
  }
  return { default: FakeMailjet };
});

vi.mock('@services/mailjetContactService', () => ({
  resolvePromotionalListId: fakeResolveListId,
  PROMOTIONAL_LIST_NAME: 'promotional',
  getPromotionalSubscribed: vi.fn(),
  setPromotionalSubscribed: vi.fn(),
  deletePromotionalContact: vi.fn(),
  syncSuppression: vi.fn(),
}));

import {
  fetchPromotionalSuppression,
  MailjetSuppressionUnavailableError,
  SUPPRESSION_PAGE_SIZE,
} from '@services/mailjetSuppressionSync';

interface ContactRow {
  ID: number;
  Email: string;
  IsExcludedFromCampaigns?: boolean;
  IsSpamComplaining?: boolean;
}
interface RecipientRow {
  ContactID: number;
  IsUnsubscribed?: boolean;
}

/**
 * Wire the fake Mailjet up to fixed page arrays. `contacts` and
 * `recipients` are the FULL result sets; the helper slices them by the
 * Offset/Limit the module asks for, so the test exercises real paging
 * rather than a canned two-call script.
 */
const wire = (params: { contacts: ContactRow[]; recipients: RecipientRow[] }) => {
  mailjetGet.mockImplementation((resource: string, query: Record<string, unknown>) => {
    const offset = Number(query.Offset ?? 0);
    const limit = Number(query.Limit ?? SUPPRESSION_PAGE_SIZE);
    const source = resource === 'contact' ? params.contacts : params.recipients;
    const page = source.slice(offset, offset + limit);
    return Promise.resolve({ body: { Count: page.length, Total: source.length, Data: page } });
  });
};

beforeEach(() => {
  mailjetGet.mockReset();
  mailjetGetById.mockReset();
  // Default: the targeted per-id lookup is unavailable, so any test that
  // does not explicitly wire it must be resolving addresses from the bulk
  // page — and any that cannot must fail closed.
  mailjetGetById.mockRejectedValue(new Error('no targeted lookup wired'));
  fakeResolveListId.mockReset();
  fakeResolveListId.mockResolvedValue(42);
});

describe('fetchPromotionalSuppression — happy paths', () => {
  test('returns the unsubscribed addresses, lowercased, and nothing else', async () => {
    wire({
      contacts: [
        { ID: 1, Email: 'Subscribed@Example.com' },
        { ID: 2, Email: 'UNSUBBED@Example.com' },
        { ID: 3, Email: 'excluded@example.com', IsExcludedFromCampaigns: true },
        { ID: 4, Email: 'complainer@example.com', IsSpamComplaining: true },
      ],
      recipients: [
        { ContactID: 1, IsUnsubscribed: false },
        { ContactID: 2, IsUnsubscribed: true },
        { ContactID: 3, IsUnsubscribed: false },
        { ContactID: 4, IsUnsubscribed: false },
      ],
    });

    const result = await fetchPromotionalSuppression();

    expect([...result.suppressed].sort()).toEqual([
      'complainer@example.com',
      'excluded@example.com',
      'unsubbed@example.com',
    ]);
    expect(result.suppressed.has('subscribed@example.com')).toBe(false);
    expect(result.listId).toBe(42);
    expect(result.membershipCount).toBe(4);
  });

  test('pages through a membership larger than one page', async () => {
    const total = SUPPRESSION_PAGE_SIZE + 7;
    const contacts: ContactRow[] = Array.from({ length: total }, (_, i) => ({
      ID: i + 1,
      Email: `u${i + 1}@example.com`,
    }));
    // The unsubscribed contact sits on the SECOND page — a single-page
    // read would miss it and silently re-subscribe them.
    const recipients: RecipientRow[] = contacts.map((c, i) => ({
      ContactID: c.ID,
      IsUnsubscribed: i === total - 1,
    }));
    wire({ contacts, recipients });

    const result = await fetchPromotionalSuppression();

    expect(result.membershipCount).toBe(total);
    expect(result.suppressed.has(`u${total}@example.com`)).toBe(true);
    expect(result.suppressed.size).toBe(1);
    // 2 pages of contacts + 2 pages of recipients.
    expect(mailjetGet).toHaveBeenCalledTimes(4);
  });

  test('reads the contact collection UNFILTERED — the list filter hides the very people we need', async () => {
    // Live-API behaviour: `contact?ContactsList=<id>` returns only the
    // list's *subscribed* members, so filtering it would leave every
    // unsubscriber unresolvable and fail every run closed.
    wire({
      contacts: [{ ID: 1, Email: 'a@example.com' }],
      recipients: [{ ContactID: 1, IsUnsubscribed: true }],
    });
    await fetchPromotionalSuppression();

    const contactCall = mailjetGet.mock.calls.find(([resource]) => resource === 'contact');
    const recipientCall = mailjetGet.mock.calls.find(([resource]) => resource === 'listrecipient');
    expect(contactCall?.[1]).not.toHaveProperty('ContactsList');
    expect(recipientCall?.[1]).toMatchObject({ ContactsList: 42 });
  });

  test('resolves an unsubscriber the bulk contact listing omits, via a targeted lookup', async () => {
    // The live failure this covers: Mailjet's `contact` collection listing
    // is NOT a complete address book (it returned Total:10 on an account
    // holding far more), while `GET /contact/{id}` resolves the same id
    // immediately. Without the fallback every run fails closed and the
    // seed can never proceed.
    wire({
      contacts: [{ ID: 1, Email: 'onpage@example.com' }],
      recipients: [
        { ContactID: 1, IsUnsubscribed: false },
        { ContactID: 777, IsUnsubscribed: true },
      ],
    });
    mailjetGetById.mockResolvedValue({ body: { Data: [{ Email: 'Hidden@Example.com' }] } });

    const result = await fetchPromotionalSuppression();

    expect([...result.suppressed]).toEqual(['hidden@example.com']);
    expect(mailjetGetById).toHaveBeenCalledWith('contact', 777);
    // Only the unsubscriber is looked up — never one call per recipient.
    expect(mailjetGetById).toHaveBeenCalledTimes(1);
  });

  test('an empty promotional list yields an empty (not failed) suppression set', async () => {
    wire({ contacts: [], recipients: [] });
    const result = await fetchPromotionalSuppression();
    expect(result.suppressed.size).toBe(0);
    expect(result.membershipCount).toBe(0);
  });
});

describe('fetchPromotionalSuppression — fails closed', () => {
  test('a mid-run page failure throws instead of returning a partial set', async () => {
    const total = SUPPRESSION_PAGE_SIZE + 5;
    const contacts: ContactRow[] = Array.from({ length: total }, (_, i) => ({
      ID: i + 1,
      Email: `u${i + 1}@example.com`,
    }));
    let calls = 0;
    mailjetGet.mockImplementation((resource: string, query: Record<string, unknown>) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('Mailjet 502'));
      const offset = Number(query.Offset ?? 0);
      const page = contacts.slice(offset, offset + SUPPRESSION_PAGE_SIZE);
      return Promise.resolve({ body: { Count: page.length, Total: total, Data: page } });
    });

    await expect(fetchPromotionalSuppression()).rejects.toBeInstanceOf(
      MailjetSuppressionUnavailableError,
    );
  });

  test('a failure resolving the list id throws (no list = unknown audience state)', async () => {
    fakeResolveListId.mockRejectedValueOnce(new Error('list not found'));
    await expect(fetchPromotionalSuppression()).rejects.toBeInstanceOf(
      MailjetSuppressionUnavailableError,
    );
  });

  test('an unsubscribed contact whose address we cannot resolve AT ALL throws', async () => {
    // ContactID 9 is flagged unsubscribed, is absent from the bulk contact
    // page, and the targeted lookup also fails. We cannot name the address
    // to suppress, so we must not pretend the set is complete.
    wire({
      contacts: [{ ID: 1, Email: 'known@example.com' }],
      recipients: [
        { ContactID: 1, IsUnsubscribed: false },
        { ContactID: 9, IsUnsubscribed: true },
      ],
    });
    await expect(fetchPromotionalSuppression()).rejects.toBeInstanceOf(
      MailjetSuppressionUnavailableError,
    );
  });

  test('a targeted lookup that returns no address throws', async () => {
    wire({ contacts: [], recipients: [{ ContactID: 9, IsUnsubscribed: true }] });
    mailjetGetById.mockResolvedValue({ body: { Data: [{ Email: '' }] } });
    await expect(fetchPromotionalSuppression()).rejects.toBeInstanceOf(
      MailjetSuppressionUnavailableError,
    );
  });

  test('a malformed page body throws rather than being read as "no suppressions"', async () => {
    mailjetGet.mockResolvedValue({ body: { Count: 0, Total: 0, Data: null } });
    await expect(fetchPromotionalSuppression()).rejects.toBeInstanceOf(
      MailjetSuppressionUnavailableError,
    );
  });

  test('a never-shrinking page stream throws instead of looping forever', async () => {
    // Every page comes back full — a broken Offset filter. Bounded by the
    // page cap and reported as unavailable.
    const fullPage = Array.from({ length: SUPPRESSION_PAGE_SIZE }, (_, i) => ({
      ID: i + 1,
      Email: `u${i + 1}@example.com`,
    }));
    mailjetGet.mockResolvedValue({
      body: { Count: fullPage.length, Total: 10_000_000, Data: fullPage },
    });
    await expect(fetchPromotionalSuppression()).rejects.toBeInstanceOf(
      MailjetSuppressionUnavailableError,
    );
  });
});
