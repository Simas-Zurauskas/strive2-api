import 'colors';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import mongoose from 'mongoose';
import { MONGO_URI } from '@conf/env';
import UserModel from '@models/UserModel';
import CreditLedgerModel, { CreditLedgerReason } from '@models/CreditLedgerModel';

type Action = 'grant' | 'clawback' | 'show';

interface Args {
  action: Action;
  email: string;
  amount?: number;
  notes?: string;
  target?: 'allowance' | 'bonus';
}

const usage = `Usage:
  yarn credit:admin grant <email> <amount> [--bonus] [--notes "..."]
  yarn credit:admin clawback <email> <amount> [--bonus] [--notes "..."]
  yarn credit:admin show <email>

Defaults: grants go to bonus balance (never expires); clawbacks come off
allowance first. Pass --bonus on a grant to force bonus, or on a clawback
to target bonus only. All writes are ledgered.
`;

const parseArgs = (): Args => {
  const raw = process.argv.slice(2);
  if (raw.length < 2) {
    console.error(usage);
    process.exit(1);
  }
  const [action, email, ...rest] = raw as [Action, string, ...string[]];
  if (!['grant', 'clawback', 'show'].includes(action)) {
    console.error(`Unknown action: ${action}\n${usage}`);
    process.exit(1);
  }

  const args: Args = { action, email };
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--bonus') {
      flags.add('bonus');
    } else if (token === '--notes') {
      args.notes = rest[++i];
    } else if (!args.amount && /^\d+$/.test(token)) {
      args.amount = Number(token);
    }
  }
  args.target = flags.has('bonus') ? 'bonus' : 'allowance';

  if ((action === 'grant' || action === 'clawback') && (!args.amount || args.amount <= 0)) {
    console.error(`${action} needs a positive integer amount.\n${usage}`);
    process.exit(1);
  }
  return args;
};

const showUser = async (email: string): Promise<void> => {
  const user = await UserModel.findOne({ email }).select('email subscription credits').lean();
  if (!user) {
    console.error(`User not found: ${email}`.red);
    process.exit(1);
  }
  console.log(`${user.email}`.bold);
  console.log(`  plan:         ${user.subscription?.plan ?? '(unset)'}`);
  console.log(`  status:       ${user.subscription?.status ?? '(unset)'}`);
  console.log(`  allowance:    ${user.credits?.allowanceBalance ?? 0} / ${user.credits?.allowanceGranted ?? 0}`);
  console.log(`  bonus:        ${user.credits?.bonusBalance ?? 0}`);
  console.log(`  periodStart:  ${user.credits?.periodStart?.toISOString() ?? '(unset)'}`);
  console.log(`  periodEnd:    ${user.credits?.periodEnd?.toISOString() ?? '(unset)'}`);

  const recent = await CreditLedgerModel
    .find({ userId: user._id })
    .sort({ timestamp: -1 })
    .limit(10)
    .lean();
  if (recent.length === 0) return;
  console.log(`  last ${recent.length} ledger rows:`.gray);
  for (const row of recent) {
    const sign = row.delta >= 0 ? '+' : '';
    console.log(
      `    ${row.timestamp.toISOString()}  ${sign}${row.delta} (${row.reason})${row.notes ? ` — ${row.notes}` : ''}`.gray,
    );
  }
};

const applyDelta = async ({
  email,
  amount,
  target,
  reason,
  notes,
}: {
  email: string;
  amount: number;
  target: 'allowance' | 'bonus';
  reason: CreditLedgerReason;
  notes?: string;
}): Promise<void> => {
  const user = await UserModel.findOne({ email });
  if (!user) {
    console.error(`User not found: ${email}`.red);
    process.exit(1);
  }

  const balanceBefore = user.credits.allowanceBalance;
  const bonusBefore = user.credits.bonusBalance;

  let allowanceDelta = 0;
  let bonusDelta = 0;

  if (amount >= 0) {
    if (target === 'allowance') allowanceDelta = amount;
    else bonusDelta = amount;
  } else {
    // Clawback: drain allowance first, then bonus, unless target pinned.
    const want = -amount;
    if (target === 'bonus') {
      bonusDelta = -Math.min(want, bonusBefore);
    } else {
      const fromAllowance = Math.min(want, balanceBefore);
      allowanceDelta = -fromAllowance;
      bonusDelta = -Math.min(want - fromAllowance, bonusBefore);
    }
  }

  const balanceAfter = Math.max(0, balanceBefore + allowanceDelta);
  const bonusAfter = Math.max(0, bonusBefore + bonusDelta);

  user.credits.allowanceBalance = balanceAfter;
  user.credits.bonusBalance = bonusAfter;
  if (allowanceDelta > 0) {
    user.credits.allowanceGranted += allowanceDelta;
  }
  await user.save();

  await CreditLedgerModel.create({
    userId: user._id,
    timestamp: new Date(),
    delta: allowanceDelta + bonusDelta,
    allowanceDelta,
    bonusDelta,
    balanceBefore,
    balanceAfter,
    bonusBefore,
    bonusAfter,
    reason,
    notes,
  });

  console.log(`Applied ${allowanceDelta + bonusDelta} credits to ${email}`.green);
  console.log(`  allowance: ${balanceBefore} → ${balanceAfter}`);
  console.log(`  bonus:     ${bonusBefore} → ${bonusAfter}`);
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  await mongoose.connect(MONGO_URI, { maxPoolSize: 5 });

  if (args.action === 'show') {
    await showUser(args.email);
  } else if (args.action === 'grant') {
    await applyDelta({
      email: args.email,
      amount: args.amount!,
      target: args.target ?? 'bonus',
      reason: 'admin_grant',
      notes: args.notes,
    });
  } else if (args.action === 'clawback') {
    await applyDelta({
      email: args.email,
      amount: -args.amount!,
      target: args.target ?? 'allowance',
      reason: 'admin_clawback',
      notes: args.notes,
    });
  }

  await mongoose.disconnect();
  process.exit(0);
};

main().catch((err) => {
  console.error('[creditAdmin] failed:'.red, err);
  process.exit(1);
});
