import type { ConsumerTransaction } from "@bop/eventing";
import { readClosedRecord } from "@bop/identity";
import { listStoreKitchenOrderItemStates } from "@rms/kitchen";
import {
  createPostgresOrderPriceReductionStore,
  listOrderBillOrders,
  listOrderMergedInto,
  orderPriceReductionPermission,
  orderPriceReductionReasonCodes,
  OrderPriceReductionError,
  parseOrderingInstant,
  parseOrderingReference,
  withBillTaxRoundingShares,
  type OrderPriceReductionChoice,
  type OrderPriceReductionReasonCode,
  type OrderPriceReductionRecord,
} from "@rms/ordering";
import { createPostgresDiningTableSettlementStore } from "@rms/payment";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { keepingCause, onlyRefusal } from "./merchant-failure.js";
import { fenceTableBill } from "./dining-waiting-rounds.js";
import {
  billReductionTaxShares,
  refreshBillTaxRounding,
  splitAgainAfterBillChange,
} from "./merchant-dining-table-checkout.js";

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

/**
 * The browser's intent: the dishes, comp / percent / amount off, and a reason. Never totals: v15 b16
 * `expectedTotalMinor` (optional) is only what the button showed, from the preview; a different
 * amount now is refused as a changed table, so the manager confirms the money taken off.
 */
export function parseItemCompCommand(value: unknown) {
  return parseItemComp(value, "Command");
}

/** v15 b16: what the comp would take off, before the manager confirms (no reason or reference). */
export function parseItemCompPreview(value: unknown) {
  return parseItemComp(value, "Preview");
}

function parseItemComp(value: unknown, mode: "Command" | "Preview") {
  try {
    const keys =
      mode === "Preview"
        ? ["orderReference", "orderItemReferences", "kind", "percent", "amountOffMinor"]
        : [
            "orderReference",
            "orderItemReferences",
            "kind",
            "percent",
            "amountOffMinor",
            "reasonCode",
            "operationReference",
            ...(value !== null &&
            typeof value === "object" &&
            Object.hasOwn(value, "expectedTotalMinor")
              ? ["expectedTotalMinor"]
              : []),
          ];
    const raw = readClosedRecord(value, keys);
    if (
      !Array.isArray(raw.orderItemReferences) ||
      raw.orderItemReferences.length < 1 ||
      raw.orderItemReferences.length > 50 ||
      (mode === "Command" &&
        (typeof raw.reasonCode !== "string" ||
          !(orderPriceReductionReasonCodes as readonly string[]).includes(raw.reasonCode))) ||
      (raw.expectedTotalMinor !== undefined &&
        (typeof raw.expectedTotalMinor !== "string" ||
          !/^[1-9][0-9]{0,11}$/u.test(raw.expectedTotalMinor)))
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
      reasonCode: (mode === "Command"
        ? raw.reasonCode
        : "GOODWILL") as OrderPriceReductionReasonCode,
      operationReference:
        mode === "Command" ? String(parseOrderingReference(raw.operationReference)) : null,
      expectedTotalMinor:
        typeof raw.expectedTotalMinor === "string" ? BigInt(raw.expectedTotalMinor) : null,
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

interface ItemCompOptions {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  installContext(
    transaction: ConsumerTransaction,
    scope: { tenantReference: string; brandReference: string; storeReference: string },
  ): Promise<void>;
  nextReference(): string;
}

export function createMerchantDiningItemComp(options: ItemCompOptions) {
  const run = itemCompRun(options);
  // A body it can't read is a refused promise (400), never a throw out of the route (an HTML 500).
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) =>
    run(input, parseItemCompCommand(input.command)) as Promise<{
      readonly status: "Recorded" | "AlreadyRecorded";
      readonly reductions: ReturnType<typeof publicRecords>;
    }>;
}

/**
 * v15 b16 (DEC-COMP-BILL-CENT): what the chosen comp or discount would take off the bill — the
 * amount the confirm button names — worked out exactly as the command records it (the whole
 * bill's tax cent included), with the command's checks and permission. Nothing is recorded, and
 * no staff PIN is asked (the PIN confirms the command).
 */
export function createMerchantDiningItemCompPreview(options: ItemCompOptions) {
  const run = itemCompRun(options);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) =>
    run(input, parseItemCompPreview(input.command)) as Promise<{
      readonly status: "Preview";
      readonly totalMinor: string;
      readonly lines: readonly {
        readonly orderItemReference: string;
        readonly amountMinor: string;
      }[];
    }>;
}

function itemCompRun(options: ItemCompOptions) {
  const resolveScope = createMerchantStoreScope(options.persistence);
  return async (
    input: { sessionCookie: unknown; csrf: unknown },
    intent: ReturnType<typeof parseItemComp>,
  ) => {
    const session = await options.authentication.authorize(input);
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
              ).catch(onlyRefusal(() => fail("ITEM_COMP_PERMISSION_DENIED")));
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
            const prior =
              intent.operationReference === null
                ? []
                : await ordering.loadByOperation(tx, intent.operationReference);
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
              return Object.freeze({
                status: "AlreadyRecorded" as const,
                reductions: publicRecords(prior),
              });
            }
            // Ordering's fence is taken first and held to commit: a table payment, write-off or
            // phone payment for this Order either committed before (seen below) or waits. v15 b11:
            // the whole bill's fences, the Order holding the bill first (the order the payment
            // commands take), because the comp records the bill's tax rounding again below.
            const owner = {
              brandReference: selected.brandReference,
              storeReference: selected.storeReference,
            };
            const holder =
              (await listOrderMergedInto(tx, owner, [intent.orderReference])).get(
                intent.orderReference,
              ) ?? intent.orderReference;
            await fenceTableBill(tx, owner, await listOrderBillOrders(tx, owner, holder));
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
            // DEC-KITCHEN-ONE-TAP (the default recorded for the Owner, changing Owner decision 2):
            // Start is optional now, so "no Start fact" no longer says the kitchen has not begun. A
            // comp leaves the kitchen's work alone, so any dish that reached the kitchen may have
            // one. A dish that never reached it comes off the bill instead. Reversed by requiring
            // "Started" here and in the order queue's offer.
            const states = await listStoreKitchenOrderItemStates(
              tx,
              { brandReference: selected.brandReference, storeReference: selected.storeReference },
              [...new Set(prepared.plan.lines.map((line) => line.orderBatchReference))],
            );
            if (!(await guard())) return fail("ITEM_COMP_PERMISSION_DENIED");
            for (const line of prepared.plan.lines) {
              const state = states.get(line.orderItemReference);
              if (state === "Cancelled") return fail("ITEM_COMP_NOT_ELIGIBLE");
              if (state === undefined) return fail("ITEM_COMP_NOT_STARTED");
            }
            const decidedAt = String(parseOrderingInstant(options.persistence.now()));
            // v15 b16 (DEC-COMP-BILL-CENT): the whole bill's tax cent on these dishes, so the
            // records take off exactly what the bill goes down by.
            const plan = withBillTaxRoundingShares(
              prepared.plan,
              await billReductionTaxShares(tx, selected, {
                orderReference: intent.orderReference,
                observedAt: decidedAt,
                authorize: async () => (await guard()) === true,
                lines: prepared.plan.lines,
              }),
            );
            if (!(await guard())) return fail("ITEM_COMP_PERMISSION_DENIED");
            if (intent.operationReference === null)
              return Object.freeze({
                status: "Preview" as const,
                totalMinor: plan.totalMinor.toString(),
                lines: Object.freeze(
                  plan.lines.map((line) =>
                    Object.freeze({
                      orderItemReference: line.orderItemReference,
                      amountMinor: line.totalMinor.toString(),
                    }),
                  ),
                ),
              });
            // What the button showed: a different amount now means the table changed meanwhile.
            if (intent.expectedTotalMinor !== null && intent.expectedTotalMinor !== plan.totalMinor)
              return fail("ITEM_COMP_CONFLICT");
            const records = await ordering.commit(tx, {
              plan,
              operationReference: intent.operationReference,
              actorReference,
              reasonCode: intent.reasonCode,
              decidedAt,
              nextReference: options.nextReference,
            });
            // v15 b11 (DEC-TAX-WHOLE-RECEIPT): the bill changed, so a tax rounding recorded for it
            // (at a split or a started payment) is recorded again for the bill as it now stands.
            // v15 b16: a comp that took the whole bill's tax cent records the rounding it leaves
            // even on a bill that had none recorded yet, so a table comped to nothing closes with
            // reports that read that cent where the bill has it (no payment would record it).
            await refreshBillTaxRounding(tx, selected, {
              orderReference: intent.orderReference,
              observedAt: decidedAt,
              authorize: async () => (await guard()) === true,
              nextReference: options.nextReference,
              whenNeverRecorded: plan.lines.some((line) => line.taxRoundingMinor !== 0n),
            });
            // v15 b12 (DEC-DINE-IN-SPLIT-BILL rule 7): a split bill is split again the same way, so
            // no guest is asked to pay a share of the bill as it was before.
            await splitAgainAfterBillChange(tx, selected, {
              orderReference: intent.orderReference,
              observedAt: decidedAt,
              authorize: async () => (await guard()) === true,
              nextReference: options.nextReference,
              actorReference,
              correlationReference: intent.operationReference,
            });
            return Object.freeze({
              status: "Recorded" as const,
              reductions: publicRecords(records),
            });
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
      return keepingCause(() => fail("ITEM_COMP_UNAVAILABLE"))(error);
    }
  };
}
