import type { ConsumerTransaction } from "@bop/eventing";
import {
  KitchenBatchCancellationError,
  listStoreKitchenBatchTouches,
  loadStoreLastKitchenStepAt,
} from "@rms/kitchen";
import {
  createPostgresStaffOrderCancellationStore,
  listStoreOpenAutoAcceptedBatches,
  listStoreOrderAutoAcceptanceFacts,
  resolveOrderAutoAcceptedPickupRefund,
  type OpenAutoAcceptedBatch,
  type OpenAutoAcceptedBatchCursor,
  type OrderAutoAcceptedPickupRefund,
} from "@rms/ordering";
import { loadStoreBackOnlineAfter, loadStorePresence } from "@rms/store";
import {
  cancelPaidBatch,
  StaffOrderCancellationError,
  type StaffOrderCancellationOptions,
} from "./merchant-order-staff-cancellation.js";

/** A pickup held through a long closure is still refunded when the Store's screens are back. */
const discoveryWindowMs = 14 * 24 * 60 * 60_000;
const discoveryPage = 200;

type OwnerScope = Readonly<{ brandReference: string; storeReference: string }>;

/** Staff presence at an instant, and when they came back if they were gone (Store's public read). */
const storeAtFor = (tx: ConsumerTransaction, scope: OwnerScope) => async (at: string) => {
  const presence = await loadStorePresence(tx, scope, at);
  return {
    online: presence.online,
    backOnlineAt: presence.online ? null : await loadStoreBackOnlineAfter(tx, scope, at),
  };
};

/** When this untouched pickup refunds, from the Store's and the kitchen's facts now. */
export function readOrderAutoAcceptedPickupRefund(
  tx: ConsumerTransaction,
  scope: OwnerScope,
  input: {
    readonly acceptedAt: string;
    readonly reachedKitchen: boolean;
    readonly lastKitchenStepAt: string | null;
    readonly observedAt: string;
  },
): Promise<OrderAutoAcceptedPickupRefund> {
  return resolveOrderAutoAcceptedPickupRefund({
    sentAt: input.acceptedAt,
    observedAt: input.observedAt,
    reachedKitchen: input.reachedKitchen,
    lastKitchenStepAt: input.lastKitchenStepAt,
    storeAt: storeAtFor(tx, scope),
  });
}

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT (Owner decision, default): today's promise for a pickup nobody
 * acts on stays. An automatically accepted pickup the kitchen has not touched 30 minutes after it was
 * sent closes and refunds what is left of its payment, as a System cancellation: Kitchen items
 * Cancelled, stock released, the record the Payment compensation refunds from, the audit saying
 * System. Every screen warns at 5 minutes, 2 minutes and 30 seconds.
 *
 * It stops for any kitchen step on the ticket, for a kitchen still recording steps (Start is optional,
 * so the queue may simply be long), for a person who said "Making it by hand", and for the Store being
 * offline at its time (no refund until staff are back and have had 15 minutes). Table rounds are
 * never refunded automatically (DEC-DINE-IN-PAID-ROUND-WAIT): the guest is in the room.
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
    /**
     * Pickups past their time that the kitchen has not touched, from `after` on. `next` carries on
     * where this page stopped, so pickups that can't close, or a day's open tickets, never hold back
     * the ones behind them; null when the pass reached the end.
     */
    async listDue(
      limit: number,
      after: OpenAutoAcceptedBatchCursor | null = null,
    ): Promise<{
      readonly due: readonly OpenAutoAcceptedBatch[];
      readonly next: OpenAutoAcceptedBatchCursor | null;
    }> {
      return options.transactions.run(async (tx) => {
        if ((await options.authorize(tx)) !== true) return { due: [], next: null };
        const now = options.now();
        const page = await listStoreOpenAutoAcceptedBatches(tx, ownerScope, {
          since: new Date(Date.parse(now) - discoveryWindowMs).toISOString(),
          limit: discoveryPage,
          onlyPickup: true,
          after,
        });
        const touches = await listStoreKitchenBatchTouches(
          tx,
          ownerScope,
          page.map((batch) => batch.orderBatchReference),
        );
        const lastKitchenStepAt = await loadStoreLastKitchenStepAt(tx, ownerScope, now);
        const position = (batch: OpenAutoAcceptedBatch) => ({
          acceptedAt: batch.acceptedAt,
          orderBatchReference: batch.orderBatchReference,
        });
        const due: OpenAutoAcceptedBatch[] = [];
        for (const batch of page) {
          const touch = touches.get(batch.orderBatchReference);
          if (batch.kept || touch === "Touched") continue;
          const refund = await readOrderAutoAcceptedPickupRefund(tx, ownerScope, {
            acceptedAt: batch.acceptedAt,
            reachedKitchen: touch !== undefined,
            lastKitchenStepAt,
            observedAt: now,
          });
          if (!refund.due) continue;
          due.push(batch);
          if (due.length === limit) return { due, next: position(batch) };
        }
        const last = page.at(-1);
        return { due, next: page.length === discoveryPage && last ? position(last) : null };
      });
    },
    /**
     * One pickup in its own transaction. Everything is decided again under the Order fence, at the
     * Order's version as it stands then: a line cancelled since it was accepted only leaves less to
     * refund. A kitchen step, a keep, an outage or a close made in the meantime leaves it alone
     * (NotDue); any other refusal throws, so it is reported by its code, not lost.
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
          const fenced = await ordering.prepareAtCurrentVersion(tx, {
            orderReference: batch.orderReference,
            orderBatchReference: batch.orderBatchReference,
            actorReference,
          });
          if (fenced.status === "NotEligible") {
            if (fenced.reason !== "NotConfirmed") return "NotDue" as const;
            throw new StaffOrderCancellationError("ORDER_CANCELLATION_NOT_CANCELLABLE");
          }
          const fact = (
            await listStoreOrderAutoAcceptanceFacts(tx, ownerScope, [batch.orderReference])
          ).get(batch.orderBatchReference);
          if (fact?.kind !== "Accepted") {
            throw new StaffOrderCancellationError("ORDER_CANCELLATION_NOT_CANCELLABLE");
          }
          if (fact.kept) return "NotDue" as const;
          const touch = (
            await listStoreKitchenBatchTouches(tx, ownerScope, [batch.orderBatchReference])
          ).get(batch.orderBatchReference);
          if (touch === "Touched") return "NotDue" as const;
          const observedAt = options.now();
          const refund = await readOrderAutoAcceptedPickupRefund(tx, ownerScope, {
            acceptedAt: batch.acceptedAt,
            reachedKitchen: touch !== undefined,
            lastKitchenStepAt: await loadStoreLastKitchenStepAt(tx, ownerScope, observedAt),
            observedAt,
          });
          if (!refund.due) return "NotDue" as const;
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
            expectedOrderVersion: fenced.plan.expectedOrderVersion,
            operationReference: options.newReference(),
            actorReference,
            reasonCode: "STORE_ERROR",
            autoAcceptedOnly: true,
            bySystem: true,
          });
          return "Closed" as const;
        });
      } catch (error) {
        // Started as it closed, or held up by whoever is changing it: the next pass finds out.
        if (error instanceof KitchenBatchCancellationError && error.code === "KITCHEN_WORK_STARTED")
          return "NotDue";
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "40P01" || code === "40001" || code === "55P03") return "NotDue";
        throw error;
      }
    },
  });
}

/**
 * One pass over what is due, run by the pickup expiry workload after its own closures. It carries on
 * through the Store's open pickups across passes, a failing Order waits longer each time and never
 * holds up the others, and failures are codes only.
 */
export function createOrderAutoAcceptedPickupSweep(options: {
  expiry: Pick<ReturnType<typeof createOrderAutoAcceptedPickupExpiry>, "listDue" | "close">;
  now(): string;
  pageSize: number;
  onFailure(code: string): void;
}) {
  const failing = new Map<string, { waitMs: number; dueAt: number }>();
  let after: OpenAutoAcceptedBatchCursor | null = null;
  return Object.freeze({
    async runOnce(): Promise<number> {
      let processed = 0;
      const page = await options.expiry.listDue(options.pageSize, after);
      after = page.next;
      for (const batch of page.due) {
        const at = Date.parse(options.now());
        const prior = failing.get(batch.orderBatchReference);
        if (prior !== undefined && at < prior.dueAt) continue;
        try {
          if ((await options.expiry.close(batch)) === "Closed") processed += 1;
          failing.delete(batch.orderBatchReference);
        } catch (error) {
          const waitMs = prior === undefined ? 60_000 : Math.min(prior.waitMs * 2, 3_600_000);
          if (failing.size >= 1_000) failing.clear();
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
