import { beforeEach, describe, expect, it, vi } from "vitest";
const policy = vi.hoisted(() => vi.fn());
vi.mock("@bop/workflow", async (load) => ({
  ...(await load<object>()),
  createPostgresWorkflowDefinitionStore: () => ({ evaluatePublishedAction: policy }),
}));
import { evaluateOrderAcceptanceWorkflow } from "./order-acceptance-workflow.js";
import { orderQueryFixture } from "../../../packages/rms/ordering/src/tests/order-creation-query.fixture.js";
type Input = Parameters<typeof evaluateOrderAcceptanceWorkflow>[0];
const id = (n: number) => `0198a107-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function fixture(): Input {
  const original = orderQueryFixture().record;
  const record = {
    ...original,
    order: { ...original.order, orderType: "DineIn", diningSessionReference: id(5) },
  };
  const batch = {
    orderBatchReference: original.order.batches[0]?.orderBatchReference,
    sequence: 1,
    acceptance: null,
    cancellation: null,
  };
  return {
    order: record,
    quoteVersion: 1,
    transaction: { query: vi.fn() },
    currentDining: {
      order: record,
      current: {
        ...record.order,
        orderVersion: 2,
        orderCheckpoint: id(6),
        batches: [batch],
        items: [],
      },
      batch,
      observedAt: record.createdAt,
    } as unknown as NonNullable<Input["currentDining"]>,
    request: {
      tenantReference: id(1),
      brandReference: record.order.brandReference,
      storeReference: record.order.storeReference,
      actorReference: id(2),
      resourceReference: record.order.orderReference,
      resourceVersion: 2,
      purposeCode: "OrderAcceptance",
      applicabilityCode: "DineIn",
      expectedVersionReference: id(3),
      currentState: "Submitted",
      action: "Accept",
      observedAt: record.createdAt,
    },
    acceptance: {
      action: "Accept",
      purposeCode: "OrderAcceptance",
      permissionCode: "ORDER_ACCEPT",
    },
    gates: {
      authorizeResource: vi.fn(async () => true),
      authorizeAction: vi.fn(async () => true),
      authorizeOverride: vi.fn(async () => false),
      evaluateRule: vi.fn(async () => true),
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  policy.mockResolvedValue({ transition: { effects: [] } });
});
describe("initial Dining current-version workflow", () => {
  it("evaluates the actual current revision while retaining initial version one", async () => {
    const input = fixture();
    await evaluateOrderAcceptanceWorkflow(input);
    expect(policy).toHaveBeenCalledWith(
      expect.objectContaining({ resourceVersion: 2, currentState: "Submitted" }),
      expect.any(Object),
    );
    expect(input.currentDining?.order.order.aggregateVersion).toBe(1);
  });
  it("rejects a stale requested version before policy evaluation", async () => {
    const input = fixture();
    input.request = { ...(input.request as object), resourceVersion: 1 };
    await expect(evaluateOrderAcceptanceWorkflow(input)).rejects.toMatchObject({
      code: "WORKFLOW_DEFINITION_UNAVAILABLE",
    });
    expect(policy).not.toHaveBeenCalled();
  });
  it.each(["wrong-scope", "cancelled", "accepted"])(
    "rejects %s source before policy evaluation",
    async (kind) => {
      const input = fixture();
      const dining = input.currentDining;
      if (!dining) throw Error("fixture");
      input.currentDining = {
        ...dining,
        current:
          kind === "wrong-scope" ? { ...dining.current, storeReference: id(99) } : dining.current,
        batch: {
          ...dining.batch,
          cancellation: kind === "cancelled" ? {} : null,
          acceptance: kind === "accepted" ? {} : null,
        },
      } as unknown as NonNullable<Input["currentDining"]>;
      await expect(evaluateOrderAcceptanceWorkflow(input)).rejects.toMatchObject({
        code: "WORKFLOW_DEFINITION_UNAVAILABLE",
      });
      expect(policy).not.toHaveBeenCalled();
    },
  );
});
