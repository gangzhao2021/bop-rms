import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createKitchenQueueProjectionService,
  createPostgresKitchenQueueQueries,
  lockPostgresKitchenQueueRead,
  KitchenQueueProjectionError,
  type KitchenQueueItemView,
} from "@rms/kitchen";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

const unavailable = async (): Promise<never> => {
  throw new KitchenQueueProjectionError("KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE");
};
const itemView = (item: KitchenQueueItemView) => ({
  ...item,
  ticketAggregateVersion: item.ticketAggregateVersion.toString(10),
  workItemVersion: item.workItemVersion.toString(10),
});

/** Selected scope and authority never come from browser query fields. */
export function createMerchantKitchenQuery(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  sha256(value: string): string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    const session = await options.authentication.authorize(input);
    let query: Readonly<Record<string, unknown>>;
    try {
      if (typeof input.query !== "object" || input.query === null) throw new Error("invalid query");
      const descriptor = Object.getOwnPropertyDescriptor(input.query, "kind");
      const kind = descriptor && "value" in descriptor ? descriptor.value : null;
      if (kind !== "List" && kind !== "Get") throw new Error("invalid query");
      query = readClosedRecord(
        input.query,
        kind === "List" ? ["kind", "filters", "cursor", "limit"] : ["kind", "workItemReference"],
      );
    } catch {
      throw new KitchenQueueProjectionError("KITCHEN_QUEUE_INPUT_INVALID");
    }
    return options.persistence.transactions.run(async (transaction) => {
      const scope = await resolveScope(
        transaction,
        input.sessionCookie,
        "kitchen.operate",
        session.sessionReference,
      );
      if (!(await scope.allowed()))
        throw new KitchenQueueProjectionError("KITCHEN_QUEUE_PERMISSION_DENIED");
      const authority = {
        actorReference: scope.actorReference,
        brandReference: scope.context.brand.brandReference,
        storeReference: scope.store.storeReference,
        observedAt: options.persistence.now(),
      };
      const tx: ConsumerTransaction = {
        async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
          const result = await transaction.query(sql, values);
          if (!result || typeof result !== "object") return unavailable();
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
            return unavailable();
          return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
        },
      };
      await lockPostgresKitchenQueueRead({ ...authority, transaction: tx });
      const service = createKitchenQueueProjectionService({
        authorization: {
          authorize: async (candidate) =>
            candidate.brandReference === authority.brandReference &&
            candidate.storeReference === authority.storeReference &&
            "actorReference" in candidate &&
            candidate.actorReference === authority.actorReference &&
            (await scope.allowed()),
        },
        trustedContext: { resolveQueryAuthority: async () => authority },
        transactions: { withTransaction: (work) => work(tx) },
        tenantContext: {
          install: async (candidate) => {
            if (
              candidate.brandReference !== authority.brandReference ||
              candidate.storeReference !== authority.storeReference ||
              !(await scope.allowed())
            )
              throw new KitchenQueueProjectionError("KITCHEN_QUEUE_PERMISSION_DENIED");
          },
        },
        queries: createPostgresKitchenQueueQueries({
          ...authority,
          authorize: async () => scope.allowed(),
        }),
        locks: { acquireStoreProjection: unavailable },
        checkpoints: {
          compareIncremental: unavailable,
          compareRebuild: unavailable,
          compareLifecycleIncremental: unavailable,
        },
        sources: {
          loadIncremental: unavailable,
          loadRebuild: unavailable,
          loadLifecycleIncremental: unavailable,
        },
        projections: {
          loadActive: unavailable,
          loadByRebuildReference: unavailable,
          replaceActive: unavailable,
        },
        references: {
          nextGenerationReference: () => {
            throw new KitchenQueueProjectionError("KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE");
          },
        },
        clock: { now: () => authority.observedAt },
        digests: { sha256: options.sha256 },
      });
      if (query.kind === "List") {
        const result = await service.list({
          ...authority,
          filters: query.filters,
          cursor: query.cursor,
          limit: query.limit,
        });
        return {
          ...result,
          operatorStatus: "Unverified" as const,
          storeReference: authority.storeReference,
          items: result.items.map(itemView),
        };
      }
      const result = await service.get({
        ...authority,
        workItemReference: query.workItemReference,
      });
      return {
        ...result,
        operatorStatus: "Unverified" as const,
        storeReference: authority.storeReference,
        item: itemView(result.item),
      };
    });
  };
}
