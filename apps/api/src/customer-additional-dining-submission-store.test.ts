import { beforeEach, expect, it, vi } from "vitest";
import type { createPostgresAdditionalDiningBatchStore } from "@rms/ordering";
import type { CustomerSubmissionInventoryFinalizerOptions } from "./customer-submission-inventory-finalizer.js";
import { createCustomerAdditionalDiningSubmissionStore } from "./customer-additional-dining-submission-store.js";
import {
  orderWriteFixture,
  orderCapacityLinkFixture,
} from "../../../packages/rms/ordering/src/tests/order-creation-store.fixture.js";
import { parseAdditionalDiningBatchSnapshot } from "@rms/ordering";
const mocks = vi.hoisted(() => ({
  owner: vi.fn(),
  inventory: vi.fn(),
  dining: vi.fn(),
  seal: vi.fn(),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresAdditionalDiningBatchStore: mocks.owner,
}));
vi.mock("./customer-submission-inventory-finalizer.js", () => ({
  createCustomerAdditionalDiningInventoryFinalizer: () => ({ finalize: mocks.inventory }),
}));
vi.mock("./customer-additional-dining-current-gate.js", () => ({
  createCustomerAdditionalDiningCurrentGate: () => mocks.dining,
}));
vi.mock("./customer-additional-dining-commitment-seal.js", () => ({
  createCustomerAdditionalDiningCommitmentSeal: () => mocks.seal,
}));
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const f = orderWriteFixture({ dineIn: true });
  const record = f.request.record;
  const scope = { ...f.scope, tenantReference: f.scope.brandReference };
  const calls: string[] = [];
  const options = {
    ...f.scope,
    currentPolicies: vi.fn(),
    audit: vi.fn(),
    authorize: vi.fn().mockResolvedValue(true),
    diningSealAudit: vi.fn(),
    inventory: {
      scope,
      stockSiteReference: scope.storeReference,
      workflow: {
        purposeCode: "Synthetic",
        applicabilityCode: "DineIn",
        currentState: "CartReady",
        action: "SubmitOrder",
        reserveCommandCode: "ReserveInventory",
        deferredActionCode: null,
        gates: {
          authorizeResource: vi.fn(),
          authorizeAction: vi.fn(),
          authorizeOverride: vi.fn(),
          evaluateRule: vi.fn(),
        },
      },
      authorize: vi.fn(),
      resolveExpiryCutoff: vi.fn(),
      generateReference: vi.fn(),
      audit: {
        reasonCode: "SYNTHETIC_TEST",
        sourceChannel: "CUSTOMER_PWA",
        retentionPolicyCode: "AUDIT_STANDARD",
        retentionPolicyVersion: 1,
      },
    } satisfies CustomerSubmissionInventoryFinalizerOptions,
    validateCurrent: vi.fn(async () => {
      calls.push("current");
    }),
    eventReference: vi.fn(),
  };
  mocks.seal.mockImplementation(async () => {
    calls.push("seal");
  });
  mocks.dining.mockImplementation(async () => {
    calls.push("dining");
  });
  mocks.inventory.mockImplementation(async () => {
    calls.push("inventory");
  });
  createCustomerAdditionalDiningSubmissionStore(options);
  const owner = mocks.owner.mock.calls[0]?.[0] as Parameters<
    typeof createPostgresAdditionalDiningBatchStore
  >[0];
  const transaction = { query: vi.fn() };
  const snapshot = parseAdditionalDiningBatchSnapshot({
    ...f.scope,
    orderReference: record.order.orderReference,
    diningSessionReference: record.order.diningSessionReference,
    guestSessionReference: record.guestSessionReference,
    originalOrderCreatedAt: record.createdAt,
    expectedOrderVersion: 2,
    batchSequence: 2,
    snapshotVersion: 1,
    batch: record.order.batches[0],
    items: record.items,
  });
  const link = orderCapacityLinkFixture(f);
  const context = Object.freeze({
    cart: f.cart,
    checkoutValidationEvidence: f.request.checkoutValidationEvidence,
    observedAt: record.createdAt,
  });
  return { options, owner, transaction, snapshot, link, context, calls };
}
it("wires current gates, actual inventory factory and effects to the same owner transaction", async () => {
  const f = fixture();
  await f.owner.finalize(f.transaction, f.snapshot, f.link, f.context);
  expect(f.calls).toEqual(["dining", "current", "inventory", "seal"]);
  expect(mocks.inventory).toHaveBeenCalledWith({
    transaction: f.transaction,
    snapshot: f.snapshot,
    ...f.context,
  });
  expect(f.owner.eventReference).toBe(f.options.eventReference);
  expect(f.owner.authorize).toBe(f.options.authorize);
});
it("stops before inventory and effects when current gates fail", async () => {
  const f = fixture();
  f.options.validateCurrent.mockRejectedValue(new Error("synthetic gate"));
  await expect(f.owner.finalize(f.transaction, f.snapshot, f.link, f.context)).rejects.toThrow();
  expect(mocks.inventory).not.toHaveBeenCalled();
  expect(mocks.seal).not.toHaveBeenCalled();
});
it("propagates inventory failure to owner savepoint without emitting effects", async () => {
  const f = fixture();
  mocks.inventory.mockRejectedValue(new Error("synthetic inventory"));
  await expect(f.owner.finalize(f.transaction, f.snapshot, f.link, f.context)).rejects.toThrow();
  expect(mocks.seal).not.toHaveBeenCalled();
});
it("rejects mismatched inventory scope before creating another owner store", () => {
  const f = fixture();
  mocks.owner.mockClear();
  expect(() =>
    createCustomerAdditionalDiningSubmissionStore({
      ...f.options,
      inventory: {
        ...f.options.inventory,
        scope: {
          ...f.options.inventory.scope,
          storeReference: "0190ed31-0000-7000-8000-000000000099",
        },
      },
    }),
  ).toThrow();
  expect(mocks.owner).not.toHaveBeenCalled();
});

it("stops all later work when locked Dining facts reject", async () => {
  const f = fixture();
  mocks.dining.mockRejectedValue(new Error("synthetic Dining failure"));
  await expect(f.owner.finalize(f.transaction, f.snapshot, f.link, f.context)).rejects.toThrow();
  expect(f.options.validateCurrent).not.toHaveBeenCalled();
  expect(mocks.inventory).not.toHaveBeenCalled();
  expect(mocks.seal).not.toHaveBeenCalled();
});

it("propagates commitment sealing failure to the owner transaction", async () => {
  const f = fixture();
  mocks.seal.mockRejectedValue(new Error("synthetic seal failure"));
  await expect(f.owner.finalize(f.transaction, f.snapshot, f.link, f.context)).rejects.toThrow();
  expect(mocks.seal).toHaveBeenCalledWith(f.transaction, f.snapshot, f.link, f.context);
});
