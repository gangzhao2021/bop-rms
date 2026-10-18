import { expect, it, vi } from "vitest";
import { createPaymentCompensationClaimBalanceGuard } from "../infrastructure/payment-compensation-runtime.js";
import { parsePaymentReference } from "../application/payment-provider-adapter.js";
import { parsePaymentDigest } from "../application/payment-intent-creation.js";
import { createMoney, parseCurrencyCode } from "@rms/pricing";
const mocked = vi.hoisted(() => ({ source: vi.fn() }));
vi.mock("../infrastructure/persistence/payment-compensation-source.js", () => ({
  createPostgresPaymentCompensationSource: mocked.source,
}));
const id = (n: number) =>
  parsePaymentReference("01909978-0000-7000-8000-" + n.toString(16).padStart(12, "0"));
const money = (amountMinor: bigint) =>
  createMoney({ amountMinor, currencyCode: parseCurrencyCode("CAD") });
const digest = parsePaymentDigest("sha256:" + "a".repeat(64));
function setup(pending: bigint, confirmed = 0n) {
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  let pendingAtCommit = pending;
  const current = {
    environment: "Test",
    terminalEvidenceDigest: digest,
    originalPaymentMethod: "OnlineCard",
    capturedAmount: money(1000n),
    confirmedRefundedAmount: money(confirmed),
    get pendingRefundClaimedAmount() {
      return money(pendingAtCommit);
    },
  };
  const resolveIdentity = vi.fn(async (input: unknown) => {
    expect(input).toMatchObject({ orderReference: id(5), paymentAttemptReference: id(8) });
    return { environment: "Test", identityVersion: 1, identityDigest: digest };
  });
  const resolve = vi.fn(async (input: unknown) => {
    expect(input).toMatchObject({ identityVersion: 1, identityDigest: digest });
    return current;
  });
  mocked.source.mockImplementation((options) => {
    expect(options.tenantReference).toBe(id(1));
    return {
      resolveIdentity: async (input: unknown) =>
        options.transactions.run(async (borrowed: unknown) => {
          expect(borrowed).toBe(tx);
          return resolveIdentity(input);
        }),
      resolve: async (input: unknown) =>
        options.transactions.run(async (borrowed: unknown) => {
          expect(borrowed).toBe(tx);
          return resolve(input);
        }),
    };
  });
  const guard = createPaymentCompensationClaimBalanceGuard({
    tenantReference: id(1),
    scope: {
      brandReference: id(2),
      storeReference: id(3),
      providerAccountReference: id(4),
      environment: "Test",
    },
    clock: { now: () => "2026-09-13T15:00:00.000Z" },
    authorize: async () => true,
    otherRefunds: async () => ({ confirmedMinor: 0n, pendingMinor: 0n, version: 1 }),
  });
  const input = {
    caseRecord: {
      brandReference: id(2),
      storeReference: id(3),
      orderReference: id(5),
      paymentTransactionReference: id(6),
      paymentIntentReference: id(7),
      paymentAttemptReference: id(8),
      environment: "Test" as const,
      terminalEvidenceDigest: digest,
    },
    receipt: { originalPaymentMethod: "OnlineCard" as const, amount: money(1000n) },
  };
  return {
    tx,
    input,
    guard,
    current,
    setPending: (value: bigint) => {
      pendingAtCommit = value;
    },
  };
}
it("borrows the action transaction and admits an exact available balance", async () => {
  const f = setup(0n);
  expect(await f.guard(f.tx, f.input)).toBe(true);
});
it("blocks a claim when occupancy appeared after its earlier source read", async () => {
  const f = setup(0n);
  f.setPending(1n);
  expect(await f.guard(f.tx, f.input)).toBe(false);
});
it("includes confirmed refunds in the captured ceiling", async () => {
  const f = setup(0n, 1n);
  expect(await f.guard(f.tx, f.input)).toBe(false);
});
it("rejects substituted capture provenance or environment", async () => {
  const f = setup(0n);
  f.current.environment = "Live";
  expect(await f.guard(f.tx, f.input)).toBe(false);
  f.current.environment = "Test";
  f.current.terminalEvidenceDigest = parsePaymentDigest("sha256:" + "b".repeat(64));
  expect(await f.guard(f.tx, f.input)).toBe(false);
});
