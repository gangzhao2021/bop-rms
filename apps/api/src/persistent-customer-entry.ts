import { parseCanonicalInstant } from "@bop/tenant";
import { createPostgresGuestSessionEntryStore } from "@bop/identity";
import {
  loadDiningGuestStartedSessionAtTable,
  loadDiningGuestTableOffer,
  loadDiningTableOpen,
} from "@rms/dining";
import {
  createCustomerEntryComposition,
  type CustomerEntryCompositionOptions,
  type CustomerEntryOperatingReader,
} from "./customer-entry-composition.js";
import type {
  CustomerEntryNotAccepting,
  CustomerEntryServiceNotOffered,
  CustomerEntryTableNotOpen,
  CustomerEntryTableOffer,
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
  /** A later instant for an entry read again; the system clock unless a test sets its own. */
  now?: () => string;
  /**
   * WP-2423 DEC-DINING-GUEST-TABLE-START: the owners' facts behind "are you with these guests?",
   * read with nothing else held, and word that guests at free tables are being sent to staff.
   */
  guestTables?: {
    asksNewParty(tableReference: string): Promise<boolean>;
    startsSpent?(): void;
  };
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
/** Entries read again with a later instant, at most: a table a phone's party just started. */
const contextReads = 3;
export function createPersistentCustomerEntryComposition(
  options: PersistentCustomerEntryOptions,
): CustomerEntryPort {
  const scope = Object.freeze({
    brandReference: options.profile.binding.brandReference,
    storeReference: options.profile.binding.storeReference,
  });
  const clock = options.now ?? (() => new Date().toISOString());
  const later = (input: CustomerEntryPortInput) => {
    const instant = clock();
    return instant > input.requestedAt ? instant : input.requestedAt;
  };
  const guestStartOffer = (decision: { readonly kind: string }) => {
    if (decision.kind === "Spent") options.guestTables?.startsSpent?.();
    return decision.kind === "MayStart" || decision.kind === "BeingCleaned"
      ? decision.kind
      : ("No" as const);
  };
  /** One entry, in one transaction, and what it leaves to be decided with nothing held. */
  const once = async (
    input: CustomerEntryPortInput,
  ): Promise<{
    readonly answer: Awaited<ReturnType<CustomerEntryPort["establish"]>>;
    /** The table this scan may ask "are you with them?" about, if the owners' facts say so. */
    readonly askAt: string | null;
    /** The table's read refused this instant (a phone of this party just started it, say). */
    readonly contextRefused: boolean;
  }> => {
    // WP-2423 Q4: a closed or paused Store is still rolled back, but its answer is kept.
    // WP-2423 item 8 ⑦ 1b (v15 2026-10-29: a pickup code at a dine-in-only Store read as an
    // unusable link): the Store takes no pickup orders, kept the same way.
    let notAccepting:
      | CustomerEntryNotAccepting
      | CustomerEntryServiceNotOffered
      | CustomerEntryTableNotOpen
      | CustomerEntryTableOffer
      | null = null;
    let retired: RetiredTableQrError | null = null;
    let askAt: string | null = null;
    let contextRefused = false;
    try {
      const requestedAt = parseCanonicalInstant(input.requestedAt);
      const answer = await options.transactions.run(async (tx) => {
        const sources = await options.sources(tx, input).catch((error: unknown) => {
          if (error instanceof RetiredTableQrError) retired = error;
          throw error;
        });
        const qr = sources.qr;
        const readOnly = async <T>(work: () => Promise<T>): Promise<T> => {
          await tx.query("SAVEPOINT customer_entry_table_open", []);
          try {
            return await work();
          } finally {
            await tx.query("ROLLBACK TO SAVEPOINT customer_entry_table_open", []);
            await tx.query("RELEASE SAVEPOINT customer_entry_table_open", []);
          }
        };
        const result = await createCustomerEntryComposition({
          ...sources,
          qr: {
            ...qr,
            contexts: {
              async resolve(payload) {
                const evidence = await qr.contexts.resolve(payload);
                if (evidence === null && String(payload.channel) === "DineIn")
                  contextRefused = true;
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
          // Coordinator 2026-10-30: the scanned table's public state, read in this transaction
          // under a savepoint that is always rolled back (read only; it also restores the scope
          // settings the read sets, and a failed read leaves the entry usable).
          table: {
            isOpen: (where) =>
              readOnly(() => loadDiningTableOpen(tx as never, scope, where.tableReference)),
            guestStart: (where) =>
              readOnly(async () =>
                guestStartOffer(
                  await loadDiningGuestTableOffer(
                    tx as never,
                    scope,
                    where.tableReference,
                    where.at,
                  ),
                ),
              ),
            ...(options.guestTables === undefined
              ? {}
              : {
                  // Only the cheap fact here, so any other open table pays one read. A guest-started
                  // table ends this transaction first: the owners' facts need a connection of their
                  // own, and a scan holding one while it waits for another could use up the pool.
                  asksNewParty: async (where: { tableReference: string }) => {
                    if (
                      (await readOnly(() =>
                        loadDiningGuestStartedSessionAtTable(
                          tx as never,
                          scope,
                          where.tableReference,
                        ),
                      )) === null
                    )
                      return false;
                    askAt = where.tableReference;
                    return true;
                  },
                }),
          },
        }).establish(input);
        if (
          result.status === "NotAccepting" ||
          result.status === "ServiceNotOffered" ||
          result.status === "TableNotOpen" ||
          result.status === "TableMayStart" ||
          result.status === "TableBeingCleaned" ||
          result.status === "TableAskNewParty"
        )
          notAccepting = result;
        if (result.status !== "Established") throw new Error("CUSTOMER_ENTRY_ROLLBACK");
        return result;
      });
      return { answer, askAt: null, contextRefused: false };
    } catch (error) {
      // WP-2423 (burst 2026-11-02): the database, not the code: a retry, not "can't be used".
      const failed = (error as { code?: unknown } | null)?.code;
      if (typeof failed === "string" && failed.startsWith("TENANT_DATABASE_")) throw error;
      const retiredCode = retired as RetiredTableQrError | null;
      if (retiredCode !== null)
        return {
          answer: Object.freeze({ status: "QrRetired", reason: retiredCode.reason } as const),
          askAt: null,
          contextRefused: false,
        };
      return {
        answer: notAccepting ?? Object.freeze({ status: "EntryUnavailable" } as const),
        askAt,
        contextRefused,
      };
    }
  };
  return Object.freeze({
    async establish(first: CustomerEntryPortInput) {
      let input = first;
      let reads = 1;
      for (;;) {
        const { answer, askAt, contextRefused } = await once(input);
        if (answer.status === "TableAskNewParty" && askAt !== null) {
          // Nothing is held now. A database that can't answer is a retry, as above; anything else
          // the owners can't say is no reason to stop a guest: they join, as at any open table.
          const asks = await (
            options.guestTables as NonNullable<typeof options.guestTables>
          )
            .asksNewParty(askAt)
            .catch((error: unknown) => {
              const failed = (error as { code?: unknown } | null)?.code;
              if (typeof failed === "string" && failed.startsWith("TENANT_DATABASE_")) throw error;
              return false;
            });
          if (asks) return answer;
          input = { ...input, intent: "Join", requestedAt: later(input) };
          continue;
        }
        // A table read refuses an instant from before its latest change, and another phone of the
        // party can make that change a moment after this request took its instant. A later instant
        // answers it; a code that really can't be used refuses again.
        if (answer.status === "EntryUnavailable" && contextRefused && reads < contextReads) {
          reads += 1;
          input = { ...input, requestedAt: later(input) };
          continue;
        }
        return answer;
      }
    },
  });
}
