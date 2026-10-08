import process from "node:process";
import { createHash } from "node:crypto";
import { createOrderFulfillmentEventComposition } from "../../apps/api/dist/order-fulfillment-composition.js";
export async function createInternalOrderCompletion(resources, { saved, actor }) {
  const scope = {
    tenantReference: resources.publicProfile.binding.tenantReference,
    ...resources.scope,
  };
  if (
    process.env.NODE_ENV !== "development" ||
    saved.environment !== "InternalTest" ||
    saved.scope.brandReference !== scope.brandReference ||
    saved.scope.storeReference !== scope.storeReference
  )
    throw new Error("INTERNAL_ORDER_COMPLETION_ONLY");
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
    active = () => resources.now() < resources.publicProfile.binding.validUntil;
  return {
    async consume(transaction, event) {
      if (
        !active() ||
        event.tenantId !== scope.brandReference ||
        event.storeId !== scope.storeReference ||
        event.eventType !== "FulfillmentCompleted"
      )
        throw new Error("INTERNAL_ORDER_COMPLETION_SCOPE_DENIED");
      const matches = (value) =>
        active() &&
        value.brandReference === scope.brandReference &&
        value.storeReference === scope.storeReference;
      const composition = createOrderFulfillmentEventComposition({
        scope,
        quoteVersion: 2,
        systemActorReference: actor,
        sha256: hash,
        fulfillment: {
          action: "FulfillOrder",
          purposeCode: saved.workflow.purposeCode,
          permissionCode: "order.fulfill",
        },
        authorize: async (_tx, r) =>
          matches(r) && r.orderReference === event.payload.orderReference,
        authorizeEvent: async (_tx, e) => active() && e.eventId === event.eventId,
        gates: {
          authorizeResource: async (_tx, r) =>
            matches(r) &&
            r.tenantReference === scope.tenantReference &&
            r.actorReference === actor &&
            r.resourceReference === event.payload.orderReference,
          authorizeAction: async () => active(),
          authorizeOverride: async () => false,
          evaluateRule: async () => {
            throw new Error("UNEXPECTED_COMPLETION_RULE");
          },
        },
        validateEligibility: async (_tx, r, order) =>
          matches(r) &&
          r.sourceEvent.eventId === event.eventId &&
          order.order.orderReference === event.payload.orderReference &&
          order.order.orderType === "Pickup",
        audit: async (r) => ({
          auditId: r.auditReference,
          brandId: r.brandReference,
          storeId: r.storeReference,
          actor: { type: "System" },
          actionCode: "ORDER_FULFILLED",
          targetType: "Order",
          targetId: r.orderReference,
          correlationId: r.operationReference,
          occurredAt: r.recordedAt,
          afterSummary: { phase: "Fulfilled", closureStatus: "Open" },
          reasonCode: "FULFILLMENT_COMPLETED",
          sourceChannel: "SYSTEM",
          dataClassification: "Restricted",
          retentionPolicyCode: "FINANCIAL_COMPLIANCE",
          retentionPolicyVersion: 1,
        }),
        workflowVersionReference: saved.workflow.payment.workflowVersionReference,
        transitionReference: saved.workflow.payment.fulfillmentTransitionReference,
        references: {
          now: resources.now,
          derive: (kind, identity) => {
            const d = hash(kind + ":" + identity).slice(7);
            return (
              "0190fa40-" +
              d.slice(0, 4) +
              "-7" +
              d.slice(4, 7) +
              "-8" +
              d.slice(7, 10) +
              "-" +
              d.slice(10, 22)
            );
          },
        },
      });
      return composition.commitEvent({ transaction, envelope: event });
    },
  };
}
