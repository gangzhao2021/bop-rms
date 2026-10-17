import { parseOrderingInstant, parseOrderingReference } from "./cart.js";

export type ReceiptRecordKind = "Original" | "Correction" | "Void" | "Refund" | "Reissue";
export type ReceiptPaymentStatus = "Paid" | "RefundPending" | "PartiallyRefunded" | "Refunded";

export interface ReceiptMoney {
  readonly amountMinor: bigint;
  readonly currencyCode: string;
}

export interface ReceiptLineSnapshot {
  readonly lineReference: string;
  readonly displayName: string;
  readonly quantity: number;
  /**
   * The Order item's frozen total: its price after discount, plus its fee and tax. Kept as issued
   * on every version; it is not the amount a receipt prints beside the item.
   */
  readonly lineTotal: ReceiptMoney;
  /**
   * WP-2423 D5: the item's price before discount, fees and tax (unit price × quantity), the amount
   * a Canadian receipt prints beside the item. Lines of one version either all carry it and add up
   * to `subtotal`, or none do (versions issued before D5 are never rewritten).
   */
  readonly lineSubtotal?: ReceiptMoney;
  /**
   * WP-2423 (receipt option lines): the options the guest chose for this item, each with what it
   * added for the whole line, frozen from the Order item at issue. Present only on lines issued
   * since it was recorded that have options, always together with `lineSubtotal`, which already
   * includes them: the item's own price is `lineSubtotal` less these amounts. Lines issued before it
   * (or without options) do not carry it and print as issued.
   */
  readonly options?: readonly ReceiptLineOption[];
}

/** WP-2423: one chosen option printed under its item ("Whipped cream", "Extra shot × 2"). */
export interface ReceiptLineOption {
  readonly displayName: string;
  /** How many of this option were chosen for each item. */
  readonly quantity: number;
  /** What the option added for the whole line; zero for a free option. */
  readonly amount: ReceiptMoney;
}

/** WP-2423 Q15: the Store address printed on the receipt (its published address at issue). */
export interface ReceiptBusinessAddress {
  readonly addressLines: readonly string[];
  readonly locality: string;
  readonly regionCode: string;
  readonly postalCode: string;
  readonly countryCode: string;
}

/** WP-2423 Q15: a sales-tax registration the Store's Owner entered ("GST/HST", "QST", "PST"). */
export interface ReceiptTaxRegistration {
  readonly label: "GST/HST" | "QST" | "PST";
  readonly number: string;
}

/** WP-2423 Q15: one tax type and rate on its own line, summed from the order's tax snapshot. */
export interface ReceiptTaxLine {
  readonly label: string;
  /** Percent as a plain decimal ("13", "9.975"), from the frozen rate; never recomputed. */
  readonly ratePercent: string;
  /** The tax was included in item prices rather than added to them. */
  readonly included: boolean;
  readonly amount: ReceiptMoney;
}

/**
 * WP-2423 Q15 (DEC-RECEIPT-TAX-AND-PRIVACY): the tax-receipt facts frozen at issue. Absent on
 * receipts issued before Q15 (they are never rewritten). `businessAddress` is null when the Store
 * had no published address; `taxRegistrations` is empty when the Owner had entered none.
 */
export interface ReceiptTaxDetails {
  readonly businessAddress: ReceiptBusinessAddress | null;
  readonly taxRegistrations: readonly ReceiptTaxRegistration[];
  readonly taxLines: readonly ReceiptTaxLine[];
  /** How the order was paid: every digital receipt covers online card payments. */
  readonly paymentMethod: "Card";
}

/**
 * WP-2423 (v15 3cd0f8dd M4): one item a confirmed refund returned (price before tax, and how many
 * of the receipt line). `lineReference` is a line of the same receipt version.
 */
export interface ReceiptRefundLine {
  readonly lineReference: string;
  readonly displayName: string;
  readonly quantity: number;
  readonly amount: ReceiptMoney;
}

/**
 * WP-2423 (v15 3cd0f8dd M4): what one confirmed refund returned, so a refund version states it:
 * - "Refund": a refund staff made at the customer's request (items, their tax, any tip share);
 * - "ItemCancellation": items the Store cancelled after payment (their price, tax and the share of
 *   the tip the refund returned — DEC-TIP-REFUND-PROPORTIONAL);
 * - "RoundRefund": a whole paid round (or order) returned in full (what was left of its items,
 *   their tax and its tip);
 * - "Other": an amount refunded on a payment that its owner did not split into items.
 * `total` is `lines` + `tax` + `tip` + `other`; `refundReference` is internal, never shown.
 */
export interface ReceiptRefund {
  readonly refundReference: string;
  readonly kind: "Refund" | "ItemCancellation" | "RoundRefund" | "Other";
  readonly lines: readonly ReceiptRefundLine[];
  readonly tax: ReceiptMoney;
  readonly tip: ReceiptMoney;
  readonly other: ReceiptMoney;
  readonly total: ReceiptMoney;
}

export interface DigitalReceiptSnapshot {
  readonly receiptReference: string;
  readonly orderReference: string;
  readonly guestSessionReference: string;
  readonly operatingEntityReference: string;
  readonly operatingEntityDisplayName: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly storeDisplayName: string;
  readonly orderNumber: string;
  readonly issuedAt: string;
  readonly locale: string;
  readonly templateVersion: string;
  /**
   * WP-2423: the exact published receipt template version this receipt was issued with (internal
   * reference, never shown to customers). Absent on receipts issued before it was recorded.
   */
  readonly templateVersionReference?: string;
  readonly lines: readonly ReceiptLineSnapshot[];
  readonly subtotal: ReceiptMoney;
  readonly adjustments?: { readonly discount: ReceiptMoney; readonly fee: ReceiptMoney };
  readonly tax: ReceiptMoney;
  readonly taxDetails?: ReceiptTaxDetails;
  readonly tip: ReceiptMoney;
  readonly total: ReceiptMoney;
  readonly paymentStatus: ReceiptPaymentStatus;
  readonly refundedTotal: ReceiptMoney;
  /**
   * WP-2423 (v15 3cd0f8dd M4): every confirmed refund to date and what it returned; their totals add
   * up to `refundedTotal`. Absent on versions issued before it was recorded (printed as issued).
   */
  readonly refunds?: readonly ReceiptRefund[];
}

export interface DigitalReceiptRecord {
  readonly recordReference: string;
  readonly version: number;
  readonly kind: ReceiptRecordKind;
  readonly recordedAt: string;
  readonly previousRecordReference: string | null;
  readonly reasonCode: string | null;
  readonly snapshot: DigitalReceiptSnapshot;
}

export interface DigitalReceiptChain {
  readonly orderReference: string;
  readonly records: readonly DigitalReceiptRecord[];
}

const kinds = ["Original", "Correction", "Void", "Refund", "Reissue"] as const;
const paymentStatuses = ["Paid", "RefundPending", "PartiallyRefunded", "Refunded"] as const;
const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const currencyPattern = /^[A-Z]{3}$/u;
const localePattern = /^[a-z]{2,3}(?:-[A-Z]{2})?$/u;

export class DigitalReceiptError extends Error {
  constructor(
    readonly code:
      | "DIGITAL_RECEIPT_INPUT_INVALID"
      | "DIGITAL_RECEIPT_CHAIN_CONFLICT"
      | "DIGITAL_RECEIPT_PERMISSION_DENIED"
      | "DIGITAL_RECEIPT_NOT_FOUND"
      | "DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE"
      /** WP-2423: the Store's published receipt template cannot be proven; nothing is issued. */
      | "DIGITAL_RECEIPT_TEMPLATE_UNAVAILABLE",
  ) {
    super(code);
    this.name = "DigitalReceiptError";
  }
}

function fail(code: DigitalReceiptError["code"] = "DIGITAL_RECEIPT_INPUT_INVALID"): never {
  throw new DigitalReceiptError(code);
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== fields.length
    )
      return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) return fail();
      result[field] = descriptor.value;
    }
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key)))
      return fail();
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof DigitalReceiptError) throw error;
    return fail();
  }
}

function text(value: unknown, maximum = 160): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.trim() !== value
  )
    return fail();
  return value;
}

function reference(value: unknown): string {
  try {
    return parseOrderingReference(value);
  } catch {
    return fail();
  }
}

function instant(value: unknown): string {
  try {
    return parseOrderingInstant(value);
  } catch {
    return fail();
  }
}

function money(value: unknown): ReceiptMoney {
  const raw = exact(value, ["amountMinor", "currencyCode"]);
  if (
    typeof raw.amountMinor !== "bigint" ||
    raw.amountMinor < 0n ||
    raw.amountMinor > 9223372036854775807n
  )
    return fail();
  if (typeof raw.currencyCode !== "string" || !currencyPattern.test(raw.currencyCode))
    return fail();
  return Object.freeze({ amountMinor: raw.amountMinor, currencyCode: raw.currencyCode });
}

function lineOption(value: unknown): ReceiptLineOption {
  const raw = exact(value, ["displayName", "quantity", "amount"]);
  if (
    !Number.isSafeInteger(raw.quantity) ||
    (raw.quantity as number) < 1 ||
    (raw.quantity as number) > 999
  )
    return fail();
  return Object.freeze({
    displayName: text(raw.displayName),
    quantity: raw.quantity as number,
    amount: money(raw.amount),
  });
}

function line(value: unknown): ReceiptLineSnapshot {
  const has = (key: string) =>
    value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
  const hasSubtotal = has("lineSubtotal");
  const hasOptions = has("options");
  const raw = exact(value, [
    "lineReference",
    "displayName",
    "quantity",
    "lineTotal",
    ...(hasSubtotal ? ["lineSubtotal"] : []),
    ...(hasOptions ? ["options"] : []),
  ]);
  if (!Number.isSafeInteger(raw.quantity) || (raw.quantity as number) < 1) return fail();
  // WP-2423: option lines are recorded only beside the item's pre-tax price, which includes them.
  if (
    hasOptions &&
    (!hasSubtotal ||
      !Array.isArray(raw.options) ||
      raw.options.length < 1 ||
      raw.options.length > 100)
  )
    return fail();
  const lineSubtotal = hasSubtotal ? money(raw.lineSubtotal) : null;
  const options = hasOptions ? Object.freeze((raw.options as unknown[]).map(lineOption)) : null;
  if (
    options !== null &&
    lineSubtotal !== null &&
    (options.some((option) => option.amount.currencyCode !== lineSubtotal.currencyCode) ||
      options.reduce((sum, option) => sum + option.amount.amountMinor, 0n) >
        lineSubtotal.amountMinor)
  )
    return fail();
  return Object.freeze({
    lineReference: reference(raw.lineReference),
    displayName: text(raw.displayName),
    quantity: raw.quantity as number,
    lineTotal: money(raw.lineTotal),
    ...(lineSubtotal === null ? {} : { lineSubtotal }),
    ...(options === null ? {} : { options }),
  });
}

const registrationLabels = ["GST/HST", "QST", "PST"] as const;
const registrationPatterns: Readonly<Record<ReceiptTaxRegistration["label"], RegExp>> = {
  "GST/HST": /^[0-9]{9}RT[0-9]{4}$/u,
  QST: /^[0-9]{10}TQ[0-9]{4}$/u,
  PST: /^[A-Z0-9][A-Z0-9 -]{2,30}[A-Z0-9]$/u,
};
const ratePercentPattern = /^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{0,9}[1-9])?$/u;

function businessAddress(value: unknown): ReceiptBusinessAddress | null {
  if (value === null) return null;
  const raw = exact(value, ["addressLines", "locality", "regionCode", "postalCode", "countryCode"]);
  if (
    !Array.isArray(raw.addressLines) ||
    raw.addressLines.length < 1 ||
    raw.addressLines.length > 3
  )
    return fail();
  return Object.freeze({
    addressLines: Object.freeze(raw.addressLines.map((item: unknown) => text(item, 160))),
    locality: text(raw.locality, 120),
    regionCode: text(raw.regionCode, 16),
    postalCode: text(raw.postalCode, 16),
    countryCode:
      typeof raw.countryCode === "string" && /^[A-Z]{2}$/u.test(raw.countryCode)
        ? raw.countryCode
        : fail(),
  });
}

function taxDetails(value: unknown): ReceiptTaxDetails {
  const raw = exact(value, ["businessAddress", "taxRegistrations", "taxLines", "paymentMethod"]);
  if (
    !Array.isArray(raw.taxRegistrations) ||
    raw.taxRegistrations.length > 3 ||
    !Array.isArray(raw.taxLines) ||
    raw.taxLines.length > 20 ||
    raw.paymentMethod !== "Card"
  )
    return fail();
  const taxRegistrations = raw.taxRegistrations.map((item: unknown) => {
    const entry = exact(item, ["label", "number"]);
    const label = entry.label as ReceiptTaxRegistration["label"];
    if (
      !registrationLabels.includes(label) ||
      typeof entry.number !== "string" ||
      !registrationPatterns[label].test(entry.number)
    )
      return fail();
    return Object.freeze({ label, number: entry.number });
  });
  if (new Set(taxRegistrations.map((item) => item.label)).size !== taxRegistrations.length)
    return fail();
  const taxLines = raw.taxLines.map((item: unknown) => {
    const entry = exact(item, ["label", "ratePercent", "included", "amount"]);
    if (
      typeof entry.ratePercent !== "string" ||
      !ratePercentPattern.test(entry.ratePercent) ||
      typeof entry.included !== "boolean"
    )
      return fail();
    return Object.freeze({
      label: text(entry.label, 64),
      ratePercent: entry.ratePercent,
      included: entry.included,
      amount: money(entry.amount),
    });
  });
  return Object.freeze({
    businessAddress: businessAddress(raw.businessAddress),
    taxRegistrations: Object.freeze(taxRegistrations),
    taxLines: Object.freeze(taxLines),
    paymentMethod: "Card" as const,
  });
}

const refundKinds = ["Refund", "ItemCancellation", "RoundRefund", "Other"] as const;

function refundEntry(value: unknown): ReceiptRefund {
  const raw = exact(value, ["refundReference", "kind", "lines", "tax", "tip", "other", "total"]);
  if (
    typeof raw.kind !== "string" ||
    !refundKinds.includes(raw.kind as ReceiptRefund["kind"]) ||
    !Array.isArray(raw.lines) ||
    raw.lines.length > 200
  )
    return fail();
  const lines = raw.lines.map((item: unknown) => {
    const entry = exact(item, ["lineReference", "displayName", "quantity", "amount"]);
    if (
      !Number.isSafeInteger(entry.quantity) ||
      (entry.quantity as number) < 1 ||
      (entry.quantity as number) > 999
    )
      return fail();
    return Object.freeze({
      lineReference: reference(entry.lineReference),
      displayName: text(entry.displayName),
      quantity: entry.quantity as number,
      amount: money(entry.amount),
    });
  });
  const parsed = Object.freeze({
    refundReference: reference(raw.refundReference),
    kind: raw.kind as ReceiptRefund["kind"],
    lines: Object.freeze(lines),
    tax: money(raw.tax),
    tip: money(raw.tip),
    other: money(raw.other),
    total: money(raw.total),
  });
  if (
    parsed.lines.reduce((sum, item) => sum + item.amount.amountMinor, 0n) +
      parsed.tax.amountMinor +
      parsed.tip.amountMinor +
      parsed.other.amountMinor !==
      parsed.total.amountMinor ||
    parsed.total.amountMinor === 0n ||
    (parsed.kind !== "Other" && parsed.lines.length === 0 && parsed.tip.amountMinor === 0n)
  )
    return fail();
  return parsed;
}

export function parseDigitalReceiptSnapshot(value: unknown): DigitalReceiptSnapshot {
  const has = (key: string) =>
    value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
  const hasAdjustments = has("adjustments");
  const hasTaxDetails = has("taxDetails");
  const hasTemplateVersionReference = has("templateVersionReference");
  const hasRefunds = has("refunds");
  const raw = exact(value, [
    "receiptReference",
    "orderReference",
    "guestSessionReference",
    "operatingEntityReference",
    "operatingEntityDisplayName",
    "brandReference",
    "storeReference",
    "storeDisplayName",
    "orderNumber",
    "issuedAt",
    "locale",
    "templateVersion",
    "lines",
    "subtotal",
    "tax",
    "tip",
    "total",
    "paymentStatus",
    "refundedTotal",
    ...(hasAdjustments ? ["adjustments"] : []),
    ...(hasTaxDetails ? ["taxDetails"] : []),
    ...(hasTemplateVersionReference ? ["templateVersionReference"] : []),
    ...(hasRefunds ? ["refunds"] : []),
  ]);
  if (!Array.isArray(raw.lines) || raw.lines.length < 1 || raw.lines.length > 200) return fail();
  if (typeof raw.locale !== "string" || !localePattern.test(raw.locale)) return fail();
  if (typeof raw.templateVersion !== "string" || !codePattern.test(raw.templateVersion))
    return fail();
  if (
    typeof raw.paymentStatus !== "string" ||
    !paymentStatuses.includes(raw.paymentStatus as ReceiptPaymentStatus)
  )
    return fail();
  const adjustments = hasAdjustments ? exact(raw.adjustments, ["discount", "fee"]) : null;
  const parsedTaxDetails = hasTaxDetails ? taxDetails(raw.taxDetails) : null;
  if (hasRefunds && (!Array.isArray(raw.refunds) || raw.refunds.length > 200)) return fail();
  const refunds = hasRefunds ? Object.freeze((raw.refunds as unknown[]).map(refundEntry)) : null;
  const parsed = Object.freeze({
    ...(parsedTaxDetails === null ? {} : { taxDetails: parsedTaxDetails }),
    ...(hasTemplateVersionReference
      ? { templateVersionReference: reference(raw.templateVersionReference) }
      : {}),
    ...(adjustments === null
      ? {}
      : {
          adjustments: Object.freeze({
            discount: money(adjustments.discount),
            fee: money(adjustments.fee),
          }),
        }),
    receiptReference: reference(raw.receiptReference),
    orderReference: reference(raw.orderReference),
    guestSessionReference: reference(raw.guestSessionReference),
    operatingEntityReference: reference(raw.operatingEntityReference),
    operatingEntityDisplayName: text(raw.operatingEntityDisplayName, 200),
    brandReference: reference(raw.brandReference),
    storeReference: reference(raw.storeReference),
    storeDisplayName: text(raw.storeDisplayName),
    orderNumber: text(raw.orderNumber, 64),
    issuedAt: instant(raw.issuedAt),
    locale: raw.locale,
    templateVersion: raw.templateVersion,
    lines: Object.freeze(raw.lines.map(line)),
    subtotal: money(raw.subtotal),
    tax: money(raw.tax),
    tip: money(raw.tip),
    total: money(raw.total),
    paymentStatus: raw.paymentStatus as ReceiptPaymentStatus,
    refundedTotal: money(raw.refundedTotal),
    ...(refunds === null ? {} : { refunds }),
  });
  const currency = parsed.total.currencyCode;
  if (
    [
      parsed.subtotal,
      parsed.tax,
      parsed.tip,
      parsed.refundedTotal,
      ...(parsed.adjustments ? [parsed.adjustments.discount, parsed.adjustments.fee] : []),
      ...parsed.lines.map((item) => item.lineTotal),
      ...parsed.lines.flatMap((item) => (item.lineSubtotal ? [item.lineSubtotal] : [])),
      ...(parsed.taxDetails?.taxLines.map((item) => item.amount) ?? []),
      ...(parsed.refunds ?? []).flatMap((refund) => [
        refund.tax,
        refund.tip,
        refund.other,
        refund.total,
        ...refund.lines.map((item) => item.amount),
      ]),
    ].some((amount) => amount.currencyCode !== currency) ||
    (parsed.taxDetails !== undefined &&
      parsed.taxDetails.taxLines.reduce((sum, item) => sum + item.amount.amountMinor, 0n) !==
        parsed.tax.amountMinor) ||
    (parsed.adjustments?.discount.amountMinor ?? 0n) > parsed.subtotal.amountMinor ||
    parsed.subtotal.amountMinor -
      (parsed.adjustments?.discount.amountMinor ?? 0n) +
      parsed.tax.amountMinor +
      (parsed.adjustments?.fee.amountMinor ?? 0n) +
      parsed.tip.amountMinor !==
      parsed.total.amountMinor ||
    parsed.refundedTotal.amountMinor > parsed.total.amountMinor
  )
    return fail();
  // WP-2423 D5: item prices are all present or all absent, and add up to the printed subtotal.
  const priced = parsed.lines.filter((item) => item.lineSubtotal !== undefined);
  if (
    priced.length > 0 &&
    (priced.length !== parsed.lines.length ||
      priced.reduce((sum, item) => sum + (item.lineSubtotal?.amountMinor ?? 0n), 0n) !==
        parsed.subtotal.amountMinor)
  )
    return fail();
  // WP-2423 (v15 3cd0f8dd M4): the refunds stated add up to what was refunded, each once, and only
  // return items of this receipt, never more of one than it lists.
  if (parsed.refunds !== undefined) {
    const returned = new Map<string, number>();
    for (const refund of parsed.refunds)
      for (const item of refund.lines)
        returned.set(item.lineReference, (returned.get(item.lineReference) ?? 0) + item.quantity);
    if (
      parsed.refunds.reduce((sum, refund) => sum + refund.total.amountMinor, 0n) !==
        parsed.refundedTotal.amountMinor ||
      new Set(parsed.refunds.map((refund) => refund.refundReference)).size !==
        parsed.refunds.length ||
      [...returned].some(([lineReference, quantity]) => {
        const sold = parsed.lines.find((item) => item.lineReference === lineReference);
        return sold === undefined || quantity > sold.quantity;
      })
    )
      return fail();
  }
  return parsed;
}

export function parseDigitalReceiptRecord(value: unknown): DigitalReceiptRecord {
  const raw = exact(value, [
    "recordReference",
    "version",
    "kind",
    "recordedAt",
    "previousRecordReference",
    "reasonCode",
    "snapshot",
  ]);
  if (!Number.isSafeInteger(raw.version) || (raw.version as number) < 1) return fail();
  if (typeof raw.kind !== "string" || !kinds.includes(raw.kind as ReceiptRecordKind)) return fail();
  if (raw.previousRecordReference !== null && typeof raw.previousRecordReference !== "string")
    return fail();
  if (
    raw.reasonCode !== null &&
    (typeof raw.reasonCode !== "string" || !codePattern.test(raw.reasonCode))
  )
    return fail();
  return Object.freeze({
    recordReference: reference(raw.recordReference),
    version: raw.version as number,
    kind: raw.kind as ReceiptRecordKind,
    recordedAt: instant(raw.recordedAt),
    previousRecordReference:
      raw.previousRecordReference === null ? null : reference(raw.previousRecordReference),
    reasonCode: raw.reasonCode as string | null,
    snapshot: parseDigitalReceiptSnapshot(raw.snapshot),
  });
}

function sameSnapshot(left: DigitalReceiptSnapshot, right: DigitalReceiptSnapshot): boolean {
  return (
    JSON.stringify(left, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ) ===
    JSON.stringify(right, (_key, value) => (typeof value === "bigint" ? value.toString() : value))
  );
}

export function parseDigitalReceiptChain(value: unknown): DigitalReceiptChain {
  const raw = exact(value, ["orderReference", "records"]);
  const orderReference = reference(raw.orderReference);
  if (!Array.isArray(raw.records) || raw.records.length < 1 || raw.records.length > 100)
    return fail();
  const records = Object.freeze(raw.records.map(parseDigitalReceiptRecord));
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const previous = records[index - 1];
    if (
      !record ||
      record.version !== index + 1 ||
      record.snapshot.orderReference !== orderReference ||
      (index === 0
        ? record.kind !== "Original" ||
          record.previousRecordReference !== null ||
          record.reasonCode !== null
        : !previous ||
          record.kind === "Original" ||
          record.previousRecordReference !== previous.recordReference ||
          record.reasonCode === null ||
          record.snapshot.receiptReference !== records[0]?.snapshot.receiptReference ||
          record.snapshot.orderReference !== records[0]?.snapshot.orderReference ||
          record.snapshot.guestSessionReference !== records[0]?.snapshot.guestSessionReference ||
          record.snapshot.operatingEntityReference !==
            records[0]?.snapshot.operatingEntityReference ||
          record.snapshot.brandReference !== records[0]?.snapshot.brandReference ||
          record.snapshot.storeReference !== records[0]?.snapshot.storeReference ||
          (record.kind === "Reissue" && !sameSnapshot(record.snapshot, previous.snapshot)))
    )
      return fail("DIGITAL_RECEIPT_CHAIN_CONFLICT");
  }
  return Object.freeze({ orderReference, records });
}
