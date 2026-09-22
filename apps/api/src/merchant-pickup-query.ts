import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresFulfillmentReadinessStore,
  parseReadinessReference,
  FulfillmentReadinessError,
} from "@rms/fulfillment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
type StoreOptions = Parameters<typeof createPostgresFulfillmentReadinessStore>[0];
function invalid(): never {
  throw new FulfillmentReadinessError("FULFILLMENT_READINESS_INPUT_INVALID");
}
export function createMerchantPickupQuery(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  store: Pick<StoreOptions, "sha256" | "validateCurrentSource">;
  /** Configured workstation for this authenticated session; not completion authority. */
  resolveWorkstation?(
    transaction: ConsumerTransaction,
    context: {
      actorReference: string;
      sessionReference: string;
      brandReference: string;
      storeReference: string;
    },
  ): Promise<{ deviceReference: string; pickupLocationReference: string } | null>;

  installContext(
    transaction: ConsumerTransaction,
    scope: { brandReference: string; storeReference: string },
  ): Promise<void>;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    const session = await options.authentication.authorize(input);
    let raw: Readonly<Record<string, unknown>>;
    try {
      raw = readClosedRecord(input.query, [
        "afterFulfillmentReference",
        "limit",
        "includeCompleted",
      ]);
    } catch {
      return invalid();
    }
    const afterFulfillmentReference =
      raw.afterFulfillmentReference === null
        ? null
        : parseReadinessReference(raw.afterFulfillmentReference);
    if (
      typeof raw.limit !== "number" ||
      !Number.isSafeInteger(raw.limit) ||
      raw.limit < 1 ||
      raw.limit > 50 ||
      typeof raw.includeCompleted !== "boolean"
    )
      return invalid();
    const limit = raw.limit,
      includeCompleted = raw.includeCompleted;
    return options.persistence.transactions.run(async (transaction) => {
      const scope = await resolveScope(
        transaction,
        input.sessionCookie,
        "fulfillment.operate",
        session.sessionReference,
      );
      if (!(await scope.allowed()))
        throw new FulfillmentReadinessError("FULFILLMENT_READINESS_PERMISSION_DENIED");
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
      const store = createPostgresFulfillmentReadinessStore({
        ...options.store,
        ...selected,
        now: options.persistence.now,
        authorizeQueue: () => scope.allowed(),
        authorize: async (_tx, access) => access.access === "Current" && (await scope.allowed()),
      });
      const result = await store.listPickupQueue({
        transaction: tx,
        afterFulfillmentReference,
        limit,
        includeCompleted,
      });
      const configured = options.resolveWorkstation
        ? await options.resolveWorkstation(tx, {
            ...selected,
            actorReference: scope.actorReference,
            sessionReference: session.sessionReference,
          })
        : null;
      const workstation =
        configured === null
          ? null
          : Object.freeze({
              deviceReference: parseReadinessReference(configured.deviceReference),
              pickupLocationReference: parseReadinessReference(configured.pickupLocationReference),
            });
      if (!(await scope.allowed()))
        throw new FulfillmentReadinessError("FULFILLMENT_READINESS_PERMISSION_DENIED");
      return Object.freeze({
        ...result,
        workstation,
        storeReference: selected.storeReference,
        items: result.items.map((item) =>
          Object.freeze({ ...item, aggregateVersion: item.aggregateVersion.toString() }),
        ),
      });
    });
  };
}
