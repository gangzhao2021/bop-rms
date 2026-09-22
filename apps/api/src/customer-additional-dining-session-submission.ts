import { parseCanonicalInstant, parseGuestRawCredential, readClosedRecord } from "@bop/identity";
import {
  createPostgresDiningCheckoutCommitmentStore,
  parseDiningCheckoutCommitment,
} from "@rms/dining";
import {
  createPostgresAdditionalDiningBatchHistoryReader,
  parseAdditionalDiningBatchSnapshot,
  parseCheckoutSession,
  parseCheckoutValidationEvidence,
  parseConfiguredCheckoutValidationEvidence,
  parseOrderingReference,
  CheckoutSessionServiceError,
} from "@rms/ordering";
import { createCustomerCheckoutSessionRead } from "./customer-checkout-session-read.js";
import type { CustomerCheckoutSessionAuthorizationOptions } from "./customer-checkout-session-authorization.js";
import {
  createCustomerAdditionalDiningSubmissionRuntime,
  type CustomerAdditionalDiningSubmissionRuntimeOptions,
} from "./customer-additional-dining-submission-runtime.js";
import {
  createCustomerOrderSourceComposition,
  createCustomerConfiguredOrderSourceComposition,
  type CustomerOrderSourceOptions,
} from "./customer-order-source-composition.js";
import { diningOrderCapacityLinkFromHistory } from "./customer-dining-checkout-composition.js";

/** Internal session bridge. Parent facts are server-resolved; final writer fences them again. */
export function createCustomerAdditionalDiningSessionSubmission(options: {
  access: CustomerCheckoutSessionAuthorizationOptions;
  runtime: CustomerAdditionalDiningSubmissionRuntimeOptions;
  source: CustomerOrderSourceOptions;
  historyAuthorization: Parameters<
    typeof createPostgresAdditionalDiningBatchHistoryReader
  >[0]["authorize"];
  parent: {
    orderReference: string;
    originalOrderCreatedAt: string;
    expectedOrderVersion: number;
    batchSequence: number;
  };
  nextItemReference(): string;
}) {
  const scope = options.runtime.inventory.scope;
  for (const candidate of [options.access.scope, options.source.scope, options.runtime]) {
    if (
      String(candidate.brandReference) !== String(scope.brandReference) ||
      String(candidate.storeReference) !== String(scope.storeReference)
    )
      throw new CheckoutSessionServiceError("INTENT_CONFLICT");
  }
  const reader = createCustomerCheckoutSessionRead(options.access);
  const runtime = createCustomerAdditionalDiningSubmissionRuntime(options.runtime);
  const history = createPostgresAdditionalDiningBatchHistoryReader({
    ...scope,
    transactions: options.runtime.transactions,
    authorize: options.historyAuthorization,
  });
  const commitments = createPostgresDiningCheckoutCommitmentStore(
    options.runtime.transactions,
    scope,
    { now: () => parseCanonicalInstant(options.source.clock.now()) },
  );
  return Object.freeze({
    async create(value: unknown) {
      const raw = readClosedRecord(value, [
        "sessionCredential",
        "csrfCredential",
        "checkoutSessionReference",
        "tipSelectionReference",
      ]);
      const accessInput = {
        sessionCredential: parseGuestRawCredential(raw.sessionCredential),
        csrfCredential: parseGuestRawCredential(raw.csrfCredential),
        checkoutSessionReference: String(parseOrderingReference(raw.checkoutSessionReference)),
      };
      const tipSelectionReference = String(parseOrderingReference(raw.tipSelectionReference));
      const session = parseCheckoutSession(await reader.read(accessInput)),
        v = session.validation;
      if (
        v.orderType !== "DineIn" ||
        String(v.brandReference) !== String(scope.brandReference) ||
        String(v.storeReference) !== String(scope.storeReference)
      )
        throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      const prior = await history.resolveSubmission(session.submissionReference);
      let result;
      if (prior !== null) {
        const snapshot = parseAdditionalDiningBatchSnapshot(prior);
        const link = await history.resolveCapacityLink(session.submissionReference);
        if (
          !link ||
          String(snapshot.orderReference) !== options.parent.orderReference ||
          snapshot.snapshotVersion !== v.quoteVersion ||
          String(snapshot.guestSessionReference) !== v.guestSessionReference ||
          String(snapshot.batch.sourceCartReference) !== v.cartReference ||
          snapshot.batch.sourceCartVersion !== v.cartVersion ||
          String(snapshot.batch.quoteReference) !== v.quoteReference ||
          String(link.paymentOperationReference) !== session.paymentOperationReference
        )
          throw new CheckoutSessionServiceError("INTENT_CONFLICT");
        result = await runtime.submit({
          sessionCredential: accessInput.sessionCredential,
          csrfCredential: accessInput.csrfCredential,
          snapshot,
          capacityLink: link,
          checkoutValidationEvidence: v,
          tipSelectionReference,
        });
      } else {
        const clock = parseDiningCheckoutCommitment(
          await commitments.loadSubmission(session.submissionReference),
        );
        if (
          clock.state !== "Prepared" ||
          String(clock.orderReference) !== options.parent.orderReference ||
          String(clock.paymentOperationReference) !== session.paymentOperationReference ||
          String(clock.submissionReference) !== session.submissionReference ||
          String(clock.guestSessionReference) !== v.guestSessionReference ||
          String(clock.brandReference) !== v.brandReference ||
          String(clock.storeReference) !== v.storeReference ||
          String(clock.cartReference) !== v.cartReference ||
          clock.cartVersion !== v.cartVersion ||
          String(clock.quoteReference) !== v.quoteReference
        )
          throw new CheckoutSessionServiceError("INTENT_CONFLICT");
        const loaded =
          v.quoteVersion === 2
            ? await createCustomerConfiguredOrderSourceComposition(options.source).load({
                evidence: parseConfiguredCheckoutValidationEvidence(v),
              })
            : await createCustomerOrderSourceComposition(options.source).load({
                evidence: parseCheckoutValidationEvidence(v),
              });
        const at = parseCanonicalInstant(options.source.clock.now());
        result = await runtime.submitCheckout({
          sessionCredential: accessInput.sessionCredential,
          csrfCredential: accessInput.csrfCredential,
          capacityLink: diningOrderCapacityLinkFromHistory(clock),
          tipSelectionReference,
          checkout: {
            quoteVersion: v.quoteVersion,
            submissionReference: session.submissionReference,
            submittedAt: at,
            parent: {
              ...options.parent,
              brandReference: v.brandReference,
              storeReference: v.storeReference,
              diningSessionReference: clock.diningSessionReference,
            },
            snapshot: {
              orderReference: clock.orderReference,
              orderBatchReference: clock.orderBatchReference,
              snapshotCapturedAt: v.validatedAt,
              checkoutValidationEvidence: v,
              cart: loaded.cart,
              lines: loaded.lines.map((line) => ({
                ...line,
                orderItemReference: parseOrderingReference(options.nextItemReference()),
              })),
            },
          },
        });
      }
      if (
        JSON.stringify(parseCheckoutSession(await reader.read(accessInput))) !==
        JSON.stringify(session)
      )
        throw new CheckoutSessionServiceError("PERMISSION_DENIED");
      return Object.freeze({
        status: result.status === "Existing" ? "AlreadyCreated" : "Created",
        record: result.snapshot,
        session,
      });
    },
  });
}
