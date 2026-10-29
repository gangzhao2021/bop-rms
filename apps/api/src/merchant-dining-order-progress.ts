import { staffContentLocale, staffNameLocales } from "./staff-content-locale.js";
import { comboPartsByOrderItem, type ComboPart } from "./merchant-combo-parts.js";
import { withOptionalRead } from "./merchant-round-business-date.js";
import { createMerchantDiningTableContext } from "./merchant-dining-table-context.js";
import {
  createPostgresMerchantOrderIndex,
  createPostgresOrderClosurePosition,
  createPostgresMerchantOrderItemLabels,
  loadMerchantOrderLines,
  parseOrderingReference,
} from "@rms/ordering";
import type { ConsumerTransaction } from "@bop/eventing";
import { listKitchenWorkChases, listOpenKitchenReworkItems } from "@rms/kitchen";
import { loadDiningServiceSetting } from "@rms/dining";
import { readClosedRecord } from "@bop/identity";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
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
    const denied = (): never => {
      throw new Error("DINING_ORDER_PROGRESS_PERMISSION_DENIED");
    };
    return options.persistence.transactions.run((transaction) =>
      // WP-2423: the caller is resolved in full at the start and once before the reply; the owner
      // reads in between only confirm they run in this authorized transaction.
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const resolved = await resolveScope(
              transaction,
              input.sessionCookie,
              "dining.item.serve",
              authorized.sessionReference,
            );
            if ((await resolved.allowed()) !== true) return denied();
            return resolved;
          },
          recheck: async (resolved) => (await resolved.allowed()) === true,
          denied,
        },
        async (authority) => {
          const resolved = authority.scope;
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

          const allowed = () => authority.guard();
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
            authorize: allowed,
            authorizeKitchen: allowed,
            authorizeDining: allowed,
            // WP-2423 item 2: a table whose every round was cancelled is still shown (and closable).
            includeCancelled: true,
          }).load({
            transaction: businessTransaction,
            ...scope,
            ...query,
            observedAt,
          });
          if (!current) return null;
          const labels = await createPostgresMerchantOrderItemLabels({
            ...scope,
            locale: options.locale,
            preferredLocale: staffContentLocale(),
            authorize: allowed,
          }).load({ transaction: businessTransaction, orderReference });
          const membership = new Map(
            current.items.map((item) => [String(item.orderItemReference), item]),
          );
          if (labels.length !== membership.size)
            throw new Error("DINING_ORDER_PROGRESS_UNAVAILABLE");
          // WP-2423 (v15 2026-10-16): each line's options and the customer's note ("Cup 3"), as the
          // order detail shows them, so staff serving several identical drinks can tell them
          // apart. Ordering's own order lines; if they can't be read the lines show by name only.
          let details: ReadonlyMap<
            string,
            {
              options: readonly { optionReference: string; name: string; quantity: number }[];
              customerNote: string | null;
            }
          > | null = null;
          try {
            if ((await allowed()) === true) {
              const lines = await loadMerchantOrderLines(
                businessTransaction,
                scope,
                orderReference,
                staffNameLocales(options.locale),
              );
              if (lines !== null)
                details = new Map(lines.items.map((line) => [line.orderItemReference, line]));
            }
          } catch (error) {
            // A database failure aborts this transaction: never continue on it.
            if (error !== null && typeof error === "object" && "diagnostic" in error) throw error;
            details = null;
          }
          // WP-2423 (2026-10-18): portions the kitchen is remaking (dropped, wrong, sent back,
          // marked done too early), matched by Order item reference (Kitchen's public Query), so
          // servers neither serve nor promise a dish that is being made again.
          const remaking = new Map<string, number>();
          for (const remake of await listOpenKitchenReworkItems(businessTransaction, scope, [
            orderReference,
          ]))
            remaking.set(
              remake.orderItemReference,
              (remaking.get(remake.orderItemReference) ?? 0) + remake.openQuantity,
            );
          // WP-2423 item 8 ⑥ part 4: a combo's dishes, each served once the kitchen made it.
          const parts =
            details === null
              ? new Map<string, readonly ComboPart[]>()
              : await withOptionalRead(
                  businessTransaction,
                  () =>
                    comboPartsByOrderItem(
                      businessTransaction,
                      scope,
                      options.locale,
                      [...(details ?? new Map()).entries()].map(([orderItemReference, line]) => ({
                        orderItemReference,
                        optionReferences: line.options.map(
                          (o: { optionReference: string }) => o.optionReference,
                        ),
                      })),
                    ),
                  new Map<string, readonly ComboPart[]>(),
                );
          // WP-2423 item 8 ⑦ (Owner decision 4): whether servers may chase a dish, and how often
          // each was chased; without them the page offers no chase.
          const chaseDish = await withOptionalRead(
            businessTransaction,
            async () =>
              (
                await loadDiningServiceSetting(
                  businessTransaction as unknown as Parameters<typeof loadDiningServiceSetting>[0],
                  scope,
                )
              ).chaseDish,
            false,
          );
          const chases = new Map<string, { count: number; lastChasedAt: string }>();
          if (chaseDish)
            for (const chase of await withOptionalRead(
              businessTransaction,
              () =>
                listKitchenWorkChases(
                  businessTransaction as unknown as Parameters<typeof listKitchenWorkChases>[0],
                  scope,
                  { orderItemReferences: labels.map((label) => label.orderItemReference) },
                ),
              [],
            )) {
              const prior = chases.get(chase.orderItemReference);
              chases.set(chase.orderItemReference, {
                count: (prior?.count ?? 0) + chase.count,
                lastChasedAt:
                  prior !== undefined && prior.lastChasedAt > chase.lastChasedAt
                    ? prior.lastChasedAt
                    : chase.lastChasedAt,
              });
            }
          const items = labels.map((label) => {
            const item = membership.get(label.orderItemReference);
            if (!item || String(item.orderBatchReference) !== String(label.orderBatchReference))
              throw new Error("DINING_ORDER_PROGRESS_UNAVAILABLE");
            const detail = details?.get(label.orderItemReference);
            return Object.freeze({
              ...item,
              remakingQuantity:
                item.phase === "Cancelled"
                  ? 0
                  : Math.min(remaking.get(label.orderItemReference) ?? 0, item.orderedQuantity),
              displayName: label.displayName,
              batchSequence: label.batchSequence,
              itemOrdinal: label.itemOrdinal,
              ...(detail === undefined
                ? {}
                : {
                    options: detail.options.map((o) => ({ name: o.name, quantity: o.quantity })),
                    customerNote: detail.customerNote,
                  }),
              ...(parts.has(label.orderItemReference)
                ? { comboParts: parts.get(label.orderItemReference) }
                : {}),
              ...(chases.has(label.orderItemReference)
                ? { chase: chases.get(label.orderItemReference) }
                : {}),
            });
          });
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
            chaseDish,
          });
        },
      ),
    );
  };
}
