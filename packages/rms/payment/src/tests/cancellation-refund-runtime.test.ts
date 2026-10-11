import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresCancellationRefundRuntime } from "../infrastructure/cancellation-refund-runtime.js";
import { refundRequestId as id } from "./ordinary-refund-request.fixture.js";

const options = () => ({
  scope: {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    providerAccountReference: id(4),
    environment: "Test" as const,
  },
  authorize: vi.fn(async () => true),
  cancellationAuthority: vi.fn(async () => true),
  businessDate: async () => "2026-09-13",
  now: () => "2026-09-13T10:00:00.000Z",
  retentionPolicyCode: "FINANCIAL_COMPLIANCE",
  retentionPolicyVersion: 1,
});
const preview = () => ({
  orderReference: id(10),
  orderBatchReference: id(11),
  orderItemReferences: [id(12)],
  actorReference: id(13),
  reasonCode: "CUSTOMER_REQUEST",
});
const record = () => ({
  ...preview(),
  requestReference: id(20),
  requestOperationReference: id(21),
  refundOperationReference: id(22),
  requestAuditReference: id(23),
  operationAuditReference: id(24),
  cancellationReference: id(25),
  cancellationDigest: "sha256:" + "c".repeat(64),
});

it("requires the cancellation authority port at composition", () => {
  const rest: Record<string, unknown> = { ...options() };
  delete rest.cancellationAuthority;
  expect(() =>
    createPostgresCancellationRefundRuntime(rest as unknown as ReturnType<typeof options>),
  ).toThrow("CANCELLATION_REFUND_UNAVAILABLE");
});

it.each([
  ["duplicate lines", { orderItemReferences: [id(12), id(12)] }],
  ["no lines", { orderItemReferences: [] }],
  ["bad reason", { reasonCode: "customer request" }],
  ["injected amount", { amountMinor: 1n }],
])("rejects %s before any database access", async (_name, change) => {
  const o = options();
  const runtime = createPostgresCancellationRefundRuntime(o);
  const tx = { query: vi.fn() } as unknown as ConsumerTransaction;
  await expect(runtime.preview(tx, { ...preview(), ...change } as never)).rejects.toThrow(
    "CANCELLATION_REFUND_INPUT_INVALID",
  );
  await expect(runtime.record(tx, { ...record(), ...change } as never)).rejects.toThrow(
    "CANCELLATION_REFUND_INPUT_INVALID",
  );
  expect(tx.query).not.toHaveBeenCalled();
});

it("rejects a malformed cancellation digest before any database access", async () => {
  const runtime = createPostgresCancellationRefundRuntime(options());
  const tx = { query: vi.fn() } as unknown as ConsumerTransaction;
  await expect(
    runtime.record(tx, { ...record(), cancellationDigest: "sha256:abc" }),
  ).rejects.toThrow("CANCELLATION_REFUND_INPUT_INVALID");
  expect(tx.query).not.toHaveBeenCalled();
});

it("checks current caller authority before reading financial history", async () => {
  const o = options();
  o.authorize.mockResolvedValue(false);
  const runtime = createPostgresCancellationRefundRuntime(o);
  const tx = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as ConsumerTransaction;
  await expect(runtime.record(tx, record())).rejects.toThrow();
  expect(tx.query).not.toHaveBeenCalled();
  expect(o.cancellationAuthority).not.toHaveBeenCalled();
});
