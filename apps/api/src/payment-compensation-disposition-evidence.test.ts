import { beforeEach, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
const d = vi.hoisted(() => ({ load: vi.fn(), identity: vi.fn(), factory: vi.fn() }));
vi.mock("@rms/ordering", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/ordering")>()),
  createPostgresOrderPaymentDispositionReader: () => ({ loadByPaymentEvent: d.load }),
}));
vi.mock("@rms/payment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/payment")>()),
  createPostgresPaymentCompensationIdentityReader: d.factory,
}));
import { createPaymentCompensationDispositionEvidence } from "./payment-compensation-disposition-evidence.js";
const id = (n: number) => "0190fa72-0000-7000-8000-" + String(n).padStart(12, "0");
const value = {
  dispositionReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  orderReference: id(4),
  orderBatchReference: id(5),
  submissionReference: id(6),
  paymentTransactionReference: id(7),
  paymentIntentReference: id(8),
  paymentAttemptReference: id(9),
  paymentEventReference: id(10),
  sourceVersion: 1,
  sourceCheckpoint: id(11),
  sourceDigest: "sha256:" + "a".repeat(64),
  evaluatedAt: "2026-09-21T00:00:00.000Z",
  disposition: "PaidWithoutFulfillableOrder",
  reason: "SubmissionCancelled",
  kitchenReleaseDisposition: "Blocked",
};
function fixture() {
  const tx = { query: vi.fn() } as unknown as ConsumerTransaction,
    authorize = vi.fn(async () => true);
  const read = createPaymentCompensationDispositionEvidence({
    scope: {
      brandReference: id(2),
      storeReference: id(3),
      providerAccountReference: id(12),
      environment: "Test",
    },
    now: () => "2026-09-21T01:00:00.000Z",
    authorize,
  });
  return { tx, authorize, read };
}
beforeEach(() => {
  vi.resetAllMocks();
  d.load.mockResolvedValue({ record: value });
  d.identity.mockResolvedValue({});
  d.factory.mockReturnValue(d.identity);
});
it("binds immutable owner record and successful Payment identity on same transaction", async () => {
  const f = fixture();
  expect(await f.read(f.tx, value)).toBe(true);
  expect(d.load).toHaveBeenCalledWith({ transaction: f.tx, paymentEventReference: id(10) });
  expect(d.identity).toHaveBeenCalledWith({
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    paymentTransactionReference: id(7),
    paymentIntentReference: id(8),
    paymentAttemptReference: id(9),
  });
  const options = d.factory.mock.calls[0]?.[0];
  expect(await options.transactions.run((tx: unknown) => tx)).toBe(f.tx);
  expect(await options.authorize({}, value)).toBe(false);
});
it.each([
  null,
  { record: { ...value, sourceVersion: 2 } },
  { record: { ...value, sourceDigest: "sha256:" + "b".repeat(64) } },
])("rejects missing or different persisted disposition", async (record) => {
  const f = fixture();
  d.load.mockResolvedValue(record);
  expect(await f.read(f.tx, value)).toBe(false);
  expect(d.identity).not.toHaveBeenCalled();
});
it("rejects wrong scope, future evidence and revoked permission", async () => {
  const f = fixture();
  expect(await f.read(f.tx, { ...value, storeReference: id(90) })).toBe(false);
  expect(await f.read(f.tx, { ...value, evaluatedAt: "2026-09-22T00:00:00.000Z" })).toBe(false);
  expect(d.load).not.toHaveBeenCalled();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  expect(await f.read(f.tx, value)).toBe(false);
});
it("denies before reads and denies absent successful terminal identity", async () => {
  const f = fixture();
  f.authorize.mockResolvedValue(false);
  expect(await f.read(f.tx, value)).toBe(false);
  expect(d.load).not.toHaveBeenCalled();
  f.authorize.mockResolvedValue(true);
  d.identity.mockResolvedValue(null);
  expect(await f.read(f.tx, value)).toBe(false);
});
