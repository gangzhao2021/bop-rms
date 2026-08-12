import {
  assertProjectionScope,
  projectionDigest,
  projectionExact,
  projectionFail,
  projectionInstant,
  projectionReference,
  projectionVersion,
  validateBusinessDate,
} from "./projection-contract.js";
export const orderOperationalProjectionName = "merchant_order_queue_v1" as const;
type Scope = Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>;
export interface OrderOperationalSource extends Scope {
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly orderType: "DineIn" | "Pickup";
  readonly sourceChannel: "Api" | "Pos" | "Qr" | "Web";
  readonly phase: "Submitted" | "Confirmed" | "Rejected" | "Cancelled" | "Fulfilled";
  readonly submittedAt: string;
  readonly sourceVersion: bigint;
  readonly sourceDigest: string;
}
export interface OrderCollaboratingSource extends Scope {
  readonly orderReference: string;
  readonly sourceDomain: "Payment" | "Kitchen" | "Fulfillment";
  readonly status:
    | "Pending"
    | "Succeeded"
    | "Failed"
    | "Refunded"
    | "Unknown"
    | "Queued"
    | "InProgress"
    | "Ready"
    | "Completed"
    | "Exception";
  readonly sourceReference: string;
  readonly sourceVersion: bigint;
  readonly asOfUtc: string;
}
export interface OrderOperationalRow extends OrderOperationalSource {
  readonly paymentStatus:
    "NotReported" | "Pending" | "Succeeded" | "Failed" | "Refunded" | "Unknown";
  readonly kitchenStatus: "Unavailable" | "Queued" | "InProgress" | "Ready" | "Exception";
  readonly fulfillmentStatus:
    "Unavailable" | "Pending" | "Ready" | "InProgress" | "Completed" | "Exception";
  readonly paymentSourceReference: string | null;
  readonly kitchenSourceReference: string | null;
  readonly fulfillmentSourceReference: string | null;
}
export interface OrderOperationalProjection extends Scope {
  readonly projectionName: typeof orderOperationalProjectionName;
  readonly projectionVersion: 1;
  readonly businessDate: string;
  readonly generationReference: string;
  readonly sourceCheckpoint: string;
  readonly asOfUtc: string;
  readonly projectedAt: string;
  readonly lastRebuiltAt: string | null;
  readonly freshnessStatus: "Fresh" | "Stale";
  readonly initializedEmpty: boolean;
  readonly rows: readonly OrderOperationalRow[];
}
function parseOrder(value: unknown): OrderOperationalSource {
  const raw = projectionExact(value, [
    "tenantReference",
    "brandReference",
    "storeReference",
    "orderReference",
    "orderNumber",
    "orderType",
    "sourceChannel",
    "phase",
    "submittedAt",
    "sourceVersion",
    "sourceDigest",
  ]);
  if (
    typeof raw.orderNumber !== "string" ||
    !/^[A-Z0-9][A-Z0-9-]{0,39}$/u.test(raw.orderNumber) ||
    !["DineIn", "Pickup"].includes(String(raw.orderType)) ||
    !["Api", "Pos", "Qr", "Web"].includes(String(raw.sourceChannel)) ||
    !["Submitted", "Confirmed", "Rejected", "Cancelled", "Fulfilled"].includes(String(raw.phase))
  )
    return projectionFail("INPUT_INVALID");
  return Object.freeze({
    tenantReference: projectionReference(raw.tenantReference),
    brandReference: projectionReference(raw.brandReference),
    storeReference: projectionReference(raw.storeReference),
    orderReference: projectionReference(raw.orderReference),
    orderNumber: raw.orderNumber,
    orderType: raw.orderType,
    sourceChannel: raw.sourceChannel,
    phase: raw.phase,
    submittedAt: projectionInstant(raw.submittedAt),
    sourceVersion: projectionVersion(raw.sourceVersion),
    sourceDigest: projectionDigest(raw.sourceDigest),
  }) as OrderOperationalSource;
}
function parseCollaborator(value: unknown): OrderCollaboratingSource {
  const raw = projectionExact(value, [
    "tenantReference",
    "brandReference",
    "storeReference",
    "orderReference",
    "sourceDomain",
    "status",
    "sourceReference",
    "sourceVersion",
    "asOfUtc",
  ]);
  const allowed =
    raw.sourceDomain === "Payment"
      ? ["Pending", "Succeeded", "Failed", "Refunded", "Unknown"]
      : raw.sourceDomain === "Kitchen"
        ? ["Queued", "InProgress", "Ready", "Exception"]
        : raw.sourceDomain === "Fulfillment"
          ? ["Pending", "Ready", "InProgress", "Completed", "Exception"]
          : [];
  if (!allowed.includes(String(raw.status))) return projectionFail("INPUT_INVALID");
  return Object.freeze({
    tenantReference: projectionReference(raw.tenantReference),
    brandReference: projectionReference(raw.brandReference),
    storeReference: projectionReference(raw.storeReference),
    orderReference: projectionReference(raw.orderReference),
    sourceDomain: raw.sourceDomain,
    status: raw.status,
    sourceReference: projectionReference(raw.sourceReference),
    sourceVersion: projectionVersion(raw.sourceVersion),
    asOfUtc: projectionInstant(raw.asOfUtc),
  }) as OrderCollaboratingSource;
}
export function buildOrderOperationalProjection(
  input: Scope & {
    readonly businessDate: string;
    readonly generationReference: string;
    readonly sourceCheckpoint: string;
    readonly asOfUtc: string;
    readonly projectedAt: string;
    readonly lastRebuiltAt: string | null;
    readonly orders: readonly unknown[];
    readonly collaborators: readonly unknown[];
  },
): OrderOperationalProjection {
  const scope = {
    tenantReference: projectionReference(input.tenantReference),
    brandReference: projectionReference(input.brandReference),
    storeReference: projectionReference(input.storeReference),
  };
  const asOfUtc = projectionInstant(input.asOfUtc);
  const projectedAt = projectionInstant(input.projectedAt);
  if (
    !Array.isArray(input.orders) ||
    !Array.isArray(input.collaborators) ||
    input.orders.length > 500 ||
    input.collaborators.length > 1500
  )
    return projectionFail("INPUT_INVALID");
  const orders = input.orders.map(parseOrder);
  const collaborators = input.collaborators.map(parseCollaborator);
  for (const source of [...orders, ...collaborators]) assertProjectionScope(source, scope);
  if (
    new Set(orders.map((source) => source.orderReference)).size !== orders.length ||
    new Set(collaborators.map((source) => `${source.orderReference}:${source.sourceDomain}`))
      .size !== collaborators.length
  )
    return projectionFail("DUPLICATE_SOURCE");
  const knownOrders = new Set(orders.map((source) => source.orderReference));
  if (collaborators.some((source) => !knownOrders.has(source.orderReference)))
    return projectionFail("SOURCE_CONFLICT");
  const rows = orders.map((order) => {
    const byDomain = (domain: OrderCollaboratingSource["sourceDomain"]) =>
      collaborators.find(
        (source) =>
          source.orderReference === order.orderReference && source.sourceDomain === domain,
      );
    const payment = byDomain("Payment");
    const kitchen = byDomain("Kitchen");
    const fulfillment = byDomain("Fulfillment");
    return Object.freeze({
      ...order,
      paymentStatus: payment?.status ?? "NotReported",
      kitchenStatus: kitchen?.status ?? "Unavailable",
      fulfillmentStatus: fulfillment?.status ?? "Unavailable",
      paymentSourceReference: payment?.sourceReference ?? null,
      kitchenSourceReference: kitchen?.sourceReference ?? null,
      fulfillmentSourceReference: fulfillment?.sourceReference ?? null,
    }) as OrderOperationalRow;
  });
  return Object.freeze({
    projectionName: orderOperationalProjectionName,
    projectionVersion: 1,
    ...scope,
    businessDate: validateBusinessDate(input.businessDate),
    generationReference: projectionReference(input.generationReference),
    sourceCheckpoint: projectionReference(input.sourceCheckpoint),
    asOfUtc,
    projectedAt,
    lastRebuiltAt: input.lastRebuiltAt === null ? null : projectionInstant(input.lastRebuiltAt),
    freshnessStatus: Date.parse(projectedAt) - Date.parse(asOfUtc) <= 2000 ? "Fresh" : "Stale",
    initializedEmpty: rows.length === 0,
    rows: Object.freeze(rows),
  });
}
