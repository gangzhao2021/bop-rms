import {
  createDiningOrderDeliveryProgress,
  readyToServeQuantity,
} from "./dining-order-delivery-progress.js";
import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresKitchenCustomerStatusReader } from "@rms/kitchen";
import { withOptionalRead } from "./merchant-round-business-date.js";
import {
  readEarlierOrdersHoldingStock,
  type EarlierOrderHoldingStock,
} from "./merchant-stock-holding-orders.js";
import {
  acquireOrderDispositionFence,
  createPostgresMerchantOrderIndex,
  createPostgresOrderAcceptanceReader,
  createPostgresOrderCreationQueryStore,
  readOrderCreationQuoteVersion,
  createPostgresOrderExecutionReader,
  createPostgresDiningOrderItemStateReader,
  createPostgresDiningOrderPreparationSource,
  parseOrderingInstant,
  listStoreOrdersWithRoundsSince,
} from "@rms/ordering";

type Scope = Readonly<{
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  sessionReference: string;
}>;
const unavailable = (): never => {
  throw new Error("MERCHANT_ORDER_QUEUE_UNAVAILABLE");
};

/** Scoped current owner reads, not the old immutable Submitted/Fulfilled projection. */
export function createMerchantOrderQueueRead(options: {
  transactions: { run<T>(work: (transaction: ConsumerTransaction) => Promise<T>): Promise<T> };
  authorize(transaction: ConsumerTransaction, sessionCookie: unknown): Promise<Scope | null>;
  quoteVersion: 1 | 2;
  now(): string;
  /**
   * WP-2423 D4: the Store's current business day (its date and start), so an Order opened on an
   * earlier day that had a round today is listed with today's orders. Without it, Orders are
   * listed by the day they were opened only.
   */
  today?(transaction: ConsumerTransaction): Promise<{
    readonly businessDate: string;
    readonly startsAt: string;
  }>;
}) {
  return async (input: {
    sessionCookie: unknown;
    afterOrderReference: string | null;
    limit: number;
    /** WP-2423 OPS-ORDER-DETAIL: only this Order (an empty page when not at this Store). */
    onlyOrderReference?: string;
  }) =>
    options.transactions.run(async (transaction) => {
      const scope = await options.authorize(transaction, input.sessionCookie);
      if (scope === null) return unavailable();
      const recheck = async () => {
        const current = await options.authorize(transaction, input.sessionCookie);
        return (
          current !== null &&
          current.tenantReference === scope.tenantReference &&
          current.brandReference === scope.brandReference &&
          current.storeReference === scope.storeReference &&
          current.sessionReference === scope.sessionReference
        );
      };
      // WP-2423: the per-order readers are read-only and share one confirmation instead of a full
      // session/membership/policy evaluation each (3–5 per order made a 50-order page exceed its
      // timeout). Nothing is returned unless the full recheck after the last read still holds.
      let confirmed: Promise<boolean> | null = null;
      const allowed = () => (confirmed ??= recheck());
      const ownerScope = {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
      };
      const orderIndex = createPostgresMerchantOrderIndex({
        ...ownerScope,
        authorize: allowed,
      });
      // WP-2423 D4: a table's Order opened on an earlier business day that had a round today is
      // today's work. A real floor reads the Orders page as "what is happening today", so such an
      // Order is listed first with today's orders (under today, latest round first) instead of
      // pages back under the day it was opened; it keeps its own business date, since its order
      // number belongs to that day. Other pages leave it out so it is listed once.
      // An unreadable business day never blanks the Orders page: Orders keep their own day.
      const readToday = options.today;
      const today =
        readToday === undefined
          ? null
          : await withOptionalRead(transaction, () => readToday(transaction), null);
      const carried =
        today === null
          ? []
          : await listStoreOrdersWithRoundsSince(transaction, ownerScope, {
              since: today.startsAt,
              businessDate: today.businessDate,
              limit: 100,
            });
      // WP-2423 (2026-10-16 v15 stock leak): an Order of an earlier day that still has stock set
      // aside is listed first with today's orders too (oldest first, after the tables above), so it
      // is never left holding stock unseen: staff make and hand it over, cancel it, or release the
      // stock of one that already ended. An unreadable answer never blanks the Orders page.
      const holding =
        today === null
          ? []
          : await withOptionalRead(
              transaction,
              () => readEarlierOrdersHoldingStock(transaction, scope, today),
              [] as readonly EarlierOrderHoldingStock[],
            );
      const heldByOrder = new Map<string, EarlierOrderHoldingStock>();
      for (const entry of holding) {
        // One row per Order: a live round wins over an ended one, the oldest hold is shown.
        const prior = heldByOrder.get(entry.orderReference);
        if (
          prior === undefined ||
          (prior.state === "Ended" && entry.state === "Open") ||
          (prior.state === entry.state && entry.heldSince < prior.heldSince)
        )
          heldByOrder.set(entry.orderReference, entry);
      }
      const carriedOrders = new Set([
        ...carried.map((order) => order.orderReference),
        ...heldByOrder.keys(),
      ]);
      const listing = input.onlyOrderReference === undefined;
      // WP-2423 (2026-10-16 v15): the earlier-day Orders listed with today's (first page only) are
      // a separate part of the answer. The page itself leaves exactly those Orders out, so it still
      // holds `limit` Orders whenever another page follows and the next page starts after its last
      // Order. Earlier-day Orders beyond this count stay on the page of the day they were opened.
      const earlierList = listing
        ? [
            ...new Set([...carried.map((order) => order.orderReference), ...heldByOrder.keys()]),
          ].slice(0, input.limit)
        : [];
      const earlier = new Set(earlierList);
      const index = await orderIndex.list({
        transaction,
        afterOrderReference: input.afterOrderReference,
        limit: input.limit,
        newestFirst: true,
        ...(input.onlyOrderReference === undefined
          ? { excludeOrderReferences: earlierList }
          : { onlyOrderReference: input.onlyOrderReference }),
      });
      const earlierItems = [];
      if (input.afterOrderReference === null && listing)
        for (const orderReference of earlierList)
          earlierItems.push(
            ...(
              await orderIndex.list({
                transaction,
                afterOrderReference: null,
                limit: 1,
                newestFirst: true,
                onlyOrderReference: orderReference,
              })
            ).items,
          );
      const listed = [
        ...earlierItems.map((item) => ({ item, earlierDay: true })),
        ...index.items.map((item) => ({ item, earlierDay: false })),
      ];
      // WP-2423: history may hold Orders priced with either Quote version; each is decoded with its own.
      const readers = {
        1: createPostgresOrderCreationQueryStore(
          { run: (work) => work(transaction) },
          ownerScope,
          1,
        ),
        2: createPostgresOrderCreationQueryStore(
          { run: (work) => work(transaction) },
          ownerScope,
          2,
        ),
      } as const;
      // WP-2423 (v15 2026-10-18, 40P01): every listed Order's disposition fence is taken first, in
      // ascending Order reference: the one order every read that fences several Orders uses (the
      // pickup queue too). Fenced one by one in list order (newest first), this read deadlocked
      // with the pickup queue fencing the same two Orders oldest first. Re-entrant: each Order's
      // readers below take the fence again. The list keeps its order.
      // The pilot runs this read as a snapshot read (55P03, same day), where these fences and the
      // readers' row locks are answered locally: one snapshot of every owner, no lock held. They
      // remain for a composition that runs it as an ordinary transaction.
      for (const orderReference of [...new Set(listed.map(({ item }) => item.orderReference))]
        .map(String)
        .sort())
        await acquireOrderDispositionFence(transaction, { ...ownerScope, orderReference });
      const items = [];
      for (const { item, earlierDay } of listed) {
        // Match acceptance/payment writers: disposition fence before the header row lock.
        const initialAcceptance = await createPostgresOrderAcceptanceReader({
          ...ownerScope,
          authorize: allowed,
        }).loadByBatch({
          transaction,
          orderReference: item.orderReference,
          orderBatchReference: item.initialBatchReference,
        });
        const version =
          (await readOrderCreationQuoteVersion(
            transaction,
            ownerScope,
            item.initialSubmissionReference,
          )) ?? options.quoteVersion;
        const current = await (readers[version] as (typeof readers)[1]).withCurrentSubmission(
          item.initialSubmissionReference,
          async (_, original) => {
            if (
              original.order.orderReference !== item.orderReference ||
              original.order.orderType !== item.orderType ||
              original.order.batches[0]?.orderBatchReference !== item.initialBatchReference
            )
              return unavailable();
            const observedAt = parseOrderingInstant(options.now());
            if (item.orderType === "Pickup") {
              const execution = await createPostgresOrderExecutionReader({
                ...ownerScope,
                authorize: allowed,
                sha256: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
              }).loadByBatch({
                transaction,
                orderReference: item.orderReference,
                orderBatchReference: item.initialBatchReference,
              });
              if (execution.occurredAt > observedAt) return unavailable();
              // WP-2423 (v15 2026-10-18): on the order detail, what the kitchen itself shows now —
              // the public source the customer's page reads — so staff see "Preparing"/"Ready" the
              // moment the kitchen does, as the customer does. It changes nothing on the Order
              // (its version and commands still follow Ordering). Unreadable leaves it unknown.
              let kitchenPhase: "InProgress" | "Ready" | null = null;
              // A pickup's Ordering phase stays Accepted until it is handed over.
              if (!listing && execution.phase === "Accepted") {
                const work = await createPostgresKitchenCustomerStatusReader({
                  ...ownerScope,
                  authorize: async (_tx, kitchenScope) =>
                    kitchenScope.orderReference === item.orderReference && (await allowed()),
                })
                  .loadByOrder({ transaction, orderReference: item.orderReference })
                  .catch(() => null);
                const batch =
                  work !== null && work.batches.length === 1 ? work.batches[0] : undefined;
                if (
                  batch !== undefined &&
                  batch.orderBatchReference === item.initialBatchReference &&
                  batch.updatedAt <= observedAt &&
                  (batch.status === "InProgress" || batch.status === "Ready")
                )
                  kitchenPhase = batch.status;
              }
              return {
                phase: execution.phase,
                version: execution.version,
                observedAt,
                kitchenPhase,
                // Pickup readiness is a Fulfillment fact (the pickup queue), never served here.
                readyToServeItemCount: 0,
                batches: [
                  {
                    orderBatchReference: item.initialBatchReference,
                    sequence: 1,
                    acceptanceStatus: initialAcceptance ? "Accepted" : "NotAccepted",
                  },
                ],
              };
            }
            if (original.order.diningSessionReference === null) return unavailable();
            const execution = await createPostgresDiningOrderItemStateReader({
              ...ownerScope,
              authorize: allowed,
            }).load({
              transaction,
              ...ownerScope,
              orderReference: item.orderReference,
              diningSessionReference: original.order.diningSessionReference,
              guestSessionReference: original.guestSessionReference,
              observedAt,
            });
            const progress =
              execution === null
                ? null
                : await createDiningOrderDeliveryProgress({
                    ...ownerScope,
                    diningScope: {
                      tenantReference: scope.tenantReference,
                      ...ownerScope,
                    },
                    authorize: allowed,
                    authorizeKitchen: allowed,
                    authorizeDining: allowed,
                  }).load({
                    transaction,
                    ...ownerScope,
                    orderReference: item.orderReference,
                    diningSessionReference: original.order.diningSessionReference,
                    guestSessionReference: original.guestSessionReference,
                    observedAt,
                  });
            if (
              execution !== null &&
              (progress === null || progress.orderVersion !== execution.orderVersion)
            )
              return unavailable();
            // Payable-state absence is not a terminal phase. Resolve cancellation
            // from owning history; unsupported terminal states remain unresolved.
            const cancelled =
              execution === null
                ? await createPostgresDiningOrderPreparationSource({
                    ...ownerScope,
                    authorize: allowed,
                  }).resolveCancelled({
                    transaction,
                    ...ownerScope,
                    orderReference: item.orderReference,
                    diningSessionReference: original.order.diningSessionReference,
                    guestSessionReference: original.guestSessionReference,
                    observedAt,
                  })
                : null;
            return execution === null
              ? {
                  phase: cancelled?.phase ?? null,
                  version: cancelled?.orderVersion ?? null,
                  observedAt,
                  readyToServeItemCount: 0,
                  kitchenPhase: null,
                  batches: [],
                }
              : {
                  phase: progress?.phase ?? unavailable(),
                  version: execution.orderVersion,
                  observedAt,
                  // A table's phase already follows the kitchen (delivery progress).
                  kitchenPhase: null,
                  // WP-2423: items the kitchen marked ready that nobody served yet, in any round —
                  // the same delivery progress and rule as the Tables page's close dialog.
                  readyToServeItemCount: readyToServeQuantity(progress?.items ?? []),
                  batches: execution.batches.map((batch) => ({
                    orderBatchReference: batch.orderBatchReference,
                    sequence: batch.sequence,
                    // WP-2423 Q6: a batch staff cancelled after acceptance is Cancelled too.
                    acceptanceStatus:
                      batch.cancellation || batch.staffCancellation
                        ? "Cancelled"
                        : batch.acceptance
                          ? "Accepted"
                          : "NotAccepted",
                  })),
                };
          },
        );
        if (current === null) return unavailable();
        items.push(
          Object.freeze({
            orderReference: item.orderReference,
            orderNumber: item.orderNumber,
            orderType: item.orderType,
            sourceChannel: item.sourceChannel,
            businessDate: item.businessDate,
            /**
             * WP-2423 D4: the business day the Order is listed under — today when a round was
             * submitted today on an Order opened on an earlier day, otherwise its own day.
             */
            listedBusinessDate:
              today !== null &&
              (listing ? earlier.has(item.orderReference) : carriedOrders.has(item.orderReference))
                ? today.businessDate
                : item.businessDate,
            /**
             * WP-2423 (2026-10-16 v15): listed with today's orders from an earlier day (first page
             * only), outside the page's newest-first sequence and its page size.
             */
            earlierDay,
            submittedAt: item.submittedAt,
            initialBatchReference: item.initialBatchReference,
            /** WP-2423 (2026-10-16): stock still set aside for this earlier-day Order, else null. */
            heldStock: ((held) =>
              held === undefined
                ? null
                : Object.freeze({
                    since: held.heldSince,
                    state: held.state,
                    orderBatchReference: held.orderBatchReference,
                    productionStarted: held.productionStarted,
                  }))(heldByOrder.get(item.orderReference)),
            batches: Object.freeze(current.batches.map((batch) => Object.freeze(batch))),
            currentPhase: current.phase,
            currentVersion: current.version,
            /** WP-2423: dine-in items ready at the pass and not yet served (0 for pickups). */
            readyToServeItemCount: current.readyToServeItemCount,
            /**
             * WP-2423 (v15 2026-10-18): a pickup's kitchen state on the order detail while Ordering
             * has not recorded it yet (null otherwise, and always on the list).
             */
            kitchenPhase: current.kitchenPhase,
            observedAt: current.observedAt,
          }),
        );
      }
      if (!(await recheck())) return unavailable();
      return Object.freeze({
        items: Object.freeze(items),
        nextAfterOrderReference: index.nextAfterOrderReference,
      });
    });
}
