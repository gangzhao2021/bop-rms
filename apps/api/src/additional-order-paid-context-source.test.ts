import { afterEach, describe, expect, it, vi } from "vitest";

const id = (n: number) => "01a1eb00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const p = {
  orderReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  guestSessionReference: id(4),
  orderBatchReference: id(5),
  submissionReference: id(6),
  sourceCartReference: id(7),
  sourceCartVersion: 3,
  quoteReference: id(8),
  orderAllocation: { amountMinor: 1695n, currencyCode: "CAD" },
};
const execution = {
  observedAt: "2026-11-17T18:13:55.000Z",
  snapshot: {
    snapshotVersion: 2,
    orderReference: p.orderReference,
    brandReference: p.brandReference,
    storeReference: p.storeReference,
    guestSessionReference: p.guestSessionReference,
    batch: {
      orderBatchReference: p.orderBatchReference,
      submissionReference: p.submissionReference,
      sourceCartReference: p.sourceCartReference,
      sourceCartVersion: p.sourceCartVersion,
      quoteReference: p.quoteReference,
    },
    items: [{ pricing: { total: { amountMinor: 1695n } } }],
  },
};
const reads: string[] = [];
const state = { firstReadUnsettled: false, alwaysUnsettled: false };

vi.mock("@rms/ordering", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/ordering")>()),
  createPostgresAdditionalDiningExecutionReader: () => ({
    loadBySubmission: async (input: { observedAt: string }) => {
      reads.push(input.observedAt);
      // The round's acceptance landed after the time this read began with.
      if (state.alwaysUnsettled || (state.firstReadUnsettled && reads.length === 1))
        throw Object.assign(new Error("additional Dining batch persistence is unavailable"), {
          code: "ADDITIONAL_DINING_BATCH_STORE_UNAVAILABLE",
        });
      return execution;
    },
  }),
}));
vi.mock("./order-captured-payment-source.js", () => ({
  createOrderCapturedPaymentSource: () => ({
    resolve: async () => ({ payment: { intent: { preparation: p } } }),
  }),
}));
vi.mock("./order-paid-capacity-source.js", () => ({
  readOrderPaidCapacity: async () => ({ commitment: { state: "PaymentPending" } }),
}));
vi.mock("@rms/inventory", () => ({
  createPostgresSubmissionFinalValidationStore: () => ({
    withCurrent: async (_input: unknown, work: (tx: unknown, facts: unknown) => Promise<unknown>) =>
      work(null, {
        record: {
          orderReference: p.orderReference,
          cartReference: p.sourceCartReference,
          cartVersion: p.sourceCartVersion,
          quoteReference: p.quoteReference,
        },
      }),
  }),
}));

const { createAdditionalOrderPaidContextSource } =
  await import("./additional-order-paid-context-source.js");

function source() {
  let tick = Date.parse("2026-11-17T18:13:55.100Z");
  return createAdditionalOrderPaidContextSource({
    scope: { brandReference: p.brandReference, storeReference: p.storeReference },
    tenantReference: id(9),
    quoteVersion: 2,
    now: () => new Date((tick += 10)).toISOString(),
    authorize: async () => true,
    authorizeOrder: async () => true,
    authorizeInventory: async () => true,
  } as never);
}

describe("Additional round paid context — WP-2423 batch 28", () => {
  afterEach(() => {
    reads.length = 0;
    state.firstReadUnsettled = false;
    state.alwaysUnsettled = false;
  });

  it("reads the round once more when its acceptance landed during the first read", async () => {
    state.firstReadUnsettled = true;
    const context = await source().resolve({} as never, {});
    expect(context.execution).toBe(execution);
    expect(reads).toHaveLength(2);
    // The second read is at a later time than the first.
    expect(Date.parse(reads[1] ?? "")).toBeGreaterThan(Date.parse(reads[0] ?? ""));
  });

  it("reads it once when nothing landed meanwhile", async () => {
    await source().resolve({} as never, {});
    expect(reads).toHaveLength(1);
  });

  it("reads at most twice, and keeps what the read met for the log, never as the answer", async () => {
    state.alwaysUnsettled = true;
    const refused = await source()
      .resolve({} as never, {})
      .catch((error: unknown) => error);
    expect(reads).toHaveLength(2);
    expect(refused).toMatchObject({ code: "ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE" });
    expect((refused as Record<symbol, unknown>)[Symbol.for("bop.failure.cause")]).toMatchObject({
      code: "ADDITIONAL_DINING_BATCH_STORE_UNAVAILABLE",
    });
    expect(Object.keys(refused as object)).not.toContain("cause");
  });
});
