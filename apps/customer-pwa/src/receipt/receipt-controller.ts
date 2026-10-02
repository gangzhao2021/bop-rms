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
  subscribeContextChange?(listener: () => void): () => void;
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
    ...(Object.hasOwn(raw.snapshot, "adjustments") ? ["adjustments"] : []),
  ]);
  const amount = (candidate: unknown) => {
    const money = exact(candidate, ["amountMinor", "currencyCode"]);
    if (
      typeof money.amountMinor !== "string" ||
      !/^(0|[1-9][0-9]{0,18})$/u.test(money.amountMinor) ||
      !currency.test(String(money.currencyCode))
    )
      return invalid();
    if (BigInt(money.amountMinor) > 9223372036854775807n) return invalid();
    return Object.freeze({
      amountMinor: BigInt(money.amountMinor),
      currencyCode: String(money.currencyCode),
    });
  };
  if (
    !reference.test(String(snapshot.receiptReference)) ||
    typeof snapshot.operatingEntityDisplayName !== "string" ||
    snapshot.operatingEntityDisplayName.length < 1 ||
    snapshot.operatingEntityDisplayName.length > 200 ||
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
  const subtotal = amount(snapshot.subtotal);
  const tax = amount(snapshot.tax);
  const tip = amount(snapshot.tip);
  const total = amount(snapshot.total);
  const refundedTotal = amount(snapshot.refundedTotal);
  const adjustmentRaw = Object.hasOwn(snapshot, "adjustments")
    ? exact(snapshot.adjustments, ["discount", "fee"])
    : undefined;
  const adjustments = adjustmentRaw
    ? Object.freeze({
        discount: amount(adjustmentRaw.discount),
        fee: amount(adjustmentRaw.fee),
      })
    : undefined;
  const amounts = [
    subtotal,
    tax,
    tip,
    total,
    refundedTotal,
    ...lines.map((line) => line.lineTotal),
    ...(adjustments ? [adjustments.discount, adjustments.fee] : []),
  ];
  if (
    amounts.some((entry) => entry.currencyCode !== total.currencyCode) ||
    (adjustments && adjustments.discount.amountMinor > subtotal.amountMinor) ||
    subtotal.amountMinor -
      (adjustments?.discount.amountMinor ?? 0n) +
      tax.amountMinor +
      (adjustments?.fee.amountMinor ?? 0n) +
      tip.amountMinor !==
      total.amountMinor
  )
    return invalid();
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
      subtotal,
      tax,
      tip,
      total,
      ...(adjustments ? { adjustments } : {}),
      paymentStatus: snapshot.paymentStatus as (typeof payments)[number],
      refundedTotal,
    }),
  });
}

function financial(value: unknown) {
  if (value === null) return null;
  const raw = exact(value, [
    "observedAt",
    "currencyCode",
    "capturedMinor",
    "confirmedRefundMinor",
    "pendingRefundMinor",
    "unresolvedAttemptCount",
  ]);
  const amount = (v: unknown) => {
    if (
      typeof v !== "string" ||
      !/^(0|[1-9][0-9]{0,18})$/u.test(v) ||
      BigInt(v) > 9223372036854775807n
    )
      return invalid();
    return BigInt(v);
  };
  const capturedMinor = amount(raw.capturedMinor),
    confirmedRefundMinor = amount(raw.confirmedRefundMinor),
    pendingRefundMinor = amount(raw.pendingRefundMinor);
  if (
    typeof raw.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(raw.observedAt) ||
    Number.isNaN(Date.parse(raw.observedAt)) ||
    new Date(raw.observedAt).toISOString() !== raw.observedAt ||
    typeof raw.currencyCode !== "string" ||
    !currency.test(raw.currencyCode) ||
    typeof raw.unresolvedAttemptCount !== "number" ||
    !Number.isSafeInteger(raw.unresolvedAttemptCount) ||
    raw.unresolvedAttemptCount < 0 ||
    confirmedRefundMinor + pendingRefundMinor > capturedMinor
  )
    return invalid();
  return Object.freeze({
    observedAt: raw.observedAt,
    currencyCode: raw.currencyCode,
    capturedMinor,
    confirmedRefundMinor,
    pendingRefundMinor,
    unresolvedAttemptCount: raw.unresolvedAttemptCount,
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
    ...(value !== null && typeof value === "object" && Object.hasOwn(value, "financial")
      ? ["financial"]
      : []),
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
    ...(Object.hasOwn(raw, "financial") ? { financial: financial(raw.financial) } : {}),
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
  let requestVersion = 0;
  let state: ReceiptState = reference.test(orderReference)
    ? online
      ? { status: "loading" }
      : { status: "offline", view: null }
    : { status: "invalid-reference" };
  const listeners = new Set<() => void>();
  let unsubscribeContext: (() => void) | undefined;
  const publish = (next: ReceiptState) => {
    state = Object.freeze(next);
    listeners.forEach((listener) => listener());
  };
  return Object.freeze({
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        unsubscribeContext = client.subscribeContextChange?.(() => {
          requestVersion += 1;
          accepted = null;
          publish({ status: "permission-denied" });
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeContext?.();
          unsubscribeContext = undefined;
          requestVersion += 1;
        }
      };
    },
    async load() {
      if (!reference.test(orderReference) || !online) return;
      const version = ++requestVersion;
      publish({ status: "loading" });
      try {
        const response = await client.load(orderReference);
        if (version !== requestVersion || !online) return;
        accepted = parseReceiptView(response, orderReference);
        publish({ status: "ready", view: accepted });
      } catch (error) {
        if (version !== requestVersion || !online) return;
        accepted = null;
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
      if (!online) {
        requestVersion += 1;
        // Reconnection alone cannot revalidate live facts or action eligibility.
        if (accepted)
          accepted = Object.freeze({
            ...accepted,
            freshnessStatus: "Stale",
            financial: null,
            deliveryStatus: "Unavailable",
            supportEligible: false,
            cancellationEligible: false,
          });
        publish({ status: "offline", view: accepted });
      } else if (state.status === "offline")
        publish(accepted ? { status: "ready", view: accepted } : { status: "unavailable" });
    },
  });
}
