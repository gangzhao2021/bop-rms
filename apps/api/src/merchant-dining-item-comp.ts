import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import { listStoreKitchenOrderItemStates } from "@rms/kitchen";
import {
  createPostgresOrderPriceReductionStore,
  orderPriceReductionPermission,
  orderPriceReductionReasonCodes,
  OrderPriceReductionError,
  parseOrderingInstant,
  parseOrderingReference,
  type OrderPriceReductionChoice,
  type OrderPriceReductionReasonCode,
  type OrderPriceReductionRecord,
} from "@rms/ordering";
import { createPostgresDiningTableSettlementStore } from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/**
 * WP-2423 item 8 ① segment 2 (Owner decision 2, DEC-TABLES-SERVER-MAIN): a manager comps or
 * discounts dishes the kitchen started or the table was served, at a table that pays at the end,
 * before it pays. One transaction: Ordering's fence and eligibility → the table has neither paid,
 * been written off, nor has a guest paying on their phone (Payment) → every dish was started in
 * the kitchen (Kitchen; a dish not started is taken off the bill instead) → Ordering's
 * append-only reduction records with their audit. A paid table is refunded instead, never comped.
 * The amounts come from the dish's price snapshot; the browser sends only the choice.
 */
export type ItemCompErrorCode =
  | "ITEM_COMP_INPUT_INVALID"
  | "ITEM_COMP_PERMISSION_DENIED"
  | "ITEM_COMP_NOT_FOUND"
  | "ITEM_COMP_NOT_PAY_LATER"
  | "ITEM_COMP_ALREADY_PAID"
  | "ITEM_COMP_GUEST_PAYING"
  | "ITEM_COMP_NOT_STARTED"
  | "ITEM_COMP_NOT_ELIGIBLE"
  | "ITEM_COMP_ALREADY_COMPED"
  | "ITEM_COMP_INVALID_AMOUNT"
  | "ITEM_COMP_CONFLICT"
  | "ITEM_COMP_UNAVAILABLE";
export class ItemCompError extends Error {
  constructor(readonly code: ItemCompErrorCode) {
    super(code);
    this.name = "ItemCompError";
  }
}
const fail = (code: ItemCompErrorCode): never => {
  throw new ItemCompError(code);
};
const databaseCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
};

/** The browser's intent: the dishes, comp / percent / amount off, and a reason. Never totals. */
export function parseItemCompCommand(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      "orderReference",
      "orderItemReferences",
      "kind",
      "percent",
      "amountOffMinor",
      "reasonCode",
      "operationReference",
    ]);
    if (
      !Array.isArray(raw.orderItemReferences) ||
      raw.orderItemReferences.length < 1 ||
      raw.orderItemReferences.length > 50 ||
      typeof raw.reasonCode !== "string" ||
      !(orderPriceReductionReasonCodes as readonly string[]).includes(raw.reasonCode)
    )
      throw new Error();
    let choice: OrderPriceReductionChoice;
    if (raw.kind === "Comp" && raw.percent === null && raw.amountOffMinor === null)
      choice = { kind: "Comp" };
    else if (
      raw.kind === "Percent" &&
      typeof raw.percent === "number" &&
      Number.isInteger(raw.percent) &&
      raw.percent >= 1 &&
      raw.percent <= 99 &&
      raw.amountOffMinor === null
    )
      choice = { kind: "Percent", percent: raw.percent };
    else if (
      raw.kind === "Amount" &&
      raw.percent === null &&
      typeof raw.amountOffMinor === "string" &&
      /^[1-9][0-9]{0,8}$/u.test(raw.amountOffMinor) &&
      raw.orderItemReferences.length === 1
    )
      choice = { kind: "Amount", netMinor: BigInt(raw.amountOffMinor) };
    else throw new Error();
    const items = raw.orderItemReferences.map((item) => String(parseOrderingReference(item)));
    if (new Set(items).size !== items.length) throw new Error();
    return Object.freeze({
      orderReference: String(parseOrderingReference(raw.orderReference)),
      orderItemReferences: Object.freeze(items.sort()),
      choice,
      reasonCode: raw.reasonCode as OrderPriceReductionReasonCode,
      operationReference: String(parseOrderingReference(raw.operationReference)),
    });
  } catch {
    return fail("ITEM_COMP_INPUT_INVALID");
  }
}

const publicRecords = (records: readonly OrderPriceReductionRecord[]) =>
  Object.freeze(
    records.map((record) =>
      Object.freeze({
        orderItemReference: record.orderItemReference,
        kind: record.kind,
        percent: record.percent,
        amountMinor: record.totalMinor.toString(),
        reasonCode: record.reasonCode,
        decidedAt: record.decidedAt,
      }),
    ),
  );

export function createMerchantDiningItemComp(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  installContext(
    transaction: ConsumerTransaction,
    scope: { tenantReference: string; brandReference: string; storeReference: string },
  ): Promise<void>;
  nextReference(): string;
}) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize(input);
    const intent = parseItemCompCommand(input.command);
    try {
      return await options.persistence.transactions.run((transaction) =>
        withMerchantTransactionAuthorization(
          {
            transaction,
            resolve: async () => {
              const current = await resolveScope(
                transaction,
                input.sessionCookie,
                orderPriceReductionPermission,
                session.sessionReference,
              ).catch(() => fail("ITEM_COMP_PERMISSION_DENIED"));
              if ((await current.allowed()) !== true) return fail("ITEM_COMP_PERMISSION_DENIED");
              return current;
            },
            recheck: async (current) => (await current.allowed()) === true,
            denied: () => fail("ITEM_COMP_PERMISSION_DENIED"),
          },
          async (authority) => {
            const tx = transaction as unknown as ConsumerTransaction;
            const scope = authority.scope;
            const guard = () => authority.guard();
            const selected = {
              tenantReference: String(scope.selected.tenantReference),
              brandReference: String(scope.context.brand.brandReference),
              storeReference: String(scope.store.storeReference),
            };
            const actorReference = String(scope.actorReference);
            await options.installContext(tx, selected);
            const ordering = createPostgresOrderPriceReductionStore({
              brandReference: selected.brandReference,
              storeReference: selected.storeReference,
              authorize: async (t, value) =>
                t === tx && value.orderReference === intent.orderReference && (await guard()),
            });
            const prior = await ordering.loadByOperation(tx, intent.operationReference);
            if (prior.length > 0) {
              // The same request again (a lost answer): its result, never a second reduction.
              if (
                prior[0]?.orderReference !== intent.orderReference ||
                prior.map((record) => record.orderItemReference).join(",") !==
                  intent.orderItemReferences.join(",") ||
                prior[0]?.reasonCode !== intent.reasonCode ||
                prior[0]?.kind !== intent.choice.kind ||
                prior[0]?.actorReference !== actorReference
              )
                return fail("ITEM_COMP_CONFLICT");
              return Object.freeze({ status: "AlreadyRecorded", reductions: publicRecords(prior) });
            }
            // Ordering's fence is taken first and held to commit: a table payment, write-off or
            // phone payment for this Order either committed before (seen below) or waits.
            const prepared = await ordering.prepare(tx, intent);
            const payments = createPostgresDiningTableSettlementStore({
              scope: selected,
              authorize: async (_t, value) =>
                value.orderReference === intent.orderReference && (await guard()) === true,
            });
            // A paid table is refunded instead; a written-off table owes nothing to reduce. Said
            // first, whatever else the dishes are (the fence is held, so nothing pays meanwhile).
            if (
              prepared.status !== "NotEligible" || prepared.reason !== "NotFound"
                ? (await payments.listByOrders(tx, [intent.orderReference])).length > 0 ||
                  (await payments.listWriteOffsByOrders(tx, [intent.orderReference])).length > 0
                : false
            )
              return fail("ITEM_COMP_ALREADY_PAID");
            if (prepared.status === "NotEligible")
              return fail(
                prepared.reason === "NotFound"
                  ? "ITEM_COMP_NOT_FOUND"
                  : prepared.reason === "NotPayLater"
                    ? "ITEM_COMP_NOT_PAY_LATER"
                    : prepared.reason === "AlreadyReduced"
                      ? "ITEM_COMP_ALREADY_COMPED"
                      : prepared.reason === "InvalidAmount"
                        ? "ITEM_COMP_INVALID_AMOUNT"
                        : "ITEM_COMP_NOT_ELIGIBLE",
              );
            if (
              (await payments.listOnlinePaymentsByOrders(tx, [intent.orderReference])).some(
                (attempt) => attempt.outcome === null,
              )
            )
              return fail("ITEM_COMP_GUEST_PAYING");
            // Comps are for dishes the kitchen started or the table was served; a dish not
            // started yet is taken off the bill instead (the kitchen stops it).
            const states = await listStoreKitchenOrderItemStates(
              tx,
              { brandReference: selected.brandReference, storeReference: selected.storeReference },
              [...new Set(prepared.plan.lines.map((line) => line.orderBatchReference))],
            );
            if (!(await guard())) return fail("ITEM_COMP_PERMISSION_DENIED");
            for (const line of prepared.plan.lines) {
              const state = states.get(line.orderItemReference);
              if (state === "Cancelled") return fail("ITEM_COMP_NOT_ELIGIBLE");
              if (state !== "Started") return fail("ITEM_COMP_NOT_STARTED");
            }
            const records = await ordering.commit(tx, {
              plan: prepared.plan,
              operationReference: intent.operationReference,
              actorReference,
              reasonCode: intent.reasonCode,
              decidedAt: String(parseOrderingInstant(options.persistence.now())),
              nextReference: options.nextReference,
            });
            return Object.freeze({ status: "Recorded", reductions: publicRecords(records) });
          },
        ),
      );
    } catch (error) {
      if (error instanceof ItemCompError) throw error;
      if (error instanceof OrderPriceReductionError)
        return fail(
          error.code === "ORDER_PRICE_REDUCTION_CONFLICT"
            ? "ITEM_COMP_CONFLICT"
            : "ITEM_COMP_UNAVAILABLE",
        );
      const code = databaseCode(error);
      if (code === "40P01" || code === "40001" || code === "55P03")
        return fail("ITEM_COMP_CONFLICT");
      return fail("ITEM_COMP_UNAVAILABLE");
    }
  };
}
