/**
 * AC5 — `POST /execute-code` must debit the vendor spend it records.
 *
 * The defect this closes: the route is gated by `requireCredits()`, but nothing
 * in the handler ever debited. The balance could therefore never fall, so that
 * gate could never close — a user sitting on one credit could run Judge0
 * indefinitely (bounded only by the 30/min rate limit) while we were billed for
 * every call. Realised loss was negligible; an un-closable credit gate is a
 * structural defect regardless, and the one-time onboarding grant keeps it open
 * roughly 5x longer per account.
 *
 * The subtle case pinned below: a learner's code that COMPILES WRONG or throws
 * is still a Judge0 success (HTTP 200 with a status description), and Judge0
 * bills us for it. Trial-and-error is the normal way people use a code editor,
 * so treating "the learner's code failed" as "don't charge" would leave the
 * majority of real executions unbilled and defeat the fix. Only a genuine
 * Judge0 service failure is free.
 *
 * Run: yarn test executeCode
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const { fakeRecordUsage, fakeDebit } = vi.hoisted(() => ({
  fakeRecordUsage: vi.fn(),
  fakeDebit: vi.fn(),
}));

vi.mock('@services/usageService', () => ({ recordUsage: fakeRecordUsage }));
vi.mock('@services/creditService', () => ({ debitActualSpend: fakeDebit }));

import { executeCodeController } from '@controlers/course/executeCode';
import { buildReqRes, invokeController } from '../../../test-helpers/express';

const USER = '507f1f77bcf86cd799439011';

const judge0Ok = (statusDescription: string) => ({
  ok: true,
  json: async () => ({
    stdout: 'out',
    status: { id: 3, description: statusDescription },
    time: '0.01',
  }),
});

beforeEach(() => {
  fakeRecordUsage.mockReset();
  fakeDebit.mockReset();
  fakeDebit.mockResolvedValue(undefined);
  vi.restoreAllMocks();
});

const run = async (fetchImpl: unknown) => {
  vi.stubGlobal('fetch', fetchImpl);
  const { req, res } = buildReqRes({ userId: USER, body: { language: 'python', code: 'print(1)' } });
  return invokeController(executeCodeController, req, res);
};

describe('executeCode — AC5 debit', () => {
  test('a successful run records usage AND debits it', async () => {
    await run(vi.fn().mockResolvedValue(judge0Ok('Accepted')));
    expect(fakeRecordUsage).toHaveBeenCalledOnce();
    expect(fakeDebit).toHaveBeenCalledOnce();
    expect(fakeDebit.mock.calls[0][0]).toMatchObject({ userId: USER, jobType: 'code_exec' });
  });

  test("a learner's FAILING code still debits — Judge0 billed us either way", async () => {
    // The reading that matters. "Runtime Error" is a Judge0 success; if this
    // did not debit, trial-and-error coding — the normal case — would be free
    // to the user and paid for by us, which is the whole defect.
    for (const status of ['Runtime Error (NZEC)', 'Wrong Answer', 'Compilation Error']) {
      fakeRecordUsage.mockReset();
      fakeDebit.mockReset();
      fakeDebit.mockResolvedValue(undefined);
      await run(vi.fn().mockResolvedValue(judge0Ok(status)));
      expect(fakeRecordUsage, status).toHaveBeenCalledOnce();
      expect(fakeDebit, status).toHaveBeenCalledOnce();
    }
  });

  test('a Judge0 SERVICE failure neither records nor debits — that one is free', async () => {
    const failing = vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => 'upstream boom' });
    await expect(run(failing)).rejects.toThrow(/Code execution service error/i);
    expect(fakeRecordUsage).not.toHaveBeenCalled();
    expect(fakeDebit).not.toHaveBeenCalled();
  });

  test('debits exactly once per request — no double charge', async () => {
    await run(vi.fn().mockResolvedValue(judge0Ok('Accepted')));
    expect(fakeDebit).toHaveBeenCalledTimes(1);
  });

  test('a failing debit cannot break the response — it is bgError-swallowed', async () => {
    // The debit is observability-adjacent bookkeeping on a user-facing path.
    // A ledger blip must not turn a successful execution into a 500.
    fakeDebit.mockRejectedValue(new Error('mongo down'));
    await expect(run(vi.fn().mockResolvedValue(judge0Ok('Accepted')))).resolves.not.toThrow();
  });

  test('carries no minMicroCents floor — execution is atomic, not streamed', async () => {
    // Sibling chat controllers forgive sub-500μ¢ spend because a client can
    // disconnect mid-stream. Judge0 either ran and cost us, or it did not
    // happen at all, so forgiving small amounts here would just under-bill.
    await run(vi.fn().mockResolvedValue(judge0Ok('Accepted')));
    expect(fakeDebit.mock.calls[0][0]).not.toHaveProperty('minMicroCents');
  });
});
