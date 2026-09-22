import { beforeEach, expect, it, vi } from "vitest";
import {
  parseInventoryReservationSet,
  type InventoryItemTransaction,
  type StockReservationSetWrite,
} from "@rms/inventory";
import { orderWriteFixture } from "../../../packages/rms/ordering/src/tests/order-creation-store.fixture.js";
import {
  createCustomerSubmissionInventoryFinalizer,
  createCustomerAdditionalDiningInventoryFinalizer,
  type CustomerSubmissionInventoryFinalizerOptions,
} from "./customer-submission-inventory-finalizer.js";

const mocks = vi.hoisted(() => ({
  current: vi.fn(),
  evaluate: vi.fn(),
  recipe: vi.fn(),
  plan: vi.fn(),
  reserve: vi.fn(),
  commit: vi.fn(),
  finalSource: vi.fn(),
  runners: [] as { run: (work: (tx: unknown) => Promise<unknown>) => Promise<unknown> }[],
}));
vi.mock("@bop/workflow", async (original) => ({
  ...(await original<typeof import("@bop/workflow")>()),
  createPostgresWorkflowDefinitionStore: (runner: (typeof mocks.runners)[number]) => {
    mocks.runners.push(runner);
    return { resolveCurrent: mocks.current, evaluatePublishedAction: mocks.evaluate };
  },
}));
vi.mock("@rms/inventory", async (original) => ({
  ...(await original<typeof import("@rms/inventory")>()),
  createPostgresSubmissionStockPlanSource: (runner: (typeof mocks.runners)[number]) => {
    mocks.runners.push(runner);
    return { resolve: mocks.plan };
  },
  createPostgresSubmissionReservationStore: (runner: (typeof mocks.runners)[number]) => {
    mocks.runners.push(runner);
    return { commit: mocks.reserve };
  },
  createPostgresSubmissionFinalValidationStore: (runner: (typeof mocks.runners)[number]) => {
    mocks.runners.push(runner);
    return { commit: mocks.commit };
  },
}));
vi.mock("./customer-submission-inventory-source.js", async (original) => ({
  ...(await original<typeof import("./customer-submission-inventory-source.js")>()),
  createCustomerSubmissionInventorySource: () => ({ resolve: mocks.recipe }),
}));
vi.mock("./customer-submission-inventory-workflow-source.js", () => ({
  createCustomerSubmissionFinalInventorySource: mocks.finalSource,
}));
const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
beforeEach(() => {
  vi.resetAllMocks();
  mocks.runners.length = 0;
});
function fixture(dineIn = false) {
  const f = orderWriteFixture({ at: "2026-09-11T10:00:00.000Z", dineIn });
  const tx: InventoryItemTransaction = { query: vi.fn() };
  let serial = 100;
  const options: CustomerSubmissionInventoryFinalizerOptions = {
    scope: { tenantReference: id(1), ...f.scope },
    stockSiteReference: id(2),
    workflow: {
      purposeCode: "Synthetic",
      applicabilityCode: dineIn ? "DineIn" : "Pickup",
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
    authorize: vi.fn().mockResolvedValue(true),
    resolveExpiryCutoff: vi.fn(),
    generateReference: () => id(serial++),
    audit: {
      reasonCode: "AUTHORIZED_ORDER_CREATE",
      sourceChannel: "CUSTOMER_PWA",
      retentionPolicyCode: "AUDIT_STANDARD",
      retentionPolicyVersion: 1,
    },
  };
  const definition = { workflowReference: id(3), versionReference: id(4), versionNumber: 1 };
  mocks.current.mockResolvedValue({ definition });
  mocks.evaluate.mockResolvedValue({
    definition,
    transition: {
      transitionReference: id(5),
      effects: [{ ownerModule: "inventory", commandCode: "ReserveInventory" }],
    },
  });
  const unit = {
    unitCode: "KG",
    dimension: "Mass",
    displayPrecision: 2,
    ledgerPrecision: 6,
    roundingMode: "HalfEven",
  };
  mocks.recipe.mockResolvedValue({
    sourceDigest: "sha256:" + "a".repeat(64),
    contributions: [
      {
        itemReference: id(6),
        configurationOperationReference: id(7),
        unitDimension: "Mass",
        quantityNumerator: "300000",
        quantityDenominator: "1",
      },
    ],
  });
  mocks.plan.mockResolvedValue({
    requirements: [
      {
        itemReference: id(6),
        currentItemVersion: 2,
        sources: [{ sourceVersionReference: id(7) }],
        unit,
        quantity: "0.3",
        trackingPolicy: { stockTrackingEnabled: true },
      },
    ],
    allocations: [
      {
        accountReference: id(8),
        locationReference: id(9),
        expectedLedgerVersion: 2,
        quantity: "0.3",
        itemReference: id(6),
        unit,
        stockSiteReference: id(2),
        lotReference: null,
      },
    ],
  });
  mocks.reserve.mockImplementation(async (write: StockReservationSetWrite) => {
    const audit = write.audit as { actor: { reference: string }; auditId: string };
    return {
      set: parseInventoryReservationSet({
        schemaVersion: 1,
        setReference: write.setReference,
        operationReference: write.operationReference,
        workflowReference: write.workflowReference,
        workflowVersion: write.workflowVersion,
        actorReference: audit.actor.reference,
        auditReference: audit.auditId,
        requestDigest: "sha256:" + "b".repeat(64),
        entries: write.writes.map((w) => ({
          accountReference: w.accountReference,
          operationReference: w.operationReference,
          movementReference: w.movementReference,
          auditReference: (w.audit as { auditId: string }).auditId,
          reservation: w.reservation,
        })),
      }),
    };
  });
  const input = {
    transaction: tx,
    cart: f.cart,
    record: f.request.record,
    checkoutValidationEvidence: f.request.checkoutValidationEvidence,
    observedAt: f.request.record.createdAt,
  };
  return { options, input, tx };
}
it.each([false, true])(
  "constructs bound reservation and final records for dineIn=%s on the supplied transaction",
  async (dineIn) => {
    const f = fixture(dineIn);
    await createCustomerSubmissionInventoryFinalizer(f.options).finalize(f.input);
    expect(mocks.reserve).toHaveBeenCalledTimes(1);
    expect(mocks.commit).toHaveBeenCalledTimes(1);
    const record = mocks.commit.mock.calls.at(0)?.[0].record;
    expect(record).toMatchObject({
      orderReference: f.input.record.order.orderReference,
      cartReference: f.input.cart.cartReference,
      submissionReference: f.input.record.submissionReference,
      items: [{ quantity: "0.3", disposition: "Reserved" }],
    });
    expect(record.reservationSet.entries[0].reservation.binding.demandDigest).toBe(
      record.demandDigest,
    );
    for (const runner of mocks.runners) expect(await runner.run(async (tx) => tx)).toBe(f.tx);
    expect(f.tx.query).not.toHaveBeenCalled();
  },
);
it("stops before owner access when current authorization fails", async () => {
  const f = fixture();
  vi.mocked(f.options.authorize).mockResolvedValue(false);
  await expect(
    createCustomerSubmissionInventoryFinalizer(f.options).finalize(f.input),
  ).rejects.toMatchObject({ code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE" });
  expect(mocks.current).not.toHaveBeenCalled();
  expect(mocks.reserve).not.toHaveBeenCalled();
  expect(mocks.commit).not.toHaveBeenCalled();
});
it("propagates reservation failure and never persists a final result", async () => {
  const f = fixture();
  mocks.reserve.mockRejectedValue(new Error("synthetic persistence failure"));
  await expect(
    createCustomerSubmissionInventoryFinalizer(f.options).finalize(f.input),
  ).rejects.toMatchObject({ code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE" });
  expect(mocks.commit).not.toHaveBeenCalled();
});
it("propagates final persistence failure to the outer transaction", async () => {
  const f = fixture();
  mocks.commit.mockRejectedValue(new Error("synthetic final write failure"));
  await expect(
    createCustomerSubmissionInventoryFinalizer(f.options).finalize(f.input),
  ).rejects.toMatchObject({ code: "CUSTOMER_INVENTORY_SOURCE_UNAVAILABLE" });
  expect(mocks.reserve).toHaveBeenCalledTimes(1);
});
it("retains captured authorization when the caller changes the options container", async () => {
  const f = fixture();
  const authorize = f.options.authorize;
  const finalizer = createCustomerSubmissionInventoryFinalizer(f.options);
  Object.assign(f.options, { authorize: vi.fn().mockResolvedValue(false) });
  await finalizer.finalize(f.input);
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(f.options.authorize).not.toHaveBeenCalled();
});

function additionalInput(f: ReturnType<typeof fixture>) {
  const record = f.input.record;
  return {
    transaction: f.tx,
    cart: f.input.cart,
    checkoutValidationEvidence: f.input.checkoutValidationEvidence,
    observedAt: f.input.observedAt,
    snapshot: {
      orderReference: record.order.orderReference,
      brandReference: record.order.brandReference,
      storeReference: record.order.storeReference,
      diningSessionReference: record.order.diningSessionReference,
      guestSessionReference: record.guestSessionReference,
      originalOrderCreatedAt: "2026-09-11T09:59:00.000Z",
      expectedOrderVersion: 2,
      batchSequence: 2,
      snapshotVersion: 1,
      batch: record.order.batches[0],
      items: record.items,
    },
  };
}
it("finalizes additional Batch inventory through the existing owner pipeline on the same transaction", async () => {
  const f = fixture(true);
  await createCustomerAdditionalDiningInventoryFinalizer(f.options).finalize(additionalInput(f));
  expect(mocks.reserve).toHaveBeenCalledTimes(1);
  expect(mocks.commit).toHaveBeenCalledTimes(1);
  expect(mocks.commit.mock.calls[0]?.[0].record).toMatchObject({
    orderReference: f.input.record.order.orderReference,
    submissionReference: f.input.record.submissionReference,
    cartReference: f.input.cart.cartReference,
    items: [{ quantity: "0.3", disposition: "Reserved" }],
  });
  for (const runner of mocks.runners) expect(await runner.run(async (tx) => tx)).toBe(f.tx);
});
it("rejects additional Batch Cart mismatch before owner work", async () => {
  const f = fixture(true);
  const input = additionalInput(f);
  input.snapshot.batch = {
    ...input.snapshot.batch,
    sourceCartVersion: input.snapshot.batch.sourceCartVersion + 1,
  };
  await expect(
    createCustomerAdditionalDiningInventoryFinalizer(f.options).finalize(input),
  ).rejects.toThrow();
  expect(mocks.current).not.toHaveBeenCalled();
  expect(mocks.reserve).not.toHaveBeenCalled();
});
it("preserves current authorization denial for additional inventory", async () => {
  const f = fixture(true);
  vi.mocked(f.options.authorize).mockResolvedValue(false);
  await expect(
    createCustomerAdditionalDiningInventoryFinalizer(f.options).finalize(additionalInput(f)),
  ).rejects.toThrow();
  expect(mocks.reserve).not.toHaveBeenCalled();
  expect(mocks.commit).not.toHaveBeenCalled();
});
