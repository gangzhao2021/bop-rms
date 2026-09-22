import {
  GuestSessionError,
  GuestSessionService,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
} from "@bop/identity";
import { parseAsapCapacityCommitment } from "@rms/fulfillment";
import {
  assertOrderCapacityLinkMatches,
  parseOrderCapacityLink,
  parseOrderCreationRecord,
  parseConfiguredOrderCreationRecord,
  parseOrderingReference,
} from "@rms/ordering";
import { createMoney, type Money } from "@rms/pricing";
import { createPaymentTipSelectionService, type PaymentTipSelectionPorts } from "@rms/payment";
import {
  createCustomerPickupCheckoutComposition,
  pickupOrderCapacityLinkFromHistory,
} from "./customer-pickup-checkout-composition.js";
import type { CustomerPickupOrderSubmissionOptions } from "./customer-pickup-order-submission-composition.js";

export interface CustomerPickupTipSelectionOptions<V extends 1 | 2 = 1> {
  readonly submission: Pick<CustomerPickupOrderSubmissionOptions<V>, "preparation" | "repository">;
  readonly tip: Pick<PaymentTipSelectionPorts, "repository" | "audit">;
}
const unavailable = (): never => {
  throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
};
/** Internal post-submission, pre-clock selection. Does not create Orders or call a Provider. */
function createVersionedCustomerPickupTipSelectionComposition<V extends 1 | 2>(
  options: CustomerPickupTipSelectionOptions<V>,
  quoteVersion: V,
) {
  const preparation = options.submission.preparation;
  const owner = createCustomerPickupCheckoutComposition(preparation);
  const scope = Object.freeze({
    brandReference: String(parseOrderingReference(preparation.scope.brandReference)),
    storeReference: String(parseOrderingReference(preparation.scope.storeReference)),
  });
  return Object.freeze({
    async select(value: unknown) {
      try {
        const raw = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "selectionReference",
          "submissionReference",
          "cartReference",
          "cartVersion",
          "quoteReference",
          "tip",
        ]);
        const credentials = Object.freeze({
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        });
        const selectionReference = parseOrderingReference(raw.selectionReference);
        const submissionReference = parseOrderingReference(raw.submissionReference);
        const cartReference = parseOrderingReference(raw.cartReference);
        const quoteReference = parseOrderingReference(raw.quoteReference);
        const tip = createMoney(raw.tip as Money);
        if (!Number.isSafeInteger(raw.cartVersion) || (raw.cartVersion as number) < 1)
          return unavailable();
        const cartVersion = raw.cartVersion as number;
        let last: string | undefined;
        const now = () => {
          const at = parseCanonicalInstant(preparation.now());
          if (last !== undefined && at < last) return unavailable();
          last = at;
          return at;
        };
        const identity = new GuestSessionService({
          ...preparation.session,
          now,
          admission: { consume: async () => null },
        });
        const authenticate = async () => {
          const guest = await identity.authorize({ ...credentials, observedAt: now() });
          if (
            guest.brandReference !== scope.brandReference ||
            guest.storeReference !== scope.storeReference ||
            guest.channel !== "Pickup" ||
            guest.diningState !== "ContextOnly"
          )
            return unavailable();
          return guest;
        };
        const first = await authenticate();
        const loaded = await preparation.capacity.repository.loadSubmission(submissionReference);
        if (loaded === null) return unavailable();
        const original = parseAsapCapacityCommitment(loaded);
        if (
          String(original.slot.brandReference) !== scope.brandReference ||
          String(original.slot.storeReference) !== scope.storeReference ||
          String(original.guestSessionReference) !== String(first.sessionReference) ||
          String(original.submissionReference) !== String(submissionReference) ||
          String(original.cartReference) !== String(cartReference) ||
          original.cartVersion !== cartVersion ||
          String(original.quoteReference) !== String(quoteReference)
        )
          return unavailable();
        const intent = Object.freeze({
          cartReference: original.cartReference,
          cartVersion: original.cartVersion,
          quoteReference: original.quoteReference,
          submissionReference: original.submissionReference,
        });
        return await createPaymentTipSelectionService({
          ...options.tip,
          scope,
          clock: { now },
          authorization: {
            async authorize(request) {
              const current = await authenticate();
              if (JSON.stringify(current) !== JSON.stringify(first)) return null;
              const prepared =
                request.action === "SelectPaymentTip"
                  ? await owner.prepareForOrdering({ ...credentials, intent })
                  : await owner.prepare({ ...credentials, intent });
              if (request.action === "SelectPaymentTip") {
                const link = pickupOrderCapacityLinkFromHistory(prepared.record);
                const repository = options.submission.repository(link);
                const orderValue = await repository.resolveSubmission(submissionReference);
                const linkValue = await repository.resolveCapacityLink(submissionReference);
                if (orderValue === null || linkValue === null) return null;
                const order =
                  quoteVersion === 2
                    ? parseConfiguredOrderCreationRecord(orderValue)
                    : parseOrderCreationRecord(orderValue);
                const storedLink = parseOrderCapacityLink(linkValue);
                assertOrderCapacityLinkMatches(storedLink, order);
                if (JSON.stringify(storedLink) !== JSON.stringify(link)) return null;
              }
              return {
                ...scope,
                guestSessionReference: current.sessionReference,
                sessionVersion: current.version,
                validUntil: new Date(
                  Math.min(
                    Date.parse(current.idleExpiresAt),
                    Date.parse(current.absoluteExpiresAt),
                    current.closureExpiresAt === null
                      ? Number.POSITIVE_INFINITY
                      : Date.parse(current.closureExpiresAt),
                  ),
                ).toISOString(),
              };
            },
          },
        }).select({
          selectionReference,
          submissionReference,
          cartReference,
          cartVersion,
          quoteReference,
          tip,
          paymentOperationReference: original.paymentOperationReference,
        });
      } catch {
        return unavailable();
      }
    },
  });
}

export function createCustomerPickupTipSelectionComposition(
  options: CustomerPickupTipSelectionOptions,
) {
  return createVersionedCustomerPickupTipSelectionComposition(options, 1);
}
export function createCustomerConfiguredPickupTipSelectionComposition(
  options: CustomerPickupTipSelectionOptions<2>,
) {
  return createVersionedCustomerPickupTipSelectionComposition(options, 2);
}
