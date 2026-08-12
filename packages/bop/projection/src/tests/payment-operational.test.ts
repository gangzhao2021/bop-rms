import { describe, expect, it } from "vitest";
import { buildPaymentOperationalProjection, OperationalProjectionError } from "../index.js";
const r = (n: number) => `018f0f58-767a-7f3b-a1d0-${String(n).padStart(12, "0")}`;
const scope = { tenantReference: r(1), brandReference: r(2), storeReference: r(3) };
const source = () => ({
  ...scope,
  paymentReference: r(4),
  attemptReference: r(5),
  orderReference: r(6),
  methodFamily: "OnlineCard",
  state: "Captured",
  currencyCode: "CAD",
  authorizedAmountMinor: "5100",
  capturedAmountMinor: "5100",
  refundedAmountMinor: "0",
  providerState: "Unknown",
  reconciliationStatus: "Pending",
  settlementReference: null,
  exceptionReference: null,
  lastCheckedAt: null,
  updatedAt: "2026-08-12T18:00:00.000Z",
  sourceVersion: 3n,
  sourceDigest: `sha256:${"b".repeat(64)}`,
});
const build = (overrides: Partial<Parameters<typeof buildPaymentOperationalProjection>[0]> = {}) =>
  buildPaymentOperationalProjection({
    ...scope,
    businessDate: "2026-08-12",
    generationReference: r(7),
    sourceCheckpoint: r(8),
    asOfUtc: "2026-08-12T18:00:00.000Z",
    projectedAt: "2026-08-12T18:00:04.999Z",
    lastRebuiltAt: null,
    sources: [source()],
    ...overrides,
  });
describe("WP-1901 Payment operational projection", () => {
  it("retains Provider Unknown and exact minor units", () => {
    expect(build().rows[0]).toMatchObject({
      authorizedAmountMinor: "5100",
      capturedAmountMinor: "5100",
      providerState: "Unknown",
    });
  });
  it("rejects impossible amount order and invented reconciliation", () => {
    expect(() => build({ sources: [{ ...source(), refundedAmountMinor: "5101" }] })).toThrowError(
      new OperationalProjectionError("SOURCE_CONFLICT"),
    );
    expect(() =>
      build({ sources: [{ ...source(), reconciliationStatus: "Difference" }] }),
    ).toThrowError(new OperationalProjectionError("SOURCE_CONFLICT"));
  });
  it("marks output stale beyond five seconds", () => {
    expect(build({ projectedAt: "2026-08-12T18:00:05.001Z" }).freshnessStatus).toBe("Stale");
  });
});
