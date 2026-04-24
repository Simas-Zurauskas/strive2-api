import 'colors';
import dotenv from 'dotenv';
import path from 'path';

// `@conf/env` reads process.env at module-import time. Load dotenv first so
// MONGO_URI is populated before any downstream import latches onto it.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import mongoose from 'mongoose';
import { MONGO_URI } from '@conf/env';
import UserModel from '@models/UserModel';
import CreditLedgerModel from '@models/CreditLedgerModel';
import { FREE_PERIOD_DAYS, PLANS } from '@lib/creditPricing';

const DRY_RUN = process.argv.includes('--dry-run');

const main = async (): Promise<void> => {
  await mongoose.connect(MONGO_URI, { maxPoolSize: 5 });
  console.log(`Connected to Mongo. DRY_RUN=${DRY_RUN}`.cyan);

  // "Unmigrated" = missing credits subdoc, OR credits present but no grant
  // ever recorded in the ledger. Re-running the script after a partial
  // failure is safe: users already processed will be skipped by the ledger
  // check below.
  const unmigratedUsers = await UserModel.find({
    $or: [
      { credits: { $exists: false } },
      { 'credits.allowanceGranted': { $lte: 0 } },
    ],
  }).select('_id email credits subscription').lean();

  console.log(`Found ${unmigratedUsers.length} users to inspect`.yellow);

  const freeAllowance = PLANS.free.monthlyAllowance;
  let migrated = 0;
  let skipped = 0;

  for (const user of unmigratedUsers) {
    const existingGrant = await CreditLedgerModel.findOne({
      userId: user._id,
      reason: 'signup_grant',
    }).select('_id').lean();

    if (existingGrant) {
      skipped++;
      continue;
    }

    const now = new Date();
    const periodEnd = new Date(now.getTime() + FREE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

    if (DRY_RUN) {
      console.log(`  [dry] ${user.email} → grant ${freeAllowance} credits, period ends ${periodEnd.toISOString()}`.gray);
      migrated++;
      continue;
    }

    await UserModel.updateOne(
      { _id: user._id },
      {
        $set: {
          subscription: { plan: 'free', status: 'active', cancelAtPeriodEnd: false },
          credits: {
            allowanceBalance: freeAllowance,
            allowanceGranted: freeAllowance,
            periodStart: now,
            periodEnd,
            bonusBalance: 0,
          },
        },
      },
    );

    await CreditLedgerModel.create({
      userId: user._id,
      timestamp: now,
      delta: freeAllowance,
      allowanceDelta: freeAllowance,
      bonusDelta: 0,
      balanceBefore: 0,
      balanceAfter: freeAllowance,
      bonusBefore: 0,
      bonusAfter: 0,
      reason: 'signup_grant',
      notes: 'Phase 1 backfill',
    });

    migrated++;
    if (migrated % 50 === 0) {
      console.log(`  progress: ${migrated} migrated`.cyan);
    }
  }

  console.log(`\nDone. Migrated: ${migrated}, already-migrated skipped: ${skipped}`.green);
  await mongoose.disconnect();
  process.exit(0);
};

main().catch((err) => {
  console.error('[migrate] failed:'.red, err);
  process.exit(1);
});
