import {
  GuestSessionError,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
} from "@bop/identity";
import { parseDiningCheckoutCommitment, type DiningCheckoutClockOptions } from "@rms/dining";
import {
  createCheckoutValidationService,
  createConfiguredCheckoutValidationService,
  type ConfiguredCheckoutValidationPorts,
  type CheckoutValidationEvidence,
  assertOrderCapacityLinkMatches,
  createCapacityLinkedOrderCreationService,
  parseCartAggregate,
  parseCartQuoteAttachment,
  parseConfiguredCartQuoteAttachment,
  parseOrderingInstant,
  parseOrderingReference,
  CheckoutValidationError,
  OrderCreationError,
  type CheckoutValidationPorts,
  type CapacityLinkedOrderCreationPorts,
  type OrderCapacityLink,
} from "@rms/ordering";
import {
  createCustomerDiningCheckoutIdentity,
  createCustomerDiningCheckoutComposition,
  createCustomerDiningSubmissionPreparation,
  diningOrderCapacityLinkFromHistory,
  type CustomerDiningSubmissionPreparationOptions,
} from "./customer-dining-checkout-composition.js";

export interface CustomerDiningOrderSubmissionOptions<V extends 1 | 2 = 1> {
  readonly preparation: CustomerDiningSubmissionPreparationOptions;
  readonly clock?: Pick<DiningCheckoutClockOptions, "repository" | "audit">;
  readonly checkout: Omit<CheckoutValidationPorts<V>, "authorization" | "fulfillment"> &
    (V extends 2
      ? Pick<ConfiguredCheckoutValidationPorts, "history" | "snapshots" | "pricingChannelCode">
      : Record<never, never>);
  readonly ordering: Omit<
    CapacityLinkedOrderCreationPorts<V>,
    "authorization" | "checkout" | "repository" | "clock"
  >;
  /** Must bind the actual atomically linked Ordering owner repository to this receipt. */
  readonly repository: (
    link: OrderCapacityLink,
    authorization?: CapacityLinkedOrderCreationPorts<V>["authorization"],
  ) => CapacityLinkedOrderCreationPorts<V>["repository"];
}
const unavailable = (): never => {
  throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
};

/** Internal composition only; Inventory finalization and Payment activation remain separate gates. */
function createVersionedCustomerDiningOrderSubmissionComposition<V extends 1 | 2>(
  options: CustomerDiningOrderSubmissionOptions<V>,
  quoteVersion: V,
) {
  const preparation = createCustomerDiningSubmissionPreparation(options.preparation);
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
      const identity = createCustomerDiningCheckoutIdentity(options.preparation, scope, () =>
        parseCanonicalInstant(now()),
      );
      const authorize = async () => {
        const guest = await identity.authorize({ ...credentials, observedAt: now() });
        if (
          String(guest.brandReference) !== String(scope.brandReference) ||
          String(guest.storeReference) !== String(scope.storeReference) ||
          guest.channel !== "DineIn" ||
          guest.diningState !== "DiningBound"
        )
          return unavailable();
        return { guestSession: guest };
      };
      const authorized = await authorize();
      const old = await options.preparation.submissions.loadSubmission(submissionReference);
      let sourceValidUntil: string;
      if (old !== null) {
        const history = parseDiningCheckoutCommitment(old);
        if (
          String(history.submissionReference) !== String(submissionReference) ||
          String(history.brandReference) !== String(scope.brandReference) ||
          String(history.storeReference) !== String(scope.storeReference)
        )
          return unavailable();
        sourceValidUntil = history.preparationValidUntil;
      } else {
        const [cartValue, quoteValue] = await Promise.all([
          options.checkout.repository.loadCart(cartReference),
          options.checkout.repository.loadQuote(cartReference),
        ]);
        if (cartValue === null || quoteValue === null) return unavailable();
        const cart = parseCartAggregate(cartValue),
          quote =
            quoteVersion === 2
              ? parseConfiguredCartQuoteAttachment(quoteValue)
              : parseCartQuoteAttachment(quoteValue);
        if (
          cart.cartReference !== cartReference ||
          cart.aggregateVersion !== expectedCartVersion ||
          cart.brandReference !== scope.brandReference ||
          cart.storeReference !== scope.storeReference ||
          cart.orderType !== "DineIn" ||
          String(cart.diningSessionReference) !==
            String(authorized.guestSession.diningSessionReference) ||
          quote.cartReference !== cartReference ||
          quote.cartVersion !== expectedCartVersion ||
          quote.brandReference !== scope.brandReference ||
          quote.storeReference !== scope.storeReference ||
          quote.quoteReference !== quoteReference
        )
          return unavailable();
        sourceValidUntil = new Date(
          Math.min(
            Date.parse(quote.quoteExpiresAt),
            Date.parse(cart.lifecycle?.idleExpiresAt ?? quote.quoteExpiresAt),
            Date.parse(cart.lifecycle?.absoluteExpiresAt ?? quote.quoteExpiresAt),
          ),
        ).toISOString();
      }
      const prepareInput = {
        ...credentials,
        intent: {
          submissionReference,
          cartReference,
          cartVersion: expectedCartVersion,
          quoteReference,
          sourceValidUntil,
        },
      };
      const prepared = await preparation.prepare(prepareInput);
      const link = diningOrderCapacityLinkFromHistory(prepared.record);
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
                    if (JSON.stringify(current.link) !== JSON.stringify(link)) return unavailable();
                    const at = now();
                    if (
                      request.brandReference !== link.brandReference ||
                      request.storeReference !== link.storeReference ||
                      request.cartReference !== link.cartReference ||
                      request.cartVersion !== link.cartVersion ||
                      request.quoteReference !== link.quoteReference ||
                      request.orderType !== "DineIn" ||
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
                      orderType: "DineIn" as const,
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
        if (options.clock === undefined) return unavailable();
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
        const result = await create({ ...raw, ...credentials });
        const history = parseDiningCheckoutCommitment(
          await options.preparation.submissions.loadSubmission(result.record.submissionReference),
        );
        const composition = createCustomerDiningCheckoutComposition({
          ...options.preparation,
          clock: {
            ...options.clock,
            ordering: {
              async resolve({ record }) {
                const link = diningOrderCapacityLinkFromHistory(record);
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
                // This is acknowledgement after positive reads, never an engine commit timestamp.
                return {
                  commitmentReference: record.commitmentReference,
                  brandReference: record.brandReference,
                  storeReference: record.storeReference,
                  submissionReference: record.submissionReference,
                  orderReference: record.orderReference,
                  orderBatchReference: record.orderBatchReference,
                  cartReference: record.cartReference,
                  cartVersion: record.cartVersion,
                  quoteReference: record.quoteReference,
                  paymentOperationReference: record.paymentOperationReference,
                  guestSessionReference: record.guestSessionReference,
                  intentHash: record.intentHash,
                  acknowledgedAt: parseOrderingInstant(options.preparation.now()),
                };
              },
            },
          },
        });
        const sealed = await composition.sealClock({
          ...credentials,
          intent: {
            submissionReference: history.submissionReference,
            cartReference: history.cartReference,
            cartVersion: history.cartVersion,
            quoteReference: history.quoteReference,
            sourceValidUntil: history.preparationValidUntil,
            commitmentReference: history.commitmentReference,
            orderReference: history.orderReference,
            orderBatchReference: history.orderBatchReference,
            paymentOperationReference: history.paymentOperationReference,
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

export function createCustomerDiningOrderSubmissionComposition(
  options: CustomerDiningOrderSubmissionOptions,
) {
  return createVersionedCustomerDiningOrderSubmissionComposition(options, 1);
}
export function createCustomerConfiguredDiningOrderSubmissionComposition(
  options: CustomerDiningOrderSubmissionOptions<2>,
) {
  return createVersionedCustomerDiningOrderSubmissionComposition(options, 2);
}
