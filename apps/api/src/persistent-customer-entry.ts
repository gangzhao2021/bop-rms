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
      try {
        const requestedAt = parseCanonicalInstant(input.requestedAt);
        return await options.transactions.run(async (tx) => {
          const sources = await options.sources(tx, input);
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
        return notAccepting ?? Object.freeze({ status: "EntryUnavailable" } as const);
      }
    },
  });
}
