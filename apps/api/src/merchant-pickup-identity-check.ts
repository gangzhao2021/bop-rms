import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresPickupHandoffStore,
  parsePickupProofReference,
  PickupHandoffError,
  completePickupHandoffPermission,
} from "@rms/fulfillment";
import { loadOrderPickupContact } from "@rms/ordering";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type StoreOptions = Parameters<typeof createPostgresPickupHandoffStore>[0];
function invalid(): never {
  throw new PickupHandoffError("PICKUP_HANDOFF_INPUT_INVALID");
}

/**
 * WP-2423: what staff compare when they check a pickup customer in person: the name on the order
 * and the last four digits of its phone. Read from Ordering's own contact read, only for the
 * pickup counter (fulfillment.pickup.complete) and only while the order is ready with no usable
 * code (never sent, expired, or locked after five wrong codes). The full phone never leaves here.
 */
export type PickupIdentityCheck =
  | { readonly status: "Available"; readonly name: string; readonly phoneLast4: string | null }
  | { readonly status: "Removed" }
  | { readonly status: "NotGiven" };

/** Only the last four digits of a phone contact; an email contact gives none. */
export function phoneLastFour(channel: "Phone" | "Email", value: string): string | null {
  if (channel !== "Phone") return null;
  const digits = value.replace(/[^0-9]/gu, "");
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export function createMerchantPickupIdentityCheck(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  store: Pick<
    StoreOptions,
    "deriveCompletionReference" | "sha256" | "validateCurrentSource" | "admit" | "appendAudit"
  >;
  installContext(
    transaction: ConsumerTransaction,
    scope: { brandReference: string; storeReference: string },
  ): Promise<void>;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    query: unknown;
  }): Promise<PickupIdentityCheck> => {
    const session = await options.authentication.authorize(input);
    let intent: Readonly<Record<string, unknown>>;
    try {
      intent = readClosedRecord(input.query, [
        "orderReference",
        "storeReference",
        "fulfillmentReference",
      ]);
    } catch {
      return invalid();
    }
    const orderReference = parsePickupProofReference(intent.orderReference),
      fulfillmentReference = parsePickupProofReference(intent.fulfillmentReference);
    const denied = (): never => {
      throw new PickupHandoffError("PICKUP_HANDOFF_PERMISSION_DENIED");
    };
    // The caller is resolved in full at the start and once before the reply; the owner read in
    // between only confirms it runs in this authorized transaction.
    return options.persistence.transactions.run((transaction) =>
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const scope = await resolveScope(
              transaction,
              input.sessionCookie,
              completePickupHandoffPermission,
              session.sessionReference,
            );
            if (intent.storeReference !== scope.store.storeReference || !(await scope.allowed()))
              return denied();
            return scope;
          },
          recheck: async (scope) => (await scope.allowed()) === true,
          denied,
        },
        async (authority) => {
          const scope = authority.scope;
          const tx: ConsumerTransaction = {
            async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
              const result = await transaction.query(sql, values);
              if (!result || typeof result !== "object") return invalid();
              const rows = Object.getOwnPropertyDescriptor(result, "rows"),
                count = Object.getOwnPropertyDescriptor(result, "rowCount");
              if (
                !rows ||
                !("value" in rows) ||
                !Array.isArray(rows.value) ||
                !count ||
                !("value" in count) ||
                (count.value !== null && (!Number.isSafeInteger(count.value) || count.value < 0))
              )
                return invalid();
              return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
            },
          };
          const selected = {
            brandReference: scope.context.brand.brandReference,
            storeReference: scope.store.storeReference,
          };
          await options.installContext(tx, selected);
          const store = createPostgresPickupHandoffStore({
            ...options.store,
            ...selected,
            actorReference: scope.actorReference,
            now: options.persistence.now,
            authorize: async (_tx, access) =>
              access.actorReference === scope.actorReference &&
              access.orderReference === orderReference &&
              access.permission === completePickupHandoffPermission &&
              (await authority.guard()),
          });
          const current = await store.lockByOrder({ transaction: tx, orderReference });
          const capability = current.capability;
          const notIssued = capability === null;
          const expired =
            capability !== null && String(current.source.lockedAt) >= String(capability.expiresAt);
          if (
            current.source.fulfillmentReference !== fulfillmentReference ||
            current.source.canonicalPhase !== "Ready" ||
            current.notCollected ||
            !(notIssued || expired || current.codeChecksLocked)
          )
            throw new PickupHandoffError("PICKUP_HANDOFF_NOT_READY");
          // Ordering owns the checkout contact; its read checks the order belongs to this Store.
          const contact = await loadOrderPickupContact(tx, selected, orderReference);
          if (contact.status === "Removed") return Object.freeze({ status: "Removed" as const });
          if (contact.status === "NotGiven") return Object.freeze({ status: "NotGiven" as const });
          return Object.freeze({
            status: "Available" as const,
            name: contact.name,
            phoneLast4: phoneLastFour(contact.channel, contact.value),
          });
        },
      ),
    );
  };
}
