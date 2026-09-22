import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import { evaluateIntactReservationPaymentRule } from "@rms/inventory";
import {
  isPaidOrderWithinAcceptanceWindow,
  OrderAcceptanceRecordError,
  parseOrderAcceptanceRecord,
  parseOrderingReference,
  parsePaymentSucceededEnvelope,
} from "@rms/ordering";
import { createOrderPaidContextSource } from "./order-paid-context-source.js";
import { evaluateOrderAcceptanceWorkflow } from "./order-acceptance-workflow.js";
import { createMerchantOrderAcceptanceComposition } from "./merchant-order-acceptance-composition.js";

type Composition = Parameters<typeof createMerchantOrderAcceptanceComposition>[0];
type Context = Awaited<ReturnType<ReturnType<typeof createOrderPaidContextSource>["resolve"]>>;
const unavailable = (): never => {
  throw new OrderAcceptanceRecordError("ORDER_ACCEPTANCE_RECORD_UNAVAILABLE");
};

/** Server-owned initial-batch acceptance. Caller supplies authenticated scope and owns the transaction. */
export function createMerchantPaidOrderAcceptance(
  options: Omit<Composition, "validateEligibility"> & {
    authorizeActor(transaction: ConsumerTransaction): Promise<boolean>;
    actorReference: string;
    workflowVersionReference: string;
    reasonCode: string;
    context: ReturnType<typeof createOrderPaidContextSource>;
  },
) {
  const actorReference = parseOrderingReference(options.actorReference);
  const workflowVersionReference = parseOrderingReference(options.workflowVersionReference);
  const scope = Object.freeze({ ...options.scope });
  const acceptance = Object.freeze({ ...options.acceptance });
  const eligible = (
    current: Context,
    expectedVersion: number,
    event: ReturnType<typeof parsePaymentSucceededEnvelope>,
  ) =>
    current.acceptance === null &&
    current.order.order.brandReference === scope.brandReference &&
    current.order.order.storeReference === scope.storeReference &&
    (current.currentDining?.current.orderVersion ?? current.order.order.aggregateVersion) ===
      expectedVersion &&
    (current.currentDining !== null || current.order.order.canonicalPhase === "Submitted") &&
    current.initialExecution.phase === "Submitted" &&
    (current.currentDining !== null || current.initialExecution.version === expectedVersion) &&
    current.initialExecution.checkpoint === current.order.submissionReference &&
    current.capacity !== null &&
    current.capacity.commitment.state === "PaymentPending" &&
    current.inventory !== null &&
    evaluateIntactReservationPaymentRule(current.inventory) &&
    isPaidOrderWithinAcceptanceWindow({
      orderType: current.order.order.orderType,
      ...current.payment.intent.preparation,
      terminalOccurredAt: event.payload.terminalOccurredAt,
      observedAt: current.observedAt,
    });
  // Store a digest only; never expose payment/resource evidence in a response or log.
  const digest = (current: Context, event: unknown) => {
    const evidence: unknown = JSON.parse(
      JSON.stringify(
        {
          scope,
          event,
          payment: current.payment,
          order: current.order,
          initialExecution: current.initialExecution,
          currentDining: current.currentDining?.current ?? null,
          capacity: current.capacity?.commitment,
          inventory: current.inventory?.record,
        },
        (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
      ),
    );
    return "sha256:" + sha256Hex(canonicalizeRfc8785(evidence));
  };
  return Object.freeze({
    async commit(input: {
      transaction: ConsumerTransaction;
      command: unknown;
      /** Exact server-resolved captured event; the context validates its persisted Payment binding. */
      paymentEvent: unknown;
    }) {
      const raw = readClosedRecord(
        input.command,
        [
          "acceptanceReference",
          "operationReference",
          "orderReference",
          "orderBatchReference",
          "expectedOrderVersion",
        ],
        "ACTOR_SHAPE_INVALID",
      );
      const expected = raw.expectedOrderVersion;
      if (
        typeof expected !== "number" ||
        !Number.isInteger(expected) ||
        expected < 1 ||
        expected >= 2147483647
      )
        return unavailable();
      const identity = {
        acceptanceReference: parseOrderingReference(raw.acceptanceReference),
        operationReference: parseOrderingReference(raw.operationReference),
        orderReference: parseOrderingReference(raw.orderReference),
        orderBatchReference: parseOrderingReference(raw.orderBatchReference),
        expectedOrderVersion: expected,
        acceptedOrderVersion: expected + 1,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        actorType: "User" as const,
        actorReference,
        purposeCode: acceptance.purposeCode,
        permissionCode: acceptance.permissionCode,
        reasonCode: options.reasonCode,
        workflowVersionReference,
      };
      if (!(await options.authorizeActor(input.transaction))) return unavailable();
      const event = parsePaymentSucceededEnvelope(input.paymentEvent);
      if (
        event.tenantId !== scope.brandReference ||
        event.storeId !== scope.storeReference ||
        event.payload.orderReference !== identity.orderReference
      )
        return unavailable();
      const current = await options.context.resolve(input.transaction, event);
      const preparation = current.payment.intent.preparation;
      if (
        preparation.orderReference !== identity.orderReference ||
        preparation.orderBatchReference !== identity.orderBatchReference
      )
        return unavailable();
      const original = current.acceptance;
      let record;
      if (original !== null) {
        if (
          Object.entries(identity).some(
            ([key, value]) => key !== "acceptanceReference" && Reflect.get(original, key) !== value,
          )
        )
          return unavailable();
        record = original;
      } else {
        if (!eligible(current, expected, event)) return unavailable();
        const evaluated = await evaluateOrderAcceptanceWorkflow({
          transaction: input.transaction,
          order: current.order,
          currentDining: current.currentDining,
          quoteVersion: options.quoteVersion,
          acceptance,
          gates: options.gates,
          request: {
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            actorReference,
            resourceReference: identity.orderReference,
            resourceVersion: expected,
            purposeCode: acceptance.purposeCode,
            applicabilityCode: current.order.order.orderType,
            expectedVersionReference: workflowVersionReference,
            currentState:
              current.currentDining?.current.canonicalPhase ?? current.order.order.canonicalPhase,
            action: acceptance.action,
            observedAt: current.observedAt,
          },
        });
        if (evaluated.transition.effects.length !== 0) return unavailable();
        record = parseOrderAcceptanceRecord({
          ...identity,
          transitionReference: evaluated.transition.transitionReference,
          sourceDigest: digest(current, event),
          acceptedAt: current.observedAt,
        });
      }
      const writer = createMerchantOrderAcceptanceComposition({
        ...options,
        scope,
        acceptance,
        validateEligibility: async (transaction, candidate) => {
          const latest = await options.context.resolve(transaction, event);
          return (
            eligible(latest, expected, event) && digest(latest, event) === candidate.sourceDigest
          );
        },
      });
      return writer.commit({
        transaction: input.transaction,
        record,
        submissionReference: preparation.submissionReference,
      });
    },
  });
}
