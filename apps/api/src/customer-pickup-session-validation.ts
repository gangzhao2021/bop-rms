import { GuestSessionService, parseCanonicalInstant, parseGuestRawCredential } from "@bop/identity";
import {
  createCheckoutValidationService,
  createConfiguredCheckoutValidationService,
  parseCheckoutSessionAllocation,
  CheckoutValidationError,
  type CheckoutValidationPorts,
  type ConfiguredCheckoutValidationPorts,
} from "@rms/ordering";
import type { CustomerCheckoutSessionOptions } from "./customer-checkout-session-composition.js";
import type { CustomerPickupOrderSubmissionOptions } from "./customer-pickup-order-submission-composition.js";
import {
  createCustomerPickupCheckoutComposition,
  pickupOrderCapacityLinkFromHistory,
} from "./customer-pickup-checkout-composition.js";

type Options<V extends 1 | 2> = Pick<
  CustomerPickupOrderSubmissionOptions<V>,
  "preparation" | "checkout"
>;
const unavailable = (): never => {
  throw new CheckoutValidationError("CHECKOUT_DEPENDENCY_UNAVAILABLE");
};
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
          !["Qr", "Web"].includes(command.sourceChannel) ||
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
    const prepared = await preparation.prepare(prepareInput);
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
