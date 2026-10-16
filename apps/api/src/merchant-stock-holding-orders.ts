import type { ConsumerTransaction } from "@bop/eventing";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { listStoreUncollectedPickupOrders } from "@rms/fulfillment";
import { listStoreSubmissionsHoldingStock } from "@rms/inventory";
import {
  listStoreOrdersOfSubmissions,
  parseOrderingInstant,
  parseOrderingReference,
} from "@rms/ordering";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { staffOrderCancellationPermission } from "./merchant-order-staff-cancellation.js";
import { createSubmissionInventoryRelease } from "./submission-inventory-release.js";

/**
 * WP-2423 (2026-10-16 v15 stock leak): an Order round from an earlier business day that still has
 * stock set aside. Open: the Order is still live (accepted and never made or handed over, or still
 * waiting) — staff make and hand it over, or cancel it (which refunds the guest and returns the
 * stock). Ended: the Order already ended (handed over, not collected, closed or cancelled) but its
 * stock was never returned — staff release it.
 */
export interface EarlierOrderHoldingStock {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly submissionReference: string;
  readonly orderNumber: string;
  readonly orderType: "Pickup" | "DineIn";
  readonly businessDate: string;
  readonly heldSince: string;
  readonly state: "Open" | "Ended";
  /** The kitchen started it: only finishing it (or the kitchen) settles the stock. */
  readonly productionStarted: boolean;
}

type StoreScope = Readonly<{
  tenantReference: string;
  brandReference: string;
  storeReference: string;
}>;

/**
 * Inventory names the rounds still holding stock first set aside before today's business day
 * began; Ordering maps them to Orders of earlier days and says which ended; Fulfillment adds the
 * pickups closed as not collected. Read only; the caller authorizes and owns the transaction.
 */
export async function readEarlierOrdersHoldingStock(
  transaction: ConsumerTransaction,
  scope: StoreScope,
  today: Readonly<{ businessDate: string; startsAt: string }>,
): Promise<readonly EarlierOrderHoldingStock[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(today.businessDate)) throw new Error("STOCK_HOLDING_INVALID");
  const startsAt = parseOrderingInstant(today.startsAt);
  // The Inventory read takes exactly the Store scope; a caller's authorized scope also carries its
  // Session, which the read refuses (2026-10-16 v15: the held-stock list was always empty).
  const storeScope = {
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  };
  const held = await listStoreSubmissionsHoldingStock(transaction as never, storeScope, {
    limit: 500,
    heldBefore: startsAt,
  });
  if (held.length === 0) return Object.freeze([]);
  const owner = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  const orders = await listStoreOrdersOfSubmissions(
    transaction,
    owner,
    held.map((entry) => entry.submissionReference),
  );
  const earlier = orders.filter((order) => order.businessDate < today.businessDate);
  const pickups = [
    ...new Set(
      earlier.filter((order) => order.orderType === "Pickup").map((o) => o.orderReference),
    ),
  ];
  const uncollected = new Set<string>();
  for (let i = 0; i < pickups.length; i += 100)
    for (const reference of await listStoreUncollectedPickupOrders(
      transaction,
      owner,
      pickups.slice(i, i + 100),
    ))
      uncollected.add(reference);
  const bySubmission = new Map(held.map((entry) => [entry.submissionReference, entry]));
  return Object.freeze(
    earlier.flatMap((order) => {
      const entry = bySubmission.get(order.submissionReference);
      if (entry === undefined) return [];
      return [
        Object.freeze({
          orderReference: order.orderReference,
          orderBatchReference: order.orderBatchReference,
          submissionReference: order.submissionReference,
          orderNumber: order.orderNumber,
          orderType: order.orderType,
          businessDate: order.businessDate,
          heldSince: entry.heldSince,
          state:
            order.ended || uncollected.has(order.orderReference)
              ? ("Ended" as const)
              : ("Open" as const),
          productionStarted: entry.productionStarted,
        }),
      ];
    }),
  );
}

export const endedOrderStockReleaseErrorCodes = [
  "ENDED_ORDER_STOCK_INPUT_INVALID",
  "ENDED_ORDER_STOCK_PERMISSION_DENIED",
  /** The round no longer holds stock from an earlier day, or its Order has not ended. */
  "ENDED_ORDER_STOCK_NOT_RELEASABLE",
  /** The kitchen started it; finishing it on the kitchen board settles the stock. */
  "ENDED_ORDER_STOCK_PRODUCTION_STARTED",
  "ENDED_ORDER_STOCK_UNAVAILABLE",
] as const;
export type EndedOrderStockReleaseErrorCode = (typeof endedOrderStockReleaseErrorCodes)[number];
export class EndedOrderStockReleaseError extends Error {
  constructor(readonly code: EndedOrderStockReleaseErrorCode) {
    super("ended order stock release is unavailable");
    this.name = "EndedOrderStockReleaseError";
  }
}
const fail = (code: EndedOrderStockReleaseErrorCode): never => {
  throw new EndedOrderStockReleaseError(code);
};

/**
 * WP-2423 (2026-10-16): a store manager or owner returns to stock what is still set aside for an
 * Order of an earlier day that already ended. One transaction: permission → the round is still
 * holding stock from an earlier day and its Order ended (re-read from the owners, never the
 * browser's copy) → Inventory releases the round's whole reservation set (System release audit per
 * reservation, ledger movement naming the staff member) → a staff audit record. A replay with the
 * same operation reference returns Released without writing.
 */
export function createMerchantEndedOrderStockRelease(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  installContext(transaction: ConsumerTransaction, scope: StoreScope): Promise<void>;
  /** The Store's current business day (its date and start). */
  today(transaction: ConsumerTransaction): Promise<{ businessDate: string; startsAt: string }>;
  nextReference(): string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    command: unknown;
  }): Promise<{ status: "Released" | "AlreadyReleased"; entryCount: number }> => {
    const session = await options.authentication.authorize(input);
    let orderReference: string, orderBatchReference: string, operationReference: string;
    try {
      const intent = readClosedRecord(input.command, [
        "orderReference",
        "orderBatchReference",
        "operationReference",
      ]);
      orderReference = String(parseOrderingReference(intent.orderReference));
      orderBatchReference = String(parseOrderingReference(intent.orderBatchReference));
      operationReference = String(parseOrderingReference(intent.operationReference));
    } catch {
      return fail("ENDED_ORDER_STOCK_INPUT_INVALID");
    }
    try {
      return await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolveScope(
                transaction,
                input.sessionCookie,
                staffOrderCancellationPermission,
                session.sessionReference,
              ).catch(() => fail("ENDED_ORDER_STOCK_PERMISSION_DENIED"));
              if ((await current.allowed()) !== true)
                return fail("ENDED_ORDER_STOCK_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("ENDED_ORDER_STOCK_PERMISSION_DENIED"),
          },
          async (authority) => {
            const scope = authority.scope;
            const allowed = () => authority.guard();
            const tx = transaction as unknown as ConsumerTransaction;
            const selected = {
              tenantReference: String(scope.selected.tenantReference),
              brandReference: String(scope.context.brand.brandReference),
              storeReference: String(scope.store.storeReference),
            };
            const actorReference = String(scope.actorReference);
            await options.installContext(tx, selected);
            const releaser = createSubmissionInventoryRelease({
              scope: selected,
              systemActorReference: actorReference,
              reasonCode: "ORDER_ENDED_STOCK_LEFT",
              now: options.persistence.now,
            });
            const today = await options.today(tx);
            const holding = await readEarlierOrdersHoldingStock(tx, selected, today);
            const target = holding.find(
              (entry) =>
                entry.orderReference === orderReference &&
                entry.orderBatchReference === orderBatchReference,
            );
            if (target === undefined) {
              // Replay: the same operation already released this round (its staff audit exists).
              const prior = await tx.query(
                "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE audit_id=$1",
                [operationReference],
              );
              if (prior.rows[0]?.n === 1 && (await allowed()))
                return Object.freeze({ status: "AlreadyReleased" as const, entryCount: 0 });
              return fail("ENDED_ORDER_STOCK_NOT_RELEASABLE");
            }
            if (target.state !== "Ended") return fail("ENDED_ORDER_STOCK_NOT_RELEASABLE");
            if (target.productionStarted) return fail("ENDED_ORDER_STOCK_PRODUCTION_STARTED");
            const releasedAt = parseOrderingInstant(options.persistence.now());
            const result = await releaser.release(tx, {
              source: {
                kind: "EndedOrderStockRelease/v1",
                reference: operationReference,
                submissionReference: target.submissionReference,
                orderReference,
                occurredAt: releasedAt,
              },
              releasedAt,
              authorize: allowed,
            });
            if (result.status === "NotReleasable")
              return fail(
                result.reason === "ProductionStarted"
                  ? "ENDED_ORDER_STOCK_PRODUCTION_STARTED"
                  : "ENDED_ORDER_STOCK_NOT_RELEASABLE",
              );
            if (result.status === "NothingToRelease")
              return fail("ENDED_ORDER_STOCK_NOT_RELEASABLE");
            await appendAuditRecordInTransaction(
              tx,
              validateAuditRecord({
                auditId: operationReference,
                brandId: selected.brandReference,
                storeId: selected.storeReference,
                actor: { type: "User", reference: actorReference },
                actionCode: "ENDED_ORDER_STOCK_RELEASED",
                targetType: "Order",
                targetId: orderReference,
                reasonCode: "ORDER_ENDED_STOCK_LEFT",
                correlationId: target.submissionReference,
                occurredAt: releasedAt,
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Internal",
                retentionPolicyCode: "AUDIT_DEFAULT",
                retentionPolicyVersion: 1,
              }),
            );
            if (!(await allowed())) return fail("ENDED_ORDER_STOCK_PERMISSION_DENIED");
            return Object.freeze({
              status: "Released" as const,
              entryCount: result.entryCount,
            });
          },
        ),
      );
    } catch (error) {
      if (error instanceof EndedOrderStockReleaseError) throw error;
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "STORE_SERVICE_PERMISSION_DENIED")
        return fail("ENDED_ORDER_STOCK_PERMISSION_DENIED");
      return fail("ENDED_ORDER_STOCK_UNAVAILABLE");
    }
  };
}
