import { parseCanonicalInstant, parseGuestRawCredential } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference, type AdditionalDiningBatchSnapshot } from "@rms/ordering";
import {
  createCustomerDiningCheckoutIdentity,
  type CustomerDiningCheckoutCompositionOptions,
} from "./customer-dining-checkout-composition.js";

/** Request-scoped credential capability. Configure Identity repositories for the
 * supplied owner transaction in the caller; this adapter never invents a session
 * or substitutes historical commitment ownership for current CSRF authorization.
 */
export function createCustomerAdditionalDiningGuestAuthorization(
  options: CustomerDiningCheckoutCompositionOptions,
  credentials: { sessionCredential: unknown; csrfCredential: unknown },
) {
  const scope = Object.freeze({
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  });
  const captured = Object.freeze({
    sessionCredential: parseGuestRawCredential(credentials.sessionCredential),
    csrfCredential: parseGuestRawCredential(credentials.csrfCredential),
  });
  const clock = options.now;
  let previousTime: string | undefined;
  let fingerprint: string | undefined;
  const now = () => {
    const at = parseCanonicalInstant(clock());
    if (previousTime !== undefined && at < previousTime)
      throw new Error("guest clock is unavailable");
    previousTime = at;
    return at;
  };
  const identity = createCustomerDiningCheckoutIdentity(options, scope, now);
  return async (
    _transaction: ConsumerTransaction,
    snapshot: Pick<
      AdditionalDiningBatchSnapshot,
      "brandReference" | "storeReference" | "guestSessionReference" | "diningSessionReference"
    > & {
      batch: Pick<AdditionalDiningBatchSnapshot["batch"], "submittedByActorReference">;
    },
  ): Promise<boolean> => {
    try {
      if (
        snapshot.brandReference !== scope.brandReference ||
        snapshot.storeReference !== scope.storeReference ||
        snapshot.batch.submittedByActorReference !== snapshot.guestSessionReference
      )
        return false;
      const guest = await identity.authorize({ ...captured, observedAt: now() });
      if (
        String(guest.sessionReference) !== String(snapshot.guestSessionReference) ||
        String(guest.brandReference) !== String(scope.brandReference) ||
        String(guest.storeReference) !== String(scope.storeReference) ||
        guest.channel !== "DineIn" ||
        guest.diningState !== "DiningBound" ||
        guest.diningParticipantReference === null ||
        String(guest.diningSessionReference) !== String(snapshot.diningSessionReference)
      )
        return false;
      const current = JSON.stringify(guest);
      if (fingerprint !== undefined && fingerprint !== current) return false;
      fingerprint = current;
      return true;
    } catch {
      return false;
    }
  };
}
