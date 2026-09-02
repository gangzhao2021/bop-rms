import { describe, expect, it } from "vitest";
import { buildKitchenOperationalProjection, OperationalProjectionError } from "../index.js";
const r = (n: number) => `018f0f58-767a-7f3b-a1d0-${String(n).padStart(12, "0")}`;
const scope = { tenantReference: r(1), brandReference: r(2), storeReference: r(3) };
const source = () => ({
  ...scope,
  ticketReference: r(4),
  workItemReference: r(5),
  orderReference: r(6),
  orderItemReference: r(7),
  stationReference: r(8),
  status: "InProgress",
  requiredQuantity: 2,
  completedQuantity: 1,
  safetyCue: "ReviewRequired",
  exceptionReference: null,
  acceptedAt: "2026-08-12T19:00:00.000Z",
  startedAt: "2026-08-12T19:00:10.000Z",
  completedAt: null,
  orderItemReadyAt: null,
  updatedAt: "2026-08-12T19:00:20.000Z",
  sourceVersion: 3n,
  sourceDigest: `sha256:${"c".repeat(64)}`,
});
const build = (overrides: Partial<Parameters<typeof buildKitchenOperationalProjection>[0]> = {}) =>
  buildKitchenOperationalProjection({
    ...scope,
    businessDate: "2026-08-12",
    stationReference: r(8),
    generationReference: r(9),
    sourceCheckpoint: r(10),
    asOfUtc: "2026-08-12T19:00:20.000Z",
    projectedAt: "2026-08-12T19:00:21.999Z",
    lastRebuiltAt: null,
    sources: [source()],
    ...overrides,
  });
describe("WP-1902 Kitchen operational projection", () => {
  it("preserves structured safety and exact progress", () => {
    expect(build().rows[0]).toMatchObject({
      status: "InProgress",
      completedQuantity: 1,
      safetyCue: "ReviewRequired",
      orderItemReadyAt: null,
    });
  });
  it("rejects client-derived completion and ready time", () => {
    expect(() =>
      build({ sources: [{ ...source(), status: "Completed", completedQuantity: 2 }] }),
    ).toThrowError(new OperationalProjectionError("SOURCE_CONFLICT"));
    expect(() =>
      build({ sources: [{ ...source(), orderItemReadyAt: "2026-08-12T19:00:20.000Z" }] }),
    ).toThrowError(new OperationalProjectionError("SOURCE_CONFLICT"));
  });
  it("enforces station scope and 2-second freshness", () => {
    expect(() => build({ stationReference: r(11) })).toThrowError(
      new OperationalProjectionError("SCOPE_MISMATCH"),
    );
    expect(build({ projectedAt: "2026-08-12T19:00:22.001Z" }).freshnessStatus).toBe("Stale");
  });
});
