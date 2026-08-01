import { FRONTEND_URL } from '@conf/env';
import { renderEmail, type RenderedEmail } from './render';
import { brand } from './tokens';

// Template builders. Each returns the full payload Mailjet needs (subject +
// html + text), keeping `services/emailService.ts` purely a transport. The
// dev-preview route imports these directly so the rendered output in the
// browser is byte-for-byte what users would receive.

export type EmailPayload = RenderedEmail & { subject: string };

export type SecurityActionKind = 'set_password' | 'change_password' | 'delete_account';

// Catalog of promotional templates the admin "send test" backdoor can fire.
// Add new keys here as templates are designed; the admin UI lists them
// directly off this type. Transactional templates (verification, reset,
// security codes) are NOT listed here — they're not user-targetable from
// the admin surface.
export type PromotionalTemplateKey = 'documents_feature';

const SECURITY_ACTION_COPY: Record<
  SecurityActionKind,
  { subject: string; title: string; verb: string; warning: string }
> = {
  set_password: {
    subject: 'Confirm setting a password',
    title: 'Confirm your password setup',
    verb: 'set a password on your account',
    warning:
      "If you didn't request this, ignore this email and consider signing out of all sessions from your account settings.",
  },
  change_password: {
    subject: 'Confirm your password change',
    title: 'Confirm your password change',
    verb: 'change your password',
    warning:
      "If you didn't request this, ignore this email and consider signing out of all sessions from your account settings.",
  },
  delete_account: {
    subject: 'Confirm account deletion',
    title: 'Confirm account deletion',
    verb: 'permanently delete your account',
    warning:
      "If you didn't request this, ignore this email and sign out of all sessions from your account settings — someone may have access to your device or token.",
  },
};

export const buildVerificationEmail = (params: { token: string }): EmailPayload => {
  // The verification URL only carries the token — the server looks up the
  // user by hashed token, so the email address adds no information and
  // removes a small leakage surface (browser history, referer headers,
  // downstream mail-relay logs).
  const verificationUrl = `${FRONTEND_URL}/verify-email?token=${params.token}`;
  return {
    subject: 'Verify your email address',
    ...renderEmail({
      preheader: 'Confirm your email to start learning with Strive.',
      title: 'Verify your email',
      body: [
        {
          type: 'paragraph',
          text: 'Confirm your email address to activate your Strive account and start building courses tailored to what you want to learn.',
        },
        { type: 'cta', url: verificationUrl, label: 'Verify email' },
        {
          type: 'fineprint',
          text: "This link expires in 24 hours. If you didn't create a Strive account, you can ignore this email.",
        },
      ],
    }),
  };
};

export const buildPasswordResetEmail = (params: { to: string; token: string }): EmailPayload => {
  const resetUrl = `${FRONTEND_URL}/reset-password?token=${params.token}&email=${encodeURIComponent(params.to)}`;
  return {
    subject: 'Reset your Strive password',
    ...renderEmail({
      preheader: 'Use this link to choose a new password.',
      title: 'Reset your password',
      body: [
        {
          type: 'paragraph',
          text: 'We received a request to reset the password on your Strive account. Use the button below to choose a new one.',
        },
        { type: 'cta', url: resetUrl, label: 'Reset password' },
        {
          type: 'fineprint',
          text: "This link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.",
        },
      ],
    }),
  };
};

export const buildSecurityActionCodeEmail = (params: {
  action: SecurityActionKind;
  code: string;
  expiresInMinutes: number;
}): EmailPayload => {
  const copy = SECURITY_ACTION_COPY[params.action];
  return {
    subject: copy.subject,
    ...renderEmail({
      preheader: `Your Strive confirmation code: ${params.code}`,
      title: copy.title,
      body: [
        {
          type: 'paragraph',
          text: `Enter this code in Strive to ${copy.verb}.`,
        },
        { type: 'code', value: params.code },
        {
          type: 'fineprint',
          text: `Expires in ${params.expiresInMinutes} minutes. ${copy.warning}`,
        },
      ],
    }),
  };
};

// ── Promotional ──────────────────────────────────────────
//
// Promotional templates differ from transactional in two ways:
//   1. They set `showUnsubscribe: true` so the renderer adds a footer
//      link. The link itself is `[[UNSUB_LINK_EN]]` — a Mailjet template
//      variable replaced server-side at send time, pointing to Mailjet's
//      hosted unsubscribe + re-subscribe page. Requires the message to
//      be sent with `TemplateLanguage: true`.
//   2. They're sent from `SENDER_EMAIL_PROMOTIONAL`, not the transactional
//      sender, so opt-out / bounce / spam metrics on the marketing stream
//      don't damage the verification-mail sender reputation.

// Public marketing origin. Hardcoded rather than derived from `FRONTEND_URL`:
// this campaign is sent against real inboxes, so the CTA must land on
// production no matter which environment the operator triggered the send
// from. Transactional templates above still use `FRONTEND_URL` so they remain
// env-correct for verification + password-reset flows.
//
// It points at the LANDING page, not at `/courses/new`. `/courses/new` sits
// under the client's `(protected)` tree, where middleware bounces a
// logged-out visitor to `/` **and strips the query string** — so a recipient
// who is not signed in on that device would lose both the destination and
// the campaign attribution (F21).
const DOCUMENTS_FEATURE_CTA_URL =
  'https://www.strive-learning.com/?source=documents-email';

/**
 * The documents/links feature announcement — the one promotional campaign
 * in this plan (PLAN A3: the separate Terms/Privacy notice campaign was
 * dropped in favour of an in-product notice plus the footer line below).
 *
 * Copy constraints applied, from `STRIVE_FOR_MARKETING.md` §10–§11:
 *   - no generation-speed claim of any kind;
 *   - no accuracy, outcome or efficacy claim;
 *   - formats named honestly — never "any file" or "any website";
 *   - no user counts, testimonials or social proof;
 *   - no model provider named as an endorsement;
 *   - nothing about credits, in either the word or a number;
 *   - the lead claim is the one we can substantiate against our own
 *     published documents: the material is not used to train models
 *     (ToS §6, Privacy §3).
 *
 * @param params.unsubscribeUrl Absolute URL of our own opt-out route for
 *   this recipient. Omitted only by the dev preview and by a test send to
 *   an address with no ledger row, where the renderer falls back to
 *   Mailjet's hosted `[[UNSUB_LINK_EN]]`.
 */
export const buildDocumentsFeatureEmail = (params?: {
  unsubscribeUrl?: string;
}): EmailPayload => {
  return {
    subject: 'Build a course from your own material',
    ...renderEmail({
      preheader:
        'Upload the documents and links you already have, and Strive writes the course around them.',
      title: 'Bring your own material',
      body: [
        { type: 'eyebrow', text: 'New in Strive' },
        {
          type: 'lede',
          text: 'Until now, Strive built a course from a goal you described. It can now build one from the material you already have.',
        },
        { type: 'divider' },
        {
          type: 'paragraph',
          text: 'Add PDFs, Word documents, slides, spreadsheets, ePub files, plain text, images, audio recordings, and links to pages you want covered. Strive reads what you give it and writes the course around it — a syllabus and a stack of readings, a folder of lecture slides, the notes you took at work.',
        },
        {
          type: 'paragraph',
          text: 'Before anything is generated you see what came through: which files were read, how much usable material each one holds, and where the gaps are. You choose how closely the course should follow your sources — stay strictly inside them, use them as a spine, or let Strive fill in around them — and every lesson is marked either "from your documents" or "AI-supplemented", so you always know which you are reading.',
        },
        {
          type: 'paragraph',
          text: 'Your material stays yours. It is private to your account and never shown to other learners. We do not use it to train AI models, and the providers that process the text are contractually prohibited from training on it.',
        },
        { type: 'cta', url: DOCUMENTS_FEATURE_CTA_URL, label: 'Try it with your own files' },
        { type: 'signoff', text: '— Simas, founder of Strive' },
        { type: 'divider' },
        // PLAN A3: with the separate notice campaign dropped, this line is
        // how email recipients learn the documents are updated. The
        // in-product notice carries the obligation for everyone else,
        // including people who have opted out of marketing.
        {
          type: 'fineprint',
          text: 'We have also updated our Terms of Service and Privacy Policy to cover uploaded documents and submitted links. Both are at strive-learning.com/terms and strive-learning.com/privacy.',
        },
        // Sender identification. The entity is named here and again in the
        // footer's copyright line; the registered address and registration
        // code live on the website (e-Commerce Directive Art. 5(1) requires
        // them to be "easily, directly and permanently accessible", not
        // repeated in every message) rather than in the email body.
        //
        // Known, accepted gap: US CAN-SPAM does require a physical postal
        // address in marketing mail, so a US recipient is the one case this
        // omission bites. Accepted deliberately — see PROGRESS.md.
        {
          type: 'fineprint',
          text: "You're receiving this because you have a Strive account.",
        },
      ],
      showUnsubscribe: true,
      unsubscribeUrl: params?.unsubscribeUrl,
      variant: 'promotional',
    }),
  };
};
