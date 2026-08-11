export type ReadinessReference = string & { readonly __readinessReference: unique symbol };
export type ReadinessDigest = string & { readonly __readinessDigest: unique symbol };
export type ReadinessInstant = string & { readonly __readinessInstant: unique symbol };

export const fulfillmentItemReadyConsumerName = "fulfillment.kitchen-item-ready:v1" as const;
export const fulfillmentItemReadyConsumerVersion = 1 as const;

export interface FulfillmentReadinessItemSource {
  readonly fulfillmentItemReference: ReadinessReference;
  readonly orderItemReference: ReadinessReference;
  readonly orderedQuantity: number;
  readonly readyQuantity: number;
  readonly handedOverQuantity: 0;
  readonly state: "Pending" | "Ready";
}

export interface FulfillmentReadinessSource {
  readonly fulfillmentReference: ReadinessReference;
  readonly brandReference: ReadinessReference;
  readonly storeReference: ReadinessReference;
  readonly orderReference: ReadinessReference;
  readonly orderBatchReference: ReadinessReference;
  readonly canonicalPhase: "Pending" | "Ready";
  readonly aggregateVersion: bigint;
  readonly lockedAt: ReadinessInstant;
  readonly items: readonly FulfillmentReadinessItemSource[];
}

export interface FulfillmentItemReadyResult {
  readonly resultReference: ReadinessReference;
  readonly fulfillmentReference: ReadinessReference;
  readonly fulfillmentItemReference: ReadinessReference;
  readonly orderReference: ReadinessReference;
  readonly orderBatchReference: ReadinessReference;
  readonly orderItemReference: ReadinessReference;
  readonly kitchenTicketReference: ReadinessReference;
  readonly kitchenReadyResultReference: ReadinessReference;
  readonly sourceEventReference: ReadinessReference;
  readonly readyQuantity: number;
  readonly occurredAt: ReadinessInstant;
}

export interface FulfillmentReadyOperation {
  readonly operationReference: ReadinessReference;
  readonly fulfillmentReference: ReadinessReference;
  readonly fulfillmentItemReference: ReadinessReference;
  readonly brandReference: ReadinessReference;
  readonly storeReference: ReadinessReference;
  readonly sourceEventReference: ReadinessReference;
  readonly kitchenReadyResultReference: ReadinessReference;
  readonly aggregateVersionBefore: bigint;
  readonly aggregateVersionAfter: bigint;
  readonly phaseBefore: "Pending" | "Ready";
  readonly phaseAfter: "Pending" | "Ready";
  readonly semanticBindingDigest: ReadinessDigest;
  readonly occurredAt: ReadinessInstant;
}

export interface FulfillmentReadyAudit {
  readonly auditId: ReadinessReference;
  readonly brandId: ReadinessReference;
  readonly storeId: ReadinessReference;
  readonly actor: { readonly type: "System" };
  readonly actionCode: "FULFILLMENT_ITEM_READY_RECORDED";
  readonly targetType: "FulfillmentItem";
  readonly targetId: ReadinessReference;
  readonly beforeSummary: { readonly state: "Pending"; readonly readyQuantity: 0 };
  readonly afterSummary: { readonly state: "Ready"; readonly readyQuantity: number };
  readonly reasonCode: "KITCHEN_ITEM_READY";
  readonly correlationId: ReadinessReference;
  readonly occurredAt: ReadinessInstant;
  readonly sourceChannel: "EVENT_CONSUMER";
  readonly dataClassification: "Confidential";
  readonly retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD";
  readonly retentionPolicyVersion: 1;
}

export interface FulfillmentReadyEffect {
  readonly result: FulfillmentItemReadyResult;
  readonly operation: FulfillmentReadyOperation;
  readonly audit: FulfillmentReadyAudit;
  readonly effectDigest: ReadinessDigest;
}

export interface FulfillmentReadyResult {
  readonly status: "Applied" | "AlreadyApplied";
  readonly effect: FulfillmentReadyEffect;
}

export const fulfillmentReadinessErrorCodes = [
  "FULFILLMENT_READINESS_INPUT_INVALID",
  "FULFILLMENT_READINESS_PERMISSION_DENIED",
  "FULFILLMENT_READINESS_NOT_FOUND",
  "FULFILLMENT_READINESS_CONFLICT",
  "FULFILLMENT_READINESS_DEPENDENCY_UNAVAILABLE",
] as const;

export class FulfillmentReadinessError extends Error {
  constructor(readonly code: (typeof fulfillmentReadinessErrorCodes)[number]) {
    super("fulfillment readiness is unavailable");
    this.name = "FulfillmentReadinessError";
  }
}

const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const maximumBigint = 9_223_372_036_854_775_807n;

function invalid(): never {
  throw new FulfillmentReadinessError("FULFILLMENT_READINESS_INPUT_INVALID");
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
    return Object.freeze(
      Object.fromEntries(
        fields.map((field) => {
          const descriptor = descriptors[field];
          if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            descriptor.get !== undefined ||
            descriptor.set !== undefined ||
            !descriptor.enumerable
          )
            return invalid();
          return [field, descriptor.value];
        }),
      ),
    );
  } catch (error) {
    if (error instanceof FulfillmentReadinessError) throw error;
    return invalid();
  }
}

function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 1 || length > 100) return invalid();
  return Object.freeze(value.map((entry) => entry));
}

export function parseReadinessReference(value: unknown): ReadinessReference {
  if (typeof value !== "string" || !referencePattern.test(value)) return invalid();
  return value as ReadinessReference;
}

export function parseReadinessDigest(value: unknown): ReadinessDigest {
  if (typeof value !== "string" || !digestPattern.test(value)) return invalid();
  return value as ReadinessDigest;
}

export function parseReadinessInstant(value: unknown): ReadinessInstant {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    new Date(value).toISOString() !== value
  )
    return invalid();
  return value as ReadinessInstant;
}

function quantity(value: unknown, allowZero = false): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < (allowZero ? 0 : 1) ||
    (value as number) > 999
  )
    return invalid();
  return value as number;
}

function version(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 1n || value > maximumBigint) return invalid();
  return value;
}

function parseSourceItem(value: unknown): FulfillmentReadinessItemSource {
  const raw = exact(value, [
    "fulfillmentItemReference",
    "orderItemReference",
    "orderedQuantity",
    "readyQuantity",
    "handedOverQuantity",
    "state",
  ]);
  const orderedQuantity = quantity(raw.orderedQuantity);
  const readyQuantity = quantity(raw.readyQuantity, true);
  if (
    raw.handedOverQuantity !== 0 ||
    (raw.state !== "Pending" && raw.state !== "Ready") ||
    (raw.state === "Pending" && readyQuantity !== 0) ||
    (raw.state === "Ready" && readyQuantity !== orderedQuantity)
  )
    return invalid();
  return Object.freeze({
    fulfillmentItemReference: parseReadinessReference(raw.fulfillmentItemReference),
    orderItemReference: parseReadinessReference(raw.orderItemReference),
    orderedQuantity,
    readyQuantity,
    handedOverQuantity: 0,
    state: raw.state,
  });
}

export function parseFulfillmentReadinessSource(value: unknown): FulfillmentReadinessSource {
  const raw = exact(value, [
    "fulfillmentReference",
    "brandReference",
    "storeReference",
    "orderReference",
    "orderBatchReference",
    "canonicalPhase",
    "aggregateVersion",
    "lockedAt",
    "items",
  ]);
  const items = list(raw.items).map(parseSourceItem);
  if (
    (raw.canonicalPhase !== "Pending" && raw.canonicalPhase !== "Ready") ||
    new Set(items.map((entry) => entry.fulfillmentItemReference)).size !== items.length ||
    new Set(items.map((entry) => entry.orderItemReference)).size !== items.length ||
    (raw.canonicalPhase === "Ready" && items.some((entry) => entry.state !== "Ready")) ||
    (raw.canonicalPhase === "Pending" && items.every((entry) => entry.state === "Ready"))
  )
    return invalid();
  return Object.freeze({
    fulfillmentReference: parseReadinessReference(raw.fulfillmentReference),
    brandReference: parseReadinessReference(raw.brandReference),
    storeReference: parseReadinessReference(raw.storeReference),
    orderReference: parseReadinessReference(raw.orderReference),
    orderBatchReference: parseReadinessReference(raw.orderBatchReference),
    canonicalPhase: raw.canonicalPhase,
    aggregateVersion: version(raw.aggregateVersion),
    lockedAt: parseReadinessInstant(raw.lockedAt),
    items: Object.freeze(items),
  });
}

export function canonicalReadinessValue(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString(10));
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalid();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalReadinessValue).join(",")}]`;
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return invalid();
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalReadinessValue((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function parseAudit(value: unknown): FulfillmentReadyAudit {
  const raw = exact(value, [
    "auditId",
    "brandId",
    "storeId",
    "actor",
    "actionCode",
    "targetType",
    "targetId",
    "beforeSummary",
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
  const before = exact(raw.beforeSummary, ["state", "readyQuantity"]);
  const after = exact(raw.afterSummary, ["state", "readyQuantity"]);
  if (
    actor.type !== "System" ||
    raw.actionCode !== "FULFILLMENT_ITEM_READY_RECORDED" ||
    raw.targetType !== "FulfillmentItem" ||
    before.state !== "Pending" ||
    before.readyQuantity !== 0 ||
    after.state !== "Ready" ||
    raw.reasonCode !== "KITCHEN_ITEM_READY" ||
    raw.sourceChannel !== "EVENT_CONSUMER" ||
    raw.dataClassification !== "Confidential" ||
    raw.retentionPolicyCode !== "FULFILLMENT_BUSINESS_RECORD" ||
    raw.retentionPolicyVersion !== 1
  )
    return invalid();
  return Object.freeze({
    auditId: parseReadinessReference(raw.auditId),
    brandId: parseReadinessReference(raw.brandId),
    storeId: parseReadinessReference(raw.storeId),
    actor: Object.freeze({ type: "System" as const }),
    actionCode: "FULFILLMENT_ITEM_READY_RECORDED",
    targetType: "FulfillmentItem",
    targetId: parseReadinessReference(raw.targetId),
    beforeSummary: Object.freeze({ state: "Pending" as const, readyQuantity: 0 as const }),
    afterSummary: Object.freeze({
      state: "Ready" as const,
      readyQuantity: quantity(after.readyQuantity),
    }),
    reasonCode: "KITCHEN_ITEM_READY",
    correlationId: parseReadinessReference(raw.correlationId),
    occurredAt: parseReadinessInstant(raw.occurredAt),
    sourceChannel: "EVENT_CONSUMER",
    dataClassification: "Confidential",
    retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD",
    retentionPolicyVersion: 1,
  });
}

export function parseFulfillmentReadyEffect(value: unknown): FulfillmentReadyEffect {
  const raw = exact(value, ["result", "operation", "audit", "effectDigest"]);
  const resultRaw = exact(raw.result, [
    "resultReference",
    "fulfillmentReference",
    "fulfillmentItemReference",
    "orderReference",
    "orderBatchReference",
    "orderItemReference",
    "kitchenTicketReference",
    "kitchenReadyResultReference",
    "sourceEventReference",
    "readyQuantity",
    "occurredAt",
  ]);
  const operationRaw = exact(raw.operation, [
    "operationReference",
    "fulfillmentReference",
    "fulfillmentItemReference",
    "brandReference",
    "storeReference",
    "sourceEventReference",
    "kitchenReadyResultReference",
    "aggregateVersionBefore",
    "aggregateVersionAfter",
    "phaseBefore",
    "phaseAfter",
    "semanticBindingDigest",
    "occurredAt",
  ]);
  const result = Object.freeze({
    resultReference: parseReadinessReference(resultRaw.resultReference),
    fulfillmentReference: parseReadinessReference(resultRaw.fulfillmentReference),
    fulfillmentItemReference: parseReadinessReference(resultRaw.fulfillmentItemReference),
    orderReference: parseReadinessReference(resultRaw.orderReference),
    orderBatchReference: parseReadinessReference(resultRaw.orderBatchReference),
    orderItemReference: parseReadinessReference(resultRaw.orderItemReference),
    kitchenTicketReference: parseReadinessReference(resultRaw.kitchenTicketReference),
    kitchenReadyResultReference: parseReadinessReference(resultRaw.kitchenReadyResultReference),
    sourceEventReference: parseReadinessReference(resultRaw.sourceEventReference),
    readyQuantity: quantity(resultRaw.readyQuantity),
    occurredAt: parseReadinessInstant(resultRaw.occurredAt),
  });
  const aggregateVersionBefore = version(operationRaw.aggregateVersionBefore);
  const aggregateVersionAfter = version(operationRaw.aggregateVersionAfter);
  if (
    aggregateVersionAfter !== aggregateVersionBefore + 1n ||
    (operationRaw.phaseBefore !== "Pending" && operationRaw.phaseBefore !== "Ready") ||
    (operationRaw.phaseAfter !== "Pending" && operationRaw.phaseAfter !== "Ready")
  )
    return invalid();
  const operation = Object.freeze({
    operationReference: parseReadinessReference(operationRaw.operationReference),
    fulfillmentReference: parseReadinessReference(operationRaw.fulfillmentReference),
    fulfillmentItemReference: parseReadinessReference(operationRaw.fulfillmentItemReference),
    brandReference: parseReadinessReference(operationRaw.brandReference),
    storeReference: parseReadinessReference(operationRaw.storeReference),
    sourceEventReference: parseReadinessReference(operationRaw.sourceEventReference),
    kitchenReadyResultReference: parseReadinessReference(operationRaw.kitchenReadyResultReference),
    aggregateVersionBefore,
    aggregateVersionAfter,
    phaseBefore: operationRaw.phaseBefore,
    phaseAfter: operationRaw.phaseAfter,
    semanticBindingDigest: parseReadinessDigest(operationRaw.semanticBindingDigest),
    occurredAt: parseReadinessInstant(operationRaw.occurredAt),
  });
  const audit = parseAudit(raw.audit);
  if (
    result.fulfillmentReference !== operation.fulfillmentReference ||
    result.fulfillmentItemReference !== operation.fulfillmentItemReference ||
    result.sourceEventReference !== operation.sourceEventReference ||
    result.kitchenReadyResultReference !== operation.kitchenReadyResultReference ||
    result.occurredAt !== operation.occurredAt ||
    audit.brandId !== operation.brandReference ||
    audit.storeId !== operation.storeReference ||
    audit.targetId !== result.fulfillmentItemReference ||
    audit.correlationId === result.sourceEventReference ||
    audit.occurredAt !== result.occurredAt ||
    audit.afterSummary.readyQuantity !== result.readyQuantity
  )
    return invalid();
  return Object.freeze({
    result,
    operation,
    audit,
    effectDigest: parseReadinessDigest(raw.effectDigest),
  });
}
