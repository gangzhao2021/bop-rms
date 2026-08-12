import type { ReceiptRecordKind, ReceiptState, ReceiptView } from "./types.js";

export type ReceiptClientErrorCode =
  "permission_denied" | "not_found" | "feature_disabled" | "service_unavailable";

export class ReceiptClientError extends Error {
  constructor(readonly code: ReceiptClientErrorCode) {
    super(code);
    this.name = "ReceiptClientError";
  }
}

export interface CustomerReceiptClient {
  load(orderReference: string): Promise<unknown>;
}

export interface ReceiptController {
  getState(): ReceiptState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  setOnline(online: boolean): void;
}

const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const currency = /^[A-Z]{3}$/u;
const kinds = ["Original", "Correction", "Void", "Refund", "Reissue"] as const;
const payments = ["Paid", "RefundPending", "PartiallyRefunded", "Refunded"] as const;
const deliveries = [
  "NotRequested",
  "Unavailable",
  "Pending",
  "Sent",
  "Unknown",
  "Suppressed",
] as const;

function invalid(): never {
  throw new Error("invalid receipt");
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== fields.length ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable)
        return invalid();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch {
    return invalid();
  }
}

function record(value: unknown, expectedVersion: number) {
  const raw = exact(value, [
    "recordReference",
    "version",
    "kind",
    "recordedAt",
    "reasonCode",
    "snapshot",
  ]);
  if (
    !reference.test(String(raw.recordReference)) ||
    raw.version !== expectedVersion ||
    !kinds.includes(raw.kind as ReceiptRecordKind) ||
    typeof raw.recordedAt !== "string" ||
    Number.isNaN(Date.parse(raw.recordedAt)) ||
    !(raw.reasonCode === null || typeof raw.reasonCode === "string") ||
    !raw.snapshot ||
    typeof raw.snapshot !== "object"
  )
    return invalid();
  const snapshot = exact(raw.snapshot, [
    "receiptReference",
    "operatingEntityDisplayName",
    "storeDisplayName",
    "orderNumber",
    "issuedAt",
    "locale",
    "lines",
    "subtotal",
    "tax",
    "tip",
    "total",
    "paymentStatus",
    "refundedTotal",
  ]);
  const amount = (candidate: unknown) => {
    const money = exact(candidate, ["amountMinor", "currencyCode"]);
    if (
      typeof money.amountMinor !== "string" ||
      !/^[0-9]{1,18}$/u.test(money.amountMinor) ||
      !currency.test(String(money.currencyCode))
    )
      return invalid();
    return Object.freeze({
      amountMinor: BigInt(money.amountMinor),
      currencyCode: String(money.currencyCode),
    });
  };
  if (
    !reference.test(String(snapshot.receiptReference)) ||
    typeof snapshot.operatingEntityDisplayName !== "string" ||
    snapshot.operatingEntityDisplayName.length < 1 ||
    snapshot.operatingEntityDisplayName.length > 160 ||
    typeof snapshot.storeDisplayName !== "string" ||
    snapshot.storeDisplayName.length < 1 ||
    snapshot.storeDisplayName.length > 160 ||
    typeof snapshot.orderNumber !== "string" ||
    snapshot.orderNumber.length < 1 ||
    snapshot.orderNumber.length > 64 ||
    typeof snapshot.issuedAt !== "string" ||
    Number.isNaN(Date.parse(snapshot.issuedAt)) ||
    typeof snapshot.locale !== "string" ||
    !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(snapshot.locale) ||
    !Array.isArray(snapshot.lines) ||
    snapshot.lines.length < 1 ||
    snapshot.lines.length > 200 ||
    !payments.includes(snapshot.paymentStatus as (typeof payments)[number])
  )
    return invalid();
  const lines = snapshot.lines.map((candidate) => {
    const line = exact(candidate, ["lineReference", "displayName", "quantity", "lineTotal"]);
    if (
      !reference.test(String(line.lineReference)) ||
      typeof line.displayName !== "string" ||
      line.displayName.length < 1 ||
      line.displayName.length > 160 ||
      !Number.isSafeInteger(line.quantity) ||
      (line.quantity as number) < 1 ||
      (line.quantity as number) > 999
    )
      return invalid();
    return Object.freeze({
      lineReference: String(line.lineReference),
      displayName: line.displayName,
      quantity: line.quantity as number,
      lineTotal: amount(line.lineTotal),
    });
  });
  return Object.freeze({
    recordReference: String(raw.recordReference),
    version: expectedVersion,
    kind: raw.kind as ReceiptRecordKind,
    recordedAt: raw.recordedAt,
    reasonCode: raw.reasonCode as string | null,
    snapshot: Object.freeze({
      receiptReference: String(snapshot.receiptReference),
      operatingEntityDisplayName: snapshot.operatingEntityDisplayName,
      storeDisplayName: snapshot.storeDisplayName,
      orderNumber: snapshot.orderNumber,
      issuedAt: snapshot.issuedAt,
      locale: snapshot.locale,
      lines: Object.freeze(lines),
      subtotal: amount(snapshot.subtotal),
      tax: amount(snapshot.tax),
      tip: amount(snapshot.tip),
      total: amount(snapshot.total),
      paymentStatus: snapshot.paymentStatus as (typeof payments)[number],
      refundedTotal: amount(snapshot.refundedTotal),
    }),
  });
}

export function parseReceiptView(value: unknown, expectedReference: string): ReceiptView {
  const raw = exact(value, [
    "orderReference",
    "freshnessStatus",
    "deliveryStatus",
    "supportEligible",
    "cancellationEligible",
    "records",
  ]);
  if (
    raw.orderReference !== expectedReference ||
    !["Fresh", "Stale"].includes(String(raw.freshnessStatus)) ||
    !deliveries.includes(raw.deliveryStatus as (typeof deliveries)[number]) ||
    typeof raw.supportEligible !== "boolean" ||
    typeof raw.cancellationEligible !== "boolean" ||
    !Array.isArray(raw.records) ||
    raw.records.length < 1
  )
    return invalid();
  return Object.freeze({
    orderReference: expectedReference,
    freshnessStatus: raw.freshnessStatus as "Fresh" | "Stale",
    deliveryStatus: raw.deliveryStatus as ReceiptView["deliveryStatus"],
    supportEligible: raw.supportEligible,
    cancellationEligible: raw.cancellationEligible,
    records: Object.freeze(raw.records.map((item, index) => record(item, index + 1))),
  });
}

export function createUnavailableReceiptClient(): CustomerReceiptClient {
  return Object.freeze({
    async load() {
      throw new ReceiptClientError("service_unavailable");
    },
  });
}

export function createReceiptController(
  orderReference: string,
  client: CustomerReceiptClient,
): ReceiptController {
  let online = typeof navigator === "undefined" || navigator.onLine !== false;
  let accepted: ReceiptView | null = null;
  let state: ReceiptState = reference.test(orderReference)
    ? online
      ? { status: "loading" }
      : { status: "offline", view: null }
    : { status: "invalid-reference" };
  const listeners = new Set<() => void>();
  const publish = (next: ReceiptState) => {
    state = Object.freeze(next);
    listeners.forEach((listener) => listener());
  };
  return Object.freeze({
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async load() {
      if (!reference.test(orderReference) || !online) return;
      publish({ status: "loading" });
      try {
        accepted = parseReceiptView(await client.load(orderReference), orderReference);
        publish({ status: "ready", view: accepted });
      } catch (error) {
        if (error instanceof ReceiptClientError) {
          const mapped =
            error.code === "service_unavailable" ? "unavailable" : error.code.replaceAll("_", "-");
          publish({
            status: mapped as
              "permission-denied" | "not-found" | "feature-disabled" | "unavailable",
          });
        } else publish({ status: "unavailable" });
      }
    },
    setOnline(next: boolean) {
      online = next;
      if (!online) publish({ status: "offline", view: accepted });
      else if (state.status === "offline")
        publish(accepted ? { status: "ready", view: accepted } : { status: "unavailable" });
    },
  });
}
