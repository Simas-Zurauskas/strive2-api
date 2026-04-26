/**
 * Self-executing tests for email canonicalization. The hash function depends
 * on JWT_SECRET so this test is not included here — the canonicalize function
 * is pure and testable; the hash is a thin wrapper asserted by its unit test
 * in the service layer later.
 *
 * Run: yarn test:email-canonicalize
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { canonicalizeEmail } from './emailCanonicalize';



// ── Basic normalization ──────────────────────────────────────

test('trims whitespace', () => {
  assert.equal(canonicalizeEmail('  foo@bar.com  '), 'foo@bar.com');
});

test('lowercases', () => {
  assert.equal(canonicalizeEmail('FOO@BAR.COM'), 'foo@bar.com');
});

test('no-at-sign falls through without crashing', () => {
  assert.equal(canonicalizeEmail('not-an-email'), 'not-an-email');
});

// ── Gmail-specific rules ──────────────────────────────────────

test('strips +alias from gmail local part', () => {
  assert.equal(canonicalizeEmail('jane+promo@gmail.com'), 'jane@gmail.com');
});

test('strips dots from gmail local part', () => {
  assert.equal(canonicalizeEmail('j.a.n.e@gmail.com'), 'jane@gmail.com');
});

test('strips both +alias and dots from gmail', () => {
  assert.equal(canonicalizeEmail('j.ane+newsletter@gmail.com'), 'jane@gmail.com');
});

test('googlemail.com collapses to gmail.com', () => {
  assert.equal(canonicalizeEmail('jane@googlemail.com'), 'jane@gmail.com');
});

test('googlemail with +alias and dots collapses to clean gmail form', () => {
  assert.equal(canonicalizeEmail('j.a.n.e+spam@googlemail.com'), 'jane@gmail.com');
});

test('three gmail aliases collapse to the same canonical form', () => {
  const a = canonicalizeEmail('attacker+1@gmail.com');
  const b = canonicalizeEmail('attacker+2@gmail.com');
  const c = canonicalizeEmail('a.t.t.a.c.k.e.r@gmail.com');
  assert.equal(a, 'attacker@gmail.com');
  assert.equal(b, 'attacker@gmail.com');
  assert.equal(c, 'attacker@gmail.com');
});

// ── Non-Gmail rules ──────────────────────────────────────

test('strips +alias from non-gmail local part (aggressive mode)', () => {
  assert.equal(canonicalizeEmail('jane+promo@protonmail.com'), 'jane@protonmail.com');
});

test('does NOT strip dots from non-gmail local part', () => {
  // `j.ane` and `jane` are different users on most providers.
  assert.equal(canonicalizeEmail('j.ane@outlook.com'), 'j.ane@outlook.com');
});

test('non-gmail domains keep their domain (no rewrite)', () => {
  assert.equal(canonicalizeEmail('foo@fastmail.com'), 'foo@fastmail.com');
  assert.equal(canonicalizeEmail('foo@yahoo.com'), 'foo@yahoo.com');
});

// ── Stable for legitimate variations ──────────────────────────

test('same email yields same canonical form deterministically', () => {
  const a = canonicalizeEmail('Simas@Gmail.com');
  const b = canonicalizeEmail('simas@gmail.com');
  assert.equal(a, b);
});

test('different users at same domain stay distinct', () => {
  const a = canonicalizeEmail('alice@gmail.com');
  const b = canonicalizeEmail('bob@gmail.com');
  assert.notEqual(a, b);
});

test('same user at different providers stay distinct', () => {
  const a = canonicalizeEmail('jane@gmail.com');
  const b = canonicalizeEmail('jane@outlook.com');
  assert.notEqual(a, b);
});

// ── Edge cases ──────────────────────────────────────

test('plus as first character of local part strips everything', () => {
  // Odd but valid — local part is just "+suffix" — canonicalizes to empty local.
  // Documenting behavior; unlikely to appear in practice.
  assert.equal(canonicalizeEmail('+promo@gmail.com'), '@gmail.com');
});

test('multiple @ signs: only split on the last', () => {
  // "a@b@c.com" — invalid but defensive handling. The last @ is the separator.
  assert.equal(canonicalizeEmail('a@b@c.com'), 'a@b@c.com');
});

// ── Done ──────────────────────────────────────────────────

