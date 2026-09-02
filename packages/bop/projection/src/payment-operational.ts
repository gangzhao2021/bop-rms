import {
  assertProjectionScope,
  projectionDigest,
  projectionExact,
  projectionFail,
  projectionInstant,
  projectionOptionalReference,
  projectionReference,
  projectionVersion,
  validateBusinessDate,
} from "./projection-contract.js";
export const paymentOperationalProjectionName = "payment_operations_v1" as const;
type Scope = Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>;
export interface PaymentOperationalSource extends Scope {
  readonly paymentReference: string;
  readonly attemptReference: string;
  readonly orderReference: string;
  readonly methodFamily: "OnlineCard" | "TerminalCard" | "TerminalInterac";
  readonly state:
    | "Created"
    | "Pending"
    | "Authorized"
    | "Captured"
    | "Failed"
    | "Cancelled"
    | "PartiallyRefunded"
    | "Refunded";
  readonly currencyCode: "CAD";
  readonly authorizedAmountMinor: string;
  readonly capturedAmountMinor: string;
  readonly refundedAmountMinor: string;
  readonly providerState: "Pending" | "Unknown" | "Confirmed" | "Failed";
  readonly reconciliationStatus: "NotChecked" | "Matched" | "Difference" | "Pending";
  readonly settlementReference: string | null;
  readonly exceptionReference: string | null;
  readonly lastCheckedAt: string | null;
  readonly updatedAt: string;
  readonly sourceVersion: bigint;
  readonly sourceDigest: string;
}
export interface PaymentOperationalProjection extends Scope {
  readonly projectionName: typeof paymentOperationalProjectionName;
  readonly projectionVersion: 1;
  readonly businessDate: string;
  readonly generationReference: string;
  readonly sourceCheckpoint: string;
  readonly asOfUtc: string;
  readonly projectedAt: string;
  readonly lastRebuiltAt: string | null;
  readonly freshnessStatus: "Fresh" | "Stale";
  readonly initializedEmpty: boolean;
  readonly rows: readonly PaymentOperationalSource[];
}
const MINOR = /^(?:0|[1-9][0-9]{0,17})$/u;
function minor(value: unknown): string {
  if (typeof value !== "string" || !MINOR.test(value)) return projectionFail("INPUT_INVALID");
  return value;
}
export function parsePaymentOperationalSource(value: unknown): PaymentOperationalSource {
  const raw = projectionExact(value, [
    "tenantReference",
    "brandReference",
    "storeReference",
    "paymentReference",
    "attemptReference",
    "orderReference",
    "methodFamily",
    "state",
    "currencyCode",
    "authorizedAmountMinor",
    "capturedAmountMinor",
    "refundedAmountMinor",
    "providerState",
    "reconciliationStatus",
    "settlementReference",
    "exceptionReference",
    "lastCheckedAt",
    "updatedAt",
    "sourceVersion",
    "sourceDigest",
  ]);
  if (
    !["OnlineCard", "TerminalCard", "TerminalInterac"].includes(String(raw.methodFamily)) ||
    ![
      "Created",
      "Pending",
      "Authorized",
      "Captured",
      "Failed",
      "Cancelled",
      "PartiallyRefunded",
      "Refunded",
    ].includes(String(raw.state)) ||
    raw.currencyCode !== "CAD" ||
    !["Pending", "Unknown", "Confirmed", "Failed"].includes(String(raw.providerState)) ||
    !["NotChecked", "Matched", "Difference", "Pending"].includes(String(raw.reconciliationStatus))
  )
    return projectionFail("INPUT_INVALID");
  const authorizedAmountMinor = minor(raw.authorizedAmountMinor);
  const capturedAmountMinor = minor(raw.capturedAmountMinor);
  const refundedAmountMinor = minor(raw.refundedAmountMinor);
  if (
    BigInt(refundedAmountMinor) > BigInt(capturedAmountMinor) ||
    BigInt(capturedAmountMinor) > BigInt(authorizedAmountMinor) ||
    (raw.reconciliationStatus === "Difference") !== (raw.exceptionReference !== null) ||
    (raw.reconciliationStatus === "Matched" && raw.providerState !== "Confirmed") ||
    (raw.state === "Refunded") !==
      (BigInt(capturedAmountMinor) > 0n && refundedAmountMinor === capturedAmountMinor)
  )
    return projectionFail("SOURCE_CONFLICT");
  return Object.freeze({
    tenantReference: projectionReference(raw.tenantReference),
    brandReference: projectionReference(raw.brandReference),
    storeReference: projectionReference(raw.storeReference),
    paymentReference: projectionReference(raw.paymentReference),
    attemptReference: projectionReference(raw.attemptReference),
    orderReference: projectionReference(raw.orderReference),
    methodFamily: raw.methodFamily,
    state: raw.state,
    currencyCode: "CAD",
    authorizedAmountMinor,
    capturedAmountMinor,
    refundedAmountMinor,
    providerState: raw.providerState,
    reconciliationStatus: raw.reconciliationStatus,
    settlementReference: projectionOptionalReference(raw.settlementReference),
    exceptionReference: projectionOptionalReference(raw.exceptionReference),
    lastCheckedAt: raw.lastCheckedAt === null ? null : projectionInstant(raw.lastCheckedAt),
    updatedAt: projectionInstant(raw.updatedAt),
    sourceVersion: projectionVersion(raw.sourceVersion),
    sourceDigest: projectionDigest(raw.sourceDigest),
  }) as PaymentOperationalSource;
}
export function buildPaymentOperationalProjection(
  input: Scope & {
    readonly businessDate: string;
    readonly generationReference: string;
    readonly sourceCheckpoint: string;
    readonly asOfUtc: string;
    readonly projectedAt: string;
    readonly lastRebuiltAt: string | null;
    readonly sources: readonly unknown[];
  },
): PaymentOperationalProjection {
  const scope = {
    tenantReference: projectionReference(input.tenantReference),
    brandReference: projectionReference(input.brandReference),
    storeReference: projectionReference(input.storeReference),
  };
  if (!Array.isArray(input.sources) || input.sources.length > 500)
    return projectionFail("INPUT_INVALID");
  const sources = input.sources.map(parsePaymentOperationalSource);
  for (const source of sources) assertProjectionScope(source, scope);
  if (
    new Set(sources.map((source) => source.paymentReference)).size !== sources.length ||
    new Set(sources.map((source) => source.attemptReference)).size !== sources.length
  )
    return projectionFail("DUPLICATE_SOURCE");
  const asOfUtc = projectionInstant(input.asOfUtc);
  const projectedAt = projectionInstant(input.projectedAt);
  return Object.freeze({
    projectionName: paymentOperationalProjectionName,
    projectionVersion: 1,
    ...scope,
    businessDate: validateBusinessDate(input.businessDate),
    generationReference: projectionReference(input.generationReference),
    sourceCheckpoint: projectionReference(input.sourceCheckpoint),
    asOfUtc,
    projectedAt,
    lastRebuiltAt: input.lastRebuiltAt === null ? null : projectionInstant(input.lastRebuiltAt),
    freshnessStatus: Date.parse(projectedAt) - Date.parse(asOfUtc) <= 5000 ? "Fresh" : "Stale",
    initializedEmpty: sources.length === 0,
    rows: Object.freeze(sources),
  });
}
