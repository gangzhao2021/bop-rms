import {
  GuestSessionError,
  parseCanonicalInstant,
  parseGuestRawCredential,
  readClosedRecord,
} from "@bop/identity";
import { parseOrderingReference, createPostgresDiningOrderPreparationSource } from "@rms/ordering";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createDiningHostSubmissionQuery,
  parseDiningReference,
  parseDiningInstant,
  parseDiningSession,
} from "@rms/dining";
import {
  createCustomerDiningCheckoutIdentity,
  createCustomerDiningSubmissionPreparation,
  type CustomerDiningSubmissionPreparationOptions,
} from "./customer-dining-checkout-composition.js";

export interface AdditionalDiningPreparationOptions {
  readonly preparation: CustomerDiningSubmissionPreparationOptions;
  /** Ordering public authority source: returns only a currently eligible existing
   * Dining Order under current session/Host/closure rules. Never a cached projection.
   * Final submission must reacquire its transaction fences and expected version.
   */
  readonly currentOrder: {
    resolve(
      input: Readonly<{
        brandReference: string;
        storeReference: string;
        diningSessionReference: string;
        guestSessionReference: string;
        orderReference: string;
        observedAt: string;
      }>,
    ): Promise<Readonly<{
      brandReference: string;
      storeReference: string;
      diningSessionReference: string;
      orderReference: string;
      orderVersion: number;
    }> | null>;
  };
}
const unavailable = (): never => {
  throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
};

/** Internal preparation only. Does not submit a Batch or authorize its final write. */
export function createCustomerAdditionalDiningPreparation(
  options: AdditionalDiningPreparationOptions,
) {
  const base = options.preparation;
  const scope = {
    brandReference: String(parseOrderingReference(base.scope.brandReference)),
    storeReference: String(parseOrderingReference(base.scope.storeReference)),
  };
  return Object.freeze({
    async prepareForOrdering(value: unknown) {
      const raw = readClosedRecord(value, [
        "sessionCredential",
        "csrfCredential",
        "intent",
        "orderReference",
        "expectedOrderVersion",
      ]);
      const credentials = {
        sessionCredential: parseGuestRawCredential(raw.sessionCredential),
        csrfCredential: parseGuestRawCredential(raw.csrfCredential),
      };
      const orderReference = String(parseOrderingReference(raw.orderReference));
      const version = raw.expectedOrderVersion;
      if (
        typeof version !== "number" ||
        !Number.isInteger(version) ||
        version < 1 ||
        version >= 2147483647
      )
        return unavailable();
      let last: string | undefined;
      const now = () => {
        const at = parseCanonicalInstant(base.now());
        if (last !== undefined && at < last) return unavailable();
        last = at;
        return at;
      };
      const identity = createCustomerDiningCheckoutIdentity(base, scope, now);
      let originalGuest: string | undefined;
      const authorize = async () => {
        const guest = await identity.authorize({ ...credentials, observedAt: now() });
        if (
          guest.channel !== "DineIn" ||
          guest.diningState !== "DiningBound" ||
          guest.diningSessionReference === null ||
          guest.brandReference !== scope.brandReference ||
          guest.storeReference !== scope.storeReference
        )
          return unavailable();
        const fingerprint = JSON.stringify(guest);
        if (originalGuest !== undefined && originalGuest !== fingerprint) return unavailable();
        originalGuest = fingerprint;
        if (guest.diningParticipantReference === null) return unavailable();
        const observedAt = parseDiningInstant(now());
        const dining = await base.dining.current.readCurrent({
          brandReference: parseDiningReference(scope.brandReference),
          storeReference: parseDiningReference(scope.storeReference),
          diningSessionReference: parseDiningReference(guest.diningSessionReference),
          participantReference: parseDiningReference(guest.diningParticipantReference),
          observedAt,
        });
        if (dining === null) return unavailable();
        const session = parseDiningSession(dining.session);
        let firstObservation = true;
        const host = await createDiningHostSubmissionQuery({
          scope,
          now: () => {
            if (firstObservation) {
              firstObservation = false;
              return observedAt;
            }
            return now();
          },
          repository: { readCurrent: async () => dining },
        }).resolve({
          purpose: "DiningHostSubmission",
          diningSessionReference: String(guest.diningSessionReference),
          participantReference: String(guest.diningParticipantReference),
          tableReference: session.tableReference,
        });
        if (host === null) return unavailable();
        const found = await options.currentOrder.resolve({
          ...scope,
          diningSessionReference: String(guest.diningSessionReference),
          guestSessionReference: String(guest.sessionReference),
          orderReference,
          observedAt: now(),
        });
        if (found === null) return unavailable();
        const order = readClosedRecord(found, [
          "brandReference",
          "storeReference",
          "diningSessionReference",
          "orderReference",
          "orderVersion",
        ]);
        if (
          order.brandReference !== scope.brandReference ||
          order.storeReference !== scope.storeReference ||
          order.diningSessionReference !== String(guest.diningSessionReference) ||
          order.orderReference !== orderReference ||
          order.orderVersion !== version
        )
          return unavailable();
      };
      await authorize();
      const preparation = createCustomerDiningSubmissionPreparation({
        ...base,
        now,
        references: {
          generate: (purpose) =>
            purpose === "Order" ? orderReference : base.references.generate(purpose),
        },
      });
      const result = await preparation.prepareForOrdering({ ...credentials, intent: raw.intent });
      if (String(result.record.orderReference) !== orderReference) return unavailable();
      await authorize();
      return Object.freeze({ ...result, expectedOrderVersion: version });
    },
  });
}

/** Production owner-source assembly for preparation reads. Each read retains its
 * own transaction until authority resolution completes. Final Batch submission
 * must acquire fresh shared Dining/Ordering/Checkout fences; preparation is not
 * an atomic reservation of the Order version.
 */
export function createPersistentAdditionalDiningPreparation(options: {
  preparation: CustomerDiningSubmissionPreparationOptions;
  transactions: { run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T> };
  authorizeOrder: Parameters<typeof createPostgresDiningOrderPreparationSource>[0]["authorize"];
}) {
  if (
    typeof options.transactions?.run !== "function" ||
    typeof options.authorizeOrder !== "function"
  )
    return unavailable();
  const source = createPostgresDiningOrderPreparationSource({
    ...options.preparation.scope,
    authorize: options.authorizeOrder,
  });
  return createCustomerAdditionalDiningPreparation({
    preparation: options.preparation,
    currentOrder: {
      resolve: (input) =>
        options.transactions.run((transaction) => source.resolve({ ...input, transaction })),
    },
  });
}
