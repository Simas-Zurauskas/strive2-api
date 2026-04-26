#!/usr/bin/env bash
# Seeds Strive's Stripe products + prices in whatever account the CLI is
# currently authenticated to. Prints env-var lines at the end — paste them
# into api/.env (replacing any existing STRIPE_PRICE_ID_*).
#
# Prerequisites: `stripe` CLI in PATH, `jq` in PATH.
set -euo pipefail

echo "Verifying CLI account..."
stripe config --list | grep account_id || true
echo ""

# ── Products ──────────────────────────────────────────────
echo "Creating products..."
STARTER_PROD=$(stripe products create \
  --name "Strive Starter" \
  --description "Starter subscription — 800 credits per billing period. Entry paid tier." \
  | jq -r .id)
PRO_PROD=$(stripe products create \
  --name "Strive Pro" \
  --description "Pro subscription — 2,200 credits per billing period. Includes priority queue and unlimited active courses." \
  | jq -r .id)
STUDIO_PROD=$(stripe products create \
  --name "Strive Studio" \
  --description "Studio subscription — 5,000 credits per billing period. Highest tier, for creators and power users." \
  | jq -r .id)
TOPUP_SMALL_PROD=$(stripe products create \
  --name "Strive Credit Pack — Small" \
  --description "One-time top-up: 300 bonus credits. Bonus credits never expire and are consumed after your plan allowance." \
  | jq -r .id)
TOPUP_LARGE_PROD=$(stripe products create \
  --name "Strive Credit Pack — Large" \
  --description "One-time top-up: 900 bonus credits. Bonus credits never expire and are consumed after your plan allowance. 17% cheaper per credit than the Small pack." \
  | jq -r .id)

echo "  starter=$STARTER_PROD"
echo "  pro=$PRO_PROD"
echo "  studio=$STUDIO_PROD"
echo "  topup_small=$TOPUP_SMALL_PROD"
echo "  topup_large=$TOPUP_LARGE_PROD"

# ── Prices ─────────────────────────────────────────────────
echo ""
echo "Creating prices..."
STARTER_MO=$(stripe prices create --product "$STARTER_PROD" --unit-amount 1299 --currency usd -d "recurring[interval]=month" | jq -r .id)
STARTER_YR=$(stripe prices create --product "$STARTER_PROD" --unit-amount 12470 --currency usd -d "recurring[interval]=year" | jq -r .id)
PRO_MO=$(stripe prices create --product "$PRO_PROD" --unit-amount 2499 --currency usd -d "recurring[interval]=month" | jq -r .id)
PRO_YR=$(stripe prices create --product "$PRO_PROD" --unit-amount 23990 --currency usd -d "recurring[interval]=year" | jq -r .id)
STUDIO_MO=$(stripe prices create --product "$STUDIO_PROD" --unit-amount 4999 --currency usd -d "recurring[interval]=month" | jq -r .id)
STUDIO_YR=$(stripe prices create --product "$STUDIO_PROD" --unit-amount 47990 --currency usd -d "recurring[interval]=year" | jq -r .id)
TOPUP_SMALL=$(stripe prices create --product "$TOPUP_SMALL_PROD" --unit-amount 599 --currency usd | jq -r .id)
TOPUP_LARGE=$(stripe prices create --product "$TOPUP_LARGE_PROD" --unit-amount 1499 --currency usd | jq -r .id)

# ── Output ─────────────────────────────────────────────────
cat <<EOF

Done. Paste these into api/.env (replacing existing STRIPE_PRICE_ID_*):

STRIPE_PRICE_ID_STARTER_MONTHLY=$STARTER_MO
STRIPE_PRICE_ID_STARTER_ANNUAL=$STARTER_YR
STRIPE_PRICE_ID_PRO_MONTHLY=$PRO_MO
STRIPE_PRICE_ID_PRO_ANNUAL=$PRO_YR
STRIPE_PRICE_ID_STUDIO_MONTHLY=$STUDIO_MO
STRIPE_PRICE_ID_STUDIO_ANNUAL=$STUDIO_YR
STRIPE_PRICE_ID_TOPUP_SMALL=$TOPUP_SMALL
STRIPE_PRICE_ID_TOPUP_LARGE=$TOPUP_LARGE
EOF
