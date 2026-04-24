/**
 * Canonicalize an email so signup-spam via Gmail +aliases/dots or simple case
 * tweaks produces the same canonical form. Rules:
 *   - trim + lowercase
 *   - `googlemail.com` → `gmail.com` (Google treats them as identical)
 *   - strip `+suffix` from local part for ALL domains
 *     (aggressive option — minor false-positive risk on providers that treat
 *     + as distinct, accepted in exchange for broader abuse coverage)
 *   - strip dots from local part for gmail.com ONLY (Gmail ignores dots; other
 *     providers treat `j.doe` and `jdoe` as different users)
 *
 * Pure — no env imports. Callers wanting a hash use `hashCanonicalEmail`
 * from `./emailHash`, which salts with JWT_SECRET.
 */
export const canonicalizeEmail = (email: string): string => {
  const normalized = email.trim().toLowerCase();
  const atIndex = normalized.lastIndexOf('@');
  if (atIndex === -1) return normalized;

  const local = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);

  const canonicalDomain = domain === 'googlemail.com' ? 'gmail.com' : domain;

  const beforePlus = local.split('+')[0];
  const strippedDots = canonicalDomain === 'gmail.com' ? beforePlus.replace(/\./g, '') : beforePlus;

  return `${strippedDots}@${canonicalDomain}`;
};
