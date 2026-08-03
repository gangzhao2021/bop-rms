import { z } from "zod";

const eventType = /^[A-Z][A-Za-z0-9]{0,127}$/u;
const moduleName = /^@(bop|rms)\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const consumerName = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*:v[1-9][0-9]*$/u;
const replacementIdentity = /^[A-Z][A-Za-z0-9]{0,127}:v[1-9][0-9]*$/u;

export const eventCatalogMetadataSchema = z.strictObject({
  eventType: z.string().regex(eventType),
  schemaVersion: z.int().positive(),
  ownerModule: z.string().regex(moduleName),
  producerModule: z.string().regex(moduleName),
  stability: z.enum(["experimental", "stable", "deprecated"]),
  consumers: z.array(z.string().regex(consumerName)).min(1),
  tenantScope: z.enum(["brand", "store"]),
  dataClassification: z.enum([
    "none",
    "indirect_identifier",
    "personal",
    "sensitive_personal",
    "payment",
    "health",
    "credential",
  ]),
  compatibility: z.literal("additive"),
  retentionCategory: z.enum(["operational_short", "operational_standard", "business_record"]),
  replaySemantics: z.enum(["idempotent", "owner_approved_only", "not_replayable"]),
  deprecated: z.boolean(),
  replacement: z.string().regex(replacementIdentity).nullable(),
});

export type EventCatalogMetadata = Readonly<
  Omit<z.infer<typeof eventCatalogMetadataSchema>, "consumers"> & {
    readonly consumers: readonly string[];
  }
>;
export type EventPayloadSchema = z.ZodObject<z.ZodRawShape>;
export type EventCatalogRegistration = Readonly<
  EventCatalogMetadata & {
    readonly payloadSchema: EventPayloadSchema;
  }
>;

export class InvalidEventCatalogError extends Error {
  readonly code:
    "EVENT_CATALOG_DUPLICATE" | "EVENT_CATALOG_INVALID" | "EVENT_CATALOG_SCHEMA_UNSAFE";
  readonly field: string;

  constructor(
    code: "EVENT_CATALOG_DUPLICATE" | "EVENT_CATALOG_INVALID" | "EVENT_CATALOG_SCHEMA_UNSAFE",
    field: string,
  ) {
    super(`${code}:${field}`);
    this.name = "InvalidEventCatalogError";
    this.code = code;
    this.field = field;
  }
}

function identity(entry: Pick<EventCatalogMetadata, "eventType" | "schemaVersion">): string {
  return `${entry.eventType}:v${entry.schemaVersion}`;
}

function assertSchemaSafe(schema: unknown): void {
  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["default", "description", "example", "examples"].includes(key))
        throw new InvalidEventCatalogError("EVENT_CATALOG_SCHEMA_UNSAFE", path);
      if (
        key === "$ref" &&
        (typeof child !== "string" || (!child.startsWith("#/") && child.length > 0))
      )
        throw new InvalidEventCatalogError("EVENT_CATALOG_SCHEMA_UNSAFE", path);
      visit(child, `${path}.${key}`);
    }
  };
  visit(schema, "payloadSchema");
}

export function payloadJsonSchema(payloadSchema: EventPayloadSchema): Record<string, unknown> {
  const schema = z.toJSONSchema(payloadSchema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
  }) as Record<string, unknown>;
  assertSchemaSafe(schema);
  if (
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    schema.properties === null ||
    typeof schema.properties !== "object"
  )
    throw new InvalidEventCatalogError("EVENT_CATALOG_SCHEMA_UNSAFE", "payloadSchema");
  return schema;
}

export function defineEventCatalog(
  registrations: readonly EventCatalogRegistration[],
): readonly EventCatalogRegistration[] {
  const seen = new Set<string>();
  const validated = registrations.map((registration, index) => {
    const { payloadSchema, ...metadata } = registration;
    const parsed = eventCatalogMetadataSchema.safeParse(metadata);
    if (!parsed.success)
      throw new InvalidEventCatalogError(
        "EVENT_CATALOG_INVALID",
        parsed.error.issues[0]?.path.join(".") || `registration[${index}]`,
      );
    if (!(payloadSchema instanceof z.ZodObject))
      throw new InvalidEventCatalogError("EVENT_CATALOG_INVALID", "payloadSchema");
    payloadJsonSchema(payloadSchema);
    const key = identity(parsed.data);
    if (seen.has(key))
      throw new InvalidEventCatalogError("EVENT_CATALOG_DUPLICATE", "eventIdentity");
    seen.add(key);
    return Object.freeze({
      ...parsed.data,
      consumers: Object.freeze([...parsed.data.consumers].sort()),
      payloadSchema,
    });
  });
  return Object.freeze(
    validated.sort(
      (left, right) =>
        left.eventType.localeCompare(right.eventType) - 0 ||
        left.schemaVersion - right.schemaVersion,
    ),
  );
}

export function registeredEventMetricLabels(
  catalog: readonly EventCatalogRegistration[],
): readonly string[] {
  return Object.freeze(catalog.map(identity));
}

const menuPublishedPayload = z.strictObject({
  menuReference: z.uuid(),
  menuVersionReference: z.uuid(),
  releaseReference: z.uuid(),
  snapshotDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  effectiveFrom: z.iso.datetime({ offset: false }),
  effectiveUntil: z.iso.datetime({ offset: false }).nullable(),
  timeZone: z.string().min(1).max(63),
});

const orderCreatedPayload = z.strictObject({
  orderReference: z.uuid(),
  orderBatchReference: z.uuid(),
  submissionReference: z.uuid(),
  businessDate: z.iso.date(),
  sourceSnapshotDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  itemCount: z.int().min(1).max(100),
});

const paymentSucceededPayload = z.strictObject({
  paymentTransactionReference: z.uuid(),
  paymentIntentReference: z.uuid(),
  paymentAttemptReference: z.uuid(),
  orderReference: z.uuid(),
  amountMinor: z.string().regex(/^[1-9][0-9]*$/u),
  currencyCode: z.literal("CAD"),
  evidenceKind: z.literal("Captured"),
  terminalOccurredAt: z.iso.datetime({ offset: false }),
});

const paymentFailedPayload = z.strictObject({
  paymentTransactionReference: z.uuid(),
  paymentIntentReference: z.uuid(),
  paymentAttemptReference: z.uuid(),
  orderReference: z.uuid(),
  reason: z.enum(["Declined", "AuthenticationRequired", "Cancelled", "ProviderRejected"]),
  retryDisposition: z.enum(["Never", "SameOperation", "NewOperation", "Unknown"]),
  terminalOccurredAt: z.iso.datetime({ offset: false }),
});

export const eventCatalog = defineEventCatalog([
  {
    eventType: "MenuPublished",
    schemaVersion: 1,
    ownerModule: "@rms/catalog",
    producerModule: "@rms/catalog",
    stability: "stable",
    consumers: ["catalog.published-menu-projection:v1"],
    tenantScope: "brand",
    dataClassification: "none",
    compatibility: "additive",
    retentionCategory: "business_record",
    replaySemantics: "idempotent",
    deprecated: false,
    replacement: null,
    payloadSchema: menuPublishedPayload,
  },
  {
    eventType: "OrderCreated",
    schemaVersion: 1,
    ownerModule: "@rms/ordering",
    producerModule: "@rms/ordering",
    stability: "stable",
    consumers: ["ordering.order-status-projection:v1"],
    tenantScope: "store",
    dataClassification: "indirect_identifier",
    compatibility: "additive",
    retentionCategory: "business_record",
    replaySemantics: "idempotent",
    deprecated: false,
    replacement: null,
    payloadSchema: orderCreatedPayload,
  },
  {
    eventType: "PaymentFailed",
    schemaVersion: 1,
    ownerModule: "@rms/payment",
    producerModule: "@rms/payment",
    stability: "stable",
    consumers: ["ordering.payment-outcome:v1", "payment.status-projection:v1"],
    tenantScope: "store",
    dataClassification: "payment",
    compatibility: "additive",
    retentionCategory: "business_record",
    replaySemantics: "idempotent",
    deprecated: false,
    replacement: null,
    payloadSchema: paymentFailedPayload,
  },
  {
    eventType: "PaymentSucceeded",
    schemaVersion: 1,
    ownerModule: "@rms/payment",
    producerModule: "@rms/payment",
    stability: "stable",
    consumers: ["ordering.payment-outcome:v1", "payment.status-projection:v1"],
    tenantScope: "store",
    dataClassification: "payment",
    compatibility: "additive",
    retentionCategory: "business_record",
    replaySemantics: "idempotent",
    deprecated: false,
    replacement: null,
    payloadSchema: paymentSucceededPayload,
  },
]);
