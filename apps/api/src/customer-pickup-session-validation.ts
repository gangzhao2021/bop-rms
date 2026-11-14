import { GuestSessionService, parseCanonicalInstant, parseGuestRawCredential } from "@bop/identity";
import {
  CheckoutSessionServiceError,
  createCheckoutValidationService,
  createConfiguredCheckoutValidationService,
  parseCheckoutSessionAllocation,
  CheckoutValidationError,
  type CheckoutValidationPorts,
  type ConfiguredCheckoutValidationPorts,
  isGuestCartChannel,
} from "@rms/ordering";
import type { CustomerCheckoutSessionOptions } from "./customer-checkout-session-composition.js";
import type { CustomerPickupOrderSubmissionOptions } from "./customer-pickup-order-submission-composition.js";
import {
  createCustomerPickupCheckoutComposition,
  pickupOrderCapacityLinkFromHistory,
} from "./customer-pickup-checkout-composition.js";
import { isQuoteExpired } from "./customer-pickup-capacity-sources.js";

type Options<V extends 1 | 2> = Pick<
  CustomerPickupOrderSubmissionOptions<V>,
  "preparation" | "checkout"
>;
const unavailable = (): never => {
  throw new CheckoutValidationError("CHECKOUT_DEPENDENCY_UNAVAILABLE");
};
/**
 * WP-2423 (checkout-session-outage, v15 2026-11-11): Fulfillment refused the pickup because this
 * hour's pickup capacity is taken (counter orders count against it too). By name and code: the
 * pilot can load Fulfillment as two copies.
 */
function isPickupFull(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "AsapCapacityError" &&
    (error as { code?: unknown }).code === "ASAP_CAPACITY_INSUFFICIENT"
  );
}
function create<V extends 1 | 2>(
  options: Options<V>,
  quoteVersion: V,
): CustomerCheckoutSessionOptions["validate"] {
  return async (input) => {
    const allocation = parseCheckoutSessionAllocation(input.allocation);
    const request = input.request;
    for (const field of [
      "createOperationReference",
      "cartReference",
      "cartVersion",
      "quoteReference",
      "quoteVersion",
    ] as const)
      if (request[field] !== allocation[field]) return unavailable();
    if (
      allocation.brandReference !== options.preparation.scope.brandReference ||
      allocation.storeReference !== options.preparation.scope.storeReference ||
      allocation.quoteVersion !== quoteVersion
    )
      return unavailable();
    const credentials = Object.freeze({
      sessionCredential: parseGuestRawCredential(input.sessionCredential),
      csrfCredential: parseGuestRawCredential(input.csrfCredential),
    });
    let last: string | undefined, fingerprint: string | undefined;
    const now = () => {
      const at = parseCanonicalInstant(options.preparation.now());
      if (last !== undefined && at < last) return unavailable();
      last = at;
      return at;
    };
    const identity = new GuestSessionService({
      ...options.preparation.session,
      now,
      admission: { consume: async () => null },
    });
    const authorize = async () => {
      const guest = await identity.authorize({ ...credentials, observedAt: now() });
      if (
        String(guest.sessionReference) !== allocation.guestSessionReference ||
        String(guest.brandReference) !== allocation.brandReference ||
        String(guest.storeReference) !== allocation.storeReference ||
        guest.channel !== "Pickup" ||
        guest.diningState !== "ContextOnly"
      )
        return unavailable();
      const current = JSON.stringify(guest);
      if (fingerprint !== undefined && fingerprint !== current) return unavailable();
      fingerprint = current;
      return { guestSession: guest };
    };
    await authorize();
    const preparation = createCustomerPickupCheckoutComposition({
      ...options.preparation,
      references: {
        generate: (purpose) =>
          purpose === "PaymentOperation"
            ? allocation.paymentOperationReference
            : options.preparation.references.generate(purpose),
      },
    });
    const prepareInput = {
      ...credentials,
      intent: {
        submissionReference: allocation.submissionReference,
        cartReference: allocation.cartReference,
        cartVersion: allocation.cartVersion,
        quoteReference: allocation.quoteReference,
      },
    };
    const fulfillment: CheckoutValidationPorts<V>["fulfillment"] = {
      async validate(command) {
        const result = await preparation.prepareForOrdering(prepareInput);
        const link = pickupOrderCapacityLinkFromHistory(result.record);
        if (
          link.paymentOperationReference !== allocation.paymentOperationReference ||
          link.submissionReference !== allocation.submissionReference ||
          link.guestSessionReference !== allocation.guestSessionReference ||
          link.brandReference !== command.brandReference ||
          link.storeReference !== command.storeReference ||
          link.cartReference !== command.cartReference ||
          link.cartVersion !== command.cartVersion ||
          link.quoteReference !== command.quoteReference ||
          command.orderType !== "Pickup" ||
          !isGuestCartChannel(command.orderType, command.sourceChannel) ||
          command.observedAt < link.preparedAt ||
          String(command.observedAt) > String(now()) ||
          String(now()) >= String(link.validUntil)
        )
          return unavailable();
        return Object.freeze({
          status: "Accepted" as const,
          brandReference: command.brandReference,
          storeReference: command.storeReference,
          cartReference: command.cartReference,
          cartVersion: command.cartVersion,
          quoteReference: command.quoteReference,
          orderType: command.orderType,
          sourceChannel: command.sourceChannel,
          evidenceReference: link.commitmentReference,
          evidenceVersion: link.commitmentVersion,
          evidenceDigest: link.ownerSnapshotDigest,
          checkedAt: command.observedAt,
          validUntil: link.validUntil,
        });
      },
    };
    // Prepare before validation's observation so owner evidence cannot originate in its future.
    let prepared: Awaited<ReturnType<typeof preparation.prepare>>;
    try {
      prepared = await preparation.prepare(prepareInput);
    } catch (error) {
      // The guest is told the hour is full (nothing created or charged), never "try again later"
      // as if the system were down.
      if (isPickupFull(error)) throw new CheckoutSessionServiceError("PICKUP_FULL");
      // WP-2423 (pickup-capacity-and-retry): the price this checkout was asked with is no longer
      // held (e.g. tried again after the hour was full): the page prices the order again.
      if (isQuoteExpired(error)) throw new CheckoutSessionServiceError("REQUOTE_REQUIRED");
      throw error;
    }
    if (prepared.record.paymentOperationReference !== allocation.paymentOperationReference)
      return unavailable();
    const ports = { ...options.checkout, authorization: { authorize }, fulfillment };
    const service =
      quoteVersion === 2
        ? createConfiguredCheckoutValidationService({
            ...ports,
            now,
          } as unknown as ConfiguredCheckoutValidationPorts)
        : createCheckoutValidationService(ports as unknown as CheckoutValidationPorts);
    const evidence = await service.validate({
      validationReference: allocation.checkoutSessionReference,
      cartReference: allocation.cartReference,
      expectedCartVersion: allocation.cartVersion,
      quoteReference: allocation.quoteReference,
      requestedAt: now(),
    });
    await authorize();
    if (String(now()) >= String(evidence.validUntil)) return unavailable();
    return evidence;
  };
}
export function createCustomerPickupSessionValidation(options: Options<1>) {
  return create(options, 1);
}
export function createCustomerConfiguredPickupSessionValidation(options: Options<2>) {
  return create(options, 2);
}
