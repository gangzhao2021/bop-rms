import { parseCanonicalInstant, parseGuestRawCredential, readClosedRecord } from "@bop/identity";
import {
  assertOrderCapacityLinkMatches,
  createPostgresAdditionalDiningBatchHistoryReader,
  parseAdditionalDiningBatchSnapshot,
  type OrderingReference,
  parseOrderCapacityLink,
  parseOrderCreationRecord,
  parseConfiguredOrderCreationRecord,
  parseOrderingReference,
  type CapacityLinkedOrderCreationPorts,
} from "@rms/ordering";
import type { PaymentIntentCreationPorts } from "@rms/payment";
import {
  createCustomerDiningCheckoutIdentity,
  type CustomerDiningCheckoutCompositionOptions,
} from "./customer-dining-checkout-composition.js";

export interface CustomerDiningPaymentAuthorizationOptions<V extends 1 | 2 = 1> {
  readonly preparation: CustomerDiningCheckoutCompositionOptions;
  readonly ordering: Pick<
    CapacityLinkedOrderCreationPorts<V>["repository"],
    "resolveSubmission" | "resolveCapacityLink"
  >;
}

export interface CustomerAdditionalDiningPaymentAuthorizationOptions {
  readonly preparation: CustomerDiningCheckoutCompositionOptions;
  readonly ordering: {
    resolveSubmission(reference: OrderingReference): Promise<unknown | null>;
    resolveCapacityLink(reference: OrderingReference): Promise<unknown | null>;
  };
}

/** Request-local access port. Does not assert capacity, inventory or payment readiness. */
function createVersionedCustomerDiningPaymentAuthorization<V extends 1 | 2>(
  options:
    | CustomerDiningPaymentAuthorizationOptions<V>
    | CustomerAdditionalDiningPaymentAuthorizationOptions,
  value: unknown,
  quoteVersion: V | "Additional",
): PaymentIntentCreationPorts["authorization"] {
  const raw = readClosedRecord(value, ["sessionCredential", "csrfCredential"]);
  const credentials = Object.freeze({
    sessionCredential: parseGuestRawCredential(raw.sessionCredential),
    csrfCredential: parseGuestRawCredential(raw.csrfCredential),
  });
  const scope = Object.freeze({
    brandReference: String(parseOrderingReference(options.preparation.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.preparation.scope.storeReference)),
  });
  let last: string | undefined;
  const now = () => {
    const at = parseCanonicalInstant(options.preparation.now());
    if (last !== undefined && at < last) throw new Error("payment authorization unavailable");
    last = at;
    return at;
  };
  const identity = createCustomerDiningCheckoutIdentity(options.preparation, scope, now);
  let fingerprint: string | undefined;
  let operation: string | undefined;
  let submission: string | undefined;
  return Object.freeze({
    async authorize(input) {
      try {
        const request = readClosedRecord(input, [
          "action",
          "paymentOperationReference",
          "submissionReference",
          "observedAt",
        ]);
        if (request.action !== "CreatePaymentIntent") return null;
        const paymentOperationReference = String(
          parseOrderingReference(request.paymentOperationReference),
        );
        const submissionReference = parseOrderingReference(request.submissionReference);
        const observedAt = parseCanonicalInstant(request.observedAt);
        if (
          observedAt > now() ||
          (operation !== undefined && operation !== paymentOperationReference) ||
          (submission !== undefined && submission !== submissionReference)
        )
          return null;
        const authenticate = async () => {
          const guest = await identity.authorize({ ...credentials, observedAt: now() });
          if (
            guest.brandReference !== scope.brandReference ||
            guest.storeReference !== scope.storeReference ||
            guest.channel !== "DineIn" ||
            guest.diningState !== "DiningBound" ||
            guest.diningSessionReference === null ||
            guest.diningParticipantReference === null
          )
            return null;
          const current = JSON.stringify(guest);
          if (fingerprint !== undefined && fingerprint !== current) return null;
          fingerprint = current;
          return guest;
        };
        const first = await authenticate();
        if (first === null) return null;
        operation = paymentOperationReference;
        submission = submissionReference;
        const recordValue = await options.ordering.resolveSubmission(submissionReference);
        const linkValue = await options.ordering.resolveCapacityLink(submissionReference);
        if (recordValue === null || linkValue === null) return null;
        const link = parseOrderCapacityLink(linkValue);
        if (quoteVersion === "Additional") {
          const saved = parseAdditionalDiningBatchSnapshot(recordValue);
          const batch = saved.batch;
          if (
            link.owner !== "Dining" ||
            saved.brandReference !== link.brandReference ||
            saved.storeReference !== link.storeReference ||
            saved.orderReference !== link.orderReference ||
            saved.diningSessionReference !== link.ownerContextReference ||
            saved.guestSessionReference !== link.guestSessionReference ||
            batch.orderBatchReference !== link.orderBatchReference ||
            batch.submissionReference !== link.submissionReference ||
            batch.sourceCartReference !== link.cartReference ||
            batch.sourceCartVersion !== link.cartVersion ||
            batch.quoteReference !== link.quoteReference ||
            batch.submittedAt < link.preparedAt ||
            batch.submittedAt >= link.validUntil
          )
            return null;
        } else {
          const record =
            quoteVersion === 2
              ? parseConfiguredOrderCreationRecord(recordValue)
              : parseOrderCreationRecord(recordValue);
          assertOrderCapacityLinkMatches(link, record);
        }
        if (
          link.owner !== "Dining" ||
          String(link.submissionReference) !== submissionReference ||
          String(link.paymentOperationReference) !== paymentOperationReference ||
          String(link.brandReference) !== scope.brandReference ||
          String(link.storeReference) !== scope.storeReference ||
          String(link.guestSessionReference) !== String(first.sessionReference) ||
          String(link.ownerContextReference) !== String(first.diningSessionReference)
        )
          return null;
        const current = await authenticate();
        if (current === null) return null;
        return Object.freeze({
          action: "CreatePaymentIntent" as const,
          guestSessionReference: String(current.sessionReference),
          ...scope,
        });
      } catch {
        return null;
      }
    },
  });
}

export function createCustomerDiningPaymentAuthorization(
  options: CustomerDiningPaymentAuthorizationOptions,
  value: unknown,
) {
  return createVersionedCustomerDiningPaymentAuthorization(options, value, 1);
}
export function createCustomerConfiguredDiningPaymentAuthorization(
  options: CustomerDiningPaymentAuthorizationOptions<2>,
  value: unknown,
) {
  return createVersionedCustomerDiningPaymentAuthorization(options, value, 2);
}

/** Exact additional Batch history; uses the same current identity and operation
 * fences as initial payment. Payment readiness and original expiry stay separate.
 */
export function createCustomerAdditionalDiningPaymentAuthorization(
  options: CustomerAdditionalDiningPaymentAuthorizationOptions,
  value: unknown,
) {
  return createVersionedCustomerDiningPaymentAuthorization(options, value, "Additional");
}

/** Runtime composition: immutable history always comes from the Ordering owner. */
export function createPersistentAdditionalDiningPaymentAuthorization(
  options: {
    preparation: CustomerDiningCheckoutCompositionOptions;
    history: Parameters<typeof createPostgresAdditionalDiningBatchHistoryReader>[0];
  },
  value: unknown,
) {
  if (
    parseOrderingReference(options.preparation.scope.brandReference) !==
      parseOrderingReference(options.history.brandReference) ||
    parseOrderingReference(options.preparation.scope.storeReference) !==
      parseOrderingReference(options.history.storeReference)
  ) {
    throw new Error("additional payment authorization scope mismatch");
  }
  return createCustomerAdditionalDiningPaymentAuthorization(
    {
      preparation: options.preparation,
      ordering: createPostgresAdditionalDiningBatchHistoryReader(options.history),
    },
    value,
  );
}
