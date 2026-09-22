import { beforeEach, describe, expect, it, vi } from "vitest";
const ports = vi.hoisted(() => ({
  status: vi.fn(),
  readiness: vi.fn(),
  proof: vi.fn(),
  recover: vi.fn(),
}));
vi.mock("./customer-order-status-read.js", () => ({
  createCustomerOrderStatusRead: () => ({ read: ports.status }),
}));
vi.mock("@rms/fulfillment", async (original) => ({
  ...(await original<typeof import("@rms/fulfillment")>()),
  createPostgresFulfillmentReadinessStore: () => ({ lockByOrder: ports.readiness }),
  createPostgresPickupProofStore: () => ({ lockByOrder: ports.proof }),
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
function options() {
  return {
    status: {
      scope,
      now: () => now,
      transactions: { run: async (work: (tx: object) => unknown) => work({}) },
    },
    readiness: scope,
    proof: scope,
    credentials: { recoverOpaque: ports.recover },
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
  });
  ports.readiness.mockResolvedValue(readinessSource());
  ports.proof.mockResolvedValue({
    capability: { generation: 1, expiresAt: "2026-09-20T07:00:00.000Z" },
  });
  ports.recover.mockReturnValue("synthetic-proof-result");
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
  });
  it("propagates expired credential denial instead of refreshing or issuing", async () => {
    ports.recover.mockImplementation(() => {
      throw new Error("expired");
    });
    await expect(createCustomerPickupCodeRead(options()).read(input)).rejects.toThrow("expired");
  });
});
