import {
  assertGuestSessionUsable,
  createGuestSession,
  parseCanonicalInstant,
  type GuestSession,
  type CanonicalInstant,
} from "@bop/identity";
import { assertCurrentDiningGuestTableContext } from "@rms/dining";
import { createConfiguredDiningQrContext } from "./configured-dining-qr-context.js";
import {
  confirmTransactionAnswered,
  guestBindingSourceUnavailable,
  isGuestDependencyFailure,
} from "./guest-binding-dependency.js";

type Options = Parameters<typeof createConfiguredDiningQrContext>[0];
type Purpose = "GuestSessionBinding" | "DiningJoin" | "DiningAdmission";

/** Current QR/table context only. DiningBound membership must additionally use
 * createCustomerDiningSessionBinding/current Dining owner participation queries.
 * Configuration must contain the original approved payload, never reconstructed
 * from the browser or Guest session. Callers may lend a retained transaction.
 */
export function createConfiguredDiningGuestContext(
  options: Omit<Options, "transaction" | "evaluatedAt" | "purpose"> & {
    transactions: { run<T>(work: (tx: Options["transaction"]) => Promise<T>): Promise<T> };
  },
) {
  const resolve = async (input: {
    session: GuestSession;
    observedAt: CanonicalInstant;
    purpose: Purpose;
  }) => {
    try {
      if (!["GuestSessionBinding", "DiningJoin", "DiningAdmission"].includes(input.purpose))
        return null;
      const at = parseCanonicalInstant(input.observedAt);
      const session = assertGuestSessionUsable(createGuestSession(input.session), at);
      const expected = options.registration.payload;
      if (
        session.channel !== "DineIn" ||
        session.brandReference !== options.binding.brandReference ||
        session.storeReference !== options.binding.storeReference ||
        session.publicStoreReference !== options.binding.publicStoreReference ||
        String(session.publicTableReference) !== String(expected.publicTableReference) ||
        String(session.qrReference) !== String(expected.qrReference) ||
        session.qrRevocationVersion !== expected.revocationVersion
      )
        return null;
      // WP-2423 (outage-reads-and-retry): the table's records that can't be read are a passing
      // fault, never "this phone left the table" (see guest-binding-dependency).
      const context = await options.transactions
        .run(async (transaction) => {
          const found = await createConfiguredDiningQrContext({
            ...options,
            transaction,
            evaluatedAt: at,
            purpose: input.purpose,
          }).resolve(expected);
          if (found === null) await confirmTransactionAnswered(transaction);
          return found;
        })
        .catch((error: unknown) => {
          throw isGuestDependencyFailure(error) ? error : guestBindingSourceUnavailable(error);
        });
      return assertCurrentDiningGuestTableContext(
        {
          brandReference: session.brandReference,
          storeReference: session.storeReference,
          publicStoreReference: session.publicStoreReference,
          publicTableReference: session.publicTableReference,
          channel: session.channel,
          qrRevocationVersion: session.qrRevocationVersion,
          observedAt: at,
        },
        context,
      );
    } catch (error) {
      if (isGuestDependencyFailure(error)) throw error;
      return null;
    }
  };
  return Object.freeze({
    resolve,
    async validate(session: GuestSession, observedAt: CanonicalInstant) {
      return (await resolve({ session, observedAt, purpose: "GuestSessionBinding" })) === null
        ? ("Unavailable" as const)
        : ("Current" as const);
    },
  });
}
