import { createMerchantDiningTableContext } from "./merchant-dining-table-context.js";
import {
  createPostgresMerchantOrderIndex,
  createPostgresOrderClosurePosition,
  createPostgresMerchantOrderItemLabels,
  parseOrderingReference,
} from "@rms/ordering";
import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createDiningOrderDeliveryProgress } from "./dining-order-delivery-progress.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/** Staff-only current serving facts. This query does not authorize financial closure. */
export function createMerchantDiningOrderProgress(options: {
  persistence: PersistentMerchantBffOptions;
  locale: string;
  authentication: Pick<MerchantBffService, "authorize">;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    const authorized = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.query, ["orderReference"]);
    const orderReference = parseOrderingReference(raw.orderReference);
    return options.persistence.transactions.run(async (transaction) => {
      const resolved = await resolveScope(
        transaction,
        input.sessionCookie,
        "dining.item.serve",
        authorized.sessionReference,
      );
      if ((await resolved.allowed()) !== true)
        throw new Error("DINING_ORDER_PROGRESS_PERMISSION_DENIED");
      const scope = {
        tenantReference: resolved.selected.tenantReference,
        brandReference: resolved.context.brand.brandReference,
        storeReference: resolved.store.storeReference,
      };
      const businessTransaction: ConsumerTransaction = {
        async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
          const result = await transaction.query(sql, values);
          if (!result || typeof result !== "object")
            throw new Error("DINING_ORDER_PROGRESS_UNAVAILABLE");
          const rows = Object.getOwnPropertyDescriptor(result, "rows");
          const count = Object.getOwnPropertyDescriptor(result, "rowCount");
          if (
            !rows ||
            !("value" in rows) ||
            !Array.isArray(rows.value) ||
            !count ||
            !("value" in count) ||
            (count.value !== null &&
              (typeof count.value !== "number" ||
                !Number.isSafeInteger(count.value) ||
                count.value < 0))
          )
            throw new Error("DINING_ORDER_PROGRESS_UNAVAILABLE");
          return { rows: rows.value as readonly Row[], rowCount: count.value as number | null };
        },
      };

      const allowed = async () => (await resolved.allowed()) === true;
      const selected = await createPostgresMerchantOrderIndex({
        ...scope,
        authorize: allowed,
      }).find({ transaction: businessTransaction, orderReference });
      if (!selected || selected.orderType !== "DineIn") return null;
      if (selected.diningSessionReference === null)
        throw new Error("DINING_ORDER_PROGRESS_UNAVAILABLE");
      const query = {
        orderReference,
        diningSessionReference: selected.diningSessionReference,
        guestSessionReference: selected.guestSessionReference,
      };
      const observedAt = options.persistence.now();
      const closure = await createPostgresOrderClosurePosition({
        ...scope,
        authorize: allowed,
      })(businessTransaction, { orderReference, observedAt });
      const current = await createDiningOrderDeliveryProgress({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        diningScope: scope,
        authorize: async () => (await resolved.allowed()) === true,
        authorizeKitchen: async () => (await resolved.allowed()) === true,
        authorizeDining: async () => (await resolved.allowed()) === true,
      }).load({
        transaction: businessTransaction,
        ...scope,
        ...query,
        observedAt,
      });
      if ((await resolved.allowed()) !== true)
        throw new Error("DINING_ORDER_PROGRESS_PERMISSION_DENIED");
      if (!current) return null;
      const labels = await createPostgresMerchantOrderItemLabels({
        ...scope,
        locale: options.locale,
        authorize: allowed,
      }).load({ transaction: businessTransaction, orderReference });
      const membership = new Map(
        current.items.map((item) => [String(item.orderItemReference), item]),
      );
      if (labels.length !== membership.size) throw new Error("DINING_ORDER_PROGRESS_UNAVAILABLE");
      const items = labels.map((label) => {
        const item = membership.get(label.orderItemReference);
        if (!item || String(item.orderBatchReference) !== String(label.orderBatchReference))
          throw new Error("DINING_ORDER_PROGRESS_UNAVAILABLE");
        return Object.freeze({
          ...item,
          displayName: label.displayName,
          batchSequence: label.batchSequence,
          itemOrdinal: label.itemOrdinal,
        });
      });
      if ((await resolved.allowed()) !== true)
        throw new Error("DINING_ORDER_PROGRESS_PERMISSION_DENIED");
      const table = await createMerchantDiningTableContext({
        scope,
        authorize: allowed,
        // Session closure may hand unresolved financial work to a Manager Task.
        allowClosedSession: true,
        allowClosingSession: true,
      }).load(businessTransaction, selected.diningSessionReference, current.observedAt);
      return Object.freeze({
        ...current,
        closureStatus: closure.status,
        closureVersion: closure.closureVersion,
        currentOrderVersion: closure.orderVersion,
        tableLabel: table.tableLabel,
        diningSessionReference: table.diningSessionReference,
        sessionPhase: table.sessionPhase,
        sessionVersion: table.sessionVersion,
        tableAssignmentVersion: table.tableAssignmentVersion,
        items: Object.freeze(items),
      });
    });
  };
}
