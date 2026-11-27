import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrdinaryRefundRequestRuntime } from "../infrastructure/ordinary-refund-request-runtime.js";
import { refundRequestId as id } from "./ordinary-refund-request.fixture.js";
const input = () => ({
  orderReference: id(1),
  requestReference: id(2),
  operationReference: id(3),
  actorReference: id(4),
  expectedClaimVersion: 0,
  reasonCode: "CUSTOMER_REQUEST",
  items: [{ orderBatchReference: id(5), orderItemReference: id(6), quantity: 1 }],
});
function setup() {
  const authorize = vi.fn(async () => false),
    query = vi.fn();
  const runtime = createPostgresOrdinaryRefundRequestRuntime({
    scope: {
      tenantReference: id(10),
      brandReference: id(11),
      storeReference: id(12),
      providerAccountReference: id(13),
      environment: "Test",
    },
    authorize,
    now: () => "2026-09-20T12:00:00.000Z",
    newAuditReference: () => id(14),
    retentionPolicyCode: "FINANCIAL_COMPLIANCE",
    retentionPolicyVersion: 1,
  });
  return {
    authorize,
    query,
    run: (value: unknown) => runtime({ query } as unknown as ConsumerTransaction, value),
  };
}
it("checks scoped current requester authority before any financial access", async () => {
  const f = setup();
  await expect(f.run(input())).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
  expect(f.authorize).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      actorReference: id(4),
      tenantReference: id(10),
      storeReference: id(12),
      observedAt: "2026-09-20T12:00:00.000Z",
    }),
  );
});
it.each([
  "amountMinor",
  "requestedAt",
  "auditReference",
  "tenantReference",
  "providerAccountReference",
])("rejects caller injection of server-owned %s", async (field) => {
  const f = setup();
  await expect(f.run({ ...input(), [field]: "injected" })).rejects.toThrow();
  expect(f.authorize).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
});
it("rejects duplicate item identities across batches before access", async () => {
  const f = setup(),
    value = input();
  value.items.push({
    ...value.items[0],
    orderBatchReference: id(7),
  } as (typeof value.items)[number]);
  await expect(f.run(value)).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
it.each([0, -1, 1.5, 1000])("rejects invalid refund quantity %s", async (quantity) => {
  const f = setup(),
    value = input();
  value.items = [{ orderBatchReference: id(5), orderItemReference: id(6), quantity }];
  await expect(f.run(value)).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
