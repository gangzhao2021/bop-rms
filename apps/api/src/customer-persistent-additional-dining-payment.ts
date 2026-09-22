import { createMoney, type Money } from "@rms/pricing";
import { createCustomerAdditionalDiningSessionPreparation } from "./customer-additional-dining-session-preparation.js";
import { parseCanonicalInstant, readClosedRecord } from "@bop/identity";
import {
  createPostgresDiningCheckoutCommitmentStore,
  parseDiningCheckoutCommitment,
} from "@rms/dining";
import {
  createPostgresAdditionalDiningBatchHistoryReader,
  createPostgresDiningOrderPreparationSource,
  parseAdditionalDiningBatchSnapshot,
  parseCheckoutSession,
  parseOrderingReference,
  CheckoutSessionServiceError,
} from "@rms/ordering";
import { createCustomerCheckoutSessionRead } from "./customer-checkout-session-read.js";
import { createCustomerAdditionalDiningPaymentComposition } from "./customer-additional-dining-payment-composition.js";
type Base = Parameters<typeof createCustomerAdditionalDiningPaymentComposition>[0];

/** Resolves parent facts through owning stores; callers cannot inject parent versions/counts. */
export function createCustomerPersistentAdditionalDiningPayment(
  options: Omit<Base, "submission"> & {
    submission: Omit<Base["submission"], "parent">;
    /** Target chosen by the server; owner authorization still required. */
    targetOrderReference: string;
  },
) {
  const targetOrderReference = String(parseOrderingReference(options.targetOrderReference));
  const s = options.submission,
    scope = s.runtime.inventory.scope;
  for (const candidate of [
    s.access.scope,
    s.source.scope,
    s.runtime,
    options.tip.preparation.scope,
  ])
    if (
      String(candidate.brandReference) !== String(scope.brandReference) ||
      String(candidate.storeReference) !== String(scope.storeReference)
    )
      throw new CheckoutSessionServiceError("INTENT_CONFLICT");
  const access = createCustomerCheckoutSessionRead(s.access);
  const history = createPostgresAdditionalDiningBatchHistoryReader({
    ...scope,
    transactions: s.runtime.transactions,
    authorize: s.historyAuthorization,
  });
  const commitments = createPostgresDiningCheckoutCommitmentStore(s.runtime.transactions, scope, {
    now: () => parseCanonicalInstant(s.source.clock.now()),
  });
  const parents = createPostgresDiningOrderPreparationSource({
    ...scope,
    authorize: options.tip.authorizeOrder,
  });
  return Object.freeze({
    async create(value: unknown) {
      const raw = readClosedRecord(value, [
        "sessionCredential",
        "csrfCredential",
        "checkoutSessionReference",
        "selectionReference",
        "tip",
      ]);
      parseOrderingReference(raw.selectionReference);
      const tip = createMoney(raw.tip as Money);
      if (
        tip.currencyCode !== "CAD" ||
        tip.amountMinor < 0n ||
        tip.amountMinor > 9223372036854775807n
      )
        throw new CheckoutSessionServiceError("INPUT_INVALID");
      const input = {
        sessionCredential: raw.sessionCredential,
        csrfCredential: raw.csrfCredential,
        checkoutSessionReference: raw.checkoutSessionReference,
      };
      const session = parseCheckoutSession(await access.read(input)),
        v = session.validation;
      if (
        v.orderType !== "DineIn" ||
        String(v.brandReference) !== String(scope.brandReference) ||
        String(v.storeReference) !== String(scope.storeReference) ||
        v.quoteVersion !== (options.tip.quoteVersion ?? 1)
      )
        throw new CheckoutSessionServiceError("INTENT_CONFLICT");
      const saved = await history.resolveSubmission(session.submissionReference);
      let parent: Base["submission"]["parent"];
      if (saved !== null) {
        const record = parseAdditionalDiningBatchSnapshot(saved),
          b = record.batch;
        if (
          String(record.orderReference) !== targetOrderReference ||
          record.snapshotVersion !== v.quoteVersion ||
          String(record.brandReference) !== v.brandReference ||
          String(record.storeReference) !== v.storeReference ||
          String(record.guestSessionReference) !== v.guestSessionReference ||
          String(b.submissionReference) !== session.submissionReference ||
          String(b.sourceCartReference) !== v.cartReference ||
          b.sourceCartVersion !== v.cartVersion ||
          String(b.quoteReference) !== v.quoteReference
        )
          throw new CheckoutSessionServiceError("INTENT_CONFLICT");
        parent = {
          orderReference: record.orderReference,
          originalOrderCreatedAt: record.originalOrderCreatedAt,
          expectedOrderVersion: record.expectedOrderVersion,
          batchSequence: record.batchSequence,
        };
      } else {
        let commitment = await commitments.loadSubmission(session.submissionReference);
        if (commitment === null) {
          const prepared = await createCustomerAdditionalDiningSessionPreparation({
            access: s.access,
            scope,
            orderReference: targetOrderReference,
            preparation: {
              preparation: { ...options.tip.preparation, now: () => s.source.clock.now() },
              transactions: s.runtime.transactions,
              authorizeOrder: options.tip.authorizeOrder,
            },
          }).prepare(input);
          if (JSON.stringify(prepared.session) !== JSON.stringify(session))
            throw new CheckoutSessionServiceError("PERMISSION_DENIED");
          commitment = prepared.record;
        }
        const clock = parseDiningCheckoutCommitment(commitment);
        if (
          String(clock.orderReference) !== targetOrderReference ||
          clock.state !== "Prepared" ||
          String(clock.submissionReference) !== session.submissionReference ||
          String(clock.paymentOperationReference) !== session.paymentOperationReference ||
          String(clock.brandReference) !== v.brandReference ||
          String(clock.storeReference) !== v.storeReference ||
          String(clock.guestSessionReference) !== v.guestSessionReference ||
          String(clock.cartReference) !== v.cartReference ||
          clock.cartVersion !== v.cartVersion ||
          String(clock.quoteReference) !== v.quoteReference
        )
          throw new CheckoutSessionServiceError("INTENT_CONFLICT");
        const current = await s.runtime.transactions.run((transaction) =>
          parents.resolveAdditionalParent({
            transaction,
            brandReference: v.brandReference,
            storeReference: v.storeReference,
            orderReference: String(clock.orderReference),
            diningSessionReference: String(clock.diningSessionReference),
            guestSessionReference: v.guestSessionReference,
            observedAt: parseCanonicalInstant(s.source.clock.now()),
          }),
        );
        if (current === null) throw new CheckoutSessionServiceError("DEPENDENCY_UNAVAILABLE");
        parent = {
          orderReference: current.orderReference,
          originalOrderCreatedAt: current.originalOrderCreatedAt,
          expectedOrderVersion: current.orderVersion,
          batchSequence: current.nextBatchSequence,
        };
      }
      if (
        JSON.stringify(parseCheckoutSession(await access.read(input))) !== JSON.stringify(session)
      )
        throw new CheckoutSessionServiceError("PERMISSION_DENIED");
      return createCustomerAdditionalDiningPaymentComposition({
        ...options,
        submission: { ...s, parent },
      }).create(value);
    },
  });
}
