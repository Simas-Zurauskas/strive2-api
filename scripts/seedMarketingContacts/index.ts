import 'colors';
import dotenv from 'dotenv';
import path from 'path';

// Load API .env BEFORE any module that touches `@conf/env`. Same pattern as
// the other scripts under `scripts/`.
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import mongoose from 'mongoose';
import { MONGO_URI } from '@conf/env';
import {
  fetchPromotionalSuppression,
  MailjetSuppressionUnavailableError,
} from '@services/mailjetSuppressionSync';
import { runSeed } from './seed';

// ── CLI ────────────────────────────────────────────────────
//
// Usage:
//   yarn marketing:seed --dry-run     # counts only, writes nothing
//   yarn marketing:seed
//
// Seeds `MarketingContact` from the verified user base. Idempotent — a
// re-run inserts nothing and overwrites nothing (see `seed.ts` for the
// A2b guarantees).
//
// The suppression read happens FIRST and the run aborts if it fails. That
// ordering is the point: seeding without knowing who unsubscribed would
// admit them to the audience, and the next campaign would mail people who
// had already opted out.

const main = async (): Promise<void> => {
  const dryRun = process.argv.slice(2).includes('--dry-run');

  console.log('Reading the Mailjet promotional suppression set…'.cyan);
  let suppressedEmails: ReadonlySet<string>;
  try {
    const suppression = await fetchPromotionalSuppression();
    suppressedEmails = suppression.suppressed;
    console.log(
      `Mailjet list ${suppression.listId}: ${suppression.membershipCount} members, ${suppression.suppressed.size} suppressed.`
        .cyan,
    );
  } catch (err) {
    // Fail closed. An empty set here is not "nobody unsubscribed", it is
    // "we do not know" — and proceeding would silently convert every
    // unsubscriber into a subscriber.
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `ABORTED: could not read the Mailjet suppression set — refusing to seed an audience of unknown state.\n  ${reason}`
        .red,
    );
    if (!(err instanceof MailjetSuppressionUnavailableError)) console.error(err);
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log('Connected to Mongo.'.green);

  const result = await runSeed({ dryRun, suppressedEmails });

  if (dryRun) {
    console.log('--dry-run: no DB writes.'.yellow);
    console.log(
      `Would seed ${result.eligible} verified users (${result.seededOptedOut} of them already unsubscribed in Mailjet → optedOut:true).`
        .yellow,
    );
    console.log(
      `Would flip ${result.suppressionFlipped} existing contact(s) to optedOut.`.yellow,
    );
  } else {
    console.log(
      `Done. eligible=${result.eligible} inserted=${result.inserted} seededOptedOut=${result.seededOptedOut} suppressionFlipped=${result.suppressionFlipped}`
        .green,
    );
  }

  await mongoose.disconnect();
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
