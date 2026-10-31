import {
  parseOrderCreationRecord,
  parseConfiguredOrderCreationRecord,
  parseAdditionalDiningBatchSnapshot,
} from "@rms/ordering";
import { addMoney, createMoney, parseCurrencyCode, type Money } from "@rms/pricing";
import { exactPaymentObject, parsePaymentInstant } from "./payment-intent-creation.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import { parsePaymentTipSelection } from "./payment-tip-selection.js";

export interface PaymentPreparationAmounts {
  readonly orderAllocation: Money;
  readonly tip: Money;
  readonly total: Money;
}
export class PaymentPreparationAmountsError extends Error {
  readonly code = "PAYMENT_PREPARATION_AMOUNTS_INVALID";
  constructor() {
    super("payment preparation amounts are unavailable");
    this.name = "PaymentPreparationAmountsError";
  }
}
/** Monetary history only. Does not establish current capacity, Inventory or Payment authority. */
function deriveVersionedPaymentPreparationAmounts(
  value: unknown,
  quoteVersion: 1 | 2 | "Additional",
): PaymentPreparationAmounts {
  try {
    const raw = exactPaymentObject(value, [
      "order",
      "selection",
      "paymentOperationReference",
      "requestedAt",
    ]);
    const parsed =
      quoteVersion === "Additional"
        ? parseAdditionalDiningBatchSnapshot(raw.order)
        : quoteVersion === 2
          ? parseConfiguredOrderCreationRecord(raw.order)
          : parseOrderCreationRecord(raw.order);
    const history =
      "batch" in parsed
        ? {
            batch: parsed.batch,
            submissionReference: parsed.batch.submissionReference,
            guestSessionReference: parsed.guestSessionReference,
            brandReference: parsed.brandReference,
            storeReference: parsed.storeReference,
            submittedAt: parsed.batch.submittedAt,
            items: parsed.items,
          }
        : {
            batch: parsed.order.batches[0],
            submissionReference: parsed.submissionReference,
            guestSessionReference: parsed.guestSessionReference,
            brandReference: parsed.order.brandReference,
            storeReference: parsed.order.storeReference,
            submittedAt: parsed.createdAt,
            items: parsed.items,
          };
    const selection = parsePaymentTipSelection(raw.selection);
    const operation = parsePaymentReference(raw.paymentOperationReference);
    const requestedAt = parsePaymentInstant(raw.requestedAt);
    const batch = history.batch;
    if (
      selection.paymentOperationReference !== operation ||
      String(selection.submissionReference) !== String(history.submissionReference) ||
      String(selection.guestSessionReference) !== String(history.guestSessionReference) ||
      String(selection.brandReference) !== String(history.brandReference) ||
      String(selection.storeReference) !== String(history.storeReference) ||
      String(selection.cartReference) !== String(batch.sourceCartReference) ||
      selection.cartVersion !== batch.sourceCartVersion ||
      String(selection.quoteReference) !== String(batch.quoteReference) ||
      Date.parse(history.submittedAt) > Date.parse(requestedAt) ||
      selection.selectedAt > requestedAt
    )
      throw new Error();
    let orderAllocation = createMoney({ amountMinor: 0n, currencyCode: parseCurrencyCode("CAD") });
    for (const item of history.items) {
      const amount = createMoney({
        ...item.pricing.total,
        currencyCode: parseCurrencyCode(item.pricing.total.currencyCode),
      });
      if (amount.currencyCode !== "CAD" || amount.amountMinor < 0n) throw new Error();
      orderAllocation = addMoney(orderAllocation, amount);
    }
    const total = addMoney(orderAllocation, selection.tip);
    if (orderAllocation.amountMinor <= 0n || total.amountMinor > 9223372036854775807n)
      throw new Error();
    return Object.freeze({ orderAllocation, tip: selection.tip, total });
  } catch {
    throw new PaymentPreparationAmountsError();
  }
}

export function derivePaymentPreparationAmounts(value: unknown): PaymentPreparationAmounts {
  return deriveVersionedPaymentPreparationAmounts(value, 1);
}
export function deriveConfiguredPaymentPreparationAmounts(
  value: unknown,
): PaymentPreparationAmounts {
  return deriveVersionedPaymentPreparationAmounts(value, 2);
}

/** Payable amount for this additional submission only; does not include prior batches. */
export function deriveAdditionalPaymentPreparationAmounts(
  value: unknown,
): PaymentPreparationAmounts {
  try {
    const raw = exactPaymentObject(value, [
      "submission",
      "selection",
      "paymentOperationReference",
      "requestedAt",
    ]);
    return deriveVersionedPaymentPreparationAmounts(
      {
        order: raw.submission,
        selection: raw.selection,
        paymentOperationReference: raw.paymentOperationReference,
        requestedAt: raw.requestedAt,
      },
      "Additional",
    );
  } catch {
    throw new PaymentPreparationAmountsError();
  }
}

export interface PaymentReceiptAmounts {
  readonly subtotal: Money;
  readonly discount: Money;
  readonly tax: Money;
  readonly fee: Money;
  readonly tip: Money;
  readonly total: Money;
}

/** Frozen monetary history, never proof of capture, refund state, or permission to issue a receipt. */
export function derivePaymentReceiptAmounts(
  value: unknown,
  quoteVersion: 1 | 2,
): PaymentReceiptAmounts {
  try {
    if (quoteVersion !== 1 && quoteVersion !== 2) throw new Error();
    const raw = exactPaymentObject(value, [
      "order",
      "selection",
      "paymentOperationReference",
      "requestedAt",
    ]);
    const prepared = deriveVersionedPaymentPreparationAmounts(raw, quoteVersion);
    const order =
      quoteVersion === 2
        ? parseConfiguredOrderCreationRecord(raw.order)
        : parseOrderCreationRecord(raw.order);
    const sum = (field: "subtotal" | "discount" | "tax" | "fee") => {
      let result = createMoney({ amountMinor: 0n, currencyCode: parseCurrencyCode("CAD") });
      for (const item of order.items) {
        const amount = item.pricing[field];
        if (amount.currencyCode !== "CAD" || amount.amountMinor < 0n) throw new Error();
        result = addMoney(
          result,
          createMoney({ amountMinor: amount.amountMinor, currencyCode: parseCurrencyCode("CAD") }),
        );
        if (result.amountMinor > 9223372036854775807n) throw new Error();
      }
      return result;
    };
    const subtotal = sum("subtotal"),
      discount = sum("discount"),
      tax = sum("tax"),
      fee = sum("fee");
    if (
      discount.amountMinor > subtotal.amountMinor ||
      subtotal.amountMinor - discount.amountMinor + tax.amountMinor + fee.amountMinor !==
        prepared.orderAllocation.amountMinor
    )
      throw new Error();
    return Object.freeze({
      subtotal,
      discount,
      tax,
      fee,
      tip: prepared.tip,
      total: prepared.total,
    });
  } catch {
    throw new PaymentPreparationAmountsError();
  }
}
