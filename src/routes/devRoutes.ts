import { Router, type Request, type Response } from 'express';
import {
  buildVerificationEmail,
  buildPasswordResetEmail,
  buildSecurityActionCodeEmail,
  buildOldUserRelaunchEmail,
  buildOldPayingUserThanksEmail,
  type EmailPayload,
} from '@lib/email/templates';

// Dev-only routes. Mounted at `/dev/*` from `index.ts` and gated by
// `ENVIRONMENT !== 'production'` — same pattern as the swagger UI. Useful
// for local iteration on email layouts without sending real mail.

const router = Router();

type Sample = {
  label: string;
  build: () => EmailPayload;
};

// Two-tier catalog so the preview index mirrors how Mailjet treats these
// streams (transactional vs promotional sender + unsubscribe handling).
const SAMPLE_GROUPS: Array<{ title: string; samples: Record<string, Sample> }> = [
  {
    title: 'Transactional',
    samples: {
      verification: {
        label: 'Verification email',
        build: () => buildVerificationEmail({ token: 'PREVIEW_TOKEN_abc123' }),
      },
      'password-reset': {
        label: 'Password reset email',
        build: () =>
          buildPasswordResetEmail({
            to: 'preview@strive-learning.com',
            token: 'PREVIEW_TOKEN_xyz789',
          }),
      },
      'security-action-set-password': {
        label: 'Security action — set password',
        build: () =>
          buildSecurityActionCodeEmail({
            action: 'set_password',
            code: '482915',
            expiresInMinutes: 30,
          }),
      },
      'security-action-change-password': {
        label: 'Security action — change password',
        build: () =>
          buildSecurityActionCodeEmail({
            action: 'change_password',
            code: '730184',
            expiresInMinutes: 30,
          }),
      },
      'security-action-delete-account': {
        label: 'Security action — delete account',
        build: () =>
          buildSecurityActionCodeEmail({
            action: 'delete_account',
            code: '149062',
            expiresInMinutes: 30,
          }),
      },
    },
  },
  {
    title: 'Promotional',
    samples: {
      'old-user-relaunch': {
        label: 'Old user relaunch',
        build: () => buildOldUserRelaunchEmail(),
      },
      'old-paying-user-thanks': {
        label: 'Old paying user — thanks + apology',
        build: () => buildOldPayingUserThanksEmail(),
      },
    },
  },
];

const SAMPLES: Record<string, Sample> = Object.fromEntries(
  SAMPLE_GROUPS.flatMap((group) => Object.entries(group.samples)),
);

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );

router.get('/email-preview', (_req: Request, res: Response) => {
  const sections = SAMPLE_GROUPS.map((group) => {
    const items = Object.entries(group.samples)
      .map(
        ([name, s]) =>
          `<li><a href="/dev/email-preview/${name}">${escapeHtml(s.label)}</a> · <a href="/dev/email-preview/${name}?format=text">text</a> · <a href="/dev/email-preview/${name}?format=raw">raw</a></li>`,
      )
      .join('\n');
    return `<h2>${escapeHtml(group.title)}</h2>\n<ul>${items}</ul>`;
  }).join('\n');

  res.set('Content-Type', 'text/html; charset=utf-8').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Email preview</title>
<style>body{font:14px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#0f172a;}h1{font-size:20px;margin:0 0 8px;}h2{font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:#8a8279;margin:28px 0 8px;}p{color:#475569;margin:0 0 24px;}ul{padding-left:20px;margin:0;}li{margin:6px 0;}a{color:#2c5545;}</style>
</head><body>
<h1>Email preview</h1>
<p>Renders the same template builders that production uses. No mail is sent.</p>
${sections}
</body></html>`);
});

router.get('/email-preview/:name', (req: Request, res: Response) => {
  const name = typeof req.params.name === 'string' ? req.params.name : '';
  const sample = SAMPLES[name];
  if (!sample) {
    res.status(404).set('Content-Type', 'text/plain').send('Unknown template');
    return;
  }

  const payload = sample.build();
  const format = typeof req.query.format === 'string' ? req.query.format : 'html';

  if (format === 'text') {
    res.set('Content-Type', 'text/plain; charset=utf-8').send(payload.text);
    return;
  }
  if (format === 'raw') {
    res.json({
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    });
    return;
  }
  // Default: render HTML so it can be inspected in the browser as the
  // recipient would see it. We deliberately do NOT inject a wrapper toolbar
  // — preview fidelity matters more than ergonomics.
  res.set('Content-Type', 'text/html; charset=utf-8').send(payload.html);
});

export const devRoutes = router;
