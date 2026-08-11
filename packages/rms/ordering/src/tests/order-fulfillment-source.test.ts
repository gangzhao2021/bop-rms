import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createOrderFulfillmentSourceEvidenceBinding,
  createOrderFulfillmentSourceLineBinding,
  createOrderFulfillmentSourceQueryService,
  OrderFulfillmentSourceError,
  parseConfirmedOrderFulfillmentSourceEvidence,
} from "../index.js";

const id = (value: number) => `00000000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const at = "2026-08-11T18:00:00.000Z";

function evidence(overrides: Record<string, unknown> = {}) {
  const line = {
    orderItemReference: id(10),
    ordinal: 1,
    quantity: 2,
    lineDigest: sha("placeholder"),
  };
  line.lineDigest = sha(createOrderFulfillmentSourceLineBinding(line));
  const raw = {
    evidenceReference: id(20),
    brandReference: id(1),
    storeReference: id(2),
    orderReference: id(3),
    orderBatchReference: id(4),
    confirmationReference: id(5),
    sourceEventReference: id(6),
    sourceAggregateVersion: 2n,
    sourceSnapshotDigest: sha("order"),
    orderType: "Pickup",
    capturedAt: "2026-08-11T17:59:59.000Z",
    evidenceVersion: 1,
    items: [line],
    evidenceDigest: sha("placeholder"),
    ...overrides,
  };
  raw.evidenceDigest = sha(createOrderFulfillmentSourceEvidenceBinding(raw));
  return parseConfirmedOrderFulfillmentSourceEvidence(raw);
}

const input = {
  brandReference: id(1) as never,
  storeReference: id(2) as never,
  orderReference: id(3) as never,
  orderBatchReference: id(4) as never,
  confirmationReference: id(5) as never,
  sourceEventReference: id(6) as never,
  sourceAggregateVersion: 2n,
  sourceSnapshotDigest: sha("order") as never,
  observedAt: at as never,
};

describe("WP-1600 Ordering public Fulfillment source", () => {
  it("authorizes and returns only the exact privacy-minimized source", async () => {
    const calls: unknown[] = [];
    const service = createOrderFulfillmentSourceQueryService({
      authorization: {
        authorize: async (value) => {
          calls.push(value);
          return true;
        },
      },
      source: { loadExact: async () => evidence() },
      digests: { sha256: sha },
    });
    await expect(service.resolve(input)).resolves.toMatchObject({
      orderType: "Pickup",
      items: [{ orderItemReference: id(10), quantity: 2 }],
    });
    expect(calls).toEqual([
      expect.objectContaining({
        action: "ResolveConfirmedOrderFulfillmentSource",
        purpose: "CreatePickupFulfillment",
      }),
    ]);
    expect(
      JSON.stringify(await service.resolve(input), (_, value) =>
        typeof value === "bigint" ? String(value) : value,
      ),
    ).not.toMatch(/customer|note|price|payment|provider/iu);
  });

  it("fails closed for denial, source drift and malformed/open evidence", async () => {
    const denied = createOrderFulfillmentSourceQueryService({
      authorization: { authorize: async () => false },
      source: { loadExact: async () => evidence() },
      digests: { sha256: sha },
    });
    await expect(denied.resolve(input)).rejects.toMatchObject({
      code: "ORDER_FULFILLMENT_SOURCE_PERMISSION_DENIED",
    });

    const drifted = createOrderFulfillmentSourceQueryService({
      authorization: { authorize: async () => true },
      source: { loadExact: async () => evidence({ storeReference: id(99) }) },
      digests: { sha256: sha },
    });
    await expect(drifted.resolve(input)).rejects.toMatchObject({
      code: "ORDER_FULFILLMENT_SOURCE_CONFLICT",
    });
    expect(() =>
      parseConfirmedOrderFulfillmentSourceEvidence({ ...evidence(), extra: "open" }),
    ).toThrowError(OrderFulfillmentSourceError);
  });
});
