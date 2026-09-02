export const orderExceptionProjectionName = "merchant_order_exception_v1" as const;
export const orderExceptionProjectionVersion = 1 as const;
export const orderExceptionPermission = "operations.order-exception.manage" as const;

export type ExceptionKind =
  | "DiningUnpaidBatch"
  | "PaymentReconciliationDifference"
  | "CaptureDeadlineExceeded"
  | "PaidWithoutFulfillableOrder";
export type ExceptionStatus = "Open" | "Acknowledged" | "Assigned" | "Resolved";

export interface OrderExceptionSource {
  readonly sourceReference: string;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly orderReference: string;
  readonly paymentReference: string | null;
  readonly diningReference: string | null;
  readonly kind: ExceptionKind;
  readonly severity: "High" | "Critical";
  readonly sourceOwner: "Dining" | "Payment";
  readonly sourceStatus: "Open" | "Final";
  readonly providerState: "NotApplicable" | "Pending" | "Unknown" | "Confirmed";
  readonly compensationStatus: "NotRequested" | "Pending" | "Completed";
  readonly sourceVersion: bigint;
  readonly sourceDigest: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolutionEvidenceReference: string | null;
}

export interface OrderExceptionRow extends OrderExceptionSource {
  readonly projectionReference: string;
  readonly status: ExceptionStatus;
  readonly ownerReference: string | null;
  readonly acknowledgedAt: string | null;
  readonly assignedAt: string | null;
  readonly resolvedAt: string | null;
  readonly dueAt: string;
}

export interface OrderExceptionProjection {
  readonly projectionName: typeof orderExceptionProjectionName;
  readonly projectionVersion: 1;
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly businessDate: string;
  readonly checkpointReference: string;
  readonly projectedAt: string;
  readonly freshnessStatus: "Fresh" | "Stale";
  readonly initializedEmpty: boolean;
  readonly rows: readonly OrderExceptionRow[];
}

export class OrderExceptionProjectionError extends Error {
  constructor(
    readonly code:
      "INPUT_INVALID" | "SCOPE_MISMATCH" | "SLA_MISSED" | "PERMISSION_DENIED" | "SOURCE_NOT_FINAL",
  ) {
    super("order exception is unavailable");
    this.name = "OrderExceptionProjectionError";
  }
}

const REF = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
function fail(code: OrderExceptionProjectionError["code"]): never {
  throw new OrderExceptionProjectionError(code);
}
function ref(value: unknown): string {
  if (typeof value !== "string" || !REF.test(value)) return fail("INPUT_INVALID");
  return value;
}
function optionalRef(value: unknown): string | null {
  return value === null ? null : ref(value);
}
function instant(value: unknown): string {
  if (typeof value !== "string" || !INSTANT.test(value) || new Date(value).toISOString() !== value)
    return fail("INPUT_INVALID");
  return value;
}
function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail("INPUT_INVALID");
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      return fail("INPUT_INVALID");
    output[field] = descriptor.value;
  }
  return output;
}

export function parseOrderExceptionSource(value: unknown): OrderExceptionSource {
  const raw = exact(value, [
    "sourceReference",
    "tenantReference",
    "brandReference",
    "storeReference",
    "orderReference",
    "paymentReference",
    "diningReference",
    "kind",
    "severity",
    "sourceOwner",
    "sourceStatus",
    "providerState",
    "compensationStatus",
    "sourceVersion",
    "sourceDigest",
    "createdAt",
    "updatedAt",
    "resolutionEvidenceReference",
  ]);
  if (
    !(
      [
        "DiningUnpaidBatch",
        "PaymentReconciliationDifference",
        "CaptureDeadlineExceeded",
        "PaidWithoutFulfillableOrder",
      ] as const
    ).includes(raw.kind as ExceptionKind) ||
    !["High", "Critical"].includes(String(raw.severity)) ||
    !["Dining", "Payment"].includes(String(raw.sourceOwner)) ||
    !["Open", "Final"].includes(String(raw.sourceStatus)) ||
    !["NotApplicable", "Pending", "Unknown", "Confirmed"].includes(String(raw.providerState)) ||
    !["NotRequested", "Pending", "Completed"].includes(String(raw.compensationStatus)) ||
    typeof raw.sourceVersion !== "bigint" ||
    raw.sourceVersion < 1n ||
    typeof raw.sourceDigest !== "string" ||
    !DIGEST.test(raw.sourceDigest)
  )
    return fail("INPUT_INVALID");
  const kind = raw.kind as ExceptionKind;
  const sourceOwner = raw.sourceOwner as OrderExceptionSource["sourceOwner"];
  if (
    (kind === "DiningUnpaidBatch") !== (sourceOwner === "Dining") ||
    (sourceOwner === "Dining" &&
      (raw.providerState !== "NotApplicable" || raw.paymentReference !== null)) ||
    (sourceOwner === "Payment" && raw.paymentReference === null) ||
    (raw.sourceStatus === "Final") !== (raw.resolutionEvidenceReference !== null)
  )
    return fail("INPUT_INVALID");
  return Object.freeze({
    sourceReference: ref(raw.sourceReference),
    tenantReference: ref(raw.tenantReference),
    brandReference: ref(raw.brandReference),
    storeReference: ref(raw.storeReference),
    orderReference: ref(raw.orderReference),
    paymentReference: optionalRef(raw.paymentReference),
    diningReference: optionalRef(raw.diningReference),
    kind,
    severity: raw.severity as OrderExceptionSource["severity"],
    sourceOwner,
    sourceStatus: raw.sourceStatus as OrderExceptionSource["sourceStatus"],
    providerState: raw.providerState as OrderExceptionSource["providerState"],
    compensationStatus: raw.compensationStatus as OrderExceptionSource["compensationStatus"],
    sourceVersion: raw.sourceVersion,
    sourceDigest: raw.sourceDigest,
    createdAt: instant(raw.createdAt),
    updatedAt: instant(raw.updatedAt),
    resolutionEvidenceReference: optionalRef(raw.resolutionEvidenceReference),
  });
}

export function buildOrderExceptionProjection(input: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly businessDate: string;
  readonly checkpointReference: string;
  readonly projectedAt: string;
  readonly freshnessStatus: "Fresh" | "Stale";
  readonly sources: readonly unknown[];
  readonly deriveProjectionReference: (sourceReference: string) => string;
}): OrderExceptionProjection {
  const tenantReference = ref(input.tenantReference);
  const brandReference = ref(input.brandReference);
  const storeReference = ref(input.storeReference);
  const checkpointReference = ref(input.checkpointReference);
  const projectedAt = instant(input.projectedAt);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.businessDate) ||
    !["Fresh", "Stale"].includes(input.freshnessStatus) ||
    !Array.isArray(input.sources) ||
    input.sources.length > 500
  )
    return fail("INPUT_INVALID");
  const sources = input.sources.map(parseOrderExceptionSource);
  if (new Set(sources.map((source) => source.sourceReference)).size !== sources.length)
    return fail("INPUT_INVALID");
  const rows = sources.map((source) => {
    if (
      source.tenantReference !== tenantReference ||
      source.brandReference !== brandReference ||
      source.storeReference !== storeReference
    )
      return fail("SCOPE_MISMATCH");
    const lag = Date.parse(projectedAt) - Date.parse(source.createdAt);
    if (source.severity === "Critical" && lag > 900_000) return fail("SLA_MISSED");
    const resolved = source.sourceStatus === "Final";
    return Object.freeze({
      ...source,
      projectionReference: ref(input.deriveProjectionReference(source.sourceReference)),
      status: resolved ? ("Resolved" as const) : ("Open" as const),
      ownerReference: null,
      acknowledgedAt: null,
      assignedAt: null,
      resolvedAt: resolved ? source.updatedAt : null,
      dueAt: new Date(Date.parse(source.createdAt) + 900_000).toISOString(),
    });
  });
  return Object.freeze({
    projectionName: orderExceptionProjectionName,
    projectionVersion: 1,
    tenantReference,
    brandReference,
    storeReference,
    businessDate: input.businessDate,
    checkpointReference,
    projectedAt,
    freshnessStatus: input.freshnessStatus,
    initializedEmpty: rows.length === 0,
    rows: Object.freeze(rows),
  });
}

export type OrderExceptionAction =
  "Acknowledge" | "Assign" | "RequestCompensation" | "RequestRetry" | "RequestWriteOff" | "Resolve";
export function authorizeOrderExceptionAction(input: {
  readonly row: OrderExceptionRow;
  readonly action: OrderExceptionAction;
  readonly actorReference: string;
  readonly actorPermissions: readonly string[];
  readonly expectedSourceVersion: bigint;
  readonly idempotencyReference: string;
  readonly assigneeReference?: string;
}): Readonly<{
  action: OrderExceptionAction;
  owningDomain: "Dining" | "Payment" | "Task";
  commandName: string;
  sourceReference: string;
  expectedSourceVersion: bigint;
  actorReference: string;
  idempotencyReference: string;
  assigneeReference: string | null;
}> {
  const row = input.row;
  if (
    !input.actorPermissions.includes(orderExceptionPermission) ||
    input.expectedSourceVersion !== row.sourceVersion
  )
    return fail("PERMISSION_DENIED");
  if (row.status === "Resolved" && input.action !== "Resolve") return fail("SOURCE_NOT_FINAL");
  const permissionByAction: Partial<Record<OrderExceptionAction, string>> = {
    RequestCompensation: "payment.compensation.request",
    RequestRetry: "payment.reconciliation.retry",
    RequestWriteOff: "ordering.writeoff.request",
    Resolve: "operations.order-exception.resolve",
  };
  const extra = permissionByAction[input.action];
  if (extra && !input.actorPermissions.includes(extra)) return fail("PERMISSION_DENIED");
  if (
    input.action === "Resolve" &&
    (row.sourceStatus !== "Final" || row.resolutionEvidenceReference === null)
  )
    return fail("SOURCE_NOT_FINAL");
  const owningDomain =
    input.action === "Acknowledge" || input.action === "Assign" || input.action === "Resolve"
      ? "Task"
      : row.sourceOwner;
  const commandName = (
    {
      Acknowledge: "AcknowledgeExceptionTask",
      Assign: "AssignExceptionTask",
      RequestCompensation: "RequestPaymentCompensation",
      RequestRetry: "RetryPaymentReconciliation",
      RequestWriteOff: "RequestOrderingWriteOff",
      Resolve: "ResolveExceptionTask",
    } as const
  )[input.action];
  return Object.freeze({
    action: input.action,
    owningDomain,
    commandName,
    sourceReference: row.sourceReference,
    expectedSourceVersion: row.sourceVersion,
    actorReference: ref(input.actorReference),
    idempotencyReference: ref(input.idempotencyReference),
    assigneeReference: input.action === "Assign" ? ref(input.assigneeReference) : null,
  });
}
