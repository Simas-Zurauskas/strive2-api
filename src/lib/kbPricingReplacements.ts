/**
 * KB markdown placeholder substitution. Mirror at
 * client/src/lib/kbPricingReplacements.ts must match — both sides produce
 * the same substituted text. A missing token renders as literal `{{token}}`
 * so a half-migration is visible immediately. Re-embed via `yarn kb:index`.
 */

import {
  lessonRangeFromCredits,
  monthlyAllowanceFor,
  PLAN_KEYS,
  PlanKey,
  planMultiplier,
  PRICING_CONFIG,
  topupUsdPerCredit,
  usdPerCreditFor,
} from './pricingConfig';

const NUM_WORDS: Record<number, string> = {
  1: 'one',
  2: 'two',
  3: 'three',
  4: 'four',
  5: 'five',
  6: 'six',
  7: 'seven',
  8: 'eight',
  9: 'nine',
  10: 'ten',
  11: 'eleven',
  12: 'twelve',
  13: 'thirteen',
  14: 'fourteen',
  15: 'fifteen',
  16: 'sixteen',
  20: 'twenty',
  22: 'twenty-two',
  25: 'twenty-five',
  30: 'thirty',
  40: 'forty',
  48: 'forty-eight',
  50: 'fifty',
};

const numWord = (n: number): string => NUM_WORDS[n] ?? String(n);

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

const fmtUsd = (n: number): string => {
  if (n === 0) return '$0';
  if (Number.isInteger(n)) return `$${n}`;
  return `$${n.toFixed(2)}`;
};

const fmtLessonRange = ([lo, hi]: [number, number]): string => {
  if (lo <= 0 && hi <= 0) return 'a few lessons';
  if (lo === hi) return `${lo} lesson${lo === 1 ? '' : 's'}`;
  return `${lo}–${hi} lessons`;
};

const fmtRoundedPct = (frac: number): string => {
  const pct = Math.round((frac * 100) / 5) * 5;
  return `~${pct}%`;
};

export const buildKbPricingReplacements = (): Record<string, string> => {
  const r: Record<string, string> = {};

  for (const key of PLAN_KEYS) {
    const price = PRICING_CONFIG.planPricing[key];
    r[`${key}MonthlyUsd`] = fmtUsd(price.monthlyUsd);
    if (key !== 'free') {
      r[`${key}AnnualMonthlyUsd`] = fmtUsd(price.annualMonthlyUsd);
    }

    const mult = planMultiplier(key);
    r[`${key}Multiplier`] = `${mult}×`;

    const word = numWord(mult);
    const unitWord = mult === 1 ? 'unit' : 'units';
    r[`${key}AllowanceUnits`] = `${cap(word)} ${unitWord} / month`;
    r[`${key}AllowanceUnitsLower`] = `${word} ${unitWord}`;

    r[`lessonsPer${cap(key)}`] = fmtLessonRange(
      lessonRangeFromCredits(monthlyAllowanceFor(key)),
    );
  }

  // ONE-TIME signup grant (KNOB 9) expressed in lessons. A placeholder rather
  // than a number written into the article because it is a quotient of two
  // knobs — the grant (KNOB 9) over the per-lesson reference cost (KNOB 6) —
  // so either one moving changes it. Keeping it here is what makes a knob move
  // change the substituted body, change the content hash, and re-index the
  // affected articles; a hardcoded figure would go stale invisibly.
  r['lessonsPerSignupGrant'] = fmtLessonRange(
    lessonRangeFromCredits(PRICING_CONFIG.onboardingAllowanceCredits),
  );

  r['topupMinUsd'] = fmtUsd(PRICING_CONFIG.topup.minUsd);
  r['topupMaxUsd'] = fmtUsd(PRICING_CONFIG.topup.maxUsd);

  const starterPerCredit = usdPerCreditFor('starter' as PlanKey);
  const topupPerCredit = topupUsdPerCredit();
  if (starterPerCredit > 0 && topupPerCredit > starterPerCredit) {
    r['topupVsStarterMarkupPct'] = fmtRoundedPct(
      (topupPerCredit - starterPerCredit) / starterPerCredit,
    );
  } else {
    r['topupVsStarterMarkupPct'] = '~25%';
  }

  r['freePeriodDays'] = `${PRICING_CONFIG.freePeriodDays}-day`;

  return r;
};

export const substitutePricingPlaceholders = (
  body: string,
  replacements: Record<string, string>,
): string => {
  let out = body;
  for (const [token, value] of Object.entries(replacements)) {
    out = out.replaceAll(`{{${token}}}`, value);
  }
  return out;
};
