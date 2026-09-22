import { describe, it, expect, vi } from "vitest";
import { evaluateOrderAcceptanceWorkflow } from "./order-acceptance-workflow.js";
import { orderQueryFixture } from "../../../packages/rms/ordering/src/tests/order-creation-query.fixture.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + n.toString(16).padStart(12, "0");
describe("order acceptance Workflow composition", () => {
  it.each([
    { brandReference: id(9) },
    { storeReference: id(9) },
    { resourceReference: id(9) },
    { resourceVersion: 2 },
    { currentState: "Accepted" },
    { applicabilityCode: "DineIn" },
    { action: "Cancel" },
    { purposeCode: "OrderCancellation" },
    { observedAt: "2000-01-01T00:00:00.000Z" },
  ])("rejects mismatched current order before policy access: %j", (mismatch) => {
    const { record } = orderQueryFixture();
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const deny = vi.fn(async () => false);
    const request = {
      tenantReference: id(1),
      brandReference: record.order.brandReference,
      storeReference: record.order.storeReference,
      actorReference: id(2),
      resourceReference: record.order.orderReference,
      resourceVersion: 1,
      purposeCode: "OrderAcceptance",
      applicabilityCode: record.order.orderType,
      expectedVersionReference: id(3),
      currentState: "Submitted",
      action: "Accept",
      observedAt: record.createdAt,
      ...mismatch,
    };
    return expect(
      evaluateOrderAcceptanceWorkflow({
        order: record,
        acceptance: {
          action: "Accept",
          purposeCode: "OrderAcceptance",
          permissionCode: "ORDER_ACCEPT",
        },
        quoteVersion: 1,
        request,
        transaction: { query },
        gates: {
          authorizeResource: deny,
          authorizeAction: deny,
          authorizeOverride: deny,
          evaluateRule: deny,
        },
      }),
    )
      .rejects.toMatchObject({ code: "WORKFLOW_DEFINITION_UNAVAILABLE" })
      .then(() => {
        expect(query).not.toHaveBeenCalled();
        expect(deny).not.toHaveBeenCalled();
      });
  });
});
