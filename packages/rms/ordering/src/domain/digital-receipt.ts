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
  readonly lineTotal: ReceiptMoney;
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
  readonly lines: readonly ReceiptLineSnapshot[];
  readonly subtotal: ReceiptMoney;
  readonly tax: ReceiptMoney;
  readonly tip: ReceiptMoney;
  readonly total: ReceiptMoney;
  readonly paymentStatus: ReceiptPaymentStatus;
  readonly refundedTotal: ReceiptMoney;
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
      | "DIGITAL_RECEIPT_DEPENDENCY_UNAVAILABLE",
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
  if (typeof raw.amountMinor !== "bigint" || raw.amountMinor < 0n) return fail();
  if (typeof raw.currencyCode !== "string" || !currencyPattern.test(raw.currencyCode))
    return fail();
  return Object.freeze({ amountMinor: raw.amountMinor, currencyCode: raw.currencyCode });
}

function line(value: unknown): ReceiptLineSnapshot {
  const raw = exact(value, ["lineReference", "displayName", "quantity", "lineTotal"]);
  if (!Number.isSafeInteger(raw.quantity) || (raw.quantity as number) < 1) return fail();
  return Object.freeze({
    lineReference: reference(raw.lineReference),
    displayName: text(raw.displayName),
    quantity: raw.quantity as number,
    lineTotal: money(raw.lineTotal),
  });
}

export function parseDigitalReceiptSnapshot(value: unknown): DigitalReceiptSnapshot {
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
  const parsed = Object.freeze({
    receiptReference: reference(raw.receiptReference),
    orderReference: reference(raw.orderReference),
    guestSessionReference: reference(raw.guestSessionReference),
    operatingEntityReference: reference(raw.operatingEntityReference),
    operatingEntityDisplayName: text(raw.operatingEntityDisplayName),
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
  });
  const currency = parsed.total.currencyCode;
  if (
    [
      parsed.subtotal,
      parsed.tax,
      parsed.tip,
      parsed.refundedTotal,
      ...parsed.lines.map((item) => item.lineTotal),
    ].some((amount) => amount.currencyCode !== currency) ||
    parsed.subtotal.amountMinor + parsed.tax.amountMinor + parsed.tip.amountMinor !==
      parsed.total.amountMinor ||
    parsed.refundedTotal.amountMinor > parsed.total.amountMinor
  )
    return fail();
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
