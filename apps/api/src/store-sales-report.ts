import type { StoreSalesOrder } from "@rms/ordering";
import type { StoreSalesPayment, StoreSalesRefund, StoreSalesSettlementTotals } from "@rms/payment";
import type { MerchantBusinessDayWindow } from "./merchant-business-day-window.js";

/**
 * WP-2423 Q14: the Store sales reports for a range of business days, computed from the payments and
 * refunds the day-end settlement counts (Payment) and the priced items they paid for (Ordering).
 *
 * Rules (DEC in docs/spec/design/store-reports-pilot.md):
 * - A sale counts on the business day its payment was taken; a refund on the day the money went
 *   back — the settlement's rule, so the reports and the settlement agree to the cent.
 * - Money is integer minor units (bigint) throughout; the browser gets decimal strings of cents.
 * - Unpaid Batches (cancelled before payment) never count; staff cancellations of paid orders show
 *   as refunds.
 * - v15 2026-11-01 (coordinator): an order the Store cancelled and refunded in full on the
 *   business day it was paid is not a sale (a refund without a cancellation stays a refund): it leaves gross and
 *   net sales, what was taken and refunds, and is listed as cancelled and refunded in full. Every
 *   Store follows this one rule. The day-end settlement still counts the payment and its refund,
 *   so the match with the settlement is checked on every payment. A refund on a later day stays a
 *   refund of that day (a closed day's figures never change).
 * - Tips belong to the payment; the system does not record which staff member earned them.
 */
export type StoreSalesChannel = "Online" | "CardMachine" | "Cash";
export type StoreSalesOrderKind = "DineIn" | "Pickup" | "Counter";
export const storeSalesChannels: readonly StoreSalesChannel[] = ["Online", "CardMachine", "Cash"];
export const storeSalesOrderKinds: readonly StoreSalesOrderKind[] = ["DineIn", "Pickup", "Counter"];

export interface StoreSalesReportInput {
  readonly storeLabel: string;
  readonly timeZone: string;
  readonly days: readonly MerchantBusinessDayWindow[];
  readonly payments: readonly StoreSalesPayment[];
  readonly refundedPayments: readonly StoreSalesPayment[];
  readonly refunds: readonly StoreSalesRefund[];
  readonly settlement: StoreSalesSettlementTotals;
  readonly unresolvedOnlineRefundCount: number;
  /**
   * DEC-DINE-IN-PAY-LATER (decision 4): tables written off when the guests left without paying,
   * by when the manager decided. Never collected; listed on their own line (absent: none).
   */
  readonly unpaidWriteOffs?: readonly {
    readonly amountMinor: bigint;
    readonly decidedAt: string;
  }[];
  readonly orders: readonly StoreSalesOrder[];
  /**
   * WP-2423 M163 (DEC-OWNER-DEFAULTS-2026-11-06 item 5): money taken back after a refund made by
   * mistake, by when it was recorded and how (cash into the drawer, or charged on the card
   * machine). Counted on its own line, by payment method, never folded into refunds or sales; the
   * drawer and the machine's batch include it. Absent: none.
   */
  readonly moneyTakenBack?: readonly {
    readonly orderReference: string;
    readonly method: "Cash" | "CardMachine";
    readonly amountMinor: bigint;
    readonly recordedAt: string;
  }[];
  /**
   * WP-2423 item 8 ① segment 2: comps and discounts managers decided in the range (and their
   * Orders are in `orders`). A round whose every dish was comped owes nothing, so it has no
   * payment line: its dishes and comps count on the day the (last) comp was decided.
   */
  readonly priceReductions?: readonly {
    readonly orderReference: string;
    readonly orderBatchReference: string;
    readonly decidedAt: string;
  }[];
  readonly mayExport: boolean;
  readonly generatedAt: string;
  /**
   * WP-2423 M160: the first day the person asked for, and the Store's first business day when the
   * range was asked from before it (the days before have no sales; the range starts there).
   */
  readonly requestedFrom?: string;
  readonly recordsBeginOn?: string | null;
}
/** A payment line of an order refunded in full the day it was paid (what it took). */
interface CancelledInFullLine {
  readonly orderReference: string;
  readonly kind: StoreSalesOrderKind | null;
  readonly channel: StoreSalesChannel;
  readonly takenAt: string;
  readonly amountMinor: bigint;
}

interface Totals {
  paymentCount: number;
  orders: Set<string>;
  grossMinor: bigint;
  discountMinor: bigint;
  /** WP-2423 item 8 ① segment 2: comps and discounts a manager took off before the table paid. */
  compMinor: bigint;
  compCount: number;
  /** v15 M149: the tax those comps and discounts took off (shown as "with tax"). */
  compTaxMinor: bigint;
  /** v15 M130: what members' points paid of the dishes (its own line, never in comps). */
  pointsMinor: bigint;
  pointsCount: number;
  serviceChargeMinor: bigint;
  taxMinor: bigint;
  taxes: Map<string, bigint>;
  tipMinor: bigint;
  collectedMinor: bigint;
  /** DEC-DINE-IN-PAY-LATER: cash rounding to 5 cents collected (not sales, tax or tips). */
  roundingMinor: bigint;
  /** Payments whose priced items could not be matched to the amount taken (should be none). */
  unmatchedMinor: bigint;
  unmatchedCount: number;
  refundCount: number;
  refundedMinor: bigint;
  refundedNetMinor: bigint;
  refundedTaxMinor: bigint;
  refundedTipMinor: bigint;
  refundedServiceChargeMinor: bigint;
  /** Whole-payment refunds that could not be split by item (should be none). */
  refundedUnallocatedMinor: bigint;
  /** v15 M162: the cash rounding a table's full cash refund handed back with it (not sales or tax). */
  refundedRoundingMinor: bigint;
  /** DEC-DINE-IN-PAY-LATER: tables written off unpaid (not collected, not in the sums above). */
  writeOffCount: number;
  writeOffMinor: bigint;
  /** WP-2423 M163: money taken back after refunds made by mistake (not in the sums above). */
  takenBackCount: number;
  takenBackMinor: bigint;
  /** Orders refunded in full the day they were paid: taken and given back, not in the sums above. */
  cancelledOrders: Set<string>;
  cancelledMinor: bigint;
}
const totals = (): Totals => ({
  cancelledOrders: new Set(),
  cancelledMinor: 0n,
  paymentCount: 0,
  orders: new Set(),
  grossMinor: 0n,
  discountMinor: 0n,
  compMinor: 0n,
  compCount: 0,
  compTaxMinor: 0n,
  pointsMinor: 0n,
  pointsCount: 0,
  serviceChargeMinor: 0n,
  taxMinor: 0n,
  taxes: new Map(),
  tipMinor: 0n,
  collectedMinor: 0n,
  roundingMinor: 0n,
  writeOffCount: 0,
  writeOffMinor: 0n,
  takenBackCount: 0,
  takenBackMinor: 0n,
  unmatchedMinor: 0n,
  unmatchedCount: 0,
  refundCount: 0,
  refundedMinor: 0n,
  refundedNetMinor: 0n,
  refundedTaxMinor: 0n,
  refundedTipMinor: 0n,
  refundedServiceChargeMinor: 0n,
  refundedUnallocatedMinor: 0n,
  refundedRoundingMinor: 0n,
});
interface ItemTotals {
  name: string;
  quantity: number;
  grossMinor: bigint;
  discountMinor: bigint;
  compMinor: bigint;
  pointsMinor: bigint;
  refundedQuantity: number;
  refundedNetMinor: bigint;
}
interface HourTotals {
  paymentCount: number;
  netSalesMinor: bigint;
  taxMinor: bigint;
  tipMinor: bigint;
  collectedMinor: bigint;
}
interface TipTotals {
  tipMinor: bigint;
  refundedMinor: bigint;
}
interface DayFacts {
  readonly window: MerchantBusinessDayWindow;
  readonly all: Totals;
  readonly channels: Map<StoreSalesChannel, Totals>;
  readonly kinds: Map<StoreSalesOrderKind, Totals>;
  readonly items: Map<string, ItemTotals>;
  readonly hours: Map<number, HourTotals>;
  readonly tips: Map<StoreSalesChannel, TipTotals>;
}

const fail = (): never => {
  throw new Error("STORE_SALES_REPORT_UNAVAILABLE");
};
const s = (value: bigint) => value.toString();
const add = <K>(map: Map<K, bigint>, key: K, value: bigint) =>
  map.set(key, (map.get(key) ?? 0n) + value);
/** Largest remainder over positive weights: floor shares, then the leftover cents in remainder order. */
function allocate(total: bigint, weights: readonly bigint[]): readonly bigint[] {
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (sum <= 0n) return fail();
  const negative = total < 0n;
  const magnitude = negative ? -total : total;
  const result = weights.map((weight) => (magnitude * weight) / sum);
  let left = magnitude - result.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((weight, index) => ({ index, remainder: (magnitude * weight) % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  for (const entry of order) {
    if (left <= 0n) break;
    result[entry.index] = (result[entry.index] ?? 0n) + 1n;
    left -= 1n;
  }
  return negative ? result.map((value) => -value) : result;
}

/** Store-local hour (0–23) of an instant. */
function localHour(instant: string, timeZone: string): number {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(
      new Date(instant),
    ),
  );
  return Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : fail();
}

/** The tax line a Store owner reads ("HST"), not a configuration code with underscores. */
export function taxLabel(code: string): string {
  return code.replaceAll("_", " ");
}

/**
 * The Store sales report. Orders refunded in full on the day they were paid are taken out of the
 * sales (and their refunds out of the refunds) and listed on their own; the match with the
 * day-end settlement is checked on all payments and refunds as they happened.
 */
export function computeStoreSalesReport(input: StoreSalesReportInput) {
  const cancelled = cancelledInFull(input);
  if (cancelled.orders.size === 0) return computeSales(input, []);
  const keep = <T extends { readonly orderReference: string }>(rows: readonly T[]) =>
    rows.filter((row) => !cancelled.orders.has(row.orderReference));
  const asHappened = computeSales(input, []);
  const sales = computeSales(
    {
      ...input,
      payments: keep(input.payments),
      refundedPayments: keep(input.refundedPayments),
      refunds: keep(input.refunds),
      orders: keep(input.orders),
      priceReductions: keep(input.priceReductions ?? []),
    },
    cancelled.lines,
  );
  return Object.freeze({ ...sales, reconciliation: asHappened.reconciliation });
}

/** Orders the Store cancelled whose payments in the range were all given back the day taken. */
function cancelledInFull(input: StoreSalesReportInput) {
  const dayOf = (instant: string) =>
    input.days.find((day) => instant >= day.startsAt && instant < day.endsAt)?.businessDate ?? null;
  const byOrder = new Map<
    string,
    { taken: bigint; refunded: bigint; days: Set<string | null>; lines: CancelledInFullLine[] }
  >();
  const entry = (orderReference: string) => {
    const found = byOrder.get(orderReference) ?? {
      taken: 0n,
      refunded: 0n,
      days: new Set<string | null>(),
      lines: [],
    };
    byOrder.set(orderReference, found);
    return found;
  };
  const orders = new Map(input.orders.map((order) => [order.orderReference, order]));
  for (const payment of input.payments) {
    const e = entry(payment.orderReference);
    const order = orders.get(payment.orderReference);
    e.taken += payment.totalMinor + payment.roundingMinor;
    e.days.add(dayOf(payment.takenAt));
    e.lines.push({
      orderReference: payment.orderReference,
      kind:
        order === undefined
          ? null
          : order.orderType === "DineIn"
            ? "DineIn"
            : order.sourceChannel === "Pos"
              ? "Counter"
              : "Pickup",
      channel: payment.channel,
      takenAt: payment.takenAt,
      amountMinor: payment.totalMinor + payment.roundingMinor,
    });
  }
  // A payment taken before the range (refunded within it) keeps its refund a refund.
  for (const payment of input.refundedPayments) entry(payment.orderReference).days.add(null);
  for (const refund of input.refunds) {
    const e = entry(refund.orderReference);
    e.refunded += refund.amountMinor;
    e.days.add(dayOf(refund.refundedAt));
  }
  const cancelled = new Set<string>(),
    lines: CancelledInFullLine[] = [];
  for (const [order, e] of byOrder)
    if (
      orders.get(order)?.cancelled === true &&
      e.taken > 0n &&
      e.refunded === e.taken &&
      e.days.size === 1 &&
      !e.days.has(null)
    ) {
      cancelled.add(order);
      lines.push(...e.lines);
    }
  return { orders: cancelled, lines };
}

function computeSales(
  input: StoreSalesReportInput,
  cancelledLines: readonly CancelledInFullLine[],
) {
  if (input.days.length < 1) return fail();
  for (let index = 1; index < input.days.length; index++)
    if (input.days[index]?.startsAt !== input.days[index - 1]?.endsAt) return fail();
  const first = input.days[0] ?? fail(),
    last = input.days.at(-1) ?? fail();
  const dayOf = (instant: string) =>
    input.days.find((day) => instant >= day.startsAt && instant < day.endsAt) ?? null;
  const facts = new Map<string, DayFacts>(
    input.days.map((window) => [
      window.businessDate,
      {
        window,
        all: totals(),
        channels: new Map(storeSalesChannels.map((channel) => [channel, totals()])),
        kinds: new Map(storeSalesOrderKinds.map((kind) => [kind, totals()])),
        items: new Map(),
        hours: new Map(),
        tips: new Map(
          storeSalesChannels.map((channel) => [channel, { tipMinor: 0n, refundedMinor: 0n }]),
        ),
      },
    ]),
  );
  const orders = new Map(input.orders.map((order) => [order.orderReference, order]));
  const kindOf = (order: StoreSalesOrder): StoreSalesOrderKind =>
    order.orderType === "DineIn" ? "DineIn" : order.sourceChannel === "Pos" ? "Counter" : "Pickup";
  const batchOf = (orderReference: string, orderBatchReference: string) =>
    orders.get(orderReference)?.batches.find((b) => b.orderBatchReference === orderBatchReference);
  const batchItems = (orderReference: string, orderBatchReference: string) =>
    batchOf(orderReference, orderBatchReference)?.items ?? null;
  // WP-2423 DEC-TAX-WHOLE-RECEIPT: the round's share of its bill's tax rounding (tax it was paid).
  const batchRounding = (orderReference: string, orderBatchReference: string) =>
    batchOf(orderReference, orderBatchReference)?.taxRounding ?? [];
  const itemKey = (item: { skuReference: string; name: string }) =>
    item.skuReference + "\u0000" + item.name;

  // DEC-DINE-IN-PAY-LATER: a table written off when the guests left (dine-in, no channel).
  for (const writeOff of input.unpaidWriteOffs ?? []) {
    const day = dayOf(writeOff.decidedAt);
    if (day === null) return fail();
    const f = facts.get(day.businessDate) ?? fail();
    for (const t of [f.all, f.kinds.get("DineIn") ?? fail()]) {
      t.writeOffCount++;
      t.writeOffMinor += writeOff.amountMinor;
    }
  }

  // WP-2423 M163: money taken back, on the day it was recorded, by how it came back.
  for (const recovery of input.moneyTakenBack ?? []) {
    const day = dayOf(recovery.recordedAt);
    if (day === null || recovery.amountMinor <= 0n) return fail();
    const f = facts.get(day.businessDate) ?? fail();
    const order = orders.get(recovery.orderReference);
    const groups = [f.all, f.channels.get(recovery.method) ?? fail()];
    if (order !== undefined) groups.push(f.kinds.get(kindOf(order)) ?? fail());
    for (const t of groups) {
      t.takenBackCount++;
      t.takenBackMinor += recovery.amountMinor;
    }
  }

  // Orders refunded in full the day they were paid: listed on their own (not sales).
  for (const line of cancelledLines) {
    const day = dayOf(line.takenAt);
    if (day === null) return fail();
    const f = facts.get(day.businessDate) ?? fail();
    const groups = [f.all, f.channels.get(line.channel) ?? fail()];
    if (line.kind !== null) groups.push(f.kinds.get(line.kind) ?? fail());
    for (const t of groups) {
      t.cancelledOrders.add(line.orderReference);
      t.cancelledMinor += line.amountMinor;
    }
  }

  // Sales: each payment taken in the range, with its share of the priced items of the round it
  // paid for. WP-2423: a round is sold once, however the table paid it — whole, split evenly, by
  // rounds or across cash, card machine and phone. Its paid lines (every part, in or out of the
  // range) together must equal what the round was priced; its sales, comps, service charges and
  // tax are then shared out to the lines by what each paid (largest remainder), so each part
  // counts on its own day and payment method and the round adds up exactly once.
  type SalesPayment = (typeof input.payments)[number];
  interface LineShare {
    grossMinor: bigint;
    discountMinor: bigint;
    compMinor: bigint;
    compTaxMinor: bigint;
    pointsMinor: bigint;
    feeMinor: bigint;
    taxMinor: bigint;
    taxes: Map<string, bigint>;
    /** The line that carries the round's dishes in the item rows (they are counted, not split). */
    readonly primary: boolean;
  }
  const roundKey = (orderReference: string, orderBatchReference: string) =>
    orderReference + "\u0000" + orderBatchReference;
  const roundLines = new Map<string, SalesPayment[]>();
  for (const payment of [...input.payments, ...input.refundedPayments]) {
    const key = roundKey(payment.orderReference, payment.orderBatchReference);
    const lines = roundLines.get(key) ?? [];
    roundLines.set(key, lines);
    lines.push(payment);
  }
  const lineShares = new Map<SalesPayment, LineShare>();
  for (const lines of roundLines.values()) {
    const head = lines[0] ?? fail();
    const items = batchItems(head.orderReference, head.orderBatchReference);
    if (items === null || items.length === 0) continue;
    const rounding = batchRounding(head.orderReference, head.orderBatchReference);
    const priced =
      items.reduce((sum, item) => sum + item.totalMinor, 0n) +
      rounding.reduce((sum, line) => sum + line.amountMinor, 0n);
    const paid = lines.reduce((sum, line) => sum + line.orderAllocationMinor, 0n);
    // A split bill whose other parts are not paid (yet, or written off when the guests left):
    // the parts paid count their own share; the rest is not sold until it is paid.
    const unpaid =
      paid < priced && lines.every((line) => line.splitPart === true) ? priced - paid : 0n;
    if (paid + unpaid !== priced) continue;
    const ordered = [...lines].sort((a, b) =>
      a.takenAt === b.takenAt
        ? a.paymentIntentReference.localeCompare(b.paymentIntentReference)
        : a.takenAt.localeCompare(b.takenAt),
    );
    // The unpaid rest, if any, takes its share last and is dropped.
    const weights = [
      ...ordered.map((line) => line.orderAllocationMinor),
      ...(unpaid > 0n ? [unpaid] : []),
    ];
    const sum = (pick: (item: StoreSalesOrder["batches"][number]["items"][number]) => bigint) =>
      items.reduce((total, item) => total + pick(item), 0n);
    const discount = allocate(
      sum((item) => item.discountMinor),
      weights,
    );
    const comp = allocate(
      sum((item) => item.compMinor),
      weights,
    );
    const compTax = allocate(
      sum((item) => item.compTaxMinor),
      weights,
    );
    const pointsOff = allocate(
      sum((item) => item.pointsMinor),
      weights,
    );
    const fee = allocate(
      sum((item) => item.feeMinor),
      weights,
    );
    const tax = allocate(
      sum((item) => item.taxMinor) + rounding.reduce((total, line) => total + line.amountMinor, 0n),
      weights,
    );
    const codes = new Map<string, bigint>();
    for (const item of items)
      for (const component of item.taxComponents) add(codes, component.code, component.amountMinor);
    for (const line of rounding) add(codes, line.code, line.amountMinor);
    const codeShares = [...codes].map(
      ([code, amount]) => [code, allocate(amount, weights)] as const,
    );
    let primary = 0;
    ordered.forEach((line, index) => {
      if (line.orderAllocationMinor > (ordered[primary]?.orderAllocationMinor ?? 0n))
        primary = index;
    });
    ordered.forEach((line, index) => {
      const d = discount[index] ?? fail(),
        c = comp[index] ?? fail(),
        p = pointsOff[index] ?? fail(),
        f = fee[index] ?? fail(),
        t = tax[index] ?? fail();
      lineShares.set(line, {
        // What the line paid is its net sales, service charges and tax: gross is the rest, so
        // each line adds up and the shares of gross still sum to the round's gross.
        grossMinor: line.orderAllocationMinor + d + c + p - f - t,
        discountMinor: d,
        compMinor: c,
        compTaxMinor: compTax[index] ?? fail(),
        pointsMinor: p,
        feeMinor: f,
        taxMinor: t,
        taxes: new Map(codeShares.map(([code, shares]) => [code, shares[index] ?? fail()])),
        // A round not paid in full lists no dishes (they are sold when it is).
        primary: unpaid === 0n && index === primary,
      });
    });
  }
  for (const payment of input.payments) {
    const day = dayOf(payment.takenAt);
    if (day === null) return fail();
    const f = facts.get(day.businessDate) ?? fail();
    const order = orders.get(payment.orderReference) ?? null;
    const kind = order === null ? null : kindOf(order);
    const items = batchItems(payment.orderReference, payment.orderBatchReference) ?? [];
    const share = lineShares.get(payment) ?? null;
    const groups = [f.all, f.channels.get(payment.channel) ?? fail()];
    if (kind !== null) groups.push(f.kinds.get(kind) ?? fail());
    for (const t of groups) {
      // A table paid at the end is one payment over several round lines.
      t.paymentCount += payment.paymentCount;
      t.orders.add(payment.orderReference);
      t.tipMinor += payment.tipMinor;
      t.collectedMinor += payment.totalMinor + payment.roundingMinor;
      t.roundingMinor += payment.roundingMinor;
      if (share === null) {
        t.unmatchedMinor += payment.orderAllocationMinor;
        t.unmatchedCount++;
        continue;
      }
      t.grossMinor += share.grossMinor;
      t.discountMinor += share.discountMinor;
      t.compMinor += share.compMinor;
      t.compTaxMinor += share.compTaxMinor;
      t.pointsMinor += share.pointsMinor;
      if (share.primary) {
        t.compCount += items.filter((item) => item.compMinor > 0n).length;
        t.pointsCount += items.filter((item) => item.pointsMinor > 0n).length;
      }
      t.serviceChargeMinor += share.feeMinor;
      t.taxMinor += share.taxMinor;
      for (const [code, amount] of share.taxes) add(t.taxes, code, amount);
    }
    const tips = f.tips.get(payment.channel) ?? fail();
    tips.tipMinor += payment.tipMinor;
    const hour = localHour(payment.takenAt, input.timeZone);
    const h = f.hours.get(hour) ?? {
      paymentCount: 0,
      netSalesMinor: 0n,
      taxMinor: 0n,
      tipMinor: 0n,
      collectedMinor: 0n,
    };
    f.hours.set(hour, h);
    h.paymentCount += payment.paymentCount;
    h.tipMinor += payment.tipMinor;
    h.collectedMinor += payment.totalMinor + payment.roundingMinor;
    if (share === null) continue;
    h.netSalesMinor += share.grossMinor - share.discountMinor - share.compMinor - share.pointsMinor;
    h.taxMinor += share.taxMinor;
    if (!share.primary) continue;
    for (const item of items) {
      const key = itemKey(item);
      const row = f.items.get(key) ?? {
        name: item.name,
        quantity: 0,
        grossMinor: 0n,
        discountMinor: 0n,
        compMinor: 0n,
        pointsMinor: 0n,
        refundedQuantity: 0,
        refundedNetMinor: 0n,
      };
      f.items.set(key, row);
      row.quantity += item.quantity;
      row.grossMinor += item.subtotalMinor;
      row.discountMinor += item.discountMinor;
      row.compMinor += item.compMinor;
      row.pointsMinor += item.pointsMinor;
    }
  }
  // Rounds comped in full: sold at their price, all of it comped, nothing collected (no payment
  // line). Never left out of the sales (AGENTS.md: no sales suppression).
  const paidBatches = new Set(
    [...input.payments, ...input.refundedPayments].map((payment) => payment.orderBatchReference),
  );
  const compedRounds = new Map<string, { orderReference: string; decidedAt: string }>();
  for (const reduction of input.priceReductions ?? []) {
    const prior = compedRounds.get(reduction.orderBatchReference);
    if (prior === undefined || reduction.decidedAt > prior.decidedAt)
      compedRounds.set(reduction.orderBatchReference, {
        orderReference: reduction.orderReference,
        decidedAt: reduction.decidedAt,
      });
  }
  for (const [orderBatchReference, round] of compedRounds) {
    if (paidBatches.has(orderBatchReference)) continue;
    const order = orders.get(round.orderReference);
    const items = batchItems(round.orderReference, orderBatchReference);
    if (
      order === undefined ||
      items === null ||
      items.length === 0 ||
      items.reduce((sum, item) => sum + item.totalMinor, 0n) !== 0n
    )
      continue;
    const day = dayOf(round.decidedAt);
    if (day === null) continue;
    const f = facts.get(day.businessDate) ?? fail();
    for (const t of [f.all, f.kinds.get(kindOf(order)) ?? fail()]) {
      t.orders.add(round.orderReference);
      for (const item of items) {
        t.grossMinor += item.subtotalMinor;
        t.discountMinor += item.discountMinor;
        t.compMinor += item.compMinor;
        t.compTaxMinor += item.compTaxMinor;
        t.pointsMinor += item.pointsMinor;
        if (item.compMinor > 0n) t.compCount++;
        if (item.pointsMinor > 0n) t.pointsCount++;
        t.serviceChargeMinor += item.feeMinor;
        t.taxMinor += item.taxMinor;
      }
    }
    for (const item of items) {
      const key = itemKey(item);
      const row = f.items.get(key) ?? {
        name: item.name,
        quantity: 0,
        grossMinor: 0n,
        discountMinor: 0n,
        compMinor: 0n,
        pointsMinor: 0n,
        refundedQuantity: 0,
        refundedNetMinor: 0n,
      };
      f.items.set(key, row);
      row.quantity += item.quantity;
      row.grossMinor += item.subtotalMinor;
      row.discountMinor += item.discountMinor;
      row.compMinor += item.compMinor;
      row.pointsMinor += item.pointsMinor;
    }
  }

  // Refunds, oldest first: earlier refunds tell a whole-payment refund what had already gone back.
  const paymentsByIntent = new Map(
    [...input.payments, ...input.refundedPayments].map((p) => [p.paymentIntentReference, p]),
  );
  const returned = new Map<string, { units: number; net: bigint; tax: bigint; fee: bigint }>();
  const tipReturned = new Map<string, bigint>();
  const roundingReturned = new Map<string, bigint>();
  // v15 M162: a table payment is one line per round; a refund of it is shared over all of them.
  const tableLines = new Map<string, StoreSalesPayment[]>();
  for (const line of paymentsByIntent.values()) {
    if (line.tableSettlementReference === undefined) continue;
    const list = tableLines.get(line.tableSettlementReference) ?? [];
    list.push(line);
    tableLines.set(line.tableSettlementReference, list);
  }
  for (const refund of [...input.refunds].sort((a, b) =>
    a.refundedAt.localeCompare(b.refundedAt),
  )) {
    const payment = paymentsByIntent.get(refund.paymentIntentReference) ?? fail();
    if (payment.orderReference !== refund.orderReference) return fail();
    // Each share: [item or null, units, net, tax, fee, tip, the payment line its tip came off].
    const shares: [
      StoreSalesOrder["batches"][number]["items"][number] | null,
      number,
      bigint,
      bigint,
      bigint,
      bigint,
      string,
    ][] = [];
    let unallocated = 0n,
      roundingShare = 0n;
    const roundingKey = refund.tableSettlementReference ?? payment.paymentIntentReference;
    if (refund.items !== null) {
      const items = batchItems(payment.orderReference, payment.orderBatchReference) ?? [];
      const byItem = new Map(items.map((item) => [item.orderItemReference, item]));
      for (const share of refund.items) {
        const item = byItem.get(share.orderItemReference) ?? null;
        shares.push([
          item,
          share.unitCount,
          share.netMinor,
          share.taxMinor,
          share.serviceChargeMinor,
          share.tipMinor,
          payment.paymentIntentReference,
        ]);
      }
      // WP-2423 M52/M131: cash from a counter payment goes back in whole nickels; what it differs
      // from the dishes' shares is cash rounding handed back (not sales, tax or tip).
      if (refund.channel === "Cash")
        roundingShare =
          refund.amountMinor -
          refund.items.reduce(
            (sum, share) =>
              sum + share.netMinor + share.taxMinor + share.serviceChargeMinor + share.tipMinor,
            0n,
          );
    } else {
      // A whole-payment refund returns what remained of each item and of the tip, over every
      // round line of a table's payment (a refund is off the whole bill, not its last round).
      const lines =
        refund.tableSettlementReference === undefined
          ? [payment]
          : (tableLines.get(refund.tableSettlementReference) ?? fail());
      if (!lines.includes(payment)) return fail();
      let remaining = 0n;
      const pending: typeof shares = [];
      const tips: [string, bigint][] = [];
      let itemized = true;
      for (const line of lines) {
        const items = batchItems(line.orderReference, line.orderBatchReference) ?? [];
        if (items.length === 0) itemized = false;
        for (const item of items) {
          const before = returned.get(item.orderItemReference) ?? {
            units: 0,
            net: 0n,
            tax: 0n,
            fee: 0n,
          };
          const share: (typeof shares)[number] = [
            item,
            item.quantity - before.units,
            item.subtotalMinor -
              item.discountMinor -
              item.compMinor -
              item.pointsMinor -
              before.net,
            item.taxMinor - before.tax,
            item.feeMinor - before.fee,
            0n,
            line.paymentIntentReference,
          ];
          remaining += share[2] + share[3] + share[4];
          pending.push(share);
        }
        const tipLeft = line.tipMinor - (tipReturned.get(line.paymentIntentReference) ?? 0n);
        remaining += tipLeft;
        tips.push([line.paymentIntentReference, tipLeft]);
      }
      // The cash rounding taken with the payment and not yet handed back (cash only; else 0).
      const roundingLeft =
        lines.reduce((sum, line) => sum + line.roundingMinor, 0n) -
        (roundingReturned.get(roundingKey) ?? 0n);
      // What came back beyond the dishes and tip left: the rounding, when it is a full refund.
      const extra = refund.amountMinor - remaining;
      const everythingLeft =
        extra === 0n ||
        (roundingLeft > 0n ? extra > 0n && extra <= roundingLeft : extra === roundingLeft);
      if (itemized && everythingLeft) {
        // Everything left, with the rounding when it came back too ($23.45 for a $23.47 bill).
        shares.push(...pending);
        for (const [line, tipLeft] of tips) shares.push([null, 0, 0n, 0n, 0n, tipLeft, line]);
        roundingShare = extra;
      } else if (itemized && refund.amountMinor > 0n && extra < 0n) {
        // v15 M162: an amount refunded off part of a bill ("Store mistake, $10 back") gives back
        // its proportion of what is left of each dish's sales, tax and service charge and of the
        // tip, on every round of the bill (largest remainder; the ETA s. 232 price-reduction
        // treatment), so the refunded tax is reported and net sales after refunds subtract it.
        // No dish counts as returned.
        const parts = [
          ...pending.flatMap((share) => [share[2], share[3], share[4]]),
          ...tips.map(([, tipLeft]) => tipLeft),
        ];
        const split = allocate(
          refund.amountMinor,
          parts.map((value) => (value > 0n ? value : 0n)),
        );
        pending.forEach((share, index) => {
          shares.push([
            share[0],
            0,
            split[index * 3] ?? fail(),
            split[index * 3 + 1] ?? fail(),
            split[index * 3 + 2] ?? fail(),
            0n,
            share[6],
          ]);
        });
        tips.forEach(([line], index) => {
          shares.push([null, 0, 0n, 0n, 0n, split[pending.length * 3 + index] ?? fail(), line]);
        });
      } else unallocated = refund.amountMinor;
    }
    for (const [item, units, net, tax, fee] of shares) {
      if (item === null) continue;
      const before = returned.get(item.orderItemReference) ?? {
        units: 0,
        net: 0n,
        tax: 0n,
        fee: 0n,
      };
      returned.set(item.orderItemReference, {
        units: before.units + units,
        net: before.net + net,
        tax: before.tax + tax,
        fee: before.fee + fee,
      });
    }
    const tipShare = shares.reduce((sum, share) => sum + share[5], 0n);
    for (const share of shares) add(tipReturned, share[6], share[5]);
    add(roundingReturned, roundingKey, roundingShare);
    const day = refund.refundedAt >= first.startsAt ? dayOf(refund.refundedAt) : null;
    if (day === null) continue;
    const f = facts.get(day.businessDate) ?? fail();
    const order = orders.get(refund.orderReference) ?? null;
    const groups = [f.all, f.channels.get(refund.channel) ?? fail()];
    if (order !== null) groups.push(f.kinds.get(kindOf(order)) ?? fail());
    const net = shares.reduce((sum, share) => sum + share[2], 0n),
      tax = shares.reduce((sum, share) => sum + share[3], 0n),
      fee = shares.reduce((sum, share) => sum + share[4], 0n);
    if (net + tax + fee + tipShare + unallocated + roundingShare !== refund.amountMinor)
      return fail();
    for (const t of groups) {
      t.refundCount++;
      t.refundedMinor += refund.amountMinor;
      t.refundedNetMinor += net;
      t.refundedTaxMinor += tax;
      t.refundedServiceChargeMinor += fee;
      t.refundedTipMinor += tipShare;
      t.refundedUnallocatedMinor += unallocated;
      t.refundedRoundingMinor += roundingShare;
    }
    (f.tips.get(refund.channel) ?? fail()).refundedMinor += tipShare;
    for (const [item, units, itemNet] of shares) {
      if (item === null || (units === 0 && itemNet === 0n)) continue;
      const key = itemKey(item);
      const row = f.items.get(key) ?? {
        name: item.name,
        quantity: 0,
        grossMinor: 0n,
        discountMinor: 0n,
        compMinor: 0n,
        pointsMinor: 0n,
        refundedQuantity: 0,
        refundedNetMinor: 0n,
      };
      f.items.set(key, row);
      row.refundedQuantity += units;
      row.refundedNetMinor += itemNet;
    }
  }

  // Range totals.
  const merge = (target: Totals, source: Totals) => {
    target.paymentCount += source.paymentCount;
    target.writeOffCount += source.writeOffCount;
    target.takenBackCount += source.takenBackCount;
    target.compCount += source.compCount;
    target.pointsCount += source.pointsCount;
    for (const order of source.orders) target.orders.add(order);
    for (const order of source.cancelledOrders) target.cancelledOrders.add(order);
    target.cancelledMinor += source.cancelledMinor;
    for (const key of [
      "grossMinor",
      "discountMinor",
      "compMinor",
      "compTaxMinor",
      "pointsMinor",
      "serviceChargeMinor",
      "taxMinor",
      "tipMinor",
      "collectedMinor",
      "roundingMinor",
      "writeOffMinor",
      "takenBackMinor",
      "unmatchedMinor",
      "refundedMinor",
      "refundedNetMinor",
      "refundedTaxMinor",
      "refundedTipMinor",
      "refundedServiceChargeMinor",
      "refundedUnallocatedMinor",
      "refundedRoundingMinor",
    ] as const)
      target[key] += source[key];
    target.unmatchedCount += source.unmatchedCount;
    target.refundCount += source.refundCount;
    for (const [code, amount] of source.taxes) add(target.taxes, code, amount);
  };
  const range = {
    all: totals(),
    channels: new Map<StoreSalesChannel, Totals>(),
    kinds: new Map<StoreSalesOrderKind, Totals>(),
  };
  for (const channel of storeSalesChannels) range.channels.set(channel, totals());
  for (const kind of storeSalesOrderKinds) range.kinds.set(kind, totals());
  const items = new Map<string, ItemTotals>();
  const hours = new Map<number, HourTotals>();
  for (const f of facts.values()) {
    merge(range.all, f.all);
    for (const [channel, t] of f.channels) merge(range.channels.get(channel) ?? fail(), t);
    for (const [kind, t] of f.kinds) merge(range.kinds.get(kind) ?? fail(), t);
    for (const [key, row] of f.items) {
      const target = items.get(key) ?? {
        ...row,
        quantity: 0,
        grossMinor: 0n,
        discountMinor: 0n,
        compMinor: 0n,
        pointsMinor: 0n,
        refundedQuantity: 0,
        refundedNetMinor: 0n,
      };
      items.set(key, target);
      target.quantity += row.quantity;
      target.grossMinor += row.grossMinor;
      target.discountMinor += row.discountMinor;
      target.compMinor += row.compMinor;
      target.pointsMinor += row.pointsMinor;
      target.refundedQuantity += row.refundedQuantity;
      target.refundedNetMinor += row.refundedNetMinor;
    }
    for (const [hour, row] of f.hours) {
      const target = hours.get(hour) ?? {
        paymentCount: 0,
        netSalesMinor: 0n,
        taxMinor: 0n,
        tipMinor: 0n,
        collectedMinor: 0n,
      };
      hours.set(hour, target);
      target.paymentCount += row.paymentCount;
      target.netSalesMinor += row.netSalesMinor;
      target.taxMinor += row.taxMinor;
      target.tipMinor += row.tipMinor;
      target.collectedMinor += row.collectedMinor;
    }
  }

  // Reconciliation with the day-end settlement's own totals for the same window.
  const channel = (c: StoreSalesChannel) => range.channels.get(c) ?? fail();
  const online = channel("Online"),
    machine = channel("CardMachine"),
    cash = channel("Cash");
  const checks = [
    online.collectedMinor === input.settlement.onlineCaptured.amountMinor,
    online.paymentCount === input.settlement.onlineCaptured.count,
    online.refundedMinor === input.settlement.onlineRefunded.amountMinor,
    online.refundCount === input.settlement.onlineRefunded.count,
    machine.collectedMinor === input.settlement.cardMachineTaken.amountMinor,
    machine.paymentCount === input.settlement.cardMachineTaken.count,
    machine.tipMinor === input.settlement.cardMachineTaken.tipMinor,
    machine.refundedMinor === input.settlement.cardMachineRefunded.amountMinor,
    machine.refundCount === input.settlement.cardMachineRefunded.count,
    cash.collectedMinor === input.settlement.cashTaken.amountMinor,
    cash.paymentCount === input.settlement.cashTaken.count,
    cash.tipMinor === input.settlement.cashTaken.tipMinor,
    cash.roundingMinor === input.settlement.cashTaken.roundingMinor,
    cash.refundedMinor === input.settlement.cashRefunded.amountMinor,
    cash.refundCount === input.settlement.cashRefunded.count,
  ];
  const settlementCollected =
    input.settlement.onlineCaptured.amountMinor +
    input.settlement.cardMachineTaken.amountMinor +
    input.settlement.cashTaken.amountMinor;
  const settlementRefunded =
    input.settlement.onlineRefunded.amountMinor +
    input.settlement.cardMachineRefunded.amountMinor +
    input.settlement.cashRefunded.amountMinor;

  const summary = (t: Totals) => {
    const netSales = t.grossMinor - t.discountMinor - t.compMinor - t.pointsMinor;
    return Object.freeze({
      paymentCount: t.paymentCount,
      orderCount: t.orders.size,
      grossSalesMinor: s(t.grossMinor),
      discountsMinor: s(t.discountMinor),
      // WP-2423 item 8 ① segment 2: its own line, never folded into discounts or hidden.
      compCount: t.compCount,
      compsMinor: s(t.compMinor),
      // v15 M149: what the comps and discounts took off with their tax (comps are before tax).
      compsWithTaxMinor: s(t.compMinor + t.compTaxMinor),
      // v15 M130: members' points, on their own line (never "comps by a manager").
      pointsCount: t.pointsCount,
      pointsUsedMinor: s(t.pointsMinor),
      netSalesMinor: s(netSales),
      serviceChargesMinor: s(t.serviceChargeMinor),
      taxMinor: s(t.taxMinor),
      taxes: Object.freeze(
        [...t.taxes]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([code, amount]) =>
            Object.freeze({ label: taxLabel(code), amountMinor: s(amount) }),
          ),
      ),
      tipsMinor: s(t.tipMinor),
      cashRoundingMinor: s(t.roundingMinor),
      unmatchedMinor: s(t.unmatchedMinor),
      unmatchedPaymentCount: t.unmatchedCount,
      unpaidWriteOffCount: t.writeOffCount,
      unpaidWriteOffMinor: s(t.writeOffMinor),
      collectedMinor: s(t.collectedMinor),
      refundCount: t.refundCount,
      refundsMinor: s(t.refundedMinor),
      refunds: Object.freeze({
        salesMinor: s(t.refundedNetMinor),
        taxMinor: s(t.refundedTaxMinor),
        tipsMinor: s(t.refundedTipMinor),
        serviceChargesMinor: s(t.refundedServiceChargeMinor),
        notItemizedMinor: s(t.refundedUnallocatedMinor),
        cashRoundingMinor: s(t.refundedRoundingMinor),
      }),
      netSalesAfterRefundsMinor: s(netSales - t.refundedNetMinor),
      // v15 M45 (Owner rule 6): the tax still owed once refunds gave theirs back.
      taxAfterRefundsMinor: s(t.taxMinor - t.refundedTaxMinor),
      netCollectedMinor: s(t.collectedMinor - t.refundedMinor),
      // WP-2423 M163: given back by the guest after a refund made by mistake. Not a sale and not
      // less refunds: the drawer (cash) and the card machine's batch hold it on top of the net.
      moneyTakenBackCount: t.takenBackCount,
      moneyTakenBackMinor: s(t.takenBackMinor),
      // Taken and given back the same day: not in the sales, taken or refunds above.
      cancelledInFullCount: t.cancelledOrders.size,
      cancelledInFullMinor: s(t.cancelledMinor),
    });
  };
  // Every report row must add up: what was taken equals sales, charges, tax, tips (and anything not
  // matched to items), so a broken source can never print a plausible but wrong total.
  for (const t of [range.all, ...range.channels.values(), ...range.kinds.values()])
    if (
      t.grossMinor -
        t.discountMinor -
        t.compMinor -
        t.pointsMinor +
        t.serviceChargeMinor +
        t.taxMinor +
        t.tipMinor +
        t.roundingMinor +
        t.unmatchedMinor !==
      t.collectedMinor
    )
      return fail();
  const orderedHours = (map: Map<number, HourTotals>) => {
    const startHour = localHour(first.startsAt, input.timeZone);
    return [...map].sort(([a], [b]) => ((a - startHour + 24) % 24) - ((b - startHour + 24) % 24));
  };
  const itemNet = (row: ItemTotals) =>
    row.grossMinor - row.discountMinor - row.compMinor - row.pointsMinor;
  const itemRows = (map: Map<string, ItemTotals>) =>
    [...map.values()]
      .sort((a, b) =>
        itemNet(b) !== itemNet(a)
          ? itemNet(b) > itemNet(a)
            ? 1
            : -1
          : a.name.localeCompare(b.name),
      )
      .map((row) =>
        Object.freeze({
          name: row.name,
          quantitySold: row.quantity,
          grossSalesMinor: s(row.grossMinor),
          discountsMinor: s(row.discountMinor),
          compsMinor: s(row.compMinor),
          pointsUsedMinor: s(row.pointsMinor),
          netSalesMinor: s(itemNet(row)),
          refundedQuantity: row.refundedQuantity,
          refundsMinor: s(row.refundedNetMinor),
          netAfterRefundsMinor: s(itemNet(row) - row.refundedNetMinor),
        }),
      );
  const hourRows = (map: Map<number, HourTotals>) =>
    orderedHours(map).map(([hour, row]) =>
      Object.freeze({
        hour: String(hour).padStart(2, "0") + ":00",
        paymentCount: row.paymentCount,
        netSalesMinor: s(row.netSalesMinor),
        taxMinor: s(row.taxMinor),
        tipsMinor: s(row.tipMinor),
        collectedMinor: s(row.collectedMinor),
      }),
    );
  const tipRows = (f: DayFacts) =>
    storeSalesChannels.map((c) => {
      const t = f.tips.get(c) ?? fail();
      return Object.freeze({
        channel: c,
        tipsMinor: s(t.tipMinor),
        refundedMinor: s(t.refundedMinor),
        netMinor: s(t.tipMinor - t.refundedMinor),
      });
    });
  const days = [...facts.values()];
  return Object.freeze({
    // WP-2423 取舍 18, v15 M130: guests' points, now a line of their own (summary.pointsUsedMinor).
    pointsUsedMinor: s(range.all.pointsMinor),
    screenId: "RPT-OPS-DASHBOARD" as const,
    queryName: "store_sales_reports_v1" as const,
    storeLabel: input.storeLabel,
    timeZone: input.timeZone,
    currencyCode: "CAD" as const,
    from: first.businessDate,
    to: last.businessDate,
    requestedFrom: input.requestedFrom ?? first.businessDate,
    recordsBeginOn: input.recordsBeginOn ?? null,
    startsAt: first.startsAt,
    endsAt: last.endsAt,
    includesOpenDay: input.days.some((day) => day.status === "Open"),
    summary: summary(range.all),
    byChannel: Object.freeze(
      storeSalesChannels.map((c) => Object.freeze({ channel: c, ...summary(channel(c)) })),
    ),
    byOrderType: Object.freeze(
      storeSalesOrderKinds.map((kind) =>
        Object.freeze({ orderType: kind, ...summary(range.kinds.get(kind) ?? fail()) }),
      ),
    ),
    items: Object.freeze(itemRows(items)),
    hours: Object.freeze(hourRows(hours)),
    tips: Object.freeze(
      days.map((f) =>
        Object.freeze({ businessDate: f.window.businessDate, channels: Object.freeze(tipRows(f)) }),
      ),
    ),
    days: Object.freeze(
      days.map((f) =>
        Object.freeze({
          businessDate: f.window.businessDate,
          status: f.window.status,
          startsAt: f.window.startsAt,
          endsAt: f.window.endsAt,
          opensAt: f.window.opensAt ?? null,
          summary: summary(f.all),
          byChannel: Object.freeze(
            storeSalesChannels.map((c) =>
              Object.freeze({ channel: c, ...summary(f.channels.get(c) ?? fail()) }),
            ),
          ),
          items: Object.freeze(itemRows(f.items)),
          hours: Object.freeze(hourRows(f.hours)),
        }),
      ),
    ),
    reconciliation: Object.freeze({
      matchesSettlement: checks.every(Boolean),
      settlementCollectedMinor: s(settlementCollected),
      settlementRefundedMinor: s(settlementRefunded),
      reportCollectedMinor: s(range.all.collectedMinor),
      reportRefundedMinor: s(range.all.refundedMinor),
      pendingOnlineRefundCount: input.unresolvedOnlineRefundCount,
    }),
    permissions: Object.freeze({ mayExport: input.mayExport }),
    generatedAt: input.generatedAt,
  });
}
export type StoreSalesReportView = ReturnType<typeof computeStoreSalesReport>;

// ── CSV export ─────────────────────────────────────────────────────────────────────────────────

export type StoreSalesReportExportKind = "summary" | "items" | "hourly" | "tips";
export const storeSalesReportExportKinds: readonly StoreSalesReportExportKind[] = [
  "summary",
  "items",
  "hourly",
  "tips",
];
/** "1234" → "12.34", "-5" → "-0.05": decimal from integer cents, never floating point. */
export function decimalFromMinor(amountMinor: string): string {
  if (!/^-?(0|[1-9][0-9]*)$/u.test(amountMinor)) return fail();
  const negative = amountMinor.startsWith("-");
  const digits = (negative ? amountMinor.slice(1) : amountMinor).padStart(3, "0");
  return (negative ? "-" : "") + digits.slice(0, -2) + "." + digits.slice(-2);
}
/** RFC 4180 field; text that a spreadsheet would run as a formula is kept as text. */
function field(value: string | number): string {
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/u.test(text) && !/^-?\d+(\.\d+)?$/u.test(text))
    text = "'" + text;
  return /[",\r\n]/u.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}
const csv = (rows: readonly (readonly (string | number)[])[]) =>
  "﻿" + rows.map((row) => row.map(field).join(",")).join("\r\n") + "\r\n";
const channelLabel: Record<StoreSalesChannel, string> = {
  Online: "Online",
  CardMachine: "Store card machine",
  Cash: "Cash",
};

/** One CSV per report: a header row, one row per business day (and item or hour), no customer data. */
export function storeSalesReportCsv(
  view: StoreSalesReportView,
  kind: StoreSalesReportExportKind,
): string {
  const money = decimalFromMinor;
  if (kind === "summary") {
    const taxLabels = [
      ...new Set(view.days.flatMap((d) => d.summary.taxes.map((t) => t.label))),
    ].sort();
    const header = [
      "business_date",
      "day_status",
      "payments",
      "orders",
      "gross_sales",
      "discounts",
      "comps_and_discounts_by_manager",
      "comps_and_discounts_count",
      "net_sales",
      "service_charges",
      ...taxLabels.map((label) => "tax_" + label.toLowerCase().replace(/[^a-z0-9]+/gu, "_")),
      "tax_total",
      "tips",
      "total_collected",
      "refunds",
      "net_collected",
      "online_collected",
      "card_machine_collected",
      "cash_collected",
      "online_refunds",
      "card_machine_refunds",
      "cash_refunds",
      "cash_rounding",
      "unpaid_write_offs",
      "unpaid_write_off_amount",
      // Taken and given back the same day (not in the sales, collected or refunds columns).
      "cancelled_refunded_in_full_orders",
      "cancelled_refunded_in_full_amount",
      "currency",
      // v15 M130/M45/M149/M162: appended after the columns accountants already import, so none
      // of them moves. comps_and_discounts_by_manager no longer includes points (points_used
      // does); net_sales is unchanged (it always took both off).
      "points_used",
      "points_count",
      "comps_and_discounts_with_tax",
      "refunded_sales",
      "refunded_tax",
      "refunded_tips",
      "net_sales_after_refunds",
      "tax_after_refunds",
      // WP-2423 M163: money taken back after refunds made by mistake (not in refunds or sales),
      // appended so no earlier column moves.
      "money_taken_back",
      "cash_taken_back",
      "card_machine_taken_back",
    ];
    return csv([
      header,
      ...view.days.map((day) => {
        const sum = day.summary;
        const byChannel = (c: StoreSalesChannel) =>
          day.byChannel.find((entry) => entry.channel === c) ?? fail();
        return [
          day.businessDate,
          day.status === "Open" ? "open (so far)" : "closed",
          sum.paymentCount,
          sum.orderCount,
          money(sum.grossSalesMinor),
          money(sum.discountsMinor),
          money(sum.compsMinor),
          sum.compCount,
          money(sum.netSalesMinor),
          money(sum.serviceChargesMinor),
          ...taxLabels.map((label) =>
            money(sum.taxes.find((t) => t.label === label)?.amountMinor ?? "0"),
          ),
          money(sum.taxMinor),
          money(sum.tipsMinor),
          money(sum.collectedMinor),
          money(sum.refundsMinor),
          money(sum.netCollectedMinor),
          money(byChannel("Online").collectedMinor),
          money(byChannel("CardMachine").collectedMinor),
          money(byChannel("Cash").collectedMinor),
          money(byChannel("Online").refundsMinor),
          money(byChannel("CardMachine").refundsMinor),
          money(byChannel("Cash").refundsMinor),
          money(sum.cashRoundingMinor),
          sum.unpaidWriteOffCount,
          money(sum.unpaidWriteOffMinor),
          sum.cancelledInFullCount,
          money(sum.cancelledInFullMinor),
          view.currencyCode,
          money(sum.pointsUsedMinor),
          sum.pointsCount,
          money(sum.compsWithTaxMinor),
          money(sum.refunds.salesMinor),
          money(sum.refunds.taxMinor),
          money(sum.refunds.tipsMinor),
          money(sum.netSalesAfterRefundsMinor),
          money(sum.taxAfterRefundsMinor),
          money(sum.moneyTakenBackMinor),
          money(byChannel("Cash").moneyTakenBackMinor),
          money(byChannel("CardMachine").moneyTakenBackMinor),
        ];
      }),
      // WP-2423 M160: a range asked from before the Store's records says where they begin, after
      // the figures (the column header stays the first row for accounting imports).
      ...(view.recordsBeginOn === null ? [] : [[], ["Records begin", view.recordsBeginOn]]),
    ]);
  }
  if (kind === "items")
    return csv([
      [
        "business_date",
        "item",
        "quantity_sold",
        "gross_sales",
        "discounts",
        "comps_and_discounts_by_manager",
        "net_sales",
        "refunded_quantity",
        "refunds",
        "net_after_refunds",
        "currency",
        // v15 M130: appended; comps_and_discounts_by_manager no longer includes points.
        "points_used",
      ],
      ...view.days.flatMap((day) =>
        day.items.map((row) => [
          day.businessDate,
          row.name,
          row.quantitySold,
          money(row.grossSalesMinor),
          money(row.discountsMinor),
          money(row.compsMinor),
          money(row.netSalesMinor),
          row.refundedQuantity,
          money(row.refundsMinor),
          money(row.netAfterRefundsMinor),
          view.currencyCode,
          money(row.pointsUsedMinor),
        ]),
      ),
    ]);
  if (kind === "hourly")
    return csv([
      [
        "business_date",
        "hour_store_time",
        "payments",
        "net_sales",
        "tax",
        "tips",
        "total_collected",
        "currency",
      ],
      ...view.days.flatMap((day) =>
        day.hours.map((row) => [
          day.businessDate,
          row.hour,
          row.paymentCount,
          money(row.netSalesMinor),
          money(row.taxMinor),
          money(row.tipsMinor),
          money(row.collectedMinor),
          view.currencyCode,
        ]),
      ),
    ]);
  return csv([
    ["business_date", "payment_channel", "tips", "tips_refunded", "net_tips", "currency"],
    ...view.tips.flatMap((day) =>
      day.channels.map((row) => [
        day.businessDate,
        channelLabel[row.channel],
        money(row.tipsMinor),
        money(row.refundedMinor),
        money(row.netMinor),
        view.currencyCode,
      ]),
    ),
  ]);
}
