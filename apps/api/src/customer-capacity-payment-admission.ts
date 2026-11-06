import { createPostgresDiningCheckoutCommitmentStore, DiningCheckoutStoreError } from "@rms/dining";
import { createPostgresAsapCapacityStore } from "@rms/fulfillment";
import { parseOrderingReference } from "@rms/ordering";
import {
  parsePaymentIntentCreationRecord,
  parsePaymentInstant,
  type PaymentIntentClaimAdmission,
  type PaymentIntentCreationRecord,
} from "@rms/payment";

export interface CustomerCapacityPaymentAdmissionOptions {
  readonly scope: Readonly<{
    tenantReference: string;
    brandReference: string;
    storeReference: string;
  }>;
  readonly owner: "Dining" | "AsapPickup";
  readonly inventory: PaymentIntentClaimAdmission;
}

/** Capacity then Inventory owner fences on Payment's transaction; scheduled Pickup has its own path. */
export function createCustomerCapacityPaymentClaimAdmission(
  options: CustomerCapacityPaymentAdmissionOptions,
): PaymentIntentClaimAdmission {
  const scope = Object.freeze({
    tenantReference: String(parseOrderingReference(options.scope.tenantReference)),
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
  });
  const owner = options.owner;
  const inventory = options.inventory.admit.bind(options.inventory);
  return Object.freeze({
    async admit(
      tx: Parameters<PaymentIntentClaimAdmission["admit"]>[0],
      value: PaymentIntentCreationRecord,
      at: string,
    ) {
      try {
        const record = parsePaymentIntentCreationRecord(value),
          p = record.intent.preparation;
        const observedAt = parsePaymentInstant(at);
        if (
          String(p.brandReference) !== scope.brandReference ||
          String(p.storeReference) !== scope.storeReference
        )
          return false;
        const bound = { run: async <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx) };
        const admitInventory = async () => {
          const decision = await inventory(tx, record, observedAt);
          if (decision === false) return false;
          const deadline =
            decision === true ? p.capacityExpiresAt : parsePaymentInstant(decision.validUntil);
          return Object.freeze({
            validUntil: deadline < p.capacityExpiresAt ? deadline : p.capacityExpiresAt,
          });
        };
        const expected = {
          guestSessionReference: p.guestSessionReference,
          submissionReference: p.submissionReference,
          cartReference: p.sourceCartReference,
          cartVersion: p.sourceCartVersion,
          quoteReference: p.quoteReference,
          orderReference: p.orderReference,
          orderBatchReference: p.orderBatchReference,
          paymentOperationReference: record.intent.paymentOperationReference,
          paymentRequestedAt: p.committedAt,
          capacityExpiresAt: p.capacityExpiresAt,
        };
        const matches = (current: object) =>
          Object.entries(expected).every(
            ([key, expectedValue]) => Reflect.get(current, key) === expectedValue,
          );
        if (owner === "Dining") {
          // WP-2423 (table-move-payment review, 2026-11-06): Dining reads where the party sits at
          // the clock's current reading, never before the request's time, so a Move recorded after
          // the request was made is followed in this gate instead of refusing every retry.
          let last: string = observedAt;
          const diningNow = () => {
            const wall = new Date().toISOString();
            if (wall > last) last = wall;
            return last;
          };
          return (
            (await createPostgresDiningCheckoutCommitmentStore(bound, scope, {
              now: diningNow,
            }).withPaymentPending(p.capacityAllocationReference, async (_transaction, current) => {
              if (!matches(current)) return false;
              return admitInventory();
            })) ?? false
          );
        }
        if (owner !== "AsapPickup") return false;
        return (
          (await createPostgresAsapCapacityStore(
            bound,
            {
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
            },
            { now: () => observedAt },
          ).withCurrentSubmission(p.submissionReference, async (_transaction, current) => {
            if (
              String(current.allocationReference) !== String(p.capacityAllocationReference) ||
              !matches(current) ||
              current.state !== "PaymentPending" ||
              current.paymentRequestedAt === null ||
              current.capacityExpiresAt === null ||
              String(observedAt) < String(current.paymentRequestedAt) ||
              String(observedAt) >= String(current.capacityExpiresAt)
            )
              return false;
            return admitInventory();
          })) ?? false
        );
      } catch (error) {
        // A busy or failed Dining read (a Move in progress, a lock or connection failure) is
        // retryable: Payment answers it as a dependency failure the guest's phone retries, never
        // as "this payment is not yours". Everything else is a refusal, as before.
        if (
          error instanceof DiningCheckoutStoreError &&
          (error.code === "DINING_CHECKOUT_STORE_CONFLICT" ||
            error.code === "DINING_CHECKOUT_STORE_UNAVAILABLE")
        )
          throw error;
        return false;
      }
    },
  });
}
