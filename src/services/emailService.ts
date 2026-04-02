import Mailjet from 'node-mailjet';
import { MAILJET_API_KEY, MAILJET_API_SECRET, FRONTEND_URL } from '@conf/env';

export const SENDER_EMAIL_ACCOUNT = 'accounts@strive-learning.com';

const mailjet = new Mailjet({
  apiKey: MAILJET_API_KEY,
  apiSecret: MAILJET_API_SECRET,
});

export const sendVerificationEmail = async (params: { to: string; token: string }): Promise<void> => {
  const { to, token } = params;
  const verificationUrl = `${FRONTEND_URL}/verify-email?token=${token}&email=${encodeURIComponent(to)}`;

  await mailjet.post('send', { version: 'v3.1' }).request({
    Messages: [
      {
        From: {
          Email: SENDER_EMAIL_ACCOUNT,
          Name: 'Strive',
        },
        To: [{ Email: to }],
        Subject: 'Verify your email address',
        HTMLPart: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
            <h1 style="font-size: 24px; font-weight: 700; color: #111827; margin-bottom: 16px;">
              Verify your email
            </h1>
            <p style="font-size: 15px; color: #4b5563; line-height: 1.6; margin-bottom: 24px;">
              Thanks for signing up for Strive. Click the button below to verify your email address and get started.
            </p>
            <a href="${verificationUrl}"
               style="display: inline-block; padding: 12px 24px; background: #4f46e5; color: #ffffff; text-decoration: none; border-radius: 8px; font-size: 15px; font-weight: 600;">
              Verify email address
            </a>
            <p style="font-size: 13px; color: #9ca3af; line-height: 1.6; margin-top: 32px;">
              This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.
            </p>
          </div>
        `,
        TextPart: `Verify your email address\n\nThanks for signing up for Strive. Visit the link below to verify your email:\n\n${verificationUrl}\n\nThis link expires in 24 hours. If you didn't create an account, you can safely ignore this email.`,
      },
    ],
  });
};
