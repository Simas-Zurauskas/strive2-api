/**
 * Template-level pins.
 *
 * Two things are pinned here that no other test covers:
 *   1. the corrected `legalName` (PLAN A5 / F20) — it rewrites the shared
 *      footer of all five transactional templates, which is a protected
 *      surface, so the change is held in place by an assertion rather than
 *      by whoever remembers it;
 *   2. the promotional documents campaign's mandatory commercial
 *      identifiers and claim-policy boundaries (F7, marketing brief §11).
 *
 * Run: yarn test templates
 */

import { describe, expect, test } from 'vitest';
import {
  buildVerificationEmail,
  buildPasswordResetEmail,
  buildSecurityActionCodeEmail,
  buildDocumentsFeatureEmail,
  type EmailPayload,
} from './templates';
import { brand, assertSenderIdentityComplete } from './tokens';

const transactional = (): EmailPayload[] => [
  buildVerificationEmail({ token: 'tok' }),
  buildPasswordResetEmail({ to: 'a@b.com', token: 'tok' }),
  buildSecurityActionCodeEmail({ action: 'set_password', code: '123456', expiresInMinutes: 30 }),
  buildSecurityActionCodeEmail({ action: 'change_password', code: '123456', expiresInMinutes: 30 }),
  buildSecurityActionCodeEmail({ action: 'delete_account', code: '123456', expiresInMinutes: 30 }),
];

describe('transactional templates (protected surface)', () => {
  test('all five carry the corrected controller name in the footer', () => {
    const payloads = transactional();
    expect(payloads).toHaveLength(5);
    for (const p of payloads) {
      expect(p.html).toContain('MB Kūrybinis kodas');
      expect(p.text).toContain('MB Kūrybinis kodas');
      // The old value was the product name. `strive-learning.com` in URLs
      // is lowercase-hyphenated and does not match this string.
      expect(p.html).not.toContain('Strive Learning');
      expect(p.text).not.toContain('Strive Learning');
    }
  });

  test('none of them grows an unsubscribe row or the promotional identifiers', () => {
    for (const p of transactional()) {
      expect(p.html).not.toContain('[[UNSUB_LINK_EN]]');
      expect(p.html).not.toContain('Unsubscribe');
      expect(p.text).not.toContain('Unsubscribe');
      expect(p.html).not.toContain('Registration number');
    }
  });
});

describe('buildDocumentsFeatureEmail', () => {
  const UNSUB = 'https://api.strive-learning.com/api/auth/marketing/unsubscribe?token=abc.def';

  test('identifies the sender and why the message was received', () => {
    const { html, text } = buildDocumentsFeatureEmail();
    for (const out of [html, text]) {
      expect(out).toContain(brand.legalName);
      // The apostrophe is entity-escaped in the HTML arm, so match around it.
      expect(out).toContain('receiving this because you have a Strive account.');
    }
  });

  test('carries no registered address or registration number (founder decision 2026-07-30)', () => {
    // Removed from the message body: e-Commerce Dir. Art. 5(1) is satisfied by
    // the website, not by repetition in every email. Pinned so the line is not
    // reintroduced by accident — if a US-facing send is planned, CAN-SPAM does
    // require a postal address and this test is the place to revisit.
    const { html, text } = buildDocumentsFeatureEmail();
    for (const out of [html, text]) {
      expect(out).not.toMatch(/TO BE SUPPLIED/i);
      expect(out).not.toMatch(/Registration number/i);
    }
  });

  test('points at the updated legal documents (PLAN A3 — the dropped notice campaign)', () => {
    const { text } = buildDocumentsFeatureEmail();
    expect(text).toContain('Terms of Service and Privacy Policy');
    expect(text).toContain('strive-learning.com/terms');
    expect(text).toContain('strive-learning.com/privacy');
  });

  test('uses OUR unsubscribe URL when one is supplied', () => {
    const { html, text } = buildDocumentsFeatureEmail({ unsubscribeUrl: UNSUB });
    expect(text).toContain(`Unsubscribe: ${UNSUB}`);
    expect(html).toContain('marketing/unsubscribe');
    expect(html).not.toContain('[[UNSUB_LINK_EN]]');
    expect(text).not.toContain('[[UNSUB_LINK_EN]]');
  });

  test('falls back to Mailjet’s hosted link when no URL is supplied', () => {
    // The dev preview and a test send to a non-contact take this branch. An
    // opt-out row that resolves to nothing would be worse than either.
    const { html } = buildDocumentsFeatureEmail();
    expect(html).toContain('href="[[UNSUB_LINK_EN]]"');
  });

  test('has exactly one CTA, and it is a public URL carrying the campaign source', () => {
    const { text } = buildDocumentsFeatureEmail();
    const ctaLines = text.split('\n').filter((l) => l.includes('https://www.strive-learning.com'));
    expect(ctaLines).toHaveLength(1);
    expect(ctaLines[0]).toContain('?source=documents-email');
    // F21: never the `(protected)` route — middleware strips its query string.
    expect(text).not.toContain('/courses/new');
  });

  test('obeys the claims policy (marketing brief §11)', () => {
    const { subject, text } = buildDocumentsFeatureEmail();
    const body = `${subject}\n${text}`.toLowerCase();

    // No generation-speed claim.
    for (const banned of ['second', 'minute', 'instant', 'in no time']) {
      expect(body).not.toContain(banned);
    }
    // No overreach on scope.
    for (const banned of ['any file', 'any website', 'any document', 'unlimited']) {
      expect(body).not.toContain(banned);
    }
    // No outcome/efficacy claim, no social proof, no vendor endorsement.
    for (const banned of [
      'guarantee',
      'faster',
      'learners trust',
      'thousands of',
      'anthropic',
      'claude',
      'openai',
    ]) {
      expect(body).not.toContain(banned);
    }
    // Never speak in credits (project rule).
    expect(body).not.toContain('credit');
  });

  test('leads on the substantiated no-training claim', () => {
    const { text } = buildDocumentsFeatureEmail();
    expect(text).toContain('We do not use it to train AI models');
    expect(text).toContain('contractually prohibited from training on it');
  });
});

describe('sender identity gate', () => {
  test('no longer blocks a campaign (identifiers removed from the body)', () => {
    // The placeholder gate was removed with the identifier line itself. The
    // function is retained as a no-op so the campaign controller keeps one
    // obvious hook if a pre-send identity check is ever reinstated.
    expect(() => assertSenderIdentityComplete()).not.toThrow();
  });
});
