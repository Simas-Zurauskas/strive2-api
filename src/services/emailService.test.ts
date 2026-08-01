/**
 * Transport-level pins for the promotional stream.
 *
 * Everything asserted here is invisible in the rendered email and fails
 * silently in production if it regresses: a wrong `From`, a missing
 * `TemplateLanguage`, an absent `List-Unsubscribe`, or tracking left on the
 * Mailjet account default. The whole point of the file is that these are
 * properties of the *payload*, so they can be checked without sending mail.
 *
 * Also pins that `sendAsyncWithRetry` — the transactional harness — is
 * unchanged by Phase 4 (PLAN §1 protected surfaces / F12).
 *
 * Run: yarn test emailService
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { mailjetPost } = vi.hoisted(() => ({ mailjetPost: vi.fn() }));

vi.mock('node-mailjet', () => {
  class FakeMailjet {
    post(resource: string, opts?: Record<string, unknown>) {
      return {
        request: (body: Record<string, unknown>) => mailjetPost(resource, opts, body),
      };
    }
  }
  return { default: FakeMailjet };
});

import {
  sendDocumentsFeatureEmail,
  sendWithRetry,
  sendVerificationEmailAsync,
  SENDER_EMAIL_ACCOUNT,
  SENDER_EMAIL_PROMOTIONAL,
} from '@services/emailService';
import { integrationLog } from '@lib/loggers';

interface MailjetMessage {
  From: { Email: string; Name: string };
  To: { Email: string }[];
  Subject: string;
  HTMLPart: string;
  TextPart: string;
  TemplateLanguage?: boolean;
  Headers?: Record<string, string>;
  TrackOpens?: string;
  TrackClicks?: string;
}

const lastMessage = (): MailjetMessage => {
  const [, , body] = mailjetPost.mock.calls[mailjetPost.mock.calls.length - 1] as [
    string,
    unknown,
    { Messages: MailjetMessage[] },
  ];
  return body.Messages[0];
};

const UNSUB = 'https://api.strive-learning.com/api/auth/marketing/unsubscribe?token=abc.def';

beforeEach(() => {
  mailjetPost.mockReset();
  mailjetPost.mockResolvedValue({ body: { Messages: [{ Status: 'success' }] } });
});

describe('sendDocumentsFeatureEmail', () => {
  test('sends from the promotional address and enables the template language', async () => {
    await sendDocumentsFeatureEmail({ to: 'a@b.com', unsubscribeUrl: UNSUB });
    const msg = lastMessage();
    expect(msg.From.Email).toBe(SENDER_EMAIL_PROMOTIONAL);
    expect(msg.From.Email).not.toBe(SENDER_EMAIL_ACCOUNT);
    expect(msg.TemplateLanguage).toBe(true);
  });

  test('carries OUR unsubscribe URL in the body and in the RFC 8058 headers', async () => {
    await sendDocumentsFeatureEmail({ to: 'a@b.com', unsubscribeUrl: UNSUB });
    const msg = lastMessage();
    expect(msg.TextPart).toContain(UNSUB);
    expect(msg.HTMLPart).toContain('marketing/unsubscribe');
    expect(msg.HTMLPart).not.toContain('[[UNSUB_LINK_EN]]');
    expect(msg.Headers?.['List-Unsubscribe']).toBe(`<${UNSUB}>`);
    expect(msg.Headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  test('disables open and click tracking (PLAN A10 — no tracking pixels)', async () => {
    await sendDocumentsFeatureEmail({ to: 'a@b.com', unsubscribeUrl: UNSUB });
    const msg = lastMessage();
    expect(msg.TrackOpens).toBe('disabled');
    expect(msg.TrackClicks).toBe('disabled');
  });

  test('names the sending entity in the shipped payload, without the identifier line', async () => {
    // The registered address / registration number line was removed from the
    // message body by founder decision (2026-07-30) — see lib/email/tokens.ts.
    // The entity is still named via the footer copyright line, which is what
    // identifies the sender; the address and registration code live on the
    // website instead. Pinned negative so the line cannot drift back in.
    await sendDocumentsFeatureEmail({ to: 'a@b.com', unsubscribeUrl: UNSUB });
    const msg = lastMessage();
    expect(msg.TextPart).toContain('MB Kūrybinis kodas');
    expect(msg.TextPart).not.toMatch(/REGISTERED ADDRESS/i);
    expect(msg.TextPart).not.toMatch(/Registration number/i);
  });

  test('without a ledger row, falls back to Mailjet’s link and omits the headers', async () => {
    await sendDocumentsFeatureEmail({ to: 'a@b.com' });
    const msg = lastMessage();
    expect(msg.HTMLPart).toContain('[[UNSUB_LINK_EN]]');
    expect(msg.TemplateLanguage).toBe(true);
    expect(msg.Headers).toBeUndefined();
  });
});

describe('sendWithRetry', () => {
  test('retries a transient failure and preserves from + templateLanguage on every attempt', async () => {
    vi.useFakeTimers();
    try {
      mailjetPost
        .mockRejectedValueOnce(new Error('502 upstream'))
        .mockResolvedValueOnce({ body: {} });

      const promise = sendWithRetry({
        to: 'a@b.com',
        payload: { subject: 's', html: '<p>h</p>', text: 't' },
        template: 'documents_feature',
        from: SENDER_EMAIL_PROMOTIONAL,
        templateLanguage: true,
        disableTracking: true,
      });
      await vi.runAllTimersAsync();
      await promise;

      expect(mailjetPost).toHaveBeenCalledTimes(2);
      for (const call of mailjetPost.mock.calls) {
        const msg = (call[2] as { Messages: MailjetMessage[] }).Messages[0];
        expect(msg.From.Email).toBe(SENDER_EMAIL_PROMOTIONAL);
        expect(msg.TemplateLanguage).toBe(true);
        expect(msg.TrackOpens).toBe('disabled');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  test('throws after the ladder is exhausted so the caller can roll back its claim', async () => {
    vi.useFakeTimers();
    try {
      mailjetPost.mockRejectedValue(new Error('permanently broken'));
      const promise = sendWithRetry({
        to: 'a@b.com',
        payload: { subject: 's', html: '<p>h</p>', text: 't' },
        template: 'documents_feature',
      });
      const assertion = expect(promise).rejects.toThrow('permanently broken');
      await vi.runAllTimersAsync();
      await assertion;
      // Three attempts: initial + two ladder rungs.
      expect(mailjetPost).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('never logs the recipient address', async () => {
    const warn = vi.spyOn(integrationLog, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      mailjetPost.mockRejectedValue(new Error('nope'));
      const promise = sendWithRetry({
        to: 'secret-person@example.com',
        payload: { subject: 's', html: '<p>h</p>', text: 't' },
        template: 'documents_feature',
      });
      const assertion = expect(promise).rejects.toThrow();
      await vi.runAllTimersAsync();
      await assertion;
      const lines = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(lines).not.toContain('secret-person@example.com');
      expect(lines).toContain('template=documents_feature');
    } finally {
      vi.useRealTimers();
      warn.mockRestore();
    }
  });
});

describe('sendAsyncWithRetry (protected surface) is unchanged', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('transactional mail still goes out fire-and-forget from the account sender, untracked fields unset', async () => {
    sendVerificationEmailAsync({ to: 'a@b.com', token: 'tok' });
    // Fire-and-forget: nothing has been attempted at return time.
    expect(mailjetPost).not.toHaveBeenCalled();

    await new Promise((r) => setImmediate(r));
    await vi.waitFor(() => expect(mailjetPost).toHaveBeenCalledTimes(1));

    const msg = lastMessage();
    expect(msg.From.Email).toBe(SENDER_EMAIL_ACCOUNT);
    // The harness drops from/templateLanguage — that is precisely why the
    // promotional path may not use it (F12). Pinned so a "helpful" refactor
    // that starts forwarding them is a visible decision, not a silent one.
    expect(msg.TemplateLanguage).toBeUndefined();
    expect(msg.Headers).toBeUndefined();
    expect(msg.TrackOpens).toBeUndefined();
    expect(msg.TrackClicks).toBeUndefined();
  });
});
