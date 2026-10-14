import { readClosedRecord } from "@bop/identity";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresKitchenStaleTicketStore,
  KitchenStaleTicketError,
  kitchenStaleTicketClosePermission,
  parseCloseStaleKitchenTicketCommand,
} from "@rms/kitchen";
import { listStoreOrderBusinessDates } from "@rms/ordering";
import { createMerchantStoreBusinessDay } from "./merchant-store-business-day.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

const denied = (): never => {
  throw new KitchenStaleTicketError("KITCHEN_STALE_TICKET_PERMISSION_DENIED");
};

function boundTransaction(transaction: {
  query(sql: string, values?: readonly unknown[]): Promise<unknown>;
}): ConsumerTransaction {
  return {
    async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
      const result = await transaction.query(sql, values);
      if (!result || typeof result !== "object")
        throw new KitchenStaleTicketError("KITCHEN_STALE_TICKET_UNAVAILABLE");
      const rows = Object.getOwnPropertyDescriptor(result, "rows");
      const count = Object.getOwnPropertyDescriptor(result, "rowCount");
      if (!rows || !("value" in rows) || !Array.isArray(rows.value))
        throw new KitchenStaleTicketError("KITCHEN_STALE_TICKET_UNAVAILABLE");
      const rowCount = count && "value" in count ? (count.value as number | null) : null;
      return { rows: rows.value as readonly Row[], rowCount };
    },
  };
}

/**
 * WP-2423 DEC-KITCHEN-STALE-TICKETS: a manager closes a kitchen ticket left open from an earlier
 * business day, with a reason. Needs `kitchen.ticket.close_stale` (Owner, Store Manager) from any
 * current staff Session of the selected Store. Actor, Store, time and both business days (the
 * Order's from Ordering, today's from the Store's published business-day start) come from the
 * server, never from the browser. Nothing is refunded or cancelled here: the Order, its payment
 * and pickup stay with Ordering, Payment and Fulfillment.
 */
export function createMerchantKitchenStaleClose(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  nextReference(): string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize(input);
    let command: ReturnType<typeof parseCloseStaleKitchenTicketCommand>;
    try {
      command = parseCloseStaleKitchenTicketCommand({
        ...readClosedRecord(input.command, [
          "idempotencyKey",
          "ticketReference",
          "expectedTicketVersion",
          "reasonCode",
          "correlationReference",
        ]),
      });
    } catch {
      throw new KitchenStaleTicketError("KITCHEN_STALE_TICKET_INPUT_INVALID");
    }
    return options.persistence.transactions.run(async (transaction) => {
      const scope = await resolveScope(
        transaction,
        input.sessionCookie,
        kitchenStaleTicketClosePermission,
        session.sessionReference,
      );
      if (!(await scope.allowed())) return denied();
      const selected = {
        brandReference: scope.context.brand.brandReference,
        storeReference: scope.store.storeReference,
      };
      const tx = boundTransaction(transaction);
      const occurredAt = options.persistence.now();
      const result = await createPostgresKitchenStaleTicketStore({
        ...selected,
        nextReference: options.nextReference,
      }).close(tx, {
        command,
        actorReference: scope.actorReference,
        occurredAt,
        businessDays: async (orderReference) => {
          const orders = await listStoreOrderBusinessDates(tx, selected, [orderReference]);
          const today = await createMerchantStoreBusinessDay({
            publication: options.persistence.publication,
            tenantReference: scope.selected.tenantReference,
            brandReference: selected.brandReference,
            storeReference: selected.storeReference,
            timeZone: scope.store.timeZone,
            authorize: scope.allowed,
          })(transaction, occurredAt);
          return {
            orderBusinessDate: orders.get(orderReference) ?? null,
            currentBusinessDate: String(today.businessDate),
          };
        },
      });
      if (!(await scope.allowed())) return denied();
      return Object.freeze({
        status: result.status,
        ticketReference: result.closure.ticketReference,
        reasonCode: result.closure.reasonCode,
        foodMade: result.closure.foodMade,
        orderBusinessDate: result.closure.orderBusinessDate,
        closedAt: result.closure.closedAt,
      });
    });
  };
}
