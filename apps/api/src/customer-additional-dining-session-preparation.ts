import { parseCanonicalInstant, parseGuestRawCredential, readClosedRecord } from "@bop/identity";
import {
  createPostgresDiningCheckoutCommitmentStore,
  parseDiningCheckoutCommitment,
} from "@rms/dining";
import {
  createPostgresCartQueryStore,
  createPostgresDiningOrderPreparationSource,
  parseCartAggregate,
  parseCheckoutSession,
  parseOrderingReference,
  CheckoutSessionServiceError,
} from "@rms/ordering";
import { createCustomerCheckoutSessionRead } from "./customer-checkout-session-read.js";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import { createPersistentAdditionalDiningPreparation } from "./customer-additional-dining-preparation.js";

/** Server-selected target Order; current owner queries authorize it, never a browser-supplied parent. */
export function createCustomerAdditionalDiningSessionPreparation(options: {
  access: CustomerCheckoutSessionAuthorizationOptions;
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  preparation: Parameters<typeof createPersistentAdditionalDiningPreparation>[0];
  orderReference: string;
}) {
  const orderReference = String(parseOrderingReference(options.orderReference));
  const { scope } = options;
  const configured = options.preparation;
  for (const candidate of [options.access.scope, configured.preparation.scope])
    if (
      String(candidate.brandReference) !== String(scope.brandReference) ||
      String(candidate.storeReference) !== String(scope.storeReference)
    )
      throw new CheckoutSessionServiceError("INTENT_CONFLICT");
  const access = createCustomerCheckoutSessionRead(options.access);
  const commitments = createPostgresDiningCheckoutCommitmentStore(configured.transactions, scope, {
    now: () => parseCanonicalInstant(configured.preparation.now()),
  });
  const carts = createPostgresCartQueryStore(configured.transactions, configured.preparation.scope);
  const parents = createPostgresDiningOrderPreparationSource({
    ...configured.preparation.scope,
    authorize: configured.authorizeOrder,
  });
  return Object.freeze({
    async prepare(value: unknown) {
      const raw = readClosedRecord(value, [
        "sessionCredential",
        "csrfCredential",
        "checkoutSessionReference",
      ]);
      const input = {
        sessionCredential: parseGuestRawCredential(raw.sessionCredential),
        csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        checkoutSessionReference: String(parseOrderingReference(raw.checkoutSessionReference)),
      };
      const session = parseCheckoutSession(await access.read(input)),
        v = session.validation;
      if (
        v.orderType !== "DineIn" ||
        String(v.brandReference) !== scope.brandReference ||
        String(v.storeReference) !== scope.storeReference
      )
        throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      let saved = await commitments.loadSubmission(session.submissionReference);
      if (saved === null) {
        const cart = parseCartAggregate(await carts.load(v.cartReference));
        if (
          cart.orderType !== "DineIn" ||
          cart.diningSessionReference === null ||
          String(cart.brandReference) !== v.brandReference ||
          String(cart.storeReference) !== v.storeReference ||
          String(cart.cartReference) !== v.cartReference ||
          cart.aggregateVersion !== v.cartVersion
        )
          throw new CheckoutSessionServiceError("INTENT_CONFLICT");
        const diningSessionReference = cart.diningSessionReference;
        const parent = await configured.transactions.run((transaction) =>
          parents.resolveAdditionalParent({
            transaction,
            brandReference: v.brandReference,
            storeReference: v.storeReference,
            orderReference,
            diningSessionReference,
            guestSessionReference: v.guestSessionReference,
            observedAt: parseCanonicalInstant(configured.preparation.now()),
          }),
        );
        if (parent === null) throw new CheckoutSessionServiceError("DEPENDENCY_UNAVAILABLE");
        const service = createPersistentAdditionalDiningPreparation({
          ...configured,
          preparation: {
            ...configured.preparation,
            submissions: commitments,
            references: {
              generate: (purpose) =>
                purpose === "PaymentOperation"
                  ? session.paymentOperationReference
                  : configured.preparation.references.generate(purpose),
            },
          },
        });
        saved = (
          await service.prepareForOrdering({
            sessionCredential: input.sessionCredential,
            csrfCredential: input.csrfCredential,
            orderReference,
            expectedOrderVersion: parent.orderVersion,
            intent: {
              submissionReference: session.submissionReference,
              cartReference: v.cartReference,
              cartVersion: v.cartVersion,
              quoteReference: v.quoteReference,
              sourceValidUntil: v.validUntil,
            },
          })
        ).record;
      }
      const record = parseDiningCheckoutCommitment(saved);
      if (
        String(record.orderReference) !== orderReference ||
        String(record.submissionReference) !== session.submissionReference ||
        String(record.paymentOperationReference) !== session.paymentOperationReference ||
        String(record.brandReference) !== v.brandReference ||
        String(record.storeReference) !== v.storeReference ||
        String(record.guestSessionReference) !== v.guestSessionReference ||
        String(record.cartReference) !== v.cartReference ||
        record.cartVersion !== v.cartVersion ||
        String(record.quoteReference) !== v.quoteReference
      )
        throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      if (
        JSON.stringify(parseCheckoutSession(await access.read(input))) !== JSON.stringify(session)
      )
        throw new CheckoutSessionServiceError("PERMISSION_DENIED");
      return Object.freeze({ record, session });
    },
  });
}
