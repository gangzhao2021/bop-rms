import { beforeEach, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresPaymentIntentBindingSource } from "../infrastructure/persistence/payment-intent-binding-source.js";
const d = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../infrastructure/persistence/payment-intent-creation-store.js", () => ({
  createPostgresPaymentIntentCreationStore: () => ({ resolveOperation: d.read }),
}));
const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-20T12:00:00.000Z";
function fixture() {
  return {
    intent: {
      paymentIntentReference: id(4),
      paymentOperationReference: id(5),
      createdAt: at,
      preparation: {
        brandReference: id(2),
        storeReference: id(3),
        orderReference: id(6),
        orderBatchReference: id(7),
        committedAt: at,
      },
    },
    attempt: {
      paymentIntentReference: id(4),
      paymentAttemptReference: id(8),
      providerEnvironment: "Test",
      createdAt: at,
    },
    providerOutcome: { secret: "private" },
  };
}
function setup() {
  const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("FROM rms_payment") ? [{ operation: id(5) }] : [],
      rowCount: null,
    })),
    authorize = vi.fn(async () => true),
    tx = { query } as unknown as ConsumerTransaction;
  const source = createPostgresPaymentIntentBindingSource({
    scope: {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      environment: "Test",
    },
    authorize,
  });
  return {
    query,
    authorize,
    tx,
    read: () => source(tx, { paymentIntentReference: id(4), observedAt: at }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  d.read.mockResolvedValue(fixture());
});
it("returns only owner-established routing references under current scope", async () => {
  const f = setup();
  expect(await f.read()).toEqual({
    paymentIntentReference: id(4),
    paymentAttemptReference: id(8),
    orderReference: id(6),
    orderBatchReference: id(7),
  });
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.query.mock.calls[1]?.[0]).toContain(
    "brand_id=$1 AND store_id=$2 AND payment_intent_id=$3",
  );
});
it("does not read without current authorization", async () => {
  const f = setup();
  f.authorize.mockResolvedValue(false);
  await expect(f.read()).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
it("rejects scope revocation after resolving the owner", async () => {
  const f = setup();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.read()).rejects.toThrow();
});
it.each(["intent", "operation", "attempt", "environment", "store", "future"])(
  "rejects mismatched %s",
  async (field) => {
    const f = setup(),
      record = fixture();
    if (field === "intent") record.intent.paymentIntentReference = id(99);
    if (field === "operation") record.intent.paymentOperationReference = id(99);
    if (field === "attempt") record.attempt.paymentIntentReference = id(99);
    if (field === "environment") record.attempt.providerEnvironment = "Live";
    if (field === "store") record.intent.preparation.storeReference = id(99);
    if (field === "future") record.intent.createdAt = "2026-09-21T12:00:00.000Z";
    d.read.mockResolvedValue(record);
    await expect(f.read()).rejects.toThrow();
  },
);
it("rejects an unresolved owner record", async () => {
  const f = setup();
  d.read.mockResolvedValue(null);
  await expect(f.read()).rejects.toThrow();
});
