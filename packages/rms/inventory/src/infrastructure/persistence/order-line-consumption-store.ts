import { planOrderLineKitchenEffects } from "../../domain/order-line-consumption.js";
import { parseInventoryInstant, parseInventoryReference } from "../../domain/inventory-item.js";
import { createPostgresStockReservationStore } from "./stock-reservation-store.js";
import type {
  InventoryItemTransaction,
  InventoryItemTransactionRunner,
} from "./inventory-item-store.js";

export class OrderLineConsumptionError extends Error {
  readonly code = "INVENTORY_ORDER_LINE_CONSUMPTION_UNAVAILABLE" as const;
  constructor() {
    super("Order line inventory consumption is unavailable");
    this.name = "OrderLineConsumptionError";
  }
}
const fail = (): never => {
  throw new OrderLineConsumptionError();
};

/**
 * WP-2423 / Section 30.6: applies one Kitchen progress fact to the per-line reservations of an
 * Order line, inside the caller's transaction. The named Kitchen Actor is the audited performer.
 * Effects are derived from current reservation state, so a replayed or reordered event is a no-op.
 * Legacy (schema 1) submission-wide reservations are not touched here.
 */
export function createPostgresOrderLineConsumptionStore(
  runner: InventoryItemTransactionRunner,
  scope: Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>,
  options: Readonly<{ nextReference: () => string }>,
) {
  const tenant = parseInventoryReference(scope.tenantReference),
    brand = parseInventoryReference(scope.brandReference),
    store = parseInventoryReference(scope.storeReference);
  return Object.freeze({
    async apply(input: {
      readonly submissionReference: string;
      readonly cartItemReference: string;
      readonly kitchen:
        | { readonly kind: "Start" }
        | {
            readonly kind: "Progress";
            readonly completedQuantity: number;
            readonly requiredQuantity: number;
          };
      readonly occurredAt: string;
      readonly actorReference: string;
      readonly correlationReference: string;
      readonly audit: Readonly<{
        reasonCode: string;
        sourceChannel: string;
        retentionPolicyCode: string;
        retentionPolicyVersion: number;
      }>;
    }) {
      const occurredAt = parseInventoryInstant(input.occurredAt);
      const actor = parseInventoryReference(input.actorReference);
      return runner.run(async (tx: InventoryItemTransaction) => {
        const bound = {
          run: async <T>(work: (t: InventoryItemTransaction) => Promise<T>) => work(tx),
        };
        const reservations = createPostgresStockReservationStore(bound, {
          tenantReference: tenant,
          brandReference: brand,
          storeReference: store,
        });
        const line = await reservations.loadOrderLine(
          input.submissionReference,
          input.cartItemReference,
        );
        const effects = planOrderLineKitchenEffects({
          cartItemReference: input.cartItemReference,
          reservations: line,
          kitchen: input.kitchen,
          occurredAt,
        });
        const applied = [];
        for (const effect of effects) {
          const balance: unknown = await tx.query(
            "SELECT ledger_version::text AS version FROM rms_inventory.stock_balance WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND account_id=$4 FOR UPDATE",
            [tenant, brand, store, effect.accountReference],
          );
          const found =
            balance !== null && typeof balance === "object"
              ? (Object.getOwnPropertyDescriptor(balance, "rows")?.value as unknown)
              : null;
          const row: unknown = Array.isArray(found) && found.length === 1 ? found[0] : null;
          const ledger =
            row !== null && typeof row === "object"
              ? (Object.getOwnPropertyDescriptor(row, "version")?.value as unknown)
              : null;
          if (typeof ledger !== "string" || !/^[1-9][0-9]*$/u.test(ledger)) return fail();
          const operationReference = parseInventoryReference(options.nextReference());
          const result = await reservations.commit({
            operationReference,
            accountReference: effect.accountReference,
            action: effect.action,
            expectedLedgerVersion: Number(ledger),
            quantity: effect.quantity,
            reservation: effect.reservation,
            movementReference:
              effect.action === "StartProduction"
                ? null
                : parseInventoryReference(options.nextReference()),
            audit: {
              auditId: parseInventoryReference(options.nextReference()),
              brandId: brand,
              storeId: store,
              actor: { type: "User", reference: actor },
              actionCode:
                "INVENTORY_RESERVATION_" +
                (effect.action === "StartProduction" ? "START_PRODUCTION" : "CONSUME"),
              targetType: "InventoryReservation",
              targetId: effect.reservation.reservationReference,
              reasonCode: input.audit.reasonCode,
              correlationId: operationReference,
              occurredAt,
              sourceChannel: input.audit.sourceChannel,
              dataClassification: "Internal",
              retentionPolicyCode: input.audit.retentionPolicyCode,
              retentionPolicyVersion: input.audit.retentionPolicyVersion,
            },
          });
          if (result.status !== "Applied") return fail();
          applied.push(
            Object.freeze({
              action: effect.action,
              accountReference: effect.accountReference,
              quantity: effect.quantity,
              reservationReference: effect.reservation.reservationReference,
            }),
          );
        }
        return Object.freeze(applied);
      });
    },
  });
}
