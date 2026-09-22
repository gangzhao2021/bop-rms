import {
  DigitalReceiptError,
  parseDigitalReceiptRecord,
  parseDigitalReceiptSnapshot,
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

/** Trusted owner coverage only, never browser-submitted amounts. Preserve the
 * document's original commercial facts; the appended record carries its new time. */
export function createRefundReceiptSnapshot(
  previousValue: unknown,
  financial: RefundReceiptFinancialEvidence,
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
  return parseDigitalReceiptSnapshot({
    ...snapshot,
    paymentStatus,
    refundedTotal: {
      amountMinor: financial.refunded.amountMinor,
      currencyCode: financial.refunded.currencyCode,
    },
  });
}
