import { beforeEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({
  status: vi.fn(),
  readiness: vi.fn(),
  proof: vi.fn(),
  recover: vi.fn(),
  counterCode: vi.fn(),
  recoverCounterCode: vi.fn(),
  codeChecks: vi.fn(),
  counterOrders: vi.fn(),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  listStoreCounterOrders: ports.counterOrders,
}));
vi.mock("./customer-order-status-read.js", () => ({
  createCustomerOrderStatusRead: () => ({ read: ports.status }),
}));
vi.mock("@rms/fulfillment", async (original) => ({
  ...(await original<typeof import("@rms/fulfillment")>()),
  createPostgresFulfillmentReadinessStore: () => ({ lockByOrder: ports.readiness }),
  createPostgresPickupProofStore: () => ({
    lockByOrder: ports.proof,
    currentCounterCode: ports.counterCode,
    codeChecks: ports.codeChecks,
  }),
}));
import {
  createCustomerPickupCodeRead,
  type CustomerPickupCodeReadOptions,
} from "./customer-pickup-code-read.js";
const scope = {
  brandReference: "0190fa47-0000-7000-8000-000000000001",
  storeReference: "0190fa47-0000-7000-8000-000000000002",
};
const input = {
  sessionCredential: "synthetic-session",
  csrfCredential: "synthetic-csrf",
  orderReference: "0190fa47-0000-7000-8000-000000000003",
};
const now = "2026-09-20T06:00:00.000Z";
// The Store accepted the order: the kitchen has its ticket (the status read's kitchen source).
const accepted = {
  kitchen: {
    batches: [
      {
        orderBatchReference: "0190fa47-0000-7000-8000-000000000005",
        status: "Ready",
        updatedAt: now,
      },
    ],
  },
};
function options() {
  return {
    status: {
      scope,
      now: () => now,
      transactions: { run: async (work: (tx: object) => unknown) => work({}) },
    },
    readiness: scope,
    proof: scope,
    credentials: { recoverOpaque: ports.recover, recoverCounterCode: ports.recoverCounterCode },
    storeDisplayName: "DEMO Store",
    pickupInstruction: "Show this proof to staff.",
  } as unknown as CustomerPickupCodeReadOptions;
}
function readinessSource(ready = true) {
  return {
    ...scope,
    fulfillmentReference: "0190fa47-0000-7000-8000-000000000004",
    orderReference: input.orderReference,
    orderBatchReference: "0190fa47-0000-7000-8000-000000000005",
    canonicalPhase: ready ? "Ready" : "Pending",
    aggregateVersion: 2n,
    lockedAt: now,
    items: [
      {
        fulfillmentItemReference: "0190fa47-0000-7000-8000-000000000006",
        orderItemReference: "0190fa47-0000-7000-8000-000000000007",
        orderedQuantity: 1,
        readyQuantity: ready ? 1 : 0,
        handedOverQuantity: 0,
        state: ready ? "Ready" : "Pending",
      },
    ],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  ports.status.mockResolvedValue({
    order: { orderType: "Pickup", orderNumber: "11", fulfillmentStatus: "Pending" },
    sources: accepted,
  });
  ports.readiness.mockResolvedValue(readinessSource());
  ports.proof.mockResolvedValue({
    capability: { generation: 1, expiresAt: "2026-09-20T07:00:00.000Z" },
  });
  ports.recover.mockReturnValue("synthetic-proof-result");
  ports.counterCode.mockResolvedValue({ derivationIndex: 0, selectorHash: "a".repeat(64) });
  ports.recoverCounterCode.mockReturnValue("048213");
  ports.codeChecks.mockResolvedValue({ rejections: 0, locked: false, counterCode: true });
  ports.counterOrders.mockResolvedValue(new Set());
});
describe("current Guest pickup proof read", () => {
  it("denies mismatched Store configuration before any query", () => {
    const config = options();
    expect(() =>
      createCustomerPickupCodeRead({
        ...config,
        proof: { ...config.proof, storeReference: scope.brandReference },
      }),
    ).toThrow("CUSTOMER_PICKUP_SCOPE_INVALID");
    expect(ports.status).not.toHaveBeenCalled();
  });
  it("does not read fulfillment history for an unauthorized Guest", async () => {
    ports.status.mockRejectedValue(new Error("denied"));
    await expect(createCustomerPickupCodeRead(options()).read(input)).rejects.toThrow("denied");
    expect(ports.readiness).not.toHaveBeenCalled();
    expect(ports.recover).not.toHaveBeenCalled();
  });
  it("does not expose a completed order proof", async () => {
    ports.status.mockResolvedValue({
      order: { orderType: "Pickup", orderNumber: "11", fulfillmentStatus: "Completed" },
    });
    await expect(createCustomerPickupCodeRead(options()).read(input)).resolves.toMatchObject({
      status: "NotReady",
    });
    expect(ports.proof).not.toHaveBeenCalled();
  });
  it("says not ready before the Store accepts, without reading fulfillment (v15: was 503)", async () => {
    // WP-2423 (v15 2026-10-17): no kitchen ticket yet. Fulfillment readiness exists only for a
    // confirmed order; asking it refused the order and the guest saw "can't be shown right now".
    ports.status.mockResolvedValue({
      order: { orderType: "Pickup", orderNumber: "11", fulfillmentStatus: "Unavailable" },
      sources: { kitchen: null },
    });
    ports.readiness.mockRejectedValue(new Error("INTERNAL_CONFIRMATION_UNAVAILABLE"));
    await expect(createCustomerPickupCodeRead(options()).read(input)).resolves.toEqual({
      schemaVersion: 1,
      status: "NotReady",
      orderReference: input.orderReference,
    });
    expect(ports.readiness).not.toHaveBeenCalled();
    expect(ports.proof).not.toHaveBeenCalled();
    expect(ports.recover).not.toHaveBeenCalled();
  });
  it("returns not ready without recovering a credential for a pending source", async () => {
    ports.readiness.mockResolvedValue(readinessSource(false));
    await expect(createCustomerPickupCodeRead(options()).read(input)).resolves.toMatchObject({
      status: "NotReady",
    });
    expect(ports.recover).not.toHaveBeenCalled();
  });
  it("rechecks Guest authorization before recovering the existing credential", async () => {
    ports.status
      .mockResolvedValueOnce({
        order: { orderType: "Pickup", orderNumber: "11", fulfillmentStatus: "Pending" },
        sources: accepted,
      })
      .mockRejectedValueOnce(new Error("revoked"));
    await expect(createCustomerPickupCodeRead(options()).read(input)).rejects.toThrow("revoked");
    expect(ports.recover).not.toHaveBeenCalled();
  });
  it("returns the existing generation only after the second authorization", async () => {
    const result = await createCustomerPickupCodeRead(options()).read(input);
    expect(result).toMatchObject({
      status: "Ready",
      generation: 1,
      orderNumber: "11",
      observedAt: now,
    });
    expect(ports.status).toHaveBeenCalledTimes(2);
    expect(ports.recover).toHaveBeenCalledTimes(1);
    // WP-2423 (DEC-PICKUP-COUNTER-CODE): the six-digit code re-derived from its saved row.
    expect(result).toMatchObject({ counterCode: "048213" });
    expect(ports.recoverCounterCode).toHaveBeenCalledWith(
      expect.objectContaining({
        counterCode: { derivationIndex: 0, selectorHash: "a".repeat(64) },
      }),
    );
  });
  it("names the Store as the order page does, from its published profile", async () => {
    // WP-2423 DEC-STORE-CUSTOMER-NAME: one name everywhere; the configured one is a fallback.
    ports.status.mockResolvedValue({
      order: { orderType: "Pickup", orderNumber: "11", fulfillmentStatus: "Pending" },
      sources: { ...accepted, storeContact: { storeDisplayName: "Maple Noodle House" } },
    });
    await expect(createCustomerPickupCodeRead(options()).read(input)).resolves.toMatchObject({
      status: "Ready",
      storeDisplayName: "Maple Noodle House",
    });
    ports.status.mockResolvedValue({
      order: { orderType: "Pickup", orderNumber: "11", fulfillmentStatus: "Pending" },
      sources: accepted,
    });
    await expect(createCustomerPickupCodeRead(options()).read(input)).resolves.toMatchObject({
      storeDisplayName: "DEMO Store",
    });
  });
  it("shows no short code for a proof issued before short codes existed", async () => {
    ports.counterCode.mockResolvedValue(null);
    const result = await createCustomerPickupCodeRead(options()).read(input);
    expect(result).toMatchObject({ status: "Ready", counterCode: null });
    expect(ports.recoverCounterCode).not.toHaveBeenCalled();
  });
  it("propagates expired credential denial instead of refreshing or issuing", async () => {
    ports.recover.mockImplementation(() => {
      throw new Error("expired");
    });
    await expect(createCustomerPickupCodeRead(options()).read(input)).rejects.toThrow("expired");
  });
  // WP-2423: a Ready order is never reported as not ready when it has no usable code.
  it("says a ready counter order is ready without issuing or reading a code", async () => {
    ports.counterOrders.mockResolvedValue(new Set([input.orderReference]));
    await expect(createCustomerPickupCodeRead(options()).read(input)).resolves.toEqual({
      schemaVersion: 1,
      status: "ReadyWithoutCode",
      orderReference: input.orderReference,
      orderNumber: "11",
      reason: "CounterOrder",
    });
    expect(ports.proof).not.toHaveBeenCalled();
    expect(ports.recover).not.toHaveBeenCalled();
    expect(ports.status).toHaveBeenCalledTimes(2);
  });
  it("says a ready order whose code is still being issued is ready", async () => {
    ports.proof.mockResolvedValue({ capability: null });
    await expect(createCustomerPickupCodeRead(options()).read(input)).resolves.toMatchObject({
      status: "ReadyWithoutCode",
      orderNumber: "11",
      reason: "CodePending",
    });
    expect(ports.recover).not.toHaveBeenCalled();
  });
  it("says a ready order is ready once its code window ended, without recovering it", async () => {
    ports.proof.mockResolvedValue({
      capability: { generation: 1, expiresAt: "2026-09-20T06:00:00.000Z" },
    });
    await expect(createCustomerPickupCodeRead(options()).read(input)).resolves.toMatchObject({
      status: "ReadyWithoutCode",
      reason: "CodeUnavailable",
    });
    expect(ports.recover).not.toHaveBeenCalled();
  });
  it("says a ready order is ready when code checks locked after wrong tries", async () => {
    ports.codeChecks.mockResolvedValue({ rejections: 5, locked: true, counterCode: true });
    await expect(createCustomerPickupCodeRead(options()).read(input)).resolves.toMatchObject({
      status: "ReadyWithoutCode",
      reason: "CodeUnavailable",
    });
    expect(ports.recover).not.toHaveBeenCalled();
  });
  it("rechecks Guest authorization before saying a code-less order is ready", async () => {
    ports.proof.mockResolvedValue({ capability: null });
    ports.status
      .mockResolvedValueOnce({
        order: { orderType: "Pickup", orderNumber: "11", fulfillmentStatus: "Pending" },
        sources: accepted,
      })
      .mockRejectedValueOnce(new Error("revoked"));
    await expect(createCustomerPickupCodeRead(options()).read(input)).rejects.toThrow("revoked");
  });
});
