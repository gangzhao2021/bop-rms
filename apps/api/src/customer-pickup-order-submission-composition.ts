import {
  GuestSessionError,
  parseCanonicalInstant,
  GuestSessionService,
  parseGuestRawCredential,
  readClosedRecord,
} from "@bop/identity";
import {
  createCheckoutValidationService,
  createConfiguredCheckoutValidationService,
  type ConfiguredCheckoutValidationPorts,
  type CheckoutValidationEvidence,
  assertOrderCapacityLinkMatches,
  createCapacityLinkedOrderCreationService,
  parseOrderingInstant,
  parseOrderingReference,
  CheckoutValidationError,
  OrderCreationError,
  type CheckoutValidationPorts,
  type CapacityLinkedOrderCreationPorts,
  type OrderCapacityLink,
} from "@rms/ordering";
import {
  createCustomerPickupCheckoutComposition,
  pickupOrderCapacityLinkFromHistory,
  type CustomerPickupCheckoutOptions,
} from "./customer-pickup-checkout-composition.js";

export interface CustomerPickupOrderSubmissionOptions<V extends 1 | 2 = 1> {
  readonly preparation: CustomerPickupCheckoutOptions;
  readonly checkout: Omit<CheckoutValidationPorts<V>, "authorization" | "fulfillment"> &
    (V extends 2
      ? Pick<ConfiguredCheckoutValidationPorts, "history" | "snapshots" | "pricingChannelCode">
      : Record<never, never>);
  readonly ordering: Omit<
    CapacityLinkedOrderCreationPorts<V>,
    "authorization" | "checkout" | "repository" | "clock"
  >;
  readonly repository: (
    link: OrderCapacityLink,
    authorization?: CapacityLinkedOrderCreationPorts<V>["authorization"],
  ) => CapacityLinkedOrderCreationPorts<V>["repository"];
}
const unavailable = (): never => {
  throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
};

/** Internal composition only; Inventory finalization and Payment activation remain separate gates. */
function createVersionedCustomerPickupOrderSubmissionComposition<V extends 1 | 2>(
  options: CustomerPickupOrderSubmissionOptions<V>,
  quoteVersion: V,
) {
  const preparation = createCustomerPickupCheckoutComposition(options.preparation);
  const scope = Object.freeze({
    brandReference: parseOrderingReference(options.preparation.scope.brandReference),
    storeReference: parseOrderingReference(options.preparation.scope.storeReference),
  });
  async function create(value: unknown) {
    try {
      const raw = readClosedRecord(value, [
        "sessionCredential",
        "csrfCredential",
        "submissionReference",
        "cartReference",
        "expectedCartVersion",
        "quoteReference",
      ]);
      const credentials = Object.freeze({
        sessionCredential: parseGuestRawCredential(raw.sessionCredential),
        csrfCredential: parseGuestRawCredential(raw.csrfCredential),
      });
      const submissionReference = parseOrderingReference(raw.submissionReference);
      const cartReference = parseOrderingReference(raw.cartReference);
      const quoteReference = parseOrderingReference(raw.quoteReference);
      if (!Number.isSafeInteger(raw.expectedCartVersion) || (raw.expectedCartVersion as number) < 1)
        return unavailable();
      const expectedCartVersion = raw.expectedCartVersion as number;
      let last: string | undefined;
      const now = () => {
        const at = parseOrderingInstant(options.preparation.now());
        if (last !== undefined && at < last) return unavailable();
        last = at;
        return at;
      };
      const identity = new GuestSessionService({
        ...options.preparation.session,
        now: () => parseCanonicalInstant(now()),
        admission: { consume: async () => null },
      });
      const authorize = async () => {
        const guest = await identity.authorize({ ...credentials, observedAt: now() });
        if (
          String(guest.brandReference) !== String(scope.brandReference) ||
          String(guest.storeReference) !== String(scope.storeReference) ||
          guest.channel !== "Pickup" ||
          guest.diningState !== "ContextOnly"
        )
          return unavailable();
        return { guestSession: guest };
      };
      await authorize();
      const prepareInput = {
        ...credentials,
        intent: {
          submissionReference,
          cartReference,
          cartVersion: expectedCartVersion,
          quoteReference,
        },
      };
      const prepared = await preparation.prepare(prepareInput);
      const link = pickupOrderCapacityLinkFromHistory(prepared.record);
      const service = createCapacityLinkedOrderCreationService(
        {
          ...options.ordering,
          clock: { now },
          authorization: { authorize },
          repository: options.repository(link, { authorize }),
          checkout: {
            async validate(command) {
              const checkoutPorts: CheckoutValidationPorts<V> = {
                ...options.checkout,
                authorization: { authorize },
                fulfillment: {
                  async validate(request) {
                    const current = await preparation.prepareForOrdering(prepareInput);
                    if (
                      JSON.stringify(pickupOrderCapacityLinkFromHistory(current.record)) !==
                      JSON.stringify(link)
                    )
                      return unavailable();
                    const at = now();
                    if (
                      request.brandReference !== link.brandReference ||
                      request.storeReference !== link.storeReference ||
                      request.cartReference !== link.cartReference ||
                      request.cartVersion !== link.cartVersion ||
                      request.quoteReference !== link.quoteReference ||
                      request.orderType !== "Pickup" ||
                      !["Qr", "Web"].includes(request.sourceChannel) ||
                      request.observedAt < link.preparedAt ||
                      request.observedAt > at ||
                      at >= link.validUntil
                    )
                      return unavailable();
                    return Object.freeze({
                      status: "Accepted" as const,
                      brandReference: link.brandReference,
                      storeReference: link.storeReference,
                      cartReference: link.cartReference,
                      cartVersion: link.cartVersion,
                      quoteReference: link.quoteReference,
                      orderType: "Pickup" as const,
                      sourceChannel: request.sourceChannel,
                      evidenceReference: link.commitmentReference,
                      evidenceVersion: link.commitmentVersion,
                      evidenceDigest: link.ownerSnapshotDigest,
                      checkedAt: request.observedAt,
                      validUntil: link.validUntil,
                    });
                  },
                },
              };
              const checkout =
                quoteVersion === 2
                  ? createConfiguredCheckoutValidationService({
                      ...checkoutPorts,
                      ...options.checkout,
                      authorization: { authorize },
                      fulfillment: checkoutPorts.fulfillment,
                      now,
                    } as unknown as ConfiguredCheckoutValidationPorts)
                  : createCheckoutValidationService(
                      checkoutPorts as unknown as CheckoutValidationPorts,
                    );
              const evidence = await checkout.validate(command);
              if (now() >= evidence.validUntil) return unavailable();
              return evidence as CheckoutValidationEvidence<V>;
            },
          },
        },
        link,
        quoteVersion,
      );
      return await service.create({
        submissionReference,
        cartReference,
        expectedCartVersion,
        quoteReference,
        requestedAt: now(),
      });
    } catch (error) {
      if (error instanceof OrderCreationError || error instanceof CheckoutValidationError)
        throw error;
      return unavailable();
    }
  }
  return Object.freeze({
    create,
    async preparePaymentClock(value: unknown) {
      try {
        const raw = readClosedRecord(value, [
          "sessionCredential",
          "csrfCredential",
          "submissionReference",
          "cartReference",
          "expectedCartVersion",
          "quoteReference",
        ]);
        const credentials = {
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        };
        const result = await create({ ...raw, ...credentials });
        const composition = createCustomerPickupCheckoutComposition({
          ...options.preparation,
          clock: {
            ordering: {
              async resolve({ record }) {
                const link = pickupOrderCapacityLinkFromHistory(record);
                const repository = options.repository(link);
                const stored = await repository.resolveSubmission(link.submissionReference);
                const storedLink = await repository.resolveCapacityLink(link.submissionReference);
                if (
                  stored === null ||
                  storedLink === null ||
                  JSON.stringify(storedLink) !== JSON.stringify(link)
                )
                  return unavailable();
                assertOrderCapacityLinkMatches(link, stored);
                if (stored.order.orderReference !== result.record.order.orderReference)
                  return unavailable();
                return {
                  allocationReference: record.allocationReference,
                  guestSessionReference: record.guestSessionReference,
                  cartReference: record.cartReference,
                  quoteReference: record.quoteReference,
                  submissionReference: record.submissionReference,
                  orderReference: record.orderReference,
                  orderBatchReference: record.orderBatchReference,
                  fulfillmentReference: record.fulfillmentReference,
                  paymentOperationReference: record.paymentOperationReference,
                  brandReference: record.slot.brandReference,
                  storeReference: record.slot.storeReference,
                  cartVersion: record.cartVersion,
                  intentDigest: record.intentDigest,
                  acknowledgedAt: parseOrderingInstant(options.preparation.now()),
                };
              },
            },
          },
        });
        const sealed = await composition.sealClock({
          ...credentials,
          intent: {
            submissionReference: raw.submissionReference,
            cartReference: raw.cartReference,
            cartVersion: raw.expectedCartVersion,
            quoteReference: raw.quoteReference,
          },
        });
        return Object.freeze({ order: result.record, clock: sealed.record });
      } catch (error) {
        if (error instanceof OrderCreationError || error instanceof CheckoutValidationError)
          throw error;
        return unavailable();
      }
    },
  });
}

export function createCustomerPickupOrderSubmissionComposition(
  options: CustomerPickupOrderSubmissionOptions,
) {
  return createVersionedCustomerPickupOrderSubmissionComposition(options, 1);
}
export function createCustomerConfiguredPickupOrderSubmissionComposition(
  options: CustomerPickupOrderSubmissionOptions<2>,
) {
  return createVersionedCustomerPickupOrderSubmissionComposition(options, 2);
}
