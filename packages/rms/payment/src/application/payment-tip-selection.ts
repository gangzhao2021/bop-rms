import { createMoney, type Money } from "@rms/pricing";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import type { PaymentReference } from "../contracts/payment-provider-adapter.js";
import {
  exactPaymentObject,
  parsePaymentInstant,
  type PaymentInstant,
} from "./payment-intent-creation.js";

export interface PaymentTipSelection {
  readonly selectionReference: PaymentReference;
  readonly paymentOperationReference: PaymentReference;
  readonly submissionReference: PaymentReference;
  readonly cartReference: PaymentReference;
  readonly cartVersion: number;
  readonly quoteReference: PaymentReference;
  readonly guestSessionReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly tip: Money;
  readonly selectedAt: PaymentInstant;
}
export class PaymentTipSelectionError extends Error {
  constructor(
    readonly code: "PAYMENT_TIP_INVALID" | "PAYMENT_TIP_CONFLICT" | "PAYMENT_TIP_UNAVAILABLE",
  ) {
    super("payment tip selection is unavailable");
    this.name = "PaymentTipSelectionError";
  }
}
export function parsePaymentTipSelection(value: unknown): PaymentTipSelection {
  try {
    const raw = exactPaymentObject(value, [
      "selectionReference",
      "paymentOperationReference",
      "submissionReference",
      "cartReference",
      "cartVersion",
      "quoteReference",
      "guestSessionReference",
      "brandReference",
      "storeReference",
      "tip",
      "selectedAt",
    ]);
    const tip = createMoney(raw.tip as Money);
    if (
      tip.currencyCode !== "CAD" ||
      tip.amountMinor < 0n ||
      tip.amountMinor > 9223372036854775807n ||
      !Number.isSafeInteger(raw.cartVersion) ||
      (raw.cartVersion as number) < 1
    )
      throw new Error();
    return Object.freeze({
      selectionReference: parsePaymentReference(raw.selectionReference),
      paymentOperationReference: parsePaymentReference(raw.paymentOperationReference),
      submissionReference: parsePaymentReference(raw.submissionReference),
      cartReference: parsePaymentReference(raw.cartReference),
      cartVersion: raw.cartVersion as number,
      quoteReference: parsePaymentReference(raw.quoteReference),
      guestSessionReference: parsePaymentReference(raw.guestSessionReference),
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      tip,
      selectedAt: parsePaymentInstant(raw.selectedAt),
    });
  } catch {
    throw new PaymentTipSelectionError("PAYMENT_TIP_INVALID");
  }
}

/** Exact immutable selection equality, including the customer's original observation instant. */
export function samePaymentTipSelection(left: PaymentTipSelection, right: PaymentTipSelection) {
  const encode = (value: PaymentTipSelection) =>
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    );
  return encode(parsePaymentTipSelection(left)) === encode(parsePaymentTipSelection(right));
}
