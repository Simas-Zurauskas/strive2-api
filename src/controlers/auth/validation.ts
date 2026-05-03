import { z } from 'zod';

export const signInSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const signUpSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
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
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
});

// Email-OTP flow: callers must include the 6-digit code from the
// confirmation email. Without the code, a stolen JWT could permanently take
// over a Google-only account by attaching a CREDENTIALS provider with an
// attacker-controlled password.
export const setPasswordSchema = z.object({
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
  code: z
    .string()
    .regex(/^\d{6}$/, 'Confirmation code must be 6 digits'),
});

// Email-OTP flow: callers must include the 6-digit code from the
// confirmation email. The legacy "newPassword only" form is removed —
// without the code, a stolen JWT could permanently take over the account
// by setting a new password and locking out the legitimate owner.
export const changePasswordSchema = z.object({
  newPassword: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters'),
  code: z
    .string()
    .regex(/^\d{6}$/, 'Confirmation code must be 6 digits'),
});
