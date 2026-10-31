import {
  GuestSessionService,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
} from "@bop/identity";
import {
  assertOrderCapacityLinkMatches,
  parseOrderCapacityLink,
  parseOrderCreationRecord,
  parseConfiguredOrderCreationRecord,
  parseOrderingReference,
  type CapacityLinkedOrderCreationPorts,
} from "@rms/ordering";
import type { PaymentIntentCreationPorts } from "@rms/payment";
import type { CustomerPickupCheckoutOptions } from "./customer-pickup-checkout-composition.js";

export interface CustomerPickupPaymentAuthorizationOptions<V extends 1 | 2 = 1> {
  readonly preparation: Pick<CustomerPickupCheckoutOptions, "scope" | "session" | "now">;
  readonly ordering: Pick<
    CapacityLinkedOrderCreationPorts<V>["repository"],
    "resolveSubmission" | "resolveCapacityLink"
  >;
}

/** Request-local access port. Does not assert capacity, inventory or payment readiness. */
function createVersionedCustomerPickupPaymentAuthorization<V extends 1 | 2>(
  options: CustomerPickupPaymentAuthorizationOptions<V>,
  value: unknown,
  quoteVersion: V,
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
  const identity = new GuestSessionService({
    ...options.preparation.session,
    now,
    admission: { consume: async () => null },
  });
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
            guest.channel !== "Pickup" ||
            guest.diningState !== "ContextOnly" ||
            guest.diningSessionReference !== null ||
            guest.diningParticipantReference !== null
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
        const record =
          quoteVersion === 2
            ? parseConfiguredOrderCreationRecord(recordValue)
            : parseOrderCreationRecord(recordValue);
        const link = parseOrderCapacityLink(linkValue);
        assertOrderCapacityLinkMatches(link, record);
        if (
          link.owner !== "Fulfillment" ||
          String(link.submissionReference) !== submissionReference ||
          String(link.paymentOperationReference) !== paymentOperationReference ||
          String(link.brandReference) !== scope.brandReference ||
          String(link.storeReference) !== scope.storeReference ||
          String(link.guestSessionReference) !== String(first.sessionReference)
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

export function createCustomerPickupPaymentAuthorization(
  options: CustomerPickupPaymentAuthorizationOptions,
  value: unknown,
) {
  return createVersionedCustomerPickupPaymentAuthorization(options, value, 1);
}
export function createCustomerConfiguredPickupPaymentAuthorization(
  options: CustomerPickupPaymentAuthorizationOptions<2>,
  value: unknown,
) {
  return createVersionedCustomerPickupPaymentAuthorization(options, value, 2);
}
