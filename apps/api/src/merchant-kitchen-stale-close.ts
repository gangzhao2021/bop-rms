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
import { createMerchantRoundBusinessDates } from "./merchant-round-business-date.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
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
    // WP-2423: one authorized run. The staff member is resolved in full once at the start and
    // once more before the commit (inside this transaction); the business-day reads in between,
    // made while the ticket is locked, take the run's no-query guard.
    return options.persistence.transactions.run((transaction) =>
      withMerchantTransactionAuthorization(
        {
          transaction,
          resolve: async () => {
            const current = await resolveScope(
              transaction,
              input.sessionCookie,
              kitchenStaleTicketClosePermission,
              session.sessionReference,
            );
            if (!(await current.allowed())) return denied();
            return current;
          },
          recheck: async (current) => (await current.allowed()) === true,
          denied,
        },
        async (authority) => {
          const scope = authority.scope;
          const guard = () => authority.guard();
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
            businessDays: async (orderReference, orderBatchReference) => {
              const orders = await listStoreOrderBusinessDates(tx, selected, [orderReference]);
              // WP-2423 D4: the ticket's round's own business day; a round added today to a table
              // opened on an earlier day is today's work and is not closed as an earlier day's.
              const rounds = await createMerchantRoundBusinessDates({
                persistence: options.persistence,
                scope: {
                  tenantReference: String(scope.selected.tenantReference),
                  brandReference: String(selected.brandReference),
                  storeReference: String(selected.storeReference),
                },
                timeZone: scope.store.timeZone,
                authorize: guard,
              })(tx, [orderBatchReference]);
              const today = await createMerchantStoreBusinessDay({
                publication: options.persistence.publication,
                tenantReference: scope.selected.tenantReference,
                brandReference: selected.brandReference,
                storeReference: selected.storeReference,
                timeZone: scope.store.timeZone,
                authorize: guard,
              })(transaction, occurredAt);
              return {
                orderBusinessDate:
                  rounds.get(orderBatchReference) ?? orders.get(orderReference) ?? null,
                currentBusinessDate: String(today.businessDate),
              };
            },
          });
          return Object.freeze({
            status: result.status,
            ticketReference: result.closure.ticketReference,
            reasonCode: result.closure.reasonCode,
            foodMade: result.closure.foodMade,
            orderBusinessDate: result.closure.orderBusinessDate,
            closedAt: result.closure.closedAt,
          });
        },
      ),
    );
  };
}
