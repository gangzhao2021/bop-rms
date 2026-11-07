import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresPickupHandoffStore,
  parsePickupProofReference,
  PickupHandoffError,
  completePickupHandoffPermission,
} from "@rms/fulfillment";
import { createPostgresKitchenReworkStore, KitchenReworkError } from "@rms/kitchen";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantStoreBusinessDay } from "./merchant-store-business-day.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/**
 * WP-2423 store-service-controls (v15 M46): from when a ready order may be closed for the night —
 * the end of the business day's last service period once it has passed, or the start of a business
 * day the Store does not open; null while service remains (or the hours can't be read).
 */
export function storeClosingFrom(
  day: { readonly startsAt: string; readonly closesAt: string | null; readonly closedToday: boolean },
  at: string,
): string | null {
  if (day.closedToday) return String(day.startsAt);
  if (day.closesAt === null) return null;
  return Date.parse(at) >= Date.parse(day.closesAt) ? day.closesAt : null;
}

/** Closing an uncollected pickup gives up a paid order, so it needs the cancellation permission. */
export const closeUncollectedPickupPermission = "ordering.order.cancel" as const;
type StoreOptions = Parameters<typeof createPostgresPickupHandoffStore>[0];
function invalid(): never {
  throw new PickupHandoffError("PICKUP_HANDOFF_INPUT_INVALID");
}
/**
 * WP-2423: close a ready pickup order nobody collected (after the one-hour pickup hold, with no
 * valid code). The browser sends intent only; staff identity, time and eligibility are server-owned.
 * No refund happens; the Store decides any refund through the ordinary refund workflow.
 */
export function createMerchantPickupNotCollected(options: {
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
  nextReference(): string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize(input);
    let intent: Readonly<Record<string, unknown>>;
    // WP-2423 store-service-controls (v15 M46, Owner item 9): `reason: "StoreClosing"` closes a
    // ready order for the night once the Store's service for the day has ended.
    const withReason =
      input.command !== null &&
      typeof input.command === "object" &&
      Object.hasOwn(input.command, "reason");
    try {
      intent = readClosedRecord(input.command, [
        "orderReference",
        "storeReference",
        "expectedAggregateVersion",
        "idempotencyReference",
        "correlationReference",
        ...(withReason ? ["reason"] : []),
      ]);
    } catch {
      return invalid();
    }
    if (withReason && intent.reason !== "StoreClosing") return invalid();
    const storeClosing = withReason;
    const orderReference = parsePickupProofReference(intent.orderReference);
    const idempotencyReference = parsePickupProofReference(intent.idempotencyReference);
    const correlationReference = parsePickupProofReference(intent.correlationReference);
    if (
      typeof intent.expectedAggregateVersion !== "string" ||
      !/^[1-9][0-9]{0,18}$/u.test(intent.expectedAggregateVersion) ||
      BigInt(intent.expectedAggregateVersion) > 9223372036854775807n
    )
      return invalid();
    const expectedAggregateVersion = BigInt(intent.expectedAggregateVersion);
    const denied = (): never => {
      throw new PickupHandoffError("PICKUP_HANDOFF_PERMISSION_DENIED");
    };
    // WP-2423: one authorized run. The caller and `ordering.order.cancel` are resolved in full once
    // at the start and once more before the commit (inside this transaction, so a withdrawn
    // permission or ended Session never commits); the owner store's authorize callback, which
    // runs while the order is locked, takes the run's no-query guard.
    return options.persistence.transactions.run((transaction) =>
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const resolved = await resolveScope(
              transaction,
              input.sessionCookie,
              closeUncollectedPickupPermission,
              session.sessionReference,
            );
            if (
              intent.storeReference !== resolved.store.storeReference ||
              (await resolved.allowed()) !== true
            )
              return denied();
            return resolved;
          },
          recheck: async (scope) => (await scope.allowed()) === true,
          denied,
        },
        async (authority) => {
          const scope = authority.scope;
          const tx = transaction as unknown as ConsumerTransaction;
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
            authorize: async (ownerTransaction, access) =>
              access.actorReference === scope.actorReference &&
              access.orderReference === orderReference &&
              access.permission === completePickupHandoffPermission &&
              (await authority.guard(ownerTransaction)),
          });
          const closedAt = options.persistence.now();
          // The day's service has ended: after the last service period's end (the effective close
          // tonight), or on a day the Store does not open. Read in this transaction.
          let closingFrom: string | null = null;
          if (storeClosing) {
            const day = await createMerchantStoreBusinessDay({
              publication: options.persistence.publication,
              tenantReference: scope.selected.tenantReference,
              brandReference: selected.brandReference,
              storeReference: selected.storeReference,
              timeZone: scope.store.timeZone,
              authorize: () => authority.guard(),
            })(transaction, closedAt);
            closingFrom = storeClosingFrom(day, closedAt);
            if (closingFrom === null)
              throw new PickupHandoffError("PICKUP_HANDOFF_NOT_CLOSING_YET");
          }
          const result = await store.closeUncollected({
            transaction: tx,
            orderReference,
            expectedAggregateVersion,
            notCollectedReference: options.nextReference(),
            idempotencyReference,
            correlationReference,
            closedAt,
            closingFrom,
          });
          // DEC-PICKUP-NOT-COLLECTED-REMAKE (2026-10-19): nobody is coming for the order, so a
          // dish the kitchen is still remaking for it is cancelled with the closure (the guest no
          // longer wants it) and leaves the Kitchen screen, instead of being made for an order
          // that can no longer be handed over. Same transaction: both happen or neither, and a
          // failure is answered like the closure's own (retry the same close).
          if (result.status === "Applied")
            await createPostgresKitchenReworkStore({
              ...selected,
              nextReference: options.nextReference,
            })
              .cancelOpenForOrder(tx, {
                orderReference,
                actorReference: scope.actorReference,
                occurredAt: result.record.closedAt,
                correlationReference,
              })
              .catch((error: unknown) => {
                if (error instanceof KitchenReworkError) return invalid();
                throw error;
              });
          return Object.freeze({
            status: result.status,
            fulfillmentReference: result.record.fulfillmentReference,
            closedAt: result.record.closedAt,
          });
        },
      ),
    );
  };
}
