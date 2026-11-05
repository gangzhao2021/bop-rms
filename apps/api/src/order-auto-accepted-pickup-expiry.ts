import type { ConsumerTransaction } from "@bop/eventing";
import { listStoreKitchenBatchTouches } from "@rms/kitchen";
import {
  createPostgresStaffOrderCancellationStore,
  listStoreOpenAutoAcceptedBatches,
  orderAutoAcceptedPickupRefundAt,
  type OpenAutoAcceptedBatch,
} from "@rms/ordering";
import {
  cancelPaidBatch,
  StaffOrderCancellationError,
  type StaffOrderCancellationOptions,
} from "./merchant-order-staff-cancellation.js";

const discoveryWindowMs = 24 * 60 * 60_000;

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT (Owner decision, default): today's promise for a pickup nobody
 * acts on stays. An automatically accepted pickup the kitchen has not touched 30 minutes after it was
 * sent closes and refunds in full, as a System cancellation: Kitchen items Cancelled, stock released,
 * the record the Payment compensation refunds from, the audit saying System. Every screen warns at
 * 5 minutes, 2 minutes and 30 seconds, and any kitchen step stops it. Table rounds are never refunded
 * automatically (DEC-DINE-IN-PAID-ROUND-WAIT): the guest is in the room.
 */
export function createOrderAutoAcceptedPickupExpiry(options: {
  scope: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>;
  /** The reserved System actor: never a person (the actor columns require one). */
  systemActorReference: string;
  transactions: { run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T> };
  now(): string;
  newReference(): string;
  authorize(transaction: ConsumerTransaction): Promise<boolean>;
  resolveRefundConfiguration?: StaffOrderCancellationOptions["resolveRefundConfiguration"];
}) {
  const scope = Object.freeze({ ...options.scope });
  const ownerScope = Object.freeze({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  });
  return Object.freeze({
    /** Pickups past their time that the kitchen has not touched. */
    async listDue(limit: number): Promise<readonly OpenAutoAcceptedBatch[]> {
      return options.transactions.run(async (tx) => {
        if ((await options.authorize(tx)) !== true) return [];
        const now = options.now();
        const batches = (
          await listStoreOpenAutoAcceptedBatches(tx, ownerScope, {
            since: new Date(Date.parse(now) - discoveryWindowMs).toISOString(),
            limit: 200,
            onlyPickup: true,
          })
        ).filter((batch) => orderAutoAcceptedPickupRefundAt(batch.acceptedAt) <= now);
        const touches = await listStoreKitchenBatchTouches(
          tx,
          ownerScope,
          batches.map((batch) => batch.orderBatchReference),
        );
        return batches
          .filter((batch) => touches.get(batch.orderBatchReference) !== "Touched")
          .slice(0, limit);
      });
    },
    /**
     * One pickup in its own transaction. The kitchen is checked again under the Order fence; a step
     * made in the meantime leaves the order alone. A repeat after it closed finds nothing to do.
     */
    async close(batch: OpenAutoAcceptedBatch): Promise<"Closed" | "NotDue"> {
      try {
        return await options.transactions.run(async (tx) => {
          if ((await options.authorize(tx)) !== true) return "NotDue" as const;
          const actorReference = options.systemActorReference;
          const allowed = () => options.authorize(tx);
          const owned = async (
            t: ConsumerTransaction,
            identity: {
              orderReference: string;
              orderBatchReference: string;
              actorReference: string;
            },
          ) =>
            t === tx &&
            identity.orderReference === batch.orderReference &&
            identity.orderBatchReference === batch.orderBatchReference &&
            identity.actorReference === actorReference &&
            (await allowed());
          const ordering = createPostgresStaffOrderCancellationStore({
            ...ownerScope,
            authorize: owned,
          });
          const fenced = await ordering.prepare(tx, {
            orderReference: batch.orderReference,
            orderBatchReference: batch.orderBatchReference,
            expectedOrderVersion: batch.acceptedOrderVersion,
            actorReference,
          });
          if (fenced.status === "NotEligible") return "NotDue" as const;
          const touches = await listStoreKitchenBatchTouches(tx, ownerScope, [
            batch.orderBatchReference,
          ]);
          if (touches.get(batch.orderBatchReference) === "Touched") return "NotDue" as const;
          await cancelPaidBatch(tx, {
            options: {
              ...(options.resolveRefundConfiguration === undefined
                ? {}
                : { resolveRefundConfiguration: options.resolveRefundConfiguration }),
              now: options.now,
              nextReference: options.newReference,
            },
            selected: scope,
            ordering,
            owned,
            allowed,
            orderReference: batch.orderReference,
            orderBatchReference: batch.orderBatchReference,
            expectedOrderVersion: batch.acceptedOrderVersion,
            operationReference: options.newReference(),
            actorReference,
            reasonCode: "STORE_ERROR",
            autoAcceptedOnly: true,
            bySystem: true,
          });
          return "Closed" as const;
        });
      } catch (error) {
        // Started, changed or no longer open: a person's order now, or the next pass finds it.
        if (error instanceof StaffOrderCancellationError) return "NotDue";
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "KITCHEN_WORK_STARTED" || code === "40P01" || code === "55P03")
          return "NotDue";
        throw error;
      }
    },
  });
}

/**
 * One pass over what is due, run by the pickup expiry workload after its own closures. A failing
 * Order waits longer each time and never holds up the others; failures are codes only.
 */
export function createOrderAutoAcceptedPickupSweep(options: {
  expiry: ReturnType<typeof createOrderAutoAcceptedPickupExpiry>;
  now(): string;
  pageSize: number;
  onFailure(code: string): void;
}) {
  const failing = new Map<string, { waitMs: number; dueAt: number }>();
  return Object.freeze({
    async runOnce(): Promise<number> {
      let processed = 0;
      for (const batch of await options.expiry.listDue(options.pageSize)) {
        const at = Date.parse(options.now());
        const prior = failing.get(batch.orderBatchReference);
        if (prior !== undefined && at < prior.dueAt) continue;
        try {
          await options.expiry.close(batch);
          failing.delete(batch.orderBatchReference);
          processed += 1;
        } catch (error) {
          const waitMs = prior === undefined ? 60_000 : Math.min(prior.waitMs * 2, 3_600_000);
          failing.set(batch.orderBatchReference, { waitMs, dueAt: at + waitMs });
          const code = (error as { code?: unknown } | null)?.code;
          options.onFailure(
            typeof code === "string" && /^[A-Z0-9_]{1,80}$/u.test(code) ? code : "UNAVAILABLE",
          );
        }
      }
      return processed;
    },
  });
}
