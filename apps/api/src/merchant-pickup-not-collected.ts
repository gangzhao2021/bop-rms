import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresPickupHandoffStore,
  parsePickupProofReference,
  PickupHandoffError,
  completePickupHandoffPermission,
} from "@rms/fulfillment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

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
    try {
      intent = readClosedRecord(input.command, [
        "orderReference",
        "storeReference",
        "expectedAggregateVersion",
        "idempotencyReference",
        "correlationReference",
      ]);
    } catch {
      return invalid();
    }
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
    return options.persistence.transactions.run(async (transaction) => {
      const scope = await resolveScope(
        transaction,
        input.sessionCookie,
        closeUncollectedPickupPermission,
        session.sessionReference,
      );
      if (intent.storeReference !== scope.store.storeReference || !(await scope.allowed()))
        throw new PickupHandoffError("PICKUP_HANDOFF_PERMISSION_DENIED");
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
        authorize: async (_tx, access) =>
          access.actorReference === scope.actorReference &&
          access.orderReference === orderReference &&
          access.permission === completePickupHandoffPermission &&
          (await scope.allowed()),
      });
      const result = await store.closeUncollected({
        transaction: tx,
        orderReference,
        expectedAggregateVersion,
        notCollectedReference: options.nextReference(),
        idempotencyReference,
        correlationReference,
        closedAt: options.persistence.now(),
      });
      return Object.freeze({
        status: result.status,
        fulfillmentReference: result.record.fulfillmentReference,
        closedAt: result.record.closedAt,
      });
    });
  };
}
