import { describe, expect, it } from "vitest";
import { buildFulfillmentOperationalProjection, OperationalProjectionError } from "../index.js";
const r = (n: number) => `018f0f58-767a-7f3b-a1d0-${String(n).padStart(12, "0")}`;
const scope = { tenantReference: r(1), brandReference: r(2), storeReference: r(3) };
const source = () => ({
  ...scope,
  fulfillmentReference: r(4),
  orderReference: r(5),
  fulfillmentType: "Pickup",
  phase: "Ready",
  orderedQuantity: 2,
  readyQuantity: 2,
  handedOverQuantity: 0,
  packageCount: 1,
  proofReadiness: "Ready",
  stagingLocationLabel: "Shelf A",
  exceptionReference: null,
  readyAt: "2026-08-12T20:00:00.000Z",
  completedAt: null,
  updatedAt: "2026-08-12T20:00:01.000Z",
  sourceVersion: 2n,
  sourceDigest: `sha256:${"d".repeat(64)}`,
});
const build = (
  overrides: Partial<Parameters<typeof buildFulfillmentOperationalProjection>[0]> = {},
) =>
  buildFulfillmentOperationalProjection({
    ...scope,
    businessDate: "2026-08-12",
    generationReference: r(6),
    sourceCheckpoint: r(7),
    asOfUtc: "2026-08-12T20:00:01.000Z",
    projectedAt: "2026-08-12T20:00:02.999Z",
    lastRebuiltAt: null,
    sources: [source()],
    ...overrides,
  });
describe("WP-1903 Fulfillment operational projection", () => {
  it("exposes proof readiness without secret material", () => {
    expect(build().rows[0]).toMatchObject({
      phase: "Ready",
      proofReadiness: "Ready",
      stagingLocationLabel: "Shelf A",
      handedOverQuantity: 0,
    });
    expect(Object.keys(build().rows[0] ?? {})).not.toContain("proof");
  });
  it("rejects inferred Ready and Completed states", () => {
    expect(() => build({ sources: [{ ...source(), readyQuantity: 1 }] })).toThrowError(
      new OperationalProjectionError("SOURCE_CONFLICT"),
    );
    expect(() =>
      build({ sources: [{ ...source(), phase: "Completed", handedOverQuantity: 2 }] }),
    ).toThrowError(new OperationalProjectionError("SOURCE_CONFLICT"));
  });
  it("requires proof-compatible phase and marks stale after two seconds", () => {
    expect(() =>
      build({
        sources: [
          {
            ...source(),
            phase: "Pending",
            readyQuantity: 0,
            readyAt: null,
            proofReadiness: "Validated",
          },
        ],
      }),
    ).toThrowError(new OperationalProjectionError("SOURCE_CONFLICT"));
    expect(build({ projectedAt: "2026-08-12T20:00:03.001Z" }).freshnessStatus).toBe("Stale");
  });
});
