import { parseCanonicalInstant } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresDiningCheckoutCommitmentStore,
  parseDiningCheckoutCommitment,
} from "@rms/dining";
import {
  createPostgresAdditionalDiningBatchHistoryReader,
  parseCheckoutSession,
  parseOrderingReference,
  CheckoutSessionServiceError,
} from "@rms/ordering";
import { createCustomerCheckoutSessionRead } from "./customer-checkout-session-read.js";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import { diningOrderCapacityLinkFromHistory } from "./customer-dining-checkout-composition.js";

/** Historical clock recovery includes sealed expired commitments without changing their state.
 * Current claim eligibility remains with Payment admission; history is never a new clock. */
export function createCustomerAdditionalDiningSessionClock(options: {
  access: CustomerCheckoutSessionAuthorizationOptions;
  scope: { tenantReference: string; brandReference: string; storeReference: string };
  transactions: { run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T> };
  authorizeHistory: Parameters<
    typeof createPostgresAdditionalDiningBatchHistoryReader
  >[0]["authorize"];
  now(): unknown;
}) {
  const scope = {
    tenantReference: String(parseOrderingReference(options.scope.tenantReference)),
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
  };
  if (
    scope.brandReference !== String(parseOrderingReference(options.access.scope.brandReference)) ||
    scope.storeReference !== String(parseOrderingReference(options.access.scope.storeReference))
  )
    throw new CheckoutSessionServiceError("INTENT_CONFLICT");
  const access = createCustomerCheckoutSessionRead(options.access);
  return Object.freeze({
    async preparePaymentClock(input: unknown) {
      const session = parseCheckoutSession(await access.read(input));
      if (
        session.validation.orderType !== "DineIn" ||
        String(session.validation.brandReference) !== scope.brandReference ||
        String(session.validation.storeReference) !== scope.storeReference
      )
        throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      return options.transactions.run(async (transaction) => {
        const bound = {
          run: async <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(transaction),
        };
        const history = createPostgresAdditionalDiningBatchHistoryReader({
          ...scope,
          transactions: bound,
          authorize: options.authorizeHistory,
        });
        const order = await history.resolveSubmission(session.submissionReference);
        const link = await history.resolveCapacityLink(session.submissionReference);
        const store = createPostgresDiningCheckoutCommitmentStore(bound, scope, {
          now: () => parseCanonicalInstant(options.now()),
        });
        const clock = parseDiningCheckoutCommitment(
          await store.loadSubmission(session.submissionReference),
        );
        if (
          !order ||
          !link ||
          !["PaymentPending", "Expired"].includes(clock.state) ||
          clock.orderingLinkedAt === null ||
          clock.paymentRequestedAt === null ||
          clock.capacityExpiresAt === null ||
          order.snapshotVersion !== session.validation.quoteVersion ||
          String(order.guestSessionReference) !==
            String(session.validation.guestSessionReference) ||
          String(order.batch.submissionReference) !== session.submissionReference ||
          String(order.batch.sourceCartReference) !== session.validation.cartReference ||
          order.batch.sourceCartVersion !== session.validation.cartVersion ||
          String(order.batch.quoteReference) !== session.validation.quoteReference ||
          String(link.paymentOperationReference) !== session.paymentOperationReference ||
          String(clock.orderReference) !== String(order.orderReference) ||
          String(clock.orderBatchReference) !== String(order.batch.orderBatchReference) ||
          Date.parse(order.batch.submittedAt) > Date.parse(clock.orderingLinkedAt) ||
          Date.parse(clock.paymentRequestedAt) > Date.parse(parseCanonicalInstant(options.now())) ||
          JSON.stringify(diningOrderCapacityLinkFromHistory(clock)) !== JSON.stringify(link)
        )
          throw new CheckoutSessionServiceError("INTENT_CONFLICT");
        if (
          JSON.stringify(parseCheckoutSession(await access.read(input))) !==
            JSON.stringify(session) ||
          (await options.authorizeHistory(transaction, {
            ...scope,
            submissionReference: session.submissionReference,
          })) !== true
        )
          throw new CheckoutSessionServiceError("PERMISSION_DENIED");
        return Object.freeze({ order, clock, session });
      });
    },
  });
}
