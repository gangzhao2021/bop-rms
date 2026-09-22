import { createPersistentAdditionalDiningPreparation } from "./customer-additional-dining-preparation.js";
import {
  GuestSessionError,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
} from "@bop/identity";
import { parseDiningCheckoutCommitment } from "@rms/dining";
import {
  assertOrderCapacityLinkMatches,
  parseOrderCapacityLink,
  parseOrderCreationRecord,
  parseConfiguredOrderCreationRecord,
  parseOrderingReference,
} from "@rms/ordering";
import { createMoney, type Money } from "@rms/pricing";
import {
  createPaymentTipSelectionService,
  createPostgresPaymentTipSelectionStore,
  type PaymentTipSelectionPorts,
} from "@rms/payment";
import {
  createCustomerDiningCheckoutIdentity,
  createCustomerDiningCheckoutComposition,
  diningOrderCapacityLinkFromHistory,
} from "./customer-dining-checkout-composition.js";
import type { CustomerDiningOrderSubmissionOptions } from "./customer-dining-order-submission-composition.js";

export interface CustomerDiningTipSelectionOptions<V extends 1 | 2 = 1> {
  readonly submission: Pick<CustomerDiningOrderSubmissionOptions<V>, "preparation" | "repository">;
  readonly tip: Pick<PaymentTipSelectionPorts, "repository" | "audit">;
}
const unavailable = (): never => {
  throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
};
/** Internal post-submission, pre-clock selection. Does not create Orders or call a Provider. */
function createVersionedCustomerDiningTipSelectionComposition<V extends 1 | 2>(
  options:
    | CustomerDiningTipSelectionOptions<V>
    | {
        submission: Pick<CustomerDiningTipSelectionOptions<V>["submission"], "preparation">;
        tip: CustomerDiningTipSelectionOptions<V>["tip"];
      },
  quoteVersion: V,
  additional?: ReturnType<typeof createPersistentAdditionalDiningPreparation>,
) {
  const preparation = options.submission.preparation;
  const owner = createCustomerDiningCheckoutComposition(preparation);
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
          ...(additional ? ["orderReference", "expectedOrderVersion"] : []),
        ]);
        const credentials = Object.freeze({
          sessionCredential: parseGuestRawCredential(raw.sessionCredential),
          csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        });
        const orderReference = additional ? parseOrderingReference(raw.orderReference) : null;
        const expectedOrderVersion = raw.expectedOrderVersion;
        if (
          additional &&
          (typeof expectedOrderVersion !== "number" ||
            !Number.isInteger(expectedOrderVersion) ||
            expectedOrderVersion < 1 ||
            expectedOrderVersion >= 2147483647)
        )
          return unavailable();
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
        const identity = createCustomerDiningCheckoutIdentity(preparation, scope, now);
        const authenticate = async () => {
          const guest = await identity.authorize({ ...credentials, observedAt: now() });
          if (
            guest.brandReference !== scope.brandReference ||
            guest.storeReference !== scope.storeReference ||
            guest.channel !== "DineIn" ||
            guest.diningState !== "DiningBound"
          )
            return unavailable();
          return guest;
        };
        const first = await authenticate();
        const loaded = await preparation.submissions.loadSubmission(submissionReference);
        if (loaded === null) return unavailable();
        const original = parseDiningCheckoutCommitment(loaded);
        if (
          (additional && String(original.orderReference) !== String(orderReference)) ||
          String(original.brandReference) !== scope.brandReference ||
          String(original.storeReference) !== scope.storeReference ||
          String(original.guestSessionReference) !== String(first.sessionReference) ||
          String(original.diningSessionReference) !== String(first.diningSessionReference) ||
          String(original.participantReference) !== String(first.diningParticipantReference) ||
          String(original.submissionReference) !== String(submissionReference) ||
          String(original.cartReference) !== String(cartReference) ||
          original.cartVersion !== cartVersion ||
          String(original.quoteReference) !== String(quoteReference)
        )
          return unavailable();
        const intent = Object.freeze({
          commitmentReference: original.commitmentReference,
          cartReference: original.cartReference,
          cartVersion: original.cartVersion,
          quoteReference: original.quoteReference,
          submissionReference: original.submissionReference,
          orderReference: original.orderReference,
          orderBatchReference: original.orderBatchReference,
          paymentOperationReference: original.paymentOperationReference,
          sourceValidUntil: original.preparationValidUntil,
        });
        return await createPaymentTipSelectionService({
          ...options.tip,
          scope,
          clock: { now },
          authorization: {
            async authorize(request) {
              const current = await authenticate();
              if (JSON.stringify(current) !== JSON.stringify(first)) return null;
              if (
                additional &&
                request.action === "SelectPaymentTip" &&
                original.state !== "Prepared"
              )
                return null;
              const prepared =
                request.action === "SelectPaymentTip"
                  ? additional
                    ? await additional.prepareForOrdering({
                        ...credentials,
                        intent: {
                          submissionReference: original.submissionReference,
                          cartReference: original.cartReference,
                          cartVersion: original.cartVersion,
                          quoteReference: original.quoteReference,
                          sourceValidUntil: original.preparationValidUntil,
                        },
                        orderReference,
                        expectedOrderVersion,
                      })
                    : await owner.prepareForOrdering({ ...credentials, intent })
                  : await owner.prepare({ ...credentials, intent });
              if (
                additional &&
                request.action === "SelectPaymentTip" &&
                (prepared.record.state !== "Prepared" ||
                  Date.parse(prepared.record.preparationValidUntil) <= Date.parse(now()))
              )
                return null;
              if (request.action === "SelectPaymentTip" && !additional) {
                if (!("repository" in options.submission)) return null;
                const link = diningOrderCapacityLinkFromHistory(prepared.record);
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

export function createCustomerDiningTipSelectionComposition(
  options: CustomerDiningTipSelectionOptions,
) {
  return createVersionedCustomerDiningTipSelectionComposition(options, 1);
}
export function createCustomerConfiguredDiningTipSelectionComposition(
  options: CustomerDiningTipSelectionOptions<2>,
) {
  return createVersionedCustomerDiningTipSelectionComposition(options, 2);
}

/** Select before additional Batch submission seals its original payment clock. */
export function createPersistentAdditionalDiningTipSelection(
  options: Parameters<typeof createPersistentAdditionalDiningPreparation>[0] & {
    tip: Pick<CustomerDiningTipSelectionOptions["tip"], "audit">;
    quoteVersion?: 1 | 2;
  },
) {
  const quoteVersion = options.quoteVersion ?? 1;
  if (quoteVersion !== 1 && quoteVersion !== 2) return unavailable();
  return createVersionedCustomerDiningTipSelectionComposition(
    {
      submission: { preparation: options.preparation },
      tip: {
        audit: options.tip.audit,
        repository: createPostgresPaymentTipSelectionStore(
          options.transactions,
          options.preparation.scope,
          { now: () => parseCanonicalInstant(options.preparation.now()) },
        ),
      },
    },
    quoteVersion,
    createPersistentAdditionalDiningPreparation(options),
  );
}
