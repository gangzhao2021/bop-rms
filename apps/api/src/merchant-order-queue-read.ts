import { createDiningOrderDeliveryProgress } from "./dining-order-delivery-progress.js";
import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresMerchantOrderIndex,
  createPostgresOrderAcceptanceReader,
  createPostgresOrderCreationQueryStore,
  readOrderCreationQuoteVersion,
  createPostgresOrderExecutionReader,
  createPostgresDiningOrderItemStateReader,
  createPostgresDiningOrderPreparationSource,
  parseOrderingInstant,
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
}) {
  return async (input: {
    sessionCookie: unknown;
    afterOrderReference: string | null;
    limit: number;
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
      const index = await createPostgresMerchantOrderIndex({
        ...ownerScope,
        authorize: allowed,
      }).list({
        transaction,
        afterOrderReference: input.afterOrderReference,
        limit: input.limit,
      });
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
      const items = [];
      for (const item of index.items) {
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
              return {
                phase: execution.phase,
                version: execution.version,
                observedAt,
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
                  batches: [],
                }
              : {
                  phase: progress?.phase ?? unavailable(),
                  version: execution.orderVersion,
                  observedAt,
                  batches: execution.batches.map((batch) => ({
                    orderBatchReference: batch.orderBatchReference,
                    sequence: batch.sequence,
                    acceptanceStatus: batch.cancellation
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
            submittedAt: item.submittedAt,
            initialBatchReference: item.initialBatchReference,
            batches: Object.freeze(current.batches.map((batch) => Object.freeze(batch))),
            currentPhase: current.phase,
            currentVersion: current.version,
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
