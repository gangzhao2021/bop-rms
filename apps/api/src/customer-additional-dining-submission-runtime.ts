import { createPostgresPaymentTipSelectionStore, parsePaymentTipSelection } from "@rms/payment";
import {
  createPostgresGuestSessionEntryStore,
  readClosedRecord,
  parseGuestRawCredential,
  parseCanonicalInstant,
} from "@bop/identity";
import { createPostgresDiningGuestBindingStore } from "@rms/dining";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createAdditionalDiningBatchSnapshot,
  parseAdditionalDiningBatchSnapshot,
  AdditionalDiningBatchStoreError,
  parseOrderingReference,
  parseOrderCapacityLink,
} from "@rms/ordering";
import {
  createCustomerAdditionalDiningSubmissionStore,
  type CustomerAdditionalDiningSubmissionStoreOptions,
} from "./customer-additional-dining-submission-store.js";
import { createCustomerAdditionalDiningGuestAuthorization } from "./customer-additional-dining-guest-authorization.js";
import type { CustomerDiningCheckoutCompositionOptions } from "./customer-dining-checkout-composition.js";

export interface CustomerAdditionalDiningSubmissionRuntimeOptions extends Omit<
  CustomerAdditionalDiningSubmissionStoreOptions,
  "authorize"
> {
  transactions: { run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T> };
  /** Current QR/context and binding adapters must use the supplied transaction
   * where their owner contracts require fencing. Identity/Dining stores are
   * always constructed by this runtime on that same transaction.
   */
  identity(transaction: ConsumerTransaction): CustomerDiningCheckoutCompositionOptions;
}

/** Internal server entry. Resolves only after runner commits; no route,
 * credentials, Store defaults or external services are installed here.
 */
export function createCustomerAdditionalDiningSubmissionRuntime(
  options: CustomerAdditionalDiningSubmissionRuntimeOptions,
) {
  if (typeof options.transactions?.run !== "function" || typeof options.identity !== "function")
    throw new AdditionalDiningBatchStoreError();
  const runtime = Object.freeze({
    async submit(value: unknown) {
      const raw = readClosedRecord(value, [
        "sessionCredential",
        "csrfCredential",
        "snapshot",
        "checkoutValidationEvidence",
        "capacityLink",
        "tipSelectionReference",
      ]);
      const credentials = {
        sessionCredential: parseGuestRawCredential(raw.sessionCredential),
        csrfCredential: parseGuestRawCredential(raw.csrfCredential),
      };
      const snapshot = parseAdditionalDiningBatchSnapshot(raw.snapshot);
      const tipSelectionReference = parseOrderingReference(raw.tipSelectionReference);
      const capacityLink = parseOrderCapacityLink(raw.capacityLink);
      if (
        snapshot.brandReference !== options.brandReference ||
        snapshot.storeReference !== options.storeReference
      )
        throw new AdditionalDiningBatchStoreError();
      return options.transactions.run(async (transaction) => {
        const bound = {
          run: async <T>(work: (tx: ConsumerTransaction) => Promise<T>) => work(transaction),
        };
        const configured = options.identity(transaction);
        if (
          configured.scope.brandReference !== options.brandReference ||
          configured.scope.storeReference !== options.storeReference
        )
          throw new AdditionalDiningBatchStoreError();
        const identity = {
          ...configured,
          session: {
            ...configured.session,
            store: createPostgresGuestSessionEntryStore(bound, configured.scope),
          },
          dining: {
            ...configured.dining,
            current: createPostgresDiningGuestBindingStore(bound, options.inventory.scope),
          },
        };
        const authorize = createCustomerAdditionalDiningGuestAuthorization(identity, credentials);
        if (!(await authorize(transaction, snapshot))) throw new AdditionalDiningBatchStoreError();
        const tips = createPostgresPaymentTipSelectionStore(bound, configured.scope, {
          now: () => parseCanonicalInstant(configured.now()),
        });
        const selection = await tips.load(tipSelectionReference);
        if (selection === null) throw new AdditionalDiningBatchStoreError();
        const selected = parsePaymentTipSelection(selection);
        const batch = snapshot.batch;
        if (
          String(selected.selectionReference) !== String(tipSelectionReference) ||
          String(selected.paymentOperationReference) !==
            String(capacityLink.paymentOperationReference) ||
          String(selected.submissionReference) !== String(batch.submissionReference) ||
          String(selected.brandReference) !== String(snapshot.brandReference) ||
          String(selected.storeReference) !== String(snapshot.storeReference) ||
          String(selected.guestSessionReference) !== String(snapshot.guestSessionReference) ||
          String(selected.cartReference) !== String(batch.sourceCartReference) ||
          selected.cartVersion !== batch.sourceCartVersion ||
          String(selected.quoteReference) !== String(batch.quoteReference) ||
          Date.parse(selected.selectedAt) > Date.parse(batch.submittedAt)
        )
          throw new AdditionalDiningBatchStoreError();
        const store = createCustomerAdditionalDiningSubmissionStore({ ...options, authorize });
        const result = await store.append({
          transaction,
          snapshot,
          checkoutValidationEvidence: raw.checkoutValidationEvidence,
          capacityLink,
        });
        if (!(await authorize(transaction, snapshot))) throw new AdditionalDiningBatchStoreError();
        return result;
      });
    },
  });

  return Object.freeze({
    ...runtime,
    /** Internal server inputs, resolved from current owner sources. No HTTP-body pass-through.
     * The same submit path owns all authorization, saved-tip and transaction fences.
     */
    async submitCheckout(input: {
      sessionCredential: unknown;
      csrfCredential: unknown;
      checkout: Parameters<typeof createAdditionalDiningBatchSnapshot>[0];
      capacityLink: unknown;
      tipSelectionReference: unknown;
    }) {
      const credentials = {
        sessionCredential: parseGuestRawCredential(input.sessionCredential),
        csrfCredential: parseGuestRawCredential(input.csrfCredential),
      };
      const snapshot = createAdditionalDiningBatchSnapshot(input.checkout);
      return runtime.submit({
        ...credentials,
        snapshot,
        checkoutValidationEvidence: input.checkout.snapshot.checkoutValidationEvidence,
        capacityLink: input.capacityLink,
        tipSelectionReference: input.tipSelectionReference,
      });
    },
  });
}
