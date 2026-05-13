import { FRONTEND_URL } from '@conf/env';
import { renderEmail, type RenderedEmail } from './render';

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
export type PromotionalTemplateKey = 'old_user_relaunch' | 'old_paying_user_thanks';

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

export const buildOldUserRelaunchEmail = (): EmailPayload => {
  return {
    // Subject pairs a wistful "miss you" beat ("It's been a while.") with the
    // news ("We rebuilt Strive."). Wistful subject lines convert best on
    // win-back per industry benchmarks; the headline carries arrival energy
    // separately so subject + headline don't duplicate inbox real estate.
    subject: "It's been a while. We rebuilt Strive.",
    ...renderEmail({
      // Preheader is the only pre-open real estate. Three short
      // reader-facing sentences (not engineering bullets) so the snippet
      // reads as benefit, not spec-sheet.
      preheader: "Personalized courses. An AI mentor on every lesson. Daily review that catches what you're about to forget.",
      title: 'The new Strive is here',
      body: [
        { type: 'eyebrow', text: 'Reintroducing Strive' },
        {
          type: 'lede',
          text: "We won't pretend the first Strive was the product we wanted to ship. We took it down, rebuilt every part, and waited until it actually worked before reaching back out.",
        },
        { type: 'divider' },
        {
          type: 'paragraph',
          text: 'Tell Strive a specific goal — "speak conversational Italian in three months," or "understand transformer attention well enough to read the papers" — and where you\'re starting from. It writes the course for that, starting from your level.',
        },
        {
          type: 'paragraph',
          text: "Lessons aren't dead pages. Code runs in place, math and diagrams render properly, and an AI mentor sits next to every one of them, already up to speed on what you're reading. Ask anything.",
        },
        {
          type: 'paragraph',
          text: "What you learn doesn't leak. A daily review queue resurfaces what's slipping before you forget it.",
        },
        {
          type: 'paragraph',
          text: "We've put some starter credit on your account so you can see for yourself — generate a course, work through a few lessons, ask the mentor anything.",
        },
        // Hardcoded to the production domain — this campaign is sent against
        // real inboxes and the CTA must land on production regardless of which
        // environment the send was triggered from (dev/staging operator UI).
        // Transactional templates above still use FRONTEND_URL so they remain
        // env-correct for verification + password-reset flows.
        { type: 'cta', url: 'https://www.strive-learning.com/', label: 'Try the new Strive' },
        { type: 'signoff', text: '— Simas, founder of Strive' },
        {
          type: 'fineprint',
          text: "You're getting this email because you signed up for the original Strive.",
        },
      ],
      showUnsubscribe: true,
      variant: 'promotional',
    }),
  };
};

// Sent to the small subset who paid for the original Strive. Plainer, more
// personal, founder-voiced. Subject inverts the expected order ("Thank you"
// before "an apology") so the open behaviour is gratitude-first, not
// guilt-first — better received and a more honest framing of the
// relationship. Grant amount is intentionally NOT mentioned by number; the
// import script controls that and the user sees the bonus on login.
export const buildOldPayingUserThanksEmail = (): EmailPayload => {
  return {
    subject: 'Thank you. And an apology.',
    ...renderEmail({
      preheader: 'A note from Simas about the old Strive, and why we rebuilt it.',
      title: 'Thank you. And an apology.',
      body: [
        { type: 'eyebrow', text: 'From the founder' },
        {
          type: 'lede',
          text: "You paid for the original Strive. That's stuck with me for a long time — we knew it wasn't ready, and we shipped it anyway.",
        },
        { type: 'divider' },
        {
          type: 'paragraph',
          text: "We took it offline, rebuilt every part, and only got back in touch when it actually worked. It's a different product now: courses written for your specific goal, code that runs inside the lesson, an AI mentor on every page, and a daily review queue that catches what's slipping.",
        },
        {
          type: 'paragraph',
          text: "You already supported us once. There's extra starter credit on your account — more than everyone else is getting — enough to generate a course and actually work through it. See whether it lives up to what we promised the first time.",
        },
        { type: 'cta', url: 'https://www.strive-learning.com/', label: 'Try the new Strive' },
        {
          type: 'paragraph',
          text: "If something feels off — or even if it doesn't — reply to this email. It lands directly in my inbox.",
        },
        { type: 'signoff', text: '— Simas, founder of Strive' },
        {
          type: 'fineprint',
          text: "You're getting this email because you supported the original Strive.",
        },
      ],
      showUnsubscribe: true,
      variant: 'promotional',
    }),
  };
};
