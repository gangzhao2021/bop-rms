import { createCustomerAdditionalDiningCommitmentSeal } from "./customer-additional-dining-commitment-seal.js";
import type { DiningCheckoutCommitment } from "@rms/dining";
import { createCustomerAdditionalDiningCurrentGate } from "./customer-additional-dining-current-gate.js";
import {
  createPostgresAdditionalDiningBatchStore,
  parseOrderingReference,
  AdditionalDiningBatchStoreError,
} from "@rms/ordering";
import {
  createCustomerAdditionalDiningInventoryFinalizer,
  type CustomerSubmissionInventoryFinalizerOptions,
} from "./customer-submission-inventory-finalizer.js";

type OwnerOptions = Parameters<typeof createPostgresAdditionalDiningBatchStore>[0];
export interface CustomerAdditionalDiningSubmissionStoreOptions extends Pick<
  OwnerOptions,
  "brandReference" | "storeReference" | "authorize" | "currentPolicies" | "audit" | "eventReference"
> {
  inventory: CustomerSubmissionInventoryFinalizerOptions;
  diningSealAudit(record: DiningCheckoutCommitment): Promise<unknown>;
  /** Current Identity/Host/Dining commitment/Checkout/Store fences, held on the
   * supplied transaction. Parsing historical evidence does not satisfy this port.
   */
  validateCurrent: OwnerOptions["finalize"];
}

/** Composition only. Caller owns transaction commit/rollback. No HTTP route or
 * runtime defaults are installed; all current gates/effects must be supplied.
 */
export function createCustomerAdditionalDiningSubmissionStore(
  options: CustomerAdditionalDiningSubmissionStoreOptions,
) {
  const brand = parseOrderingReference(options.brandReference);
  const store = parseOrderingReference(options.storeReference);
  const { authorize, validateCurrent } = options;
  if (
    typeof authorize !== "function" ||
    typeof validateCurrent !== "function" ||
    brand !== parseOrderingReference(options.inventory.scope.brandReference) ||
    store !== parseOrderingReference(options.inventory.scope.storeReference)
  )
    throw new AdditionalDiningBatchStoreError();
  const inventory = createCustomerAdditionalDiningInventoryFinalizer(options.inventory);
  const dining = createCustomerAdditionalDiningCurrentGate(options.inventory.scope);
  const seal = createCustomerAdditionalDiningCommitmentSeal(
    options.inventory.scope,
    options.diningSealAudit,
  );
  return createPostgresAdditionalDiningBatchStore({
    brandReference: brand,
    storeReference: store,
    authorize,
    currentPolicies: options.currentPolicies,
    audit: options.audit,
    eventReference: options.eventReference,
    finalize: async (transaction, snapshot, capacityLink, context) => {
      await dining(transaction, snapshot, capacityLink, context);
      await validateCurrent(transaction, snapshot, capacityLink, context);
      await inventory.finalize({
        transaction,
        snapshot,
        cart: context.cart,
        checkoutValidationEvidence: context.checkoutValidationEvidence,
        observedAt: context.observedAt,
      });
      await seal(transaction, snapshot, capacityLink, context);
    },
  });
}
