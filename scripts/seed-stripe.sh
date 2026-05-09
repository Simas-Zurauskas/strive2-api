#!/usr/bin/env bash
# Seeds Strive's Stripe products + prices in whatever account the CLI is
# currently authenticated to. Prints env-var lines at the end — paste them
# into api/.env (replacing any existing STRIPE_PRICE_ID_*).
#
# Modes:
#   ./seed-stripe.sh          — TEST mode (default; safe to re-run on sandbox)
#   ./seed-stripe.sh --live   — LIVE mode (requires typed confirmation)
#
# Not idempotent — running twice against the same account creates duplicate
# products. Intended to run ONCE per Stripe account at bootstrap time.
#
# Prerequisites: `stripe` CLI in PATH, `jq` in PATH, `stripe login` already done.
set -euo pipefail

LIVE_FLAG=""
MODE_LABEL="TEST"
if [[ "${1:-}" == "--live" ]]; then
  LIVE_FLAG="--live"
  MODE_LABEL="LIVE"
fi

echo "Mode: $MODE_LABEL"
echo "Authenticated account:"
stripe $LIVE_FLAG accounts retrieve 2>/dev/null \
  | jq -r '"  id=\(.id)\n  name=\(.business_profile.name // .settings.dashboard.display_name // "(unset)")\n  country=\(.country)"' \
  || { echo "ERROR: stripe CLI not authenticated. Run \`stripe login\` first." >&2; exit 1; }
echo ""

if [[ "$MODE_LABEL" == "LIVE" ]]; then
  echo "⚠️  About to create products and prices in the LIVE Stripe account above."
  echo "    This is irreversible (products can be archived but not deleted)."
  read -r -p "Type 'seed live' to proceed: " CONFIRM
  if [[ "$CONFIRM" != "seed live" ]]; then
    echo "Aborted." >&2
    exit 1
  fi
  echo ""
fi

# ── Products ──────────────────────────────────────────────
# Descriptions MUST match `PLANS[*].description` in api/src/lib/creditPricing.ts
# verbatim — the pricing page and Stripe Checkout share this copy.
# Top-up products are NOT seeded — top-ups use ad-hoc `price_data` on each
# Checkout Session (variable $5–$500 amount, see TOPUP_* in creditPricing.ts).
echo "Creating products..."
STARTER_PROD=$(stripe $LIVE_FLAG products create \
  --name "Strive Starter" \
  --description "Monthly plan for occasional learners. Recurring AI-generation allowance sized for building a few personalized courses each month, plus regular lesson generation, quizzes, and code-execution practice." \
  | jq -r .id)
PRO_PROD=$(stripe $LIVE_FLAG products create \
  --name "Strive Pro" \
  --description "Monthly plan for active learners. Substantially larger recurring AI-generation allowance — comfortable headroom for ongoing course building, frequent lesson regeneration, and intensive review and code practice." \
  | jq -r .id)
STUDIO_PROD=$(stripe $LIVE_FLAG products create \
  --name "Strive Studio" \
  --description "Monthly plan for power users and educators. Our largest recurring AI-generation allowance, designed for heavy continuous use — building several courses in parallel and frequent re-generation across the platform." \
  | jq -r .id)

echo "  starter=$STARTER_PROD"
echo "  pro=$PRO_PROD"
echo "  studio=$STUDIO_PROD"

# ── Prices ─────────────────────────────────────────────────
# Annual = monthlyAnnualUsd × 12, rounded up to whole cents.
# Starter $10.39×12 = $124.68 → 12470¢; Pro $19.99×12 = $239.88 → 23990¢;
# Studio $39.99×12 = $479.88 → 47990¢.
echo ""
echo "Creating prices..."
STARTER_MO=$(stripe $LIVE_FLAG prices create --product "$STARTER_PROD" --unit-amount 1299 --currency usd -d "recurring[interval]=month" | jq -r .id)
STARTER_YR=$(stripe $LIVE_FLAG prices create --product "$STARTER_PROD" --unit-amount 12470 --currency usd -d "recurring[interval]=year" | jq -r .id)
PRO_MO=$(stripe $LIVE_FLAG prices create --product "$PRO_PROD" --unit-amount 2499 --currency usd -d "recurring[interval]=month" | jq -r .id)
PRO_YR=$(stripe $LIVE_FLAG prices create --product "$PRO_PROD" --unit-amount 23990 --currency usd -d "recurring[interval]=year" | jq -r .id)
STUDIO_MO=$(stripe $LIVE_FLAG prices create --product "$STUDIO_PROD" --unit-amount 4999 --currency usd -d "recurring[interval]=month" | jq -r .id)
STUDIO_YR=$(stripe $LIVE_FLAG prices create --product "$STUDIO_PROD" --unit-amount 47990 --currency usd -d "recurring[interval]=year" | jq -r .id)

# ── Output ─────────────────────────────────────────────────
cat <<EOF

Done. Paste these into api/.env (replacing existing STRIPE_PRICE_ID_*):

STRIPE_PRICE_ID_STARTER_MONTHLY=$STARTER_MO
STRIPE_PRICE_ID_STARTER_ANNUAL=$STARTER_YR
STRIPE_PRICE_ID_PRO_MONTHLY=$PRO_MO
STRIPE_PRICE_ID_PRO_ANNUAL=$PRO_YR
STRIPE_PRICE_ID_STUDIO_MONTHLY=$STUDIO_MO
STRIPE_PRICE_ID_STUDIO_ANNUAL=$STUDIO_YR
EOF
