import { parseCanonicalInstant } from "@bop/tenant";
import { createPostgresGuestSessionEntryStore } from "@bop/identity";
import {
  createCustomerEntryComposition,
  type CustomerEntryCompositionOptions,
  type CustomerEntryOperatingReader,
} from "./customer-entry-composition.js";
import type {
  CustomerEntryNotAccepting,
  CustomerEntryPort,
  CustomerEntryPortInput,
} from "./customer-entry.js";
import {
  createPersistentPublicStoreProfilePorts,
  type PersistentPublicStoreProfileOptions,
} from "./persistent-public-store-profile.js";
type Transaction = Parameters<typeof createPersistentPublicStoreProfilePorts>[0];
/**
 * WP-2423 Q11: thrown by `sources` when the presented token is exactly a table code this Store
 * issued and has since replaced or turned off. Entry is refused with plain guidance to ask staff.
 */
export class RetiredTableQrError extends Error {
  constructor(readonly reason: "Replaced" | "TurnedOff") {
    super("Table code retired");
    this.name = "RetiredTableQrError";
  }
}
export interface PersistentCustomerEntryOptions {
  profile: PersistentPublicStoreProfileOptions;
  transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  session: Omit<CustomerEntryCompositionOptions["session"], "store">;
  /** All returned owner ports must use this transaction and retain current fences.
   * The binding is request-scoped; credentials are the shared configured provider.
   */
  sources(
    tx: Transaction,
    input: CustomerEntryPortInput,
  ): Promise<
    Pick<CustomerEntryCompositionOptions, "qr" | "admission"> &
      (
        | { operating: CustomerEntryCompositionOptions["operating"] }
        | { operatingReader: CustomerEntryOperatingReader }
      ) & {
        binding: CustomerEntryCompositionOptions["session"]["binding"];
      }
  >;
}
export function createPersistentCustomerEntryComposition(
  options: PersistentCustomerEntryOptions,
): CustomerEntryPort {
  const scope = Object.freeze({
    brandReference: options.profile.binding.brandReference,
    storeReference: options.profile.binding.storeReference,
  });
  return Object.freeze({
    async establish(input: CustomerEntryPortInput) {
      // WP-2423 Q4: a closed or paused Store is still rolled back, but its answer is kept.
      let notAccepting: CustomerEntryNotAccepting | null = null;
      let retired: RetiredTableQrError | null = null;
      try {
        const requestedAt = parseCanonicalInstant(input.requestedAt);
        return await options.transactions.run(async (tx) => {
          const sources = await options.sources(tx, input).catch((error: unknown) => {
            if (error instanceof RetiredTableQrError) retired = error;
            throw error;
          });
          const qr = sources.qr;
          const result = await createCustomerEntryComposition({
            ...sources,
            qr: {
              ...qr,
              contexts: {
                async resolve(payload) {
                  const evidence = await qr.contexts.resolve(payload);
                  return evidence !== null &&
                    evidence.brandReference === scope.brandReference &&
                    evidence.storeReference === scope.storeReference
                    ? evidence
                    : null;
                },
              },
            },
            profile: createPersistentPublicStoreProfilePorts(tx, options.profile, {
              evaluatedAt: requestedAt,
              purpose: "CustomerEntry",
            }),
            session: {
              ...options.session,
              binding: sources.binding,
              store: createPostgresGuestSessionEntryStore({ run: async (work) => work(tx) }, scope),
            },
          }).establish(input);
          if (result.status === "NotAccepting") notAccepting = result;
          if (result.status !== "Established") throw new Error("CUSTOMER_ENTRY_ROLLBACK");
          return result;
        });
      } catch {
        const retiredCode = retired as RetiredTableQrError | null;
        if (retiredCode !== null)
          return Object.freeze({ status: "QrRetired", reason: retiredCode.reason } as const);
        return notAccepting ?? Object.freeze({ status: "EntryUnavailable" } as const);
      }
    },
  });
}
