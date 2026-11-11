import {
  assertGuestSessionUsable,
  createGuestSession,
  parseCanonicalInstant,
  type GuestSessionBindingPort,
} from "@bop/identity";
import { createConfiguredPickupQrContext } from "./configured-pickup-qr-context.js";
import {
  confirmTransactionAnswered,
  guestBindingSourceUnavailable,
  isGuestDependencyFailure,
} from "./guest-binding-dependency.js";

type ContextOptions = Parameters<typeof createConfiguredPickupQrContext>[0];
type Sources = Omit<ContextOptions, "transaction" | "evaluatedAt" | "purpose">;

/** Server-owned registration only. The current authorization callbacks must fence
 * their source facts; this adapter never grants approval from configuration alone.
 * Supply a joined runner to retain these reads in an existing request transaction.
 */
export function createConfiguredPickupSessionBinding(
  options: Sources & {
    transactions: {
      run<T>(work: (tx: ContextOptions["transaction"]) => Promise<T>): Promise<T>;
    };
  },
): GuestSessionBindingPort {
  return Object.freeze({
    async validate(
      value: Parameters<GuestSessionBindingPort["validate"]>[0],
      observedAt: Parameters<GuestSessionBindingPort["validate"]>[1],
    ) {
      try {
        const at = parseCanonicalInstant(observedAt);
        const session = assertGuestSessionUsable(createGuestSession(value), at);
        const expected = options.registration.payload;
        if (
          session.channel !== "Pickup" ||
          session.publicTableReference !== null ||
          session.brandReference !== options.binding.brandReference ||
          session.storeReference !== options.binding.storeReference ||
          session.publicStoreReference !== options.binding.publicStoreReference ||
          String(session.qrReference) !== String(expected.qrReference) ||
          session.qrRevocationVersion !== expected.revocationVersion
        )
          return "Unavailable";
        // WP-2423 (outage-reads-and-retry): records that can't be read are a passing fault, never
        // "this phone's session ended" (see guest-binding-dependency).
        const current = await options.transactions
          .run(async (transaction) => {
            const found = await createConfiguredPickupQrContext({
              ...options,
              transaction,
              evaluatedAt: at,
              purpose: "CustomerCart",
            }).resolve(expected);
            if (found === null) await confirmTransactionAnswered(transaction);
            return found;
          })
          .catch((error: unknown) => {
            throw isGuestDependencyFailure(error) ? error : guestBindingSourceUnavailable(error);
          });
        return current !== null &&
          current.brandLifecycle === "Active" &&
          current.storeLifecycle === "Active" &&
          String(current.brandReference) === String(session.brandReference) &&
          String(current.storeReference) === String(session.storeReference) &&
          String(current.publicStoreReference) === String(session.publicStoreReference) &&
          current.channel === session.channel &&
          current.publicTableReference === null &&
          current.tableReference === null &&
          current.qrState === "Enabled" &&
          current.revocationVersion === session.qrRevocationVersion &&
          String(current.validUntil) > String(at)
          ? "Current"
          : "Unavailable";
      } catch (error) {
        if (isGuestDependencyFailure(error)) throw error;
        return "Unavailable";
      }
    },
  });
}
