import process from "node:process";
import { loadOutboxEnvelope } from "../../packages/bop/eventing/src/index.ts";
import { createPostgresOrderPaymentAcceptanceWaitStore } from "../../packages/rms/ordering/src/index.ts";
import { createAdditionalOrderPaidContextSource } from "../../apps/api/dist/additional-order-paid-context-source.js";
import { createAdditionalOrderPaidOutcomeSource } from "../../apps/api/dist/additional-order-paid-outcome-source.js";
import { createOrderCapturedPaymentSource } from "../../apps/api/dist/order-captured-payment-source.js";
import { createPostgresOrderBatchIdentitySource } from "../../packages/rms/ordering/src/index.ts";
import { createHash } from "node:crypto";
import { createOrderPaidContextSource } from "../../apps/api/dist/order-paid-context-source.js";
import { createOrderPaidOutcomeSource } from "../../apps/api/dist/order-paid-outcome-source.js";
import { evaluateIntactReservationPaymentRule } from "../../packages/rms/inventory/src/index.ts";
import {
  createOrderPaymentOutcomeConsumerService,
  createPostgresOrderPaymentOutcomeStore,
} from "../../packages/rms/ordering/src/index.ts";
export async function createInternalPaidOutcome(
  resources,
  { persistentWaiting = false } = {},
  {
    loadPickupWorkflow,
    loadDiningWorkflow,
    loadAdditionalWorkflow,
    providerAccountReference,
    actorReference,
  },
) {
  const saved = await loadPickupWorkflow();
  const scope = {
      tenantReference: resources.publicProfile.binding.tenantReference,
      ...resources.scope,
    },
    reference = resources.credentials.reference;
  if (
    process.env.NODE_ENV !== "development" ||
    saved.environment !== "InternalTest" ||
    saved.scope.storeReference !== scope.storeReference
  )
    throw new Error("INTERNAL_PAID_OUTCOME_ONLY");
  const dining = await loadDiningWorkflow();
  if (
    dining.environment !== saved.environment ||
    dining.database !== saved.database ||
    JSON.stringify(dining.scope) !== JSON.stringify(saved.scope) ||
    dining.workflow.purposeCode !== saved.workflow.purposeCode
  )
    throw new Error("INTERNAL_PAID_SCOPE_MISMATCH");
  const additionalConfig = await loadAdditionalWorkflow();
  if (
    additionalConfig.environment !== saved.environment ||
    additionalConfig.database !== saved.database ||
    JSON.stringify(additionalConfig.scope) !== JSON.stringify(saved.scope)
  )
    throw new Error("INTERNAL_ADDITIONAL_SCOPE_MISMATCH");
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const active = () => resources.now() < resources.publicProfile.binding.validUntil;
  const sameScope = (value) =>
    value.brandReference === scope.brandReference &&
    value.storeReference === scope.storeReference &&
    active();
  const paymentOptions = {
    scope: {
      ...resources.scope,
      providerAccountReference: providerAccountReference,
      environment: "Test",
    },
    now: resources.now,
    authorize: async (_tx, event) =>
      event.tenantId === scope.brandReference && event.storeId === scope.storeReference && active(),
  };
  const captured = createOrderCapturedPaymentSource(paymentOptions);
  const additionalContext = createAdditionalOrderPaidContextSource({
    ...paymentOptions,
    tenantReference: scope.tenantReference,
    quoteVersion: 1,
    authorizeOrder: async (_tx, value) => sameScope(value),
    authorizeInventory: async () => active(),
  });
  const context = createOrderPaidContextSource({
    currentDiningAcceptance: true,
    scope: {
      ...resources.scope,
      providerAccountReference: providerAccountReference,
      environment: "Test",
    },
    tenantReference: scope.tenantReference,
    quoteVersion: 1,
    now: resources.now,
    authorize: async (_tx, event) =>
      event.tenantId === scope.brandReference && event.storeId === scope.storeReference && active(),
    authorizeOrder: async (_tx, value) => sameScope(value),
    authorizeInventory: async () => active(),
  });
  function service() {
    let observedAt;
    const initialSource = createOrderPaidOutcomeSource({
      context,
      quoteVersion: 1,
      sha256: hash,
      release: {
        action: "ReleasePaidOrder",
        purposeCode: saved.workflow.purposeCode,
        permissionCode: "order.release",
        nextState: "Accepted",
      },
      generateDispositionReference: reference,
      generateConfirmationReference: reference,
      resolveWorkflow: async ({ context: current }) => {
        observedAt = current.observedAt;
        const orderType = current.order.order.orderType;
        const workflow = orderType === "DineIn" ? dining.workflow : saved.workflow;
        if (!["Pickup", "DineIn"].includes(orderType) || !current.acceptance)
          throw new Error("INTERNAL_PAID_OUTCOME_UNAVAILABLE");
        const request = {
          ...scope,
          actorReference: actorReference,
          resourceReference: current.order.order.orderReference,
          resourceVersion:
            current.currentDining?.current.orderVersion ?? current.acceptance.acceptedOrderVersion,
          purposeCode: workflow.purposeCode,
          applicabilityCode: orderType,
          expectedVersionReference: workflow.payment.workflowVersionReference,
          currentState: current.currentDining?.current.canonicalPhase ?? "Accepted",
          action: "ReleasePaidOrder",
          observedAt,
        };
        return {
          request,
          gates: {
            authorizeResource: async (_tx, value) =>
              sameScope(value) &&
              value.tenantReference === scope.tenantReference &&
              value.actorReference === request.actorReference &&
              value.resourceReference === request.resourceReference &&
              value.resourceVersion === request.resourceVersion,
            authorizeAction: async () => active(),
            authorizeOverride: async () => false,
            evaluateRule: async (_tx, value) =>
              active() &&
              value.ruleReference === workflow.payment.intactReservationRuleReference &&
              current.capacity !== null &&
              current.inventory !== null &&
              evaluateIntactReservationPaymentRule(current.inventory),
          },
        };
      },
    });
    const source = {
      loadExact: async (input) => {
        const facts = await captured.resolve(input.transaction, input.paymentEvent);
        const p = facts.payment.intent.preparation;
        const identity = await createPostgresOrderBatchIdentitySource({
          ...resources.scope,
          authorize: async () => active(),
        }).load(input.transaction, {
          orderReference: p.orderReference,
          orderBatchReference: p.orderBatchReference,
          observedAt: resources.now(),
        });
        if (!identity || identity.submissionReference !== p.submissionReference)
          throw new Error("INTERNAL_BATCH_IDENTITY_UNAVAILABLE");
        if (identity.kind === "Initial") return initialSource.loadExact(input);
        if (identity.kind !== "Additional" || identity.orderType !== "DineIn")
          throw new Error("INTERNAL_BATCH_KIND_UNAVAILABLE");
        const current = await additionalContext.resolve(input.transaction, input.paymentEvent);
        observedAt = current.observedAt;
        const workflow = additionalConfig.workflow;
        return createAdditionalOrderPaidOutcomeSource({
          context: { resolve: async () => current },
          quoteVersion: 1,
          sha256: hash,
          release: {
            action: "ReleasePaidOrder",
            purposeCode: workflow.purposeCode,
            permissionCode: "order.release",
            nextState: current.execution.canonicalPhase,
          },
          generateDispositionReference: reference,
          generateConfirmationReference: reference,
          resolveWorkflow: async () => {
            const request = {
              ...scope,
              actorReference: actorReference,
              resourceReference: p.orderReference,
              resourceVersion: current.execution.orderVersion,
              purposeCode: workflow.purposeCode,
              applicabilityCode: "DineIn",
              expectedVersionReference: workflow.payment.workflowVersionReference,
              currentState: current.execution.canonicalPhase,
              action: "ReleasePaidOrder",
              observedAt,
            };
            return {
              request,
              gates: {
                authorizeResource: async (_tx, value) =>
                  sameScope(value) &&
                  value.tenantReference === scope.tenantReference &&
                  value.actorReference === request.actorReference &&
                  value.resourceReference === request.resourceReference &&
                  value.resourceVersion === request.resourceVersion,
                authorizeAction: async () => active(),
                authorizeOverride: async () => false,
                evaluateRule: async (_tx, value) =>
                  active() &&
                  value.ruleReference === workflow.payment.intactReservationRuleReference &&
                  evaluateIntactReservationPaymentRule(current.inventory),
              },
            };
          },
        }).loadExact(input);
      },
    };
    const outcomes = createPostgresOrderPaymentOutcomeStore({
      ...resources.scope,
      sha256: hash,
      audit: async ({ orderReference, correlationReference, outcome }) => ({
        auditId: reference(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "ORDER_PAYMENT_DISPOSITION_RECORDED",
        targetType: "Order",
        targetId: orderReference,
        correlationId: correlationReference,
        afterSummary: { outcome },
        reasonCode: "PAYMENT_CAPTURED",
        occurredAt: observedAt ?? resources.now(),
        sourceChannel: "EVENT_CONSUMER",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      }),
    });
    const waits = createPostgresOrderPaymentAcceptanceWaitStore({
      ...resources.scope,
      sha256: hash,
      authorize: async () => active(),
      validateCurrent: async (tx, { event, record }) => {
        const current = await source.loadExact({
          transaction: tx,
          paymentEvent: event,
          brandReference: event.tenantId,
          storeReference: event.storeId,
          orderReference: event.payload.orderReference,
          paymentTransactionReference: event.payload.paymentTransactionReference,
          paymentIntentReference: event.payload.paymentIntentReference,
          paymentAttemptReference: event.payload.paymentAttemptReference,
          paymentEventReference: event.eventId,
        });
        return (
          current?.disposition === "AwaitingAcceptance" &&
          [
            "brandReference",
            "storeReference",
            "orderReference",
            "orderBatchReference",
            "submissionReference",
            "sourceVersion",
            "sourceCheckpoint",
          ].every((key) => current[key] === record[key])
        );
      },
      audit: async ({ event, record }) => ({
        auditId: reference(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "ORDER_PAYMENT_WAIT_RECORDED",
        targetType: "OrderPaymentWait",
        targetId: record.dispositionReference,
        correlationId: event.correlationId,
        afterSummary: { outcome: "AwaitingAcceptance" },
        reasonCode: "ORDER_ACCEPTANCE_PENDING",
        occurredAt: record.evaluatedAt,
        sourceChannel: "EVENT_CONSUMER",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      }),
    });
    const consumer = createOrderPaymentOutcomeConsumerService({
      authorization: {
        authorize: async (value) =>
          sameScope(value) &&
          value.action === "ApplyPaymentOutcome" &&
          value.purpose === "ApplyAuthoritativePaymentOutcome",
      },
      source,
      outcomes,
      references: { generate: reference },
      digests: { sha256: hash },
      ...(persistentWaiting
        ? {
            waiting: {
              record: async ({ transaction, event, disposition }) =>
                (await waits.record(transaction, event, disposition)).record,
              load: ({ transaction, event }) => waits.load(transaction, event),
            },
          }
        : {}),
    });
    return { ...consumer, listUnresolved: waits.listUnresolved };
  }
  return {
    registrations: service().registrations,
    consume: (tx, event) => service().consume(tx, event),
    listUnresolved: (tx, limit, after = null) => service().listUnresolved(tx, limit, after),
    resume: async (tx, eventReference) => {
      if (!persistentWaiting) throw new Error("INTERNAL_PAID_WAIT_DISABLED");
      const event = await loadOutboxEnvelope(tx, eventReference);
      if (
        !event ||
        event.eventType !== "PaymentSucceeded" ||
        event.tenantId !== scope.brandReference ||
        event.storeId !== scope.storeReference
      )
        throw new Error("INTERNAL_PAID_WAIT_EVENT_UNAVAILABLE");
      return service().resumePending(tx, event);
    },
  };
}
