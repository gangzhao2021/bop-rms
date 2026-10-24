import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresDiningCheckoutCommitmentStore } from "@rms/dining";
import { createPostgresAsapCapacityStore } from "@rms/fulfillment";
import { parsePaymentIntentCreationRecord } from "@rms/payment";
import {
  parseOrderingReference,
  parseOrderingInstant,
  OrderPaymentOutcomeError,
} from "@rms/ordering";

const unavailable = (): never => {
  throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
};

/** Caller authorizes Order scope and holds its transaction; capacity state is not a release decision. */
export async function readOrderPaidCapacity(
  transaction: ConsumerTransaction,
  scopeInput: { tenantReference: string; brandReference: string; storeReference: string },
  paymentValue: unknown,
  orderType: "DineIn" | "Pickup",
  observedAtValue: string,
) {
  try {
    const scope = {
      tenantReference: String(parseOrderingReference(scopeInput.tenantReference)),
      brandReference: String(parseOrderingReference(scopeInput.brandReference)),
      storeReference: String(parseOrderingReference(scopeInput.storeReference)),
    };
    const payment = parsePaymentIntentCreationRecord(paymentValue);
    const p = payment.intent.preparation;
    const observedAt = parseOrderingInstant(observedAtValue);
    if (
      String(p.brandReference) !== scope.brandReference ||
      String(p.storeReference) !== scope.storeReference
    )
      return unavailable();
    const bound = {
      run: async <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(transaction),
    };
    const expected = {
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
    };
    const matches = (value: object) =>
      Object.entries(expected).every(([key, reference]) => Reflect.get(value, key) === reference);
    if (orderType === "DineIn") {
      const result = await createPostgresDiningCheckoutCommitmentStore(bound, scope, {
        now: () => observedAt,
      }).withCurrentFacts(p.capacityAllocationReference, async (_, facts) => {
        if (!matches(facts.commitment)) return unavailable();
        return Object.freeze({ owner: "Dining" as const, ...facts });
      });
      return result ?? unavailable();
    }
    if (orderType !== "Pickup") return unavailable();
    const result = await createPostgresAsapCapacityStore(
      bound,
      { brandReference: scope.brandReference, storeReference: scope.storeReference },
      { now: () => observedAt },
    ).withCurrentSubmission(p.submissionReference, async (_, commitment) => {
      if (
        String(commitment.allocationReference) !== String(p.capacityAllocationReference) ||
        !matches(commitment)
      )
        return unavailable();
      return Object.freeze({ owner: "AsapPickup" as const, commitment });
    });
    return result ?? unavailable();
  } catch {
    return unavailable();
  }
}
