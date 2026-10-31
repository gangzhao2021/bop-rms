import { expect, it, vi } from "vitest";
import { createPaymentIntentCreationService, type PaymentIntentClaimAdmission } from "@rms/payment";
import {
  harness,
  command,
  at,
  refs,
  id,
} from "../../../packages/rms/payment/src/tests/payment-intent-creation.fixture.js";
import { createCustomerAdditionalDiningPaymentStore } from "./customer-additional-dining-payment-store.js";
const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  ordering: vi.fn(),
  dining: vi.fn(),
  inventory: vi.fn(),
  inventoryFactory: vi.fn(),
  action: vi.fn(),
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  createPostgresAdmittedPaymentIntentCreationStore: mocks.store,
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresAdditionalDiningBatchHistoryReader: () => ({
    withCurrentSubmission: mocks.ordering,
  }),
}));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningCheckoutCommitmentStore: () => ({ withPaymentPending: mocks.dining }),
}));
vi.mock("./customer-inventory-payment-admission.js", () => ({
  createCustomerInventoryPaymentClaimAdmission: mocks.inventoryFactory,
}));
vi.mock("./customer-payment-workflow-action.js", () => ({
  createCustomerIntactReservationPaymentAction: mocks.action,
}));
it.each(["allow", "dining-deny", "inventory-deny"])(
  "installs ordered owner admission in Payment store: %s",
  async (mode) => {
    vi.resetAllMocks();
    const evaluate = vi.fn(async () => true);
    mocks.action.mockReturnValue(evaluate);
    mocks.inventoryFactory.mockReturnValue({ admit: mocks.inventory });
    const payment = (await createPaymentIntentCreationService(harness().ports).create(command()))
      .record;
    const p = payment.intent.preparation,
      steps: string[] = [];
    const tx = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    mocks.ordering.mockImplementation(
      async (_ref: string, _at: string, action: (...args: unknown[]) => Promise<unknown>) => {
        steps.push("Ordering");
        return action(
          tx,
          {
            snapshotVersion: 1,
            orderReference: p.orderReference,
            guestSessionReference: p.guestSessionReference,
            batch: {
              orderBatchReference: p.orderBatchReference,
              submissionReference: p.submissionReference,
              sourceCartReference: p.sourceCartReference,
              sourceCartVersion: p.sourceCartVersion,
              quoteReference: p.quoteReference,
              submittedAt: p.committedAt,
            },
          },
          {
            paymentOperationReference: payment.intent.paymentOperationReference,
            commitmentReference: p.capacityAllocationReference,
          },
        );
      },
    );
    mocks.dining.mockImplementation(
      async (_ref: string, action: (...args: unknown[]) => Promise<unknown>) => {
        steps.push("Dining");
        if (mode === "dining-deny") return null;
        return action(tx, {
          guestSessionReference: p.guestSessionReference,
          submissionReference: p.submissionReference,
          cartReference: p.sourceCartReference,
          cartVersion: p.sourceCartVersion,
          quoteReference: p.quoteReference,
          orderReference: p.orderReference,
          orderBatchReference: p.orderBatchReference,
          paymentOperationReference: payment.intent.paymentOperationReference,
          paymentRequestedAt: p.committedAt,
          capacityExpiresAt: p.capacityExpiresAt,
        });
      },
    );
    mocks.inventory.mockImplementation(async (transaction) => {
      expect(transaction).toBe(tx);
      steps.push("Inventory");
      return mode !== "inventory-deny";
    });
    const transactions = { run: vi.fn() };
    createCustomerAdditionalDiningPaymentStore({
      transactions,
      scope: { tenantReference: id(40), brandReference: refs.brand, storeReference: refs.store },
      quoteVersion: 1,
      clock: { now: () => at, generateObservationReference: () => id(41) },
      authorizeHistory: async () => true,
      inventory: {
        authorize: async () => true,
        authorizeOverride: async () => false,
        workflow: {
          purposeCode: "Synthetic",
          action: "CreatePaymentIntent",
          permissionCode: "synthetic.payment.create",
          paymentCommandCode: "CreatePaymentIntent",
          intactReservationRuleReference: id(42),
        },
      },
    });
    expect(mocks.store.mock.calls[0]?.[0]).toBe(transactions);
    const admission = mocks.store.mock.calls[0]?.[3] as PaymentIntentClaimAdmission;
    const result = await admission.admit(tx, payment, at);
    expect(mocks.action.mock.calls[0]?.[0]).toMatchObject({
      submissionKind: "Additional",
      quoteVersion: 1,
      currentOrder: { orderReference: p.orderReference },
    });
    expect(mocks.inventoryFactory.mock.calls[0]?.[0].evaluate).toBe(evaluate);
    expect(steps).toEqual(
      mode === "dining-deny" ? ["Ordering", "Dining"] : ["Ordering", "Dining", "Inventory"],
    );
    expect(result).toEqual(mode === "allow" ? { validUntil: p.capacityExpiresAt } : false);
  },
);
