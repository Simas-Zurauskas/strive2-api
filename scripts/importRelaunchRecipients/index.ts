import 'colors';
import dotenv from 'dotenv';
import path from 'path';

// Load API .env BEFORE any module that touches `@conf/env`. Same pattern as
// scripts/indexProductKb/index.ts.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { readFileSync } from 'fs';
import mongoose from 'mongoose';
import { MONGO_URI } from '@conf/env';
import RelaunchRecipientModel from '@models/RelaunchRecipientModel';
import SignupCreditGrantModel from '@models/SignupCreditGrantModel';

// ── CLI ────────────────────────────────────────────────────
//
// Usage:
//   yarn relaunch:import --file ../wiki/working/prod.User.json
//   yarn relaunch:import --file ../wiki/working/prod.User.json --usd 5
//   yarn relaunch:import --file ../wiki/working/prod.User.json --dry-run
//
// Idempotent: upserts on `email`, so re-running with a wider list (or after a
// failed partial run) does not corrupt state. Re-running the same list is a
// no-op aside from `updatedAt` bumps.

interface Flags {
  file: string;
  usd: number;
  reason: string;
  source: string;
  dryRun: boolean;
}

const parseFlags = (): Flags => {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const idx = args.indexOf(`--${name}`);
    if (idx === -1) return undefined;
    return args[idx + 1];
  };
  const file = get('file');
  if (!file) {
    console.error('Missing --file <path>'.red);
    process.exit(1);
  }
  const usdRaw = get('usd');
  const usd = usdRaw ? Number(usdRaw) : 5;
  if (!Number.isFinite(usd) || usd < 0) {
    console.error(`Invalid --usd value: ${usdRaw}`.red);
    process.exit(1);
  }
  const source = get('source') ?? path.basename(file);
  const reason = get('reason') ?? 'old-user-relaunch';
  const dryRun = args.includes('--dry-run');
  return { file, usd, reason, source, dryRun };
};

// ── File parse ────────────────────────────────────────────

interface DumpEntry {
  email?: string;
}

const readEmailsFromFile = (filePath: string): string[] => {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const raw = readFileSync(abs, 'utf-8');
  const parsed = JSON.parse(raw) as DumpEntry[] | unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array, got ${typeof parsed}`);
  }
  const emails = parsed
    .map((row) => (row && typeof row === 'object' && 'email' in row ? (row as DumpEntry).email : undefined))
    .filter((e): e is string => typeof e === 'string')
    .map((e) => e.toLowerCase().trim())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  // Dedupe — the dump may contain repeats across exports.
  return Array.from(new Set(emails));
};

// ── Main ──────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const flags = parseFlags();
  const emails = readEmailsFromFile(flags.file);
  console.log(`Found ${emails.length} unique valid emails in ${flags.file}`.cyan);
  console.log(`Will award $${flags.usd} signup credit per email (reason="${flags.reason}", source="${flags.source}")`.cyan);

  if (flags.dryRun) {
    console.log('--dry-run: no DB writes. Sample of first 5:'.yellow);
    console.log(emails.slice(0, 5).join('\n'));
    return;
  }

  await mongoose.connect(MONGO_URI);
  console.log('Connected to Mongo.'.green);

  // bulkWrite upsert keeps the script roughly O(1) round-trips regardless of
  // list size (chunked at 1000 to stay under the Mongo bulk limit).
  const CHUNK = 1000;
  let recipientsUpserted = 0;
  let grantsUpserted = 0;

  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK);

    const recipientOps = chunk.map((email) => ({
      updateOne: {
        filter: { email },
        update: { $setOnInsert: { email, importSource: flags.source } },
        upsert: true,
      },
    }));
    const recipientRes = await RelaunchRecipientModel.bulkWrite(recipientOps, { ordered: false });
    recipientsUpserted += recipientRes.upsertedCount + recipientRes.modifiedCount;

    if (flags.usd > 0) {
      // Only seed grants for rows that DON'T already have one. Using
      // $setOnInsert means a re-run with a different --usd does NOT overwrite
      // an existing grant amount — change those manually if you need to.
      const grantOps = chunk.map((email) => ({
        updateOne: {
          filter: { email },
          update: {
            $setOnInsert: {
              email,
              usdAmount: flags.usd,
              importSource: flags.source,
              reason: flags.reason,
            },
          },
          upsert: true,
        },
      }));
      const grantRes = await SignupCreditGrantModel.bulkWrite(grantOps, { ordered: false });
      grantsUpserted += grantRes.upsertedCount;
    }

    console.log(`Processed ${Math.min(i + CHUNK, emails.length)}/${emails.length}`.gray);
  }

  console.log(
    `Done. Recipients touched=${recipientsUpserted}, grants newly inserted=${grantsUpserted}.`.green,
  );

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
