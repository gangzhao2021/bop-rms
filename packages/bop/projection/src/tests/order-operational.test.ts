import { describe, expect, it } from "vitest";
import { buildOrderOperationalProjection, OperationalProjectionError } from "../index.js";
const r = (n: number) => `018f0f58-767a-7f3b-a1d0-${String(n).padStart(12, "0")}`;
const scope = { tenantReference: r(1), brandReference: r(2), storeReference: r(3) };
const order = () => ({
  ...scope,
  orderReference: r(4),
  orderNumber: "ORD-1900",
  orderType: "Pickup",
  sourceChannel: "Qr",
  phase: "Confirmed",
  submittedAt: "2026-08-12T17:00:00.000Z",
  sourceVersion: 2n,
  sourceDigest: `sha256:${"a".repeat(64)}`,
});
const build = (overrides: Partial<Parameters<typeof buildOrderOperationalProjection>[0]> = {}) =>
  buildOrderOperationalProjection({
    ...scope,
    businessDate: "2026-08-12",
    generationReference: r(5),
    sourceCheckpoint: r(6),
    asOfUtc: "2026-08-12T17:00:01.000Z",
    projectedAt: "2026-08-12T17:00:02.000Z",
    lastRebuiltAt: null,
    orders: [order()],
    collaborators: [
      {
        ...scope,
        orderReference: r(4),
        sourceDomain: "Payment",
        status: "Unknown",
        sourceReference: r(7),
        sourceVersion: 1n,
        asOfUtc: "2026-08-12T17:00:01.000Z",
      },
    ],
    ...overrides,
  });
describe("WP-1900 Order operational projection", () => {
  it("labels missing domains and retains Payment Unknown", () => {
    expect(build().rows[0]).toMatchObject({
      paymentStatus: "Unknown",
      kitchenStatus: "Unavailable",
      fulfillmentStatus: "Unavailable",
    });
  });
  it("marks projection stale beyond the 2-second target", () => {
    expect(build({ projectedAt: "2026-08-12T17:00:03.001Z" }).freshnessStatus).toBe("Stale");
  });
  it("rejects duplicate domain sources and orphan collaborators", () => {
    const collaborator = {
      ...scope,
      orderReference: r(4),
      sourceDomain: "Kitchen",
      status: "Queued",
      sourceReference: r(8),
      sourceVersion: 1n,
      asOfUtc: "2026-08-12T17:00:01.000Z",
    };
    expect(() => build({ collaborators: [collaborator, collaborator] })).toThrowError(
      new OperationalProjectionError("DUPLICATE_SOURCE"),
    );
    expect(() =>
      build({ collaborators: [{ ...collaborator, orderReference: r(9) }] }),
    ).toThrowError(new OperationalProjectionError("SOURCE_CONFLICT"));
  });
});
