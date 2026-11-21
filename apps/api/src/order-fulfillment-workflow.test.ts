import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { createOrderFulfillmentCompletionRecord } from "@rms/ordering";
import { createFulfillmentCompletionPublication } from "@rms/fulfillment";
import { orderQueryFixture } from "../../../packages/rms/ordering/src/tests/order-creation-query.fixture.js";
import { evaluateOrderFulfillmentWorkflow } from "./order-fulfillment-workflow.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + n.toString(16).padStart(12, "0");

describe("Order fulfillment Workflow composition", () => {
  it.each([
    { brandReference: id(299) },
    { storeReference: id(299) },
    { resourceReference: id(299) },
    { resourceVersion: 3 },
    { currentState: "Ready" },
    { applicabilityCode: "DineIn" },
    { action: "Cancel" },
    { purposeCode: "OrderCancellation" },
    { expectedVersionReference: id(299) },
    { observedAt: "2000-01-01T00:00:00.000Z" },
  ])("rejects mismatched owner intent before accessing published policy: %j", async (mismatch) => {
    const { record: order } = orderQueryFixture();
    const at = new Date(Date.parse(order.createdAt) + 1000).toISOString();
    const source = createFulfillmentCompletionPublication({
      publicationReference: id(203),
      eventReference: id(202),
      brandReference: order.order.brandReference,
      storeReference: order.order.storeReference,
      fulfillmentReference: id(201),
      orderReference: order.order.orderReference,
      aggregateVersion: 5n,
      handoffRecordReference: id(204),
      verificationMethod: "Opaque",
      completedAt: at,
      correlationReference: id(205),
      causationReference: id(206),
      completionPhase: "Completed",
    }).event;
    const completion = createOrderFulfillmentCompletionRecord(
      {
        completionReference: id(207),
        operationReference: id(208),
        auditReference: id(209),
        brandReference: order.order.brandReference,
        storeReference: order.order.storeReference,
        orderReference: order.order.orderReference,
        orderBatchReference: order.order.batches[0].orderBatchReference,
        orderType: "Pickup",
        phaseBefore: "Accepted",
        expectedOrderVersion: 2,
        expectedSourceCheckpoint: id(212),
        fulfilledOrderVersion: 3,
        phase: "Fulfilled",
        closureStatus: "Open",
        actorType: "System",
        actorReference: null,
        purposeCode: "OrderFulfillment",
        permissionCode: "order.fulfill",
        workflowVersionReference: id(210),
        transitionReference: id(211),
        completedAt: at,
        recordedAt: at,
        sourceEvent: source,
      },
      (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
    );
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
    const deny = vi.fn(async () => false);
    await expect(
      evaluateOrderFulfillmentWorkflow({
        transaction: { query },
        order,
        quoteVersion: 1,
        completion,
        fulfillment: {
          action: "FulfillOrder",
          purposeCode: "OrderFulfillment",
          permissionCode: "order.fulfill",
        },
        request: {
          tenantReference: id(220),
          brandReference: completion.brandReference,
          storeReference: completion.storeReference,
          actorReference: id(221),
          resourceReference: completion.orderReference,
          resourceVersion: 2,
          purposeCode: "OrderFulfillment",
          applicabilityCode: "Pickup",
          expectedVersionReference: completion.workflowVersionReference,
          currentState: "Accepted",
          action: "FulfillOrder",
          observedAt: at,
          ...mismatch,
        },
        gates: {
          authorizeResource: deny,
          authorizeAction: deny,
          authorizeOverride: deny,
          evaluateRule: deny,
        },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_DEFINITION_UNAVAILABLE" });
    expect(query).not.toHaveBeenCalled();
    expect(deny).not.toHaveBeenCalled();
  });
});
