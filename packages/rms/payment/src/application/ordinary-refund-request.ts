import { exactPaymentObject, parsePaymentInstant } from "./payment-intent-creation.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import { ordinaryRefundPolicyVersion } from "./ordinary-refund-escalation.js";

const fail = (): never => {
  throw new Error("ORDINARY_REFUND_REQUEST_INVALID");
};
const ref = (value: unknown) => String(parsePaymentReference(value));
const amount = (value: unknown) => {
  if (typeof value !== "bigint" || value < 0n || value > 9223372036854775807n) return fail();
  return value;
};
const digest = (value: unknown) => {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) return fail();
  return value;
};
const componentKeys = [
  "netAmountMinor",
  "taxAmountMinor",
  "tipAmountMinor",
  "serviceChargeAmountMinor",
  "serviceChargeTaxAmountMinor",
] as const;
const list = (value: unknown, maximum: number): unknown[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) return fail();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry?.enumerable || !("value" in entry)) return fail();
    result.push(entry.value);
  }
  return result;
};

/** Immutable request, not approval or Provider dispatch authority. Owner adapters
 * must validate capture membership and reproduce Pricing before this is recorded. */
export function parseOrdinaryRefundRequest(value: unknown) {
  try {
    const raw = exactPaymentObject(value, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "orderReference",
      "requestReference",
      "operationReference",
      "actorReference",
      "auditReference",
      "expectedClaimVersion",
      "policyVersion",
      "allocationVersion",
      "reasonCode",
      "requestedAt",
      "currencyCode",
      "amountMinor",
      "payments",
    ]);
    if (
      raw.policyVersion !== ordinaryRefundPolicyVersion ||
      raw.allocationVersion !== "ORDINARY_REFUND_ALLOCATION_V1" ||
      raw.currencyCode !== "CAD" ||
      typeof raw.reasonCode !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.reasonCode) ||
      typeof raw.expectedClaimVersion !== "number" ||
      !Number.isSafeInteger(raw.expectedClaimVersion) ||
      raw.expectedClaimVersion < 0 ||
      raw.expectedClaimVersion >= Number.MAX_SAFE_INTEGER
    )
      return fail();
    const paymentIds = new Set<string>(),
      itemIds = new Set<string>();
    const payments = list(raw.payments, 100)
      .map((value) => {
        const payment = exactPaymentObject(value, [
          "paymentTransactionReference",
          "paymentIntentReference",
          "paymentAttemptReference",
          "firstCaptureReference",
          "sourceReference",
          "sourceDigest",
          "items",
        ]);
        const paymentAttemptReference = ref(payment.paymentAttemptReference);
        if (paymentIds.has(paymentAttemptReference)) return fail();
        paymentIds.add(paymentAttemptReference);
        const items = list(payment.items, 1000)
          .map((value) => {
            const item = exactPaymentObject(value, [
              "orderItemReference",
              "refundUnitOrdinals",
              "components",
            ]);
            const orderItemReference = ref(item.orderItemReference);
            if (itemIds.has(orderItemReference)) return fail();
            itemIds.add(orderItemReference);
            const refundUnitOrdinals = list(item.refundUnitOrdinals, 999)
              .map((ordinal) => {
                if (
                  typeof ordinal !== "number" ||
                  !Number.isSafeInteger(ordinal) ||
                  ordinal < 1 ||
                  ordinal > 999
                )
                  return fail();
                return ordinal;
              })
              .sort((a, b) => a - b);
            if (new Set(refundUnitOrdinals).size !== refundUnitOrdinals.length) return fail();
            const components = exactPaymentObject(item.components, componentKeys);
            const parsed = Object.freeze({
              netAmountMinor: amount(components.netAmountMinor),
              taxAmountMinor: amount(components.taxAmountMinor),
              tipAmountMinor: amount(components.tipAmountMinor),
              serviceChargeAmountMinor: amount(components.serviceChargeAmountMinor),
              serviceChargeTaxAmountMinor: amount(components.serviceChargeTaxAmountMinor),
            });
            amount(Object.values(parsed).reduce((sum, part) => sum + part, 0n));
            return Object.freeze({
              orderItemReference,
              refundUnitOrdinals: Object.freeze(refundUnitOrdinals),
              components: parsed,
            });
          })
          .sort((a, b) => a.orderItemReference.localeCompare(b.orderItemReference));
        return Object.freeze({
          paymentTransactionReference: ref(payment.paymentTransactionReference),
          paymentIntentReference: ref(payment.paymentIntentReference),
          paymentAttemptReference,
          firstCaptureReference: ref(payment.firstCaptureReference),
          sourceReference: ref(payment.sourceReference),
          sourceDigest: digest(payment.sourceDigest),
          items: Object.freeze(items),
        });
      })
      .sort((a, b) => a.paymentAttemptReference.localeCompare(b.paymentAttemptReference));
    const total = amount(raw.amountMinor);
    if (
      total === 0n ||
      total !== payments.reduce((sum, payment) => sum + ordinaryRefundPaymentAmount(payment), 0n)
    )
      return fail();
    return Object.freeze({
      tenantReference: ref(raw.tenantReference),
      brandReference: ref(raw.brandReference),
      storeReference: ref(raw.storeReference),
      orderReference: ref(raw.orderReference),
      requestReference: ref(raw.requestReference),
      operationReference: ref(raw.operationReference),
      actorReference: ref(raw.actorReference),
      auditReference: ref(raw.auditReference),
      expectedClaimVersion: raw.expectedClaimVersion,
      policyVersion: ordinaryRefundPolicyVersion,
      allocationVersion: "ORDINARY_REFUND_ALLOCATION_V1" as const,
      reasonCode: raw.reasonCode,
      requestedAt: parsePaymentInstant(raw.requestedAt),
      currencyCode: "CAD" as const,
      amountMinor: total,
      payments: Object.freeze(payments),
    });
  } catch {
    return fail();
  }
}
export type OrdinaryRefundRequest = ReturnType<typeof parseOrdinaryRefundRequest>;
export function ordinaryRefundPaymentAmount(payment: {
  readonly items: readonly {
    readonly components: Readonly<Record<(typeof componentKeys)[number], bigint>>;
  }[];
}): bigint {
  return amount(
    payment.items.reduce(
      (sum, item) =>
        sum + Object.values(item.components).reduce((total, component) => total + component, 0n),
      0n,
    ),
  );
}
export function encodeOrdinaryRefundRequest(value: unknown): string {
  const encoded = JSON.stringify(parseOrdinaryRefundRequest(value), (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
  if (encoded.length > 65536) return fail();
  return encoded;
}
export function decodeOrdinaryRefundRequest(value: unknown): OrdinaryRefundRequest {
  try {
    if (typeof value !== "string" || value.length > 65536) return fail();
    return parseOrdinaryRefundRequest(
      JSON.parse(value, (key, item: unknown) => {
        if (key === "amountMinor" || componentKeys.some((component) => component === key)) {
          if (typeof item !== "string" || !/^(0|[1-9][0-9]{0,18})$/u.test(item)) return fail();
          return BigInt(item);
        }
        return item;
      }),
    );
  } catch {
    return fail();
  }
}
