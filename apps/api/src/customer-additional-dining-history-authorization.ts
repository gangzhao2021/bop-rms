import {
  createPostgresGuestSessionEntryStore,
  parseCanonicalInstant,
  parseGuestRawCredential,
} from "@bop/identity";
import {
  createPostgresDiningGuestBindingStore,
  createPostgresDiningCheckoutCommitmentStore,
  parseDiningCheckoutCommitment,
} from "@rms/dining";
import { parseOrderingReference } from "@rms/ordering";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  customerPaymentConsumerTransaction,
  type createCustomerAdditionalOrderPaymentClaimAdmission,
} from "./customer-order-payment-admission.js";
import {
  createCustomerDiningCheckoutIdentity,
  type CustomerDiningCheckoutCompositionOptions,
} from "./customer-dining-checkout-composition.js";

/** Claim-time history authority requires an existing Dining commitment.
 * Do not use for the pre-preparation existence lookup: that path uses authorized CheckoutSession access.
 */
export function createCustomerAdditionalDiningHistoryAuthorization(
  options: {
    scope: { tenantReference: string; brandReference: string; storeReference: string };
    identity(transaction: ConsumerTransaction): CustomerDiningCheckoutCompositionOptions;
  },
  credentials: { sessionCredential: unknown; csrfCredential: unknown },
): Parameters<typeof createCustomerAdditionalOrderPaymentClaimAdmission>[0]["authorizeHistory"] {
  const scope = {
    tenantReference: String(parseOrderingReference(options.scope.tenantReference)),
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
  };
  const captured = {
    sessionCredential: parseGuestRawCredential(credentials.sessionCredential),
    csrfCredential: parseGuestRawCredential(credentials.csrfCredential),
  };
  let last: string | undefined, fingerprint: string | undefined;
  return async (transaction, binding) => {
    try {
      if (
        String(binding.brandReference) !== scope.brandReference ||
        String(binding.storeReference) !== scope.storeReference
      )
        return false;
      const submission = String(parseOrderingReference(binding.submissionReference));
      const tx = customerPaymentConsumerTransaction(transaction);
      const configured = options.identity(tx);
      if (
        String(configured.scope.brandReference) !== scope.brandReference ||
        String(configured.scope.storeReference) !== scope.storeReference
      )
        return false;
      const now = () => {
        const at = parseCanonicalInstant(configured.now());
        if (last !== undefined && at < last) throw new Error("history authority unavailable");
        last = at;
        return at;
      };
      const bound = { run: async <T>(work: (t: ConsumerTransaction) => Promise<T>) => work(tx) };
      const currentOptions = {
        ...configured,
        session: {
          ...configured.session,
          store: createPostgresGuestSessionEntryStore(bound, configured.scope),
        },
        dining: {
          ...configured.dining,
          current: createPostgresDiningGuestBindingStore(bound, scope),
        },
      };
      const identity = createCustomerDiningCheckoutIdentity(currentOptions, configured.scope, now);
      const guest = await identity.authorize({ ...captured, observedAt: now() });
      if (
        guest.channel !== "DineIn" ||
        guest.diningState !== "DiningBound" ||
        guest.diningSessionReference === null ||
        guest.diningParticipantReference === null ||
        String(guest.brandReference) !== scope.brandReference ||
        String(guest.storeReference) !== scope.storeReference
      )
        return false;
      const current = JSON.stringify(guest);
      if (fingerprint !== undefined && current !== fingerprint) return false;
      const saved = await createPostgresDiningCheckoutCommitmentStore(bound, scope, {
        now,
      }).loadSubmission(submission);
      if (saved === null) return false;
      const commitment = parseDiningCheckoutCommitment(saved);
      if (
        String(commitment.submissionReference) !== submission ||
        String(commitment.brandReference) !== scope.brandReference ||
        String(commitment.storeReference) !== scope.storeReference ||
        String(commitment.guestSessionReference) !== String(guest.sessionReference) ||
        String(commitment.diningSessionReference) !== String(guest.diningSessionReference) ||
        String(commitment.participantReference) !== String(guest.diningParticipantReference) ||
        String(commitment.preparedAt) > now()
      )
        return false;
      if (JSON.stringify(await identity.authorize({ ...captured, observedAt: now() })) !== current)
        return false;
      fingerprint = current;
      return true;
    } catch {
      return false;
    }
  };
}
