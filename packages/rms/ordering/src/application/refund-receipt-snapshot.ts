import {
  DigitalReceiptError,
  parseDigitalReceiptRecord,
  parseDigitalReceiptSnapshot,
  type DigitalReceiptSnapshot,
  type ReceiptRefund,
} from "../domain/digital-receipt.js";
import { parseOrderingInstant } from "../domain/cart.js";

export interface RefundReceiptFinancialEvidence {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly orderReference: string;
  readonly observedAt: string;
  readonly captured: { readonly amountMinor: bigint; readonly currencyCode: string };
  readonly refunded: { readonly amountMinor: bigint; readonly currencyCode: string };
  readonly pendingRefund: { readonly amountMinor: bigint; readonly currencyCode: string };
}
const fail = (): never => {
  throw new DigitalReceiptError("DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE");
};

/**
 * WP-2423 (v15 3cd0f8dd M4): what the confirmed refunds returned, from the Payment owner's records
 * (never the browser). `itemized`: each refund request whose refund is confirmed, by the round whose
 * payment it refunded, with each item's price, tax, tip share and other charges it returned.
 * `rounds`: each charged round's payment — captured, confirmed refunded and its tip — and its items.
 */
export interface RefundReceiptItemization {
  readonly itemized: readonly {
    readonly refundReference: string;
    readonly kind: "Refund" | "ItemCancellation";
    readonly payments: readonly {
      readonly orderBatchReference: string;
      readonly items: readonly {
        readonly orderItemReference: string;
        readonly quantity: number;
        readonly netMinor: bigint;
        readonly taxMinor: bigint;
        readonly tipMinor: bigint;
        readonly otherMinor: bigint;
      }[];
    }[];
  }[];
  readonly rounds: readonly {
    readonly orderBatchReference: string;
    readonly capturedMinor: bigint;
    readonly refundedMinor: bigint;
    readonly tipMinor: bigint;
    readonly lineReferences: readonly string[];
  }[];
}

/**
 * WP-2423 (v15 3cd0f8dd M4): every confirmed refund to date as the receipt states it. Refunds the
 * Payment owner split into items are stated item by item; what a round's payment returned beyond
 * them is that round's remaining items, tax and tip when the payment was returned in full, else an
 * amount. Null when the evidence does not add up exactly (the version then states the amount only).
 */
function statedRefunds(
  snapshot: DigitalReceiptSnapshot,
  refundedMinor: bigint,
  itemization: RefundReceiptItemization,
): readonly ReceiptRefund[] | null {
  const currencyCode = snapshot.total.currencyCode;
  const money = (amountMinor: bigint) => ({ amountMinor, currencyCode });
  const lines = new Map(snapshot.lines.map((line) => [line.lineReference, line] as const));
  const returned = new Map<string, { quantity: number; net: bigint; tax: bigint }>();
  const byRound = new Map<string, { total: bigint; tip: bigint }>();
  const refunds: ReceiptRefund[] = [];
  for (const refund of itemization.itemized) {
    const grouped = new Map<string, { quantity: number; net: bigint }>();
    let tax = 0n,
      tip = 0n,
      other = 0n;
    for (const payment of refund.payments)
      for (const item of payment.items) {
        const line = lines.get(item.orderItemReference);
        if (
          line === undefined ||
          !Number.isSafeInteger(item.quantity) ||
          item.quantity < 1 ||
          [item.netMinor, item.taxMinor, item.tipMinor, item.otherMinor].some((v) => v < 0n)
        )
          return null;
        const entry = grouped.get(item.orderItemReference) ?? { quantity: 0, net: 0n };
        grouped.set(item.orderItemReference, {
          quantity: entry.quantity + item.quantity,
          net: entry.net + item.netMinor,
        });
        const sold = returned.get(item.orderItemReference) ?? { quantity: 0, net: 0n, tax: 0n };
        returned.set(item.orderItemReference, {
          quantity: sold.quantity + item.quantity,
          net: sold.net + item.netMinor,
          tax: sold.tax + item.taxMinor,
        });
        const round = byRound.get(payment.orderBatchReference) ?? { total: 0n, tip: 0n };
        byRound.set(payment.orderBatchReference, {
          total: round.total + item.netMinor + item.taxMinor + item.tipMinor + item.otherMinor,
          tip: round.tip + item.tipMinor,
        });
        tax += item.taxMinor;
        tip += item.tipMinor;
        other += item.otherMinor;
      }
    const stated = [...grouped].map(([lineReference, entry]) => ({
      lineReference,
      displayName: lines.get(lineReference)?.displayName ?? "",
      quantity: entry.quantity,
      amount: money(entry.net),
    }));
    const total =
      stated.reduce((sum, line) => sum + line.amount.amountMinor, 0n) + tax + tip + other;
    if (total === 0n) continue;
    refunds.push({
      refundReference: refund.refundReference,
      kind: refund.kind,
      lines: stated,
      tax: money(tax),
      tip: money(tip),
      other: money(other),
      total: money(total),
    });
  }
  for (const round of itemization.rounds) {
    const itemized = byRound.get(round.orderBatchReference) ?? { total: 0n, tip: 0n };
    const residual = round.refundedMinor - itemized.total;
    if (residual < 0n) return null;
    if (residual === 0n) continue;
    let entry: ReceiptRefund | null = null;
    if (round.refundedMinor === round.capturedMinor) {
      // Returned in full: what was left of the round's items, their tax, and its tip.
      const remaining = [];
      let tax = 0n;
      for (const lineReference of round.lineReferences) {
        const line = lines.get(lineReference);
        if (line === undefined) return null;
        const before = line.lineSubtotal ?? line.lineTotal;
        const earlier = returned.get(lineReference) ?? { quantity: 0, net: 0n, tax: 0n };
        const quantity = line.quantity - earlier.quantity;
        const net = before.amountMinor - earlier.net;
        const lineTax = line.lineTotal.amountMinor - before.amountMinor - earlier.tax;
        if (quantity <= 0) continue;
        if (net < 0n || lineTax < 0n) return null;
        remaining.push({
          lineReference,
          displayName: line.displayName,
          quantity,
          amount: money(net),
        });
        tax += lineTax;
      }
      const tip = round.tipMinor - itemized.tip;
      const other =
        residual - remaining.reduce((sum, line) => sum + line.amount.amountMinor, 0n) - tax - tip;
      if (tip >= 0n && other >= 0n && (remaining.length > 0 || tip > 0n))
        entry = {
          refundReference: round.orderBatchReference,
          kind: "RoundRefund",
          lines: remaining,
          tax: money(tax),
          tip: money(tip),
          other: money(other),
          total: money(residual),
        };
    }
    refunds.push(
      entry ?? {
        refundReference: round.orderBatchReference,
        kind: "Other",
        lines: [],
        tax: money(0n),
        tip: money(0n),
        other: money(residual),
        total: money(residual),
      },
    );
  }
  if (refunds.reduce((sum, refund) => sum + refund.total.amountMinor, 0n) !== refundedMinor)
    return null;
  return refunds;
}

/** Trusted owner coverage only, never browser-submitted amounts. Preserve the
 * document's original commercial facts; the appended record carries its new time. */
export function createRefundReceiptSnapshot(
  previousValue: unknown,
  financial: RefundReceiptFinancialEvidence,
  itemization?: RefundReceiptItemization,
) {
  const previous = parseDigitalReceiptRecord(previousValue);
  const snapshot = previous.snapshot;
  const observedAt = parseOrderingInstant(financial.observedAt);
  if (
    previous.kind === "Void" ||
    observedAt < previous.recordedAt ||
    observedAt < snapshot.issuedAt ||
    financial.brandReference !== snapshot.brandReference ||
    financial.storeReference !== snapshot.storeReference ||
    financial.orderReference !== snapshot.orderReference
  )
    return fail();
  for (const amount of [financial.captured, financial.refunded, financial.pendingRefund]) {
    if (
      typeof amount.amountMinor !== "bigint" ||
      amount.amountMinor < 0n ||
      amount.amountMinor > 9223372036854775807n ||
      amount.currencyCode !== snapshot.total.currencyCode
    )
      return fail();
  }
  if (
    financial.captured.amountMinor !== snapshot.total.amountMinor ||
    financial.refunded.amountMinor < snapshot.refundedTotal.amountMinor ||
    financial.refunded.amountMinor + financial.pendingRefund.amountMinor >
      financial.captured.amountMinor
  )
    return fail();
  const paymentStatus =
    financial.pendingRefund.amountMinor > 0n
      ? "RefundPending"
      : financial.refunded.amountMinor === 0n
        ? "Paid"
        : financial.refunded.amountMinor === financial.captured.amountMinor
          ? "Refunded"
          : "PartiallyRefunded";
  if (
    snapshot.paymentStatus === paymentStatus &&
    snapshot.refundedTotal.amountMinor === financial.refunded.amountMinor
  )
    return null;
  // WP-2423 (v15 3cd0f8dd M4): the version states what each confirmed refund returned. Without
  // complete evidence it states the refunded amount only (never a guessed split).
  const facts: Omit<DigitalReceiptSnapshot, "refunds"> & { refunds?: unknown } = { ...snapshot };
  delete facts.refunds;
  const refunds =
    itemization === undefined || financial.refunded.amountMinor === 0n
      ? null
      : statedRefunds(snapshot, financial.refunded.amountMinor, itemization);
  return parseDigitalReceiptSnapshot({
    ...facts,
    paymentStatus,
    refundedTotal: {
      amountMinor: financial.refunded.amountMinor,
      currencyCode: financial.refunded.currencyCode,
    },
    ...(refunds === null ? {} : { refunds }),
  });
}
