import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  buildKbPricingReplacements,
  substitutePricingPlaceholders,
} from './kbPricingReplacements';

const replacements = buildKbPricingReplacements();

test('builder produces all expected placeholders', () => {
  // If any of these is missing, KB markdown referencing it will render
  // as a literal `{{token}}` — a visible bug.
  const expected = [
    'freeMonthlyUsd',
    'starterMonthlyUsd',
    'proMonthlyUsd',
    'studioMonthlyUsd',
    'starterAnnualMonthlyUsd',
    'proAnnualMonthlyUsd',
    'studioAnnualMonthlyUsd',
    'freeMultiplier',
    'starterMultiplier',
    'proMultiplier',
    'studioMultiplier',
    'freeAllowanceUnits',
    'starterAllowanceUnits',
    'proAllowanceUnits',
    'studioAllowanceUnits',
    'freeAllowanceUnitsLower',
    'starterAllowanceUnitsLower',
    'proAllowanceUnitsLower',
    'studioAllowanceUnitsLower',
    'lessonsPerFree',
    'lessonsPerStarter',
    'lessonsPerPro',
    'lessonsPerStudio',
    'topupMinUsd',
    'topupMaxUsd',
    'topupVsStarterMarkupPct',
    'freePeriodDays',
  ];
  for (const key of expected) {
    assert.ok(
      typeof replacements[key] === 'string' && replacements[key].length > 0,
      `placeholder "${key}" missing or empty`,
    );
  }
});

test('plan prices format with $ and correct decimals', () => {
  assert.equal(replacements.freeMonthlyUsd, '$0');
  assert.match(replacements.starterMonthlyUsd, /^\$\d+(\.\d{2})?$/);
  assert.match(replacements.proMonthlyUsd, /^\$\d+(\.\d{2})?$/);
  assert.match(replacements.studioMonthlyUsd, /^\$\d+(\.\d{2})?$/);
});

test('multipliers format as "N×"', () => {
  for (const key of ['free', 'starter', 'pro', 'studio'] as const) {
    assert.match(replacements[`${key}Multiplier`], /^\d+×$/, `${key}Multiplier`);
  }
});

test('allowance unit descriptors render as "<EnglishWord> unit(s) / month" for each plan', () => {
  // Free is 1 → singular "unit"; paid plans plural "units". Pin the shape
  // rather than the exact multiplier so a knob change in pricingConfig.ts
  // doesn't require a test edit — `numWord` translates the integer multiplier
  // into its English form ("Ten", "Twenty-two", "Forty-eight", etc.).
  assert.equal(replacements.freeAllowanceUnits, 'One unit / month');
  assert.match(replacements.starterAllowanceUnits, /^[A-Z][a-z-]+ units \/ month$/);
  assert.match(replacements.proAllowanceUnits, /^[A-Z][a-z-]+ units \/ month$/);
  assert.match(replacements.studioAllowanceUnits, /^[A-Z][a-z-]+ units \/ month$/);
});

test('lessonsPer{plan} renders a sensible non-empty range', () => {
  for (const key of ['free', 'starter', 'pro', 'studio'] as const) {
    const v = replacements[`lessonsPer${key[0].toUpperCase() + key.slice(1)}`];
    assert.ok(/lessons?$/.test(v), `lessonsPer${key} = "${v}" should end in "lesson(s)"`);
  }
});

test('top-up bounds and markup format correctly', () => {
  assert.match(replacements.topupMinUsd, /^\$\d+$/);
  assert.match(replacements.topupMaxUsd, /^\$\d+$/);
  assert.match(replacements.topupVsStarterMarkupPct, /^~\d+%$/);
});

// ── Substitution ────────────────────────────────────────────

test('substitutePricingPlaceholders replaces known tokens', () => {
  const body = 'Starter is {{starterMonthlyUsd}} a month. {{starterMultiplier}} the Free allowance.';
  const out = substitutePricingPlaceholders(body, replacements);
  assert.ok(out.includes(replacements.starterMonthlyUsd));
  assert.ok(out.includes(replacements.starterMultiplier));
  assert.ok(!out.includes('{{starterMonthlyUsd}}'));
});

test('substitutePricingPlaceholders leaves unknown tokens intact (visible drift)', () => {
  const body = 'Missing token: {{somethingThatDoesNotExist}}';
  const out = substitutePricingPlaceholders(body, replacements);
  assert.ok(out.includes('{{somethingThatDoesNotExist}}'));
});

test('substitutePricingPlaceholders replaces ALL occurrences of a token', () => {
  const body = '{{topupMinUsd}} is the floor. Top up {{topupMinUsd}} or more.';
  const out = substitutePricingPlaceholders(body, replacements);
  const occurrences = out.split(replacements.topupMinUsd).length - 1;
  assert.equal(occurrences, 2);
});
