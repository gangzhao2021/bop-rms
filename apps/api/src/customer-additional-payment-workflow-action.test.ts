import { beforeEach, expect, it, vi } from "vitest";
import { additionalSourceFixture } from "../../../packages/rms/ordering/src/tests/order-status-additional-source.fixture.js";
import { createCustomerIntactReservationPaymentAction } from "./customer-payment-workflow-action.js";
const mocked = vi.hoisted(() => ({ current: vi.fn(), evaluate: vi.fn() }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresDiningOrderPreparationSource: () => ({ resolveCurrent: mocked.current }),
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  parsePaymentIntentCreationRecord: (value: unknown) => value,
}));
vi.mock("@bop/workflow", async (original) => ({
  ...(await original<typeof import("@bop/workflow")>()),
  createPostgresWorkflowDefinitionStore: () => ({ evaluatePublishedAction: mocked.evaluate }),
}));
beforeEach(() => vi.clearAllMocks());
function setup() {
  const f = additionalSourceFixture();
  const a = f.additional,
    b = a.batch;
  const reference = f.previous.sourceCheckpoint;
  mocked.current.mockResolvedValue({ orderVersion: 7, canonicalPhase: "Accepted" });
  mocked.evaluate.mockResolvedValue({
    definition: { workflowReference: reference, versionNumber: 1 },
  });
  const action = createCustomerIntactReservationPaymentAction({
    scope: {
      tenantReference: a.brandReference,
      brandReference: a.brandReference,
      storeReference: a.storeReference,
    },
    currentOrder: a,
    quoteVersion: 1,
    submissionKind: "Additional",
    workflow: {
      purposeCode: "Synthetic",
      action: "CreatePaymentIntent",
      permissionCode: "synthetic.payment.create",
      paymentCommandCode: "CreatePaymentIntent",
      intactReservationRuleReference: reference,
    },
    authorize: async () => true,
    authorizeOverride: async () => false,
  });
  // Synthetic Payment/Inventory boundary records: tests here exercise composition,
  // not their owner parsers or successful financial persistence.
  const input = {
    payment: {
      intent: {
        preparation: {
          orderReference: a.orderReference,
          orderBatchReference: b.orderBatchReference,
          guestSessionReference: a.guestSessionReference,
          submissionReference: b.submissionReference,
        },
      },
    },
    inventory: {
      observedAt: b.submittedAt,
      record: {
        tenantReference: a.brandReference,
        brandReference: a.brandReference,
        storeReference: a.storeReference,
        orderReference: a.orderReference,
        actorReference: a.guestSessionReference,
        submissionReference: b.submissionReference,
        cartReference: b.sourceCartReference,
        cartVersion: b.sourceCartVersion,
        quoteReference: b.quoteReference,
        workflowVersionReference: reference,
        workflowReference: reference,
        workflowVersion: 1,
      },
    },
  } as unknown as Parameters<typeof action>[1];
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  return { action, input, tx, a };
}
it("uses current Accepted phase and version for the additional Batch", async () => {
  const f = setup();
  expect(await f.action(f.tx, f.input)).toBe(true);
  expect(mocked.current).toHaveBeenCalledOnce();
  expect(mocked.evaluate.mock.calls[0]?.[0]).toMatchObject({
    resourceReference: f.a.orderReference,
    resourceVersion: 7,
    currentState: "Accepted",
    applicabilityCode: "DineIn",
  });
});
it.each([null, { orderVersion: 1, canonicalPhase: "Submitted" }])(
  "denies missing or pre-append current state",
  async (current) => {
    const f = setup();
    mocked.current.mockResolvedValue(current);
    expect(await f.action(f.tx, f.input)).toBe(false);
    expect(mocked.evaluate).not.toHaveBeenCalled();
  },
);
it("denies a different Batch before consulting current workflow", async () => {
  const f = setup();
  const input = {
    ...f.input,
    payment: {
      ...f.input.payment,
      intent: {
        ...f.input.payment.intent,
        preparation: {
          ...f.input.payment.intent.preparation,
          orderBatchReference: f.a.orderReference,
        },
      },
    },
  };
  expect(await f.action(f.tx, input)).toBe(false);
  expect(mocked.current).not.toHaveBeenCalled();
  expect(mocked.evaluate).not.toHaveBeenCalled();
});
