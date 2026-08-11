export type FulfillmentReference = string & { readonly __fulfillmentReference: unique symbol };
export type FulfillmentDigest = string & { readonly __fulfillmentDigest: unique symbol };
export type FulfillmentInstant = string & { readonly __fulfillmentInstant: unique symbol };

export const pickupFulfillmentConsumerName = "fulfillment.confirmed-order:v1" as const;
export const pickupFulfillmentConsumerVersion = 1 as const;
export const pickupFulfillmentPermission = "fulfillment.operate" as const;
export const pickupFulfillmentAuditRetentionPolicyCode = "FULFILLMENT_BUSINESS_RECORD" as const;
export const pickupFulfillmentAuditRetentionPolicyVersion = 1 as const;

export interface PickupFulfillmentItem {
  readonly fulfillmentItemReference: FulfillmentReference;
  readonly orderItemReference: FulfillmentReference;
  readonly ordinal: number;
  readonly orderedQuantity: number;
  readonly readyQuantity: 0;
  readonly handedOverQuantity: 0;
  readonly state: "Pending";
  readonly sourceLineDigest: FulfillmentDigest;
}

export interface PickupFulfillmentAggregate {
  readonly fulfillmentReference: FulfillmentReference;
  readonly brandReference: FulfillmentReference;
  readonly storeReference: FulfillmentReference;
  readonly orderReference: FulfillmentReference;
  readonly orderBatchReference: FulfillmentReference;
  readonly confirmationReference: FulfillmentReference;
  readonly sourceEventReference: FulfillmentReference;
  readonly sourceAggregateVersion: bigint;
  readonly sourceSnapshotDigest: FulfillmentDigest;
  readonly sourceEvidenceReference: FulfillmentReference;
  readonly sourceEvidenceVersion: 1;
  readonly sourceEvidenceDigest: FulfillmentDigest;
  readonly fulfillmentType: "Pickup";
  readonly canonicalPhase: "Pending";
  readonly aggregateVersion: 1;
  readonly createdAt: FulfillmentInstant;
  readonly correlationReference: FulfillmentReference;
  readonly items: readonly PickupFulfillmentItem[];
}

export interface PickupFulfillmentCreationOperation {
  readonly operationReference: FulfillmentReference;
  readonly fulfillmentReference: FulfillmentReference;
  readonly brandReference: FulfillmentReference;
  readonly storeReference: FulfillmentReference;
  readonly sourceEventReference: FulfillmentReference;
  readonly confirmationReference: FulfillmentReference;
  readonly orderReference: FulfillmentReference;
  readonly sourceEvidenceDigest: FulfillmentDigest;
  readonly semanticBindingDigest: FulfillmentDigest;
  readonly occurredAt: FulfillmentInstant;
}

export interface PickupFulfillmentAuditRecord {
  readonly auditId: FulfillmentReference;
  readonly brandId: FulfillmentReference;
  readonly storeId: FulfillmentReference;
  readonly actor: { readonly type: "System" };
  readonly actionCode: "PICKUP_FULFILLMENT_CREATED";
  readonly targetType: "Fulfillment";
  readonly targetId: FulfillmentReference;
  readonly afterSummary: { readonly canonicalPhase: "Pending"; readonly itemCount: number };
  readonly reasonCode: "ORDER_CONFIRMED";
  readonly correlationId: FulfillmentReference;
  readonly occurredAt: FulfillmentInstant;
  readonly sourceChannel: "EVENT_CONSUMER";
  readonly dataClassification: "Confidential";
  readonly retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD";
  readonly retentionPolicyVersion: 1;
}

export interface PickupFulfillmentCreationEffect {
  readonly aggregate: PickupFulfillmentAggregate;
  readonly operation: PickupFulfillmentCreationOperation;
  readonly audit: PickupFulfillmentAuditRecord;
  readonly effectDigest: FulfillmentDigest;
}

export type PickupFulfillmentCreationResult =
  | {
      readonly status: "Created" | "AlreadyCreated";
      readonly effect: PickupFulfillmentCreationEffect;
    }
  | { readonly status: "NotApplicable" };

export const pickupFulfillmentErrorCodes = [
  "PICKUP_FULFILLMENT_INPUT_INVALID",
  "PICKUP_FULFILLMENT_PERMISSION_DENIED",
  "PICKUP_FULFILLMENT_NOT_APPLICABLE",
  "PICKUP_FULFILLMENT_CONFLICT",
  "PICKUP_FULFILLMENT_DEPENDENCY_UNAVAILABLE",
] as const;

export type PickupFulfillmentErrorCode = (typeof pickupFulfillmentErrorCodes)[number];

export class PickupFulfillmentError extends Error {
  constructor(readonly code: PickupFulfillmentErrorCode) {
    super("pickup fulfillment is unavailable");
    this.name = "PickupFulfillmentError";
  }
}

const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function fail(code: ConstructorParameters<typeof PickupFulfillmentError>[0]): never {
  throw new PickupFulfillmentError(code);
}

function invalid(): never {
  return fail("PICKUP_FULFILLMENT_INPUT_INVALID");
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !keys.includes(field)) ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof PickupFulfillmentError) throw error;
    return invalid();
  }
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors["length"] as PropertyDescriptor | undefined;
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > 100) return invalid();
  const expected = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  )
    return invalid();
  return Object.freeze(
    Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      return descriptor.value;
    }),
  );
}

export function parseFulfillmentReference(value: unknown): FulfillmentReference {
  if (typeof value !== "string" || !referencePattern.test(value)) return invalid();
  return value as FulfillmentReference;
}

export function parseFulfillmentDigest(value: unknown): FulfillmentDigest {
  if (typeof value !== "string" || !digestPattern.test(value)) return invalid();
  return value as FulfillmentDigest;
}

export function parseFulfillmentInstant(value: unknown): FulfillmentInstant {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    new Date(value).toISOString() !== value
  )
    return invalid();
  return value as FulfillmentInstant;
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    return invalid();
  return value as number;
}

function item(value: unknown): PickupFulfillmentItem {
  const raw = exact(value, [
    "fulfillmentItemReference",
    "orderItemReference",
    "ordinal",
    "orderedQuantity",
    "readyQuantity",
    "handedOverQuantity",
    "state",
    "sourceLineDigest",
  ]);
  if (raw.readyQuantity !== 0 || raw.handedOverQuantity !== 0 || raw.state !== "Pending")
    return invalid();
  return Object.freeze({
    fulfillmentItemReference: parseFulfillmentReference(raw.fulfillmentItemReference),
    orderItemReference: parseFulfillmentReference(raw.orderItemReference),
    ordinal: positiveInteger(raw.ordinal, 100),
    orderedQuantity: positiveInteger(raw.orderedQuantity, 999),
    readyQuantity: 0,
    handedOverQuantity: 0,
    state: "Pending",
    sourceLineDigest: parseFulfillmentDigest(raw.sourceLineDigest),
  });
}

export function parsePickupFulfillmentAggregate(value: unknown): PickupFulfillmentAggregate {
  const raw = exact(value, [
    "fulfillmentReference",
    "brandReference",
    "storeReference",
    "orderReference",
    "orderBatchReference",
    "confirmationReference",
    "sourceEventReference",
    "sourceAggregateVersion",
    "sourceSnapshotDigest",
    "sourceEvidenceReference",
    "sourceEvidenceVersion",
    "sourceEvidenceDigest",
    "fulfillmentType",
    "canonicalPhase",
    "aggregateVersion",
    "createdAt",
    "correlationReference",
    "items",
  ]);
  if (
    typeof raw.sourceAggregateVersion !== "bigint" ||
    raw.sourceAggregateVersion < 1n ||
    raw.sourceEvidenceVersion !== 1 ||
    raw.fulfillmentType !== "Pickup" ||
    raw.canonicalPhase !== "Pending" ||
    raw.aggregateVersion !== 1
  )
    return invalid();
  const items = array(raw.items)
    .map(item)
    .sort((left, right) => left.ordinal - right.ordinal);
  if (
    items.some((entry, index) => entry.ordinal !== index + 1) ||
    new Set(items.map((entry) => entry.fulfillmentItemReference)).size !== items.length ||
    new Set(items.map((entry) => entry.orderItemReference)).size !== items.length
  )
    return invalid();
  const fulfillmentReference = parseFulfillmentReference(raw.fulfillmentReference);
  if (items.some((entry) => entry.fulfillmentItemReference === fulfillmentReference))
    return invalid();
  return Object.freeze({
    fulfillmentReference,
    brandReference: parseFulfillmentReference(raw.brandReference),
    storeReference: parseFulfillmentReference(raw.storeReference),
    orderReference: parseFulfillmentReference(raw.orderReference),
    orderBatchReference: parseFulfillmentReference(raw.orderBatchReference),
    confirmationReference: parseFulfillmentReference(raw.confirmationReference),
    sourceEventReference: parseFulfillmentReference(raw.sourceEventReference),
    sourceAggregateVersion: raw.sourceAggregateVersion,
    sourceSnapshotDigest: parseFulfillmentDigest(raw.sourceSnapshotDigest),
    sourceEvidenceReference: parseFulfillmentReference(raw.sourceEvidenceReference),
    sourceEvidenceVersion: 1,
    sourceEvidenceDigest: parseFulfillmentDigest(raw.sourceEvidenceDigest),
    fulfillmentType: "Pickup",
    canonicalPhase: "Pending",
    aggregateVersion: 1,
    createdAt: parseFulfillmentInstant(raw.createdAt),
    correlationReference: parseFulfillmentReference(raw.correlationReference),
    items: Object.freeze(items),
  });
}

export function parsePickupFulfillmentCreationOperation(
  value: unknown,
): PickupFulfillmentCreationOperation {
  const raw = exact(value, [
    "operationReference",
    "fulfillmentReference",
    "brandReference",
    "storeReference",
    "sourceEventReference",
    "confirmationReference",
    "orderReference",
    "sourceEvidenceDigest",
    "semanticBindingDigest",
    "occurredAt",
  ]);
  return Object.freeze({
    operationReference: parseFulfillmentReference(raw.operationReference),
    fulfillmentReference: parseFulfillmentReference(raw.fulfillmentReference),
    brandReference: parseFulfillmentReference(raw.brandReference),
    storeReference: parseFulfillmentReference(raw.storeReference),
    sourceEventReference: parseFulfillmentReference(raw.sourceEventReference),
    confirmationReference: parseFulfillmentReference(raw.confirmationReference),
    orderReference: parseFulfillmentReference(raw.orderReference),
    sourceEvidenceDigest: parseFulfillmentDigest(raw.sourceEvidenceDigest),
    semanticBindingDigest: parseFulfillmentDigest(raw.semanticBindingDigest),
    occurredAt: parseFulfillmentInstant(raw.occurredAt),
  });
}

function parseAudit(value: unknown): PickupFulfillmentAuditRecord {
  const raw = exact(value, [
    "auditId",
    "brandId",
    "storeId",
    "actor",
    "actionCode",
    "targetType",
    "targetId",
    "afterSummary",
    "reasonCode",
    "correlationId",
    "occurredAt",
    "sourceChannel",
    "dataClassification",
    "retentionPolicyCode",
    "retentionPolicyVersion",
  ]);
  const actor = exact(raw.actor, ["type"]);
  const summary = exact(raw.afterSummary, ["canonicalPhase", "itemCount"]);
  if (
    actor.type !== "System" ||
    raw.actionCode !== "PICKUP_FULFILLMENT_CREATED" ||
    raw.targetType !== "Fulfillment" ||
    summary.canonicalPhase !== "Pending" ||
    !Number.isSafeInteger(summary.itemCount) ||
    (summary.itemCount as number) < 1 ||
    raw.reasonCode !== "ORDER_CONFIRMED" ||
    raw.sourceChannel !== "EVENT_CONSUMER" ||
    raw.dataClassification !== "Confidential" ||
    raw.retentionPolicyCode !== "FULFILLMENT_BUSINESS_RECORD" ||
    raw.retentionPolicyVersion !== 1
  )
    return invalid();
  return Object.freeze({
    auditId: parseFulfillmentReference(raw.auditId),
    brandId: parseFulfillmentReference(raw.brandId),
    storeId: parseFulfillmentReference(raw.storeId),
    actor: Object.freeze({ type: "System" as const }),
    actionCode: "PICKUP_FULFILLMENT_CREATED",
    targetType: "Fulfillment",
    targetId: parseFulfillmentReference(raw.targetId),
    afterSummary: Object.freeze({
      canonicalPhase: "Pending",
      itemCount: summary.itemCount as number,
    }),
    reasonCode: "ORDER_CONFIRMED",
    correlationId: parseFulfillmentReference(raw.correlationId),
    occurredAt: parseFulfillmentInstant(raw.occurredAt),
    sourceChannel: "EVENT_CONSUMER",
    dataClassification: "Confidential",
    retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD",
    retentionPolicyVersion: 1,
  });
}

export function canonicalFulfillmentValue(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(String(value));
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalid();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalFulfillmentValue).join(",")}]`;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return invalid();
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalFulfillmentValue((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

export function createPickupFulfillmentSemanticBinding(value: unknown): string {
  const aggregate = parsePickupFulfillmentAggregate(value);
  return canonicalFulfillmentValue({
    fulfillmentReference: aggregate.fulfillmentReference,
    brandReference: aggregate.brandReference,
    storeReference: aggregate.storeReference,
    orderReference: aggregate.orderReference,
    orderBatchReference: aggregate.orderBatchReference,
    confirmationReference: aggregate.confirmationReference,
    sourceAggregateVersion: aggregate.sourceAggregateVersion,
    sourceSnapshotDigest: aggregate.sourceSnapshotDigest,
    fulfillmentType: aggregate.fulfillmentType,
    canonicalPhase: aggregate.canonicalPhase,
    aggregateVersion: aggregate.aggregateVersion,
    createdAt: aggregate.createdAt,
    correlationReference: aggregate.correlationReference,
    items: aggregate.items.map((entry) => ({
      fulfillmentItemReference: entry.fulfillmentItemReference,
      orderItemReference: entry.orderItemReference,
      ordinal: entry.ordinal,
      orderedQuantity: entry.orderedQuantity,
      readyQuantity: entry.readyQuantity,
      handedOverQuantity: entry.handedOverQuantity,
      state: entry.state,
      sourceLineDigest: entry.sourceLineDigest,
    })),
  });
}

export function parsePickupFulfillmentCreationEffect(
  value: unknown,
): PickupFulfillmentCreationEffect {
  const raw = exact(value, ["aggregate", "operation", "audit", "effectDigest"]);
  const aggregate = parsePickupFulfillmentAggregate(raw.aggregate);
  const operation = parsePickupFulfillmentCreationOperation(raw.operation);
  const audit = parseAudit(raw.audit);
  const effectDigest = parseFulfillmentDigest(raw.effectDigest);
  if (
    operation.fulfillmentReference !== aggregate.fulfillmentReference ||
    operation.brandReference !== aggregate.brandReference ||
    operation.storeReference !== aggregate.storeReference ||
    operation.sourceEventReference !== aggregate.sourceEventReference ||
    operation.confirmationReference !== aggregate.confirmationReference ||
    operation.orderReference !== aggregate.orderReference ||
    operation.sourceEvidenceDigest !== aggregate.sourceEvidenceDigest ||
    operation.occurredAt !== aggregate.createdAt ||
    audit.brandId !== aggregate.brandReference ||
    audit.storeId !== aggregate.storeReference ||
    audit.targetId !== aggregate.fulfillmentReference ||
    audit.correlationId !== aggregate.correlationReference ||
    audit.occurredAt !== aggregate.createdAt ||
    audit.afterSummary?.itemCount !== aggregate.items.length
  )
    return invalid();
  return Object.freeze({ aggregate, operation, audit, effectDigest });
}
