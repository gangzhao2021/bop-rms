import { beforeEach, expect, it, vi } from "vitest";
import { fixture as identityFixture } from "../test-support/dining-order-submission-fixture.js";
import {
  orderWriteFixture,
  orderCapacityLinkFixture,
} from "../../../packages/rms/ordering/src/tests/order-creation-store.fixture.js";
import { createCustomerAdditionalDiningSubmissionRuntime } from "./customer-additional-dining-submission-runtime.js";
const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  authorize: vi.fn(),
  identityStore: vi.fn(),
  diningStore: vi.fn(),
  tipStore: vi.fn(),
  tipLoad: vi.fn(),
}));
vi.mock("./customer-additional-dining-submission-store.js", () => ({
  createCustomerAdditionalDiningSubmissionStore: () => ({ append: mocks.append }),
}));
vi.mock("./customer-additional-dining-guest-authorization.js", () => ({
  createCustomerAdditionalDiningGuestAuthorization: () => mocks.authorize,
}));
vi.mock("@bop/identity", async (original) => ({
  ...(await original<typeof import("@bop/identity")>()),
  createPostgresGuestSessionEntryStore: mocks.identityStore,
}));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningGuestBindingStore: mocks.diningStore,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  createPostgresPaymentTipSelectionStore: mocks.tipStore,
}));
beforeEach(() => vi.resetAllMocks());
function setup() {
  const f = orderWriteFixture({ dineIn: true });
  const identity = identityFixture();
  const r = f.request.record;
  const snapshot = {
    ...f.scope,
    orderReference: r.order.orderReference,
    diningSessionReference: r.order.diningSessionReference,
    guestSessionReference: r.guestSessionReference,
    originalOrderCreatedAt: r.createdAt,
    expectedOrderVersion: 2,
    batchSequence: 2,
    snapshotVersion: 1,
    batch: r.order.batches[0],
    items: r.items,
  };
  const link = orderCapacityLinkFixture(f);
  const selection = {
    selectionReference: r.submissionReference,
    paymentOperationReference: link.paymentOperationReference,
    submissionReference: r.submissionReference,
    cartReference: r.order.batches[0].sourceCartReference,
    cartVersion: r.order.batches[0].sourceCartVersion,
    quoteReference: r.order.batches[0].quoteReference,
    guestSessionReference: r.guestSessionReference,
    ...f.scope,
    tip: { amountMinor: 0n, currencyCode: "CAD" },
    selectedAt: r.createdAt,
  };
  mocks.tipStore.mockReturnValue({ load: mocks.tipLoad });
  mocks.tipLoad.mockResolvedValue(selection);
  const transaction = { query: vi.fn() };
  const events: string[] = [];
  mocks.append.mockImplementation(async () => {
    events.push("append");
    return { status: "Created", snapshot };
  });
  mocks.authorize.mockImplementation(async () => {
    events.push("authorize");
    return true;
  });
  const runtime = createCustomerAdditionalDiningSubmissionRuntime({
    currentPolicies: vi.fn(),
    audit: vi.fn(),
    ...f.scope,
    transactions: {
      run: async (work) => {
        events.push("begin");
        try {
          const value = await work(transaction);
          events.push("commit");
          return value;
        } catch (error) {
          events.push("rollback");
          throw error;
        }
      },
    },
    identity: (tx) => {
      expect(tx).toBe(transaction);
      return { ...identity.options, scope: f.scope };
    },
    inventory: {
      scope: { ...f.scope, tenantReference: f.scope.brandReference },
      stockSiteReference: f.scope.storeReference,
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
    },
    diningSealAudit: vi.fn(),
    validateCurrent: vi.fn(),
    eventReference: vi.fn(),
  });
  const input = {
    sessionCredential: identity.input.sessionCredential,
    csrfCredential: identity.input.csrfCredential,
    snapshot,
    checkoutValidationEvidence: f.request.checkoutValidationEvidence,
    capacityLink: link,
    tipSelectionReference: selection.selectionReference,
  };
  const checkoutInput = {
    sessionCredential: input.sessionCredential,
    csrfCredential: input.csrfCredential,
    capacityLink: link,
    tipSelectionReference: selection.selectionReference,
    checkout: {
      snapshot: f.snapshotInput,
      quoteVersion: 1 as const,
      submissionReference: r.submissionReference,
      submittedAt: r.createdAt,
      parent: {
        ...f.scope,
        orderReference: r.order.orderReference,
        diningSessionReference: r.order.diningSessionReference,
        originalOrderCreatedAt: r.createdAt,
        expectedOrderVersion: 2,
        batchSequence: 2,
      },
    },
  };
  return { runtime, input, checkoutInput, transaction, events, selection };
}
it("uses one transaction for stores and append and returns after commit", async () => {
  const f = setup();
  expect((await f.runtime.submit(f.input)).status).toBe("Created");
  expect(f.events).toEqual(["begin", "authorize", "append", "authorize", "commit"]);
  expect(mocks.append.mock.calls[0]?.[0].transaction).toBe(f.transaction);
  for (const store of [mocks.identityStore, mocks.diningStore, mocks.tipStore])
    expect(await store.mock.calls[0]?.[0].run(async (tx: unknown) => tx)).toBe(f.transaction);
});
it("rolls back when final authorization is revoked", async () => {
  const f = setup();
  mocks.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.runtime.submit(f.input)).rejects.toThrow();
  expect(f.events).toEqual(["begin", "append", "rollback"]);
});
it("propagates append failure without committing", async () => {
  const f = setup();
  mocks.append.mockRejectedValue(new Error("synthetic append"));
  await expect(f.runtime.submit(f.input)).rejects.toThrow();
  expect(f.events).toEqual(["begin", "authorize", "rollback"]);
  expect(mocks.authorize).toHaveBeenCalledOnce();
});
it("rejects unknown request fields before starting a transaction", async () => {
  const f = setup();
  await expect(f.runtime.submit({ ...f.input, bypass: true })).rejects.toThrow();
  expect(f.events).toEqual([]);
});

it.each(["missing", "foreign", "late"])(
  "rejects %s saved tip before Batch writes",
  async (mode) => {
    const f = setup();
    mocks.tipLoad.mockResolvedValue(
      mode === "missing"
        ? null
        : {
            ...f.selection,
            ...(mode === "foreign"
              ? { quoteReference: f.selection.selectionReference }
              : { selectedAt: new Date(Date.parse(f.selection.selectedAt) + 1).toISOString() }),
          },
    );
    await expect(f.runtime.submit(f.input)).rejects.toThrow();
    expect(mocks.append).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe("rollback");
  },
);
it("does not read saved tip before current authorization", async () => {
  const f = setup();
  mocks.authorize.mockResolvedValue(false);
  await expect(f.runtime.submit(f.input)).rejects.toThrow();
  expect(mocks.tipLoad).not.toHaveBeenCalled();
  expect(mocks.append).not.toHaveBeenCalled();
});

it("constructs checkout Batch facts before entering the same authorized submit transaction", async () => {
  const f = setup();
  await f.runtime.submitCheckout(f.checkoutInput);
  expect(mocks.append.mock.calls[0]?.[0]).toMatchObject({
    snapshot: f.input.snapshot,
    checkoutValidationEvidence: f.input.checkoutValidationEvidence,
    transaction: f.transaction,
  });
  expect(f.events).toEqual(["begin", "authorize", "append", "authorize", "commit"]);
});
it("does not construct-and-submit an expired checkout", async () => {
  const f = setup();
  await expect(
    f.runtime.submitCheckout({
      ...f.checkoutInput,
      checkout: {
        ...f.checkoutInput.checkout,
        submittedAt: f.checkoutInput.checkout.snapshot.checkoutValidationEvidence.validUntil,
      },
    }),
  ).rejects.toThrow();
  expect(f.events).toEqual([]);
  expect(mocks.append).not.toHaveBeenCalled();
});
it("constructed checkout still requires a persisted matching tip", async () => {
  const f = setup();
  mocks.tipLoad.mockResolvedValue(null);
  await expect(f.runtime.submitCheckout(f.checkoutInput)).rejects.toThrow();
  expect(mocks.append).not.toHaveBeenCalled();
  expect(f.events.at(-1)).toBe("rollback");
});
