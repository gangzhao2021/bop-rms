import { describe, expect, it } from "vitest";
import { createPostgresPaymentReceiptCoverageSource } from "../infrastructure/persistence/payment-receipt-coverage-source.js";
const id = (n: number) => "0190ec04-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  tenantReference: id(8),
  brandReference: id(1),
  storeReference: id(2),
  providerAccountReference: id(3),
  environment: "Test" as const,
};
const at = "2026-09-12T12:00:00.000Z";
const input = {
  orderReference: id(4),
  observedAt: at,
  freshAfter: at,
  expectedBatches: [{ orderBatchReference: id(5), orderAllocationMinor: 100n }],
};
describe("receipt coverage admission", () => {
  it("rejects unauthorized requests without querying payment facts", async () => {
    let queries = 0;
    const source = createPostgresPaymentReceiptCoverageSource({
      scope,
      authorize: async () => false,
    });
    await expect(
      source.resolve(
        {
          query: async () => {
            queries++;
            return { rows: [], rowCount: 0 };
          },
        },
        input,
      ),
    ).rejects.toMatchObject({ code: "PAYMENT_RECEIPT_COVERAGE_PERMISSION_DENIED" });
    expect(queries).toBe(0);
  });
  it("rejects duplicate batches and future freshness boundaries before SQL", async () => {
    const source = createPostgresPaymentReceiptCoverageSource({
      scope,
      authorize: async () => true,
    });
    for (const request of [
      { ...input, expectedBatches: [...input.expectedBatches, ...input.expectedBatches] },
      { ...input, freshAfter: "2026-09-13T12:00:00.000Z" },
    ]) {
      await expect(
        source.resolve(
          {
            query: async () => {
              throw new Error("unexpected SQL");
            },
          },
          request,
        ),
      ).rejects.toMatchObject({ code: "PAYMENT_RECEIPT_COVERAGE_INPUT_INVALID" });
    }
  });
  it("never calls missing intents a fully captured order", async () => {
    const source = createPostgresPaymentReceiptCoverageSource({
      scope,
      authorize: async () => true,
    });
    await expect(
      source.resolve({ query: async () => ({ rows: [], rowCount: 0 }) }, input),
    ).rejects.toMatchObject({ code: "PAYMENT_RECEIPT_COVERAGE_UNAVAILABLE" });
  });
});
