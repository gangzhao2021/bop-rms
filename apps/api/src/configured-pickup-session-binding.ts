import {
  assertGuestSessionUsable,
  createGuestSession,
  parseCanonicalInstant,
  type GuestSessionBindingPort,
} from "@bop/identity";
import { createConfiguredPickupQrContext } from "./configured-pickup-qr-context.js";

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
        return await options.transactions.run(async (transaction) => {
          const current = await createConfiguredPickupQrContext({
            ...options,
            transaction,
            evaluatedAt: at,
            purpose: "CustomerCart",
          }).resolve(expected);
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
        });
      } catch {
        return "Unavailable";
      }
    },
  });
}
