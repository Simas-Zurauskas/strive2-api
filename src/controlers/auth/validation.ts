import { z } from 'zod';

// Moderate password standard. Mirrors the FE rules in
// `client/src/validation/auth.ts` exactly — drift between the two would
// either let weak passwords through (FE-only) or surface server-error
// noise on inputs the FE accepted (BE stricter). Composition: 8–128 chars,
// must contain at least one letter and one digit. Blocks "12345678" /
// "password" / etc. without forcing symbol-class theatre.
const passwordRule = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
  .regex(/\d/, 'Password must contain at least one number');

export const signInSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const signUpSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: passwordRule,
});

export const googleAuthSchema = z.object({
  idToken: z.string().min(1, 'Google ID token is required'),
});

/**
 * The token alone is sufficient — `emailVerificationToken` (hashed) is
 * unique per user, so the controller looks the user up by hash directly.
 * Keeping `email` in the request body would be a needless second
 * identifier and would expose timing differences between known/unknown
 * emails. The `.passthrough()`-equivalent default of `z.object` strips
 * unknown keys, so older verification links (`?token=X&email=Y`) still
 * work — the email is silently ignored.
 */
export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Verification token is required'),
});

export const resendVerificationSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

// Email-OTP flow: callers send the 6-digit code from the confirmation email
// rather than the password. Old `password`-based form is removed — every
// account-deletion request now goes through the email confirmation, so a
// stolen JWT can't authorise deletion.
export const deleteAccountSchema = z.object({
  code: z
    .string()
    .regex(/^\d{6}$/, 'Confirmation code must be 6 digits'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

export const resetPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
  token: z.string().min(1, 'Reset token is required'),
  newPassword: passwordRule,
});

// Email-OTP flow: callers must include the 6-digit code from the
// confirmation email. Without the code, a stolen JWT could permanently take
// over a Google-only account by attaching a CREDENTIALS provider with an
// attacker-controlled password.
export const setPasswordSchema = z.object({
  newPassword: passwordRule,
  code: z
    .string()
    .regex(/^\d{6}$/, 'Confirmation code must be 6 digits'),
});

// Email-OTP flow: callers must include the 6-digit code from the
// confirmation email. The legacy "newPassword only" form is removed —
// without the code, a stolen JWT could permanently take over the account
// by setting a new password and locking out the legitimate owner.
export const changePasswordSchema = z.object({
  newPassword: passwordRule,
  code: z
    .string()
    .regex(/^\d{6}$/, 'Confirmation code must be 6 digits'),
});

/**
 * First-touch marketing attribution (see `IUserAttribution`). Every value here
 * comes from a URL query parameter or `document.referrer`, so all of it is
 * attacker-controlled: an arbitrary visitor can put arbitrary text in any
 * field simply by crafting a link.
 *
 * The caps below are the boundary guard. They are sized to real-world campaign
 * tags rather than to the protocol maximum — a 200-character `utm_campaign` is
 * already far beyond anything an ad platform generates, and referrer URLs are
 * the only field that legitimately runs long. Values are stored verbatim and
 * only ever read back by analytics; nothing downstream interpolates them into
 * a query, a template, or an outbound URL.
 *
 * Every field is optional because campaign parameters are, by nature, partial:
 * organic traffic has a referrer and nothing else, a Google Ads click has a
 * `gclid` and possibly no UTMs at all.
 */
const attributionField = z.string().trim().max(200).optional();

export const attributionSchema = z.object({
  source: attributionField,
  medium: attributionField,
  campaign: attributionField,
  term: attributionField,
  content: attributionField,
  gclid: attributionField,
  fbclid: attributionField,
  referrer: z.string().trim().max(500).optional(),
  landingPath: attributionField,
  capturedAt: z.coerce.date().optional(),
});
