import { createPostgresWorkflowDefinitionStore } from "@bop/workflow";
import { sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import { evaluateIntactReservationPaymentRule } from "@rms/inventory";
import {
  encodeAdditionalDiningBatchSnapshot,
  isPaidOrderWithinAcceptanceWindow,
  OrderAcceptanceRecordError,
  parseOrderAcceptanceRecord,
  parseOrderingReference,
  parsePaymentSucceededEnvelope,
} from "@rms/ordering";
import { createAdditionalOrderPaidContextSource } from "./additional-order-paid-context-source.js";
import { createMerchantAdditionalOrderAcceptanceComposition } from "./merchant-additional-order-acceptance-composition.js";

type Composition = Parameters<typeof createMerchantAdditionalOrderAcceptanceComposition>[0];
type Context = Awaited<
  ReturnType<ReturnType<typeof createAdditionalOrderPaidContextSource>["resolve"]>
>;
const unavailable = (): never => {
  throw new OrderAcceptanceRecordError("ORDER_ACCEPTANCE_RECORD_UNAVAILABLE");
};

/** Server-owned additional-batch acceptance. Caller supplies authenticated scope and owns the transaction. */
export function createMerchantPaidAdditionalOrderAcceptance(
  options: Omit<Composition, "validateEligibility" | "sha256"> & {
    authorizeActor(transaction: ConsumerTransaction): Promise<boolean>;
    actorReference: string;
    workflowVersionReference: string;
    reasonCode: string;
    context: ReturnType<typeof createAdditionalOrderPaidContextSource>;
  },
) {
  const actorReference = parseOrderingReference(options.actorReference);
  const workflowVersionReference = parseOrderingReference(options.workflowVersionReference);
  const scope = Object.freeze({ ...options.scope });
  const acceptance = Object.freeze({ ...options.acceptance });
  const hash = (value: string) => "sha256:" + sha256Hex(value);
  const eligible = (
    current: Context,
    expectedVersion: number,
    event: ReturnType<typeof parsePaymentSucceededEnvelope>,
  ) =>
    current.execution.acceptance === null &&
    current.execution.snapshot.brandReference === scope.brandReference &&
    current.execution.snapshot.storeReference === scope.storeReference &&
    current.execution.snapshot.snapshotVersion === options.quoteVersion &&
    current.execution.orderVersion === expectedVersion &&
    current.execution.batchPhase === "Submitted" &&
    current.capacity !== null &&
    current.capacity.commitment.state === "PaymentPending" &&
    current.inventory !== null &&
    evaluateIntactReservationPaymentRule(current.inventory) &&
    isPaidOrderWithinAcceptanceWindow({
      orderType: "DineIn",
      ...current.payment.intent.preparation,
      terminalOccurredAt: event.payload.terminalOccurredAt,
      observedAt: current.observedAt,
    });
  const digest = (current: Context) =>
    hash(encodeAdditionalDiningBatchSnapshot(current.execution.snapshot));
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
      const original = current.execution.acceptance;
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
        const evaluated = await createPostgresWorkflowDefinitionStore(
          { run: (work) => work(input.transaction) },
          scope,
        ).evaluatePublishedAction(
          {
            ...scope,
            actorReference,
            resourceReference: identity.orderReference,
            resourceVersion: expected,
            purposeCode: acceptance.purposeCode,
            applicabilityCode: "DineIn",
            expectedVersionReference: workflowVersionReference,
            currentState: current.execution.canonicalPhase,
            action: acceptance.action,
            observedAt: current.observedAt,
          },
          {
            ...options.gates,
            authorizeAction: async (transaction, action) =>
              action.transition.nextState === "Accepted" &&
              action.transition.permissionCode === acceptance.permissionCode &&
              (await options.gates.authorizeAction(transaction, action)) === true,
          },
        );
        if (evaluated.transition.effects.length !== 0) return unavailable();
        record = parseOrderAcceptanceRecord({
          ...identity,
          transitionReference: evaluated.transition.transitionReference,
          sourceDigest: digest(current),
          acceptedAt: current.observedAt,
        });
      }
      const writer = createMerchantAdditionalOrderAcceptanceComposition({
        ...options,
        scope,
        acceptance,
        sha256: hash,
        validateEligibility: async (transaction, candidate) => {
          const latest = await options.context.resolve(transaction, event);
          return eligible(latest, expected, event) && digest(latest) === candidate.sourceDigest;
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
