import { z } from "zod";

const eventType = /^[A-Z][A-Za-z0-9]{0,127}$/u;
const moduleName = /^@(bop|rms)\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const consumerName = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*:v[1-9][0-9]*$/u;
const replacementIdentity = /^[A-Z][A-Za-z0-9]{0,127}:v[1-9][0-9]*$/u;
const canonicalUuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

const fulfillmentCompletedPayload = z.strictObject({
  fulfillmentReference: z.string().regex(canonicalUuidV7),
  orderReference: z.string().regex(canonicalUuidV7),
  handoffRecordReference: z.string().regex(canonicalUuidV7),
  storeReference: z.string().regex(canonicalUuidV7),
  verificationMethod: z.enum(["Opaque", "HumanCode"]),
  completedAt: z.iso.datetime({ offset: false }),
});

const kitchenWorkCreatedPayload = z.strictObject({
  kitchenTicketReference: z.uuid(),
  orderReference: z.uuid(),
  orderBatchReference: z.uuid(),
  confirmationReference: z.uuid(),
  workItemCount: z.int().min(1).max(100),
  aggregateVersion: z.literal(1),
  createdAt: z.iso.datetime({ offset: false }),
});

const kitchenWorkAcceptedPayload = z.strictObject({
  kitchenTicketReference: z.string().regex(canonicalUuidV7),
  kitchenWorkItemReference: z.string().regex(canonicalUuidV7),
  orderItemReference: z.string().regex(canonicalUuidV7),
  ticketVersion: z.string().regex(/^[1-9][0-9]*$/u),
  workItemVersion: z.string().regex(/^[1-9][0-9]*$/u),
  workItemStatus: z.literal("Queued"),
  acceptedAt: z.iso.datetime({ offset: false }),
});

const kitchenWorkStartedPayload = z.strictObject({
  kitchenTicketReference: z.string().regex(canonicalUuidV7),
  kitchenWorkItemReference: z.string().regex(canonicalUuidV7),
  orderItemReference: z.string().regex(canonicalUuidV7),
  ticketVersion: z.string().regex(/^[1-9][0-9]*$/u),
  workItemVersion: z.string().regex(/^[1-9][0-9]*$/u),
  fromStatus: z.literal("Queued"),
  toStatus: z.literal("In Progress"),
  startedAt: z.iso.datetime({ offset: false }),
});

const kitchenItemProgressRecordedPayload = z
  .strictObject({
    kitchenTicketReference: z.string().regex(canonicalUuidV7),
    kitchenWorkItemReference: z.string().regex(canonicalUuidV7),
    orderItemReference: z.string().regex(canonicalUuidV7),
    ticketVersion: z.string().regex(/^[1-9][0-9]*$/u),
    workItemVersion: z.string().regex(/^[1-9][0-9]*$/u),
    quantityDelta: z.int().min(1).max(999),
    completedQuantity: z.int().min(1).max(998),
    requiredQuantity: z.int().min(2).max(999),
    fromStatus: z.literal("In Progress"),
    toStatus: z.literal("In Progress"),
    recordedAt: z.iso.datetime({ offset: false }),
  })
  .refine(
    (payload) =>
      payload.quantityDelta <= payload.completedQuantity &&
      payload.completedQuantity < payload.requiredQuantity,
  );

const kitchenItemCompletedPayload = z
  .strictObject({
    kitchenTicketReference: z.string().regex(canonicalUuidV7),
    kitchenWorkItemReference: z.string().regex(canonicalUuidV7),
    orderItemReference: z.string().regex(canonicalUuidV7),
    ticketVersion: z.string().regex(/^[1-9][0-9]*$/u),
    workItemVersion: z.string().regex(/^[1-9][0-9]*$/u),
    quantityDelta: z.int().min(1).max(999),
    completedQuantity: z.int().min(1).max(999),
    requiredQuantity: z.int().min(1).max(999),
    fromStatus: z.literal("In Progress"),
    toStatus: z.literal("Completed"),
    completedAt: z.iso.datetime({ offset: false }),
  })
  .refine(
    (payload) =>
      payload.quantityDelta <= payload.completedQuantity &&
      payload.completedQuantity === payload.requiredQuantity,
  );

const kitchenItemReadyPayload = z
  .strictObject({
    kitchenTicketReference: z.string().regex(canonicalUuidV7),
    orderReference: z.string().regex(canonicalUuidV7),
    orderBatchReference: z.string().regex(canonicalUuidV7),
    orderItemReference: z.string().regex(canonicalUuidV7),
    readyResultReference: z.string().regex(canonicalUuidV7),
    readyQuantity: z.int().min(1).max(999),
    requiredQuantity: z.int().min(1).max(999),
    readyAt: z.iso.datetime({ offset: false }),
  })
  .refine((payload) => payload.readyQuantity === payload.requiredQuantity);

const kitchenOrderReadyPayload = z
  .strictObject({
    kitchenTicketReference: z.string().regex(canonicalUuidV7),
    orderReference: z.string().regex(canonicalUuidV7),
    orderBatchReference: z.string().regex(canonicalUuidV7),
    readyItemCount: z.int().min(1).max(100),
    itemCount: z.int().min(1).max(100),
    readyAt: z.iso.datetime({ offset: false }),
  })
  .refine((payload) => payload.readyItemCount === payload.itemCount);

const menuPublishedPayload = z.strictObject({
  menuReference: z.uuid(),
  menuVersionReference: z.uuid(),
  releaseReference: z.uuid(),
  snapshotDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  effectiveFrom: z.iso.datetime({ offset: false }),
  effectiveUntil: z.iso.datetime({ offset: false }).nullable(),
  timeZone: z.string().min(1).max(63),
});

const bundleLifecyclePayload = z.strictObject({
  bundleReference: z.string().regex(canonicalUuidV7),
  bundleVersionReference: z.string().regex(canonicalUuidV7),
  aggregateVersion: z.string().regex(/^[1-9][0-9]*$/u),
  lifecycle: z.enum(["Draft", "Published", "Suspended", "Discontinued", "Archived"]),
  validationDigest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/u)
    .nullable(),
});

const availabilityRulePayload = z.strictObject({
  availabilityRuleReference: z.string().regex(canonicalUuidV7),
  aggregateVersion: z.string().regex(/^[1-9][0-9]*$/u),
  sellableType: z.enum(["Product", "Sku", "Bundle"]),
  lifecycle: z.enum(["Draft", "Active", "Inactive", "Archived"]),
  occurredAt: z.iso.datetime({ offset: false }),
});

const priceBookPayload = z.strictObject({
  priceBookReference: z.string().regex(canonicalUuidV7),
  versionReference: z.string().regex(canonicalUuidV7),
  aggregateVersion: z.string().regex(/^[1-9][0-9]*$/u),
  lifecycle: z.enum(["Draft", "Published", "Archived"]),
  currencyCode: z.string().regex(/^[A-Z]{3}$/u),
  snapshotDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  occurredAt: z.iso.datetime({ offset: false }),
});

const taxConfigPayload = z.strictObject({
  configurationReference: z.string().regex(canonicalUuidV7),
  versionReference: z.string().regex(canonicalUuidV7),
  aggregateVersion: z.string().regex(/^[1-9][0-9]*$/u),
  lifecycle: z.enum(["Draft", "Published"]),
  jurisdictionCode: z.string().regex(/^[A-Z][A-Z0-9_-]{0,63}$/u),
  snapshotDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  occurredAt: z.iso.datetime({ offset: false }),
});

const promotionPayload = z.strictObject({
  promotionReference: z.string().regex(canonicalUuidV7),
  versionReference: z.string().regex(canonicalUuidV7),
  aggregateVersion: z.string().regex(/^[1-9][0-9]*$/u),
  lifecycle: z.enum(["Draft", "Published", "Paused", "Archived"]),
  snapshotDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  occurredAt: z.iso.datetime({ offset: false }),
});

const recipePayload = z.strictObject({
  recipeReference: z.string().regex(canonicalUuidV7),
  versionReference: z.string().regex(canonicalUuidV7),
  aggregateVersion: z.string().regex(/^[1-9][0-9]*$/u),
  lifecycle: z.enum(["Draft", "Published", "Invalidated", "Archived"]),
  snapshotDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  occurredAt: z.iso.datetime({ offset: false }),
});

const reportDefinitionPayload = z.strictObject({
  reportReference: z.string().regex(canonicalUuidV7),
  versionReference: z.string().regex(canonicalUuidV7),
  aggregateVersion: z.string().regex(/^[1-9][0-9]*$/u),
  lifecycle: z.enum(["Draft", "InReview", "Published", "Archived"]),
  certificationStatus: z.enum(["Draft", "InReview", "Certified"]),
  snapshotDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  occurredAt: z.iso.datetime({ offset: false }),
});

const metricDefinitionPayload = z.strictObject({
  metricReference: z.string().regex(canonicalUuidV7),
  versionReference: z.string().regex(canonicalUuidV7),
  aggregateVersion: z.string().regex(/^[1-9][0-9]*$/u),
  lifecycle: z.enum(["Draft", "InReview", "Certified", "Deprecated", "Archived"]),
  certificationStatus: z.enum(["Draft", "InReview", "Certified", "Deprecated"]),
  ownerDomainCode: z.string().regex(/^[A-Z][A-Z0-9_.:-]{0,63}$/u),
  snapshotDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  replacementMetricReference: z.string().regex(canonicalUuidV7).nullable(),
  occurredAt: z.iso.datetime({ offset: false }),
});

const reportSchedulePayload = z.strictObject({
  scheduleReference: z.string().regex(canonicalUuidV7),
  scheduleVersionReference: z.string().regex(canonicalUuidV7),
  reportReference: z.string().regex(canonicalUuidV7),
  reportVersionReference: z.string().regex(canonicalUuidV7),
  status: z.enum(["Active", "Paused", "Archived"]),
  cadence: z.enum(["Daily", "Weekly", "Monthly"]),
  format: z.enum(["Csv", "Json"]),
  timezone: z.string().regex(/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/u),
  occurredAt: z.iso.datetime({ offset: false }),
});

const reportRunQueuedPayload = z.strictObject({
  runReference: z.string().regex(canonicalUuidV7),
  reportReference: z.string().regex(canonicalUuidV7),
  reportVersionReference: z.string().regex(canonicalUuidV7),
  parameterSnapshotDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  triggerKind: z.enum(["Manual", "Scheduled"]),
  queuedAt: z.iso.datetime({ offset: false }),
});

const reportRunStatePayload = z.strictObject({
  runReference: z.string().regex(canonicalUuidV7),
  stateReference: z.string().regex(canonicalUuidV7),
  sequence: z.string().regex(/^[1-9][0-9]*$/u),
  status: z.union([
    z.literal("Queued"),
    z.literal("Running"),
    z.literal("Completed"),
    z.literal("CompletedWithWarning"),
    z.literal("Failed"),
    z.literal("Cancelled"),
  ]),
  dataAsOf: z.iso.datetime({ offset: false }).nullable(),
  generatedAt: z.iso.datetime({ offset: false }).nullable(),
  rowCount: z
    .string()
    .regex(/^(?:0|[1-9][0-9]*)$/u)
    .nullable(),
  summaryDigest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/u)
    .nullable(),
  errorCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_.:-]{0,63}$/u)
    .nullable(),
  occurredAt: z.iso.datetime({ offset: false }),
});

const reportArtifactRevisionPayload = z.strictObject({
  artifactReference: z.string().regex(canonicalUuidV7),
  revisionReference: z.string().regex(canonicalUuidV7),
  runReference: z.string().regex(canonicalUuidV7),
  revisionNumber: z.string().regex(/^[1-9][0-9]*$/u),
  outputAssetReference: z.string().regex(canonicalUuidV7),
  format: z.enum(["Csv", "Spreadsheet", "Pdf"]),
  classification: z.enum(["Public", "Internal", "Confidential", "Restricted"]),
  expiresAt: z.iso.datetime({ offset: false }),
  occurredAt: z.iso.datetime({ offset: false }),
});

const reportArtifactRevokedPayload = z.strictObject({
  artifactReference: z.string().regex(canonicalUuidV7),
  revisionReference: z.string().regex(canonicalUuidV7),
  reasonCode: z.string().regex(/^[A-Z][A-Z0-9_.:-]{0,63}$/u),
  revokedAt: z.iso.datetime({ offset: false }),
});

const orderCreatedPayload = z.strictObject({
  orderReference: z.uuid(),
  orderBatchReference: z.uuid(),
  submissionReference: z.uuid(),
  businessDate: z.iso.date(),
  sourceSnapshotDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  itemCount: z.int().min(1).max(100),
});

const orderConfirmedPayload = z.strictObject({
  confirmationReference: z.uuid(),
  orderReference: z.uuid(),
  orderBatchReference: z.uuid(),
  sourceSnapshotDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  confirmedAt: z.iso.datetime({ offset: false }),
});

const orderAmendedPayload = z.strictObject({
  amendmentReference: z.string().regex(canonicalUuidV7),
  orderReference: z.string().regex(canonicalUuidV7),
  aggregateVersion: z.string().regex(/^[1-9][0-9]*$/u),
  amendmentKind: z
    .string()
    .regex(/^(?:AddItem|ReduceItem|VoidItem|ReplaceItemConfiguration|UpdateNote)$/u),
  quoteReference: z.string().regex(canonicalUuidV7),
  quoteVersion: z.string().regex(/^[1-9][0-9]*$/u),
  deltaMinor: z.string().regex(/^-?(?:0|[1-9][0-9]{0,29})$/u),
  currencyCode: z.string().regex(/^[A-Z]{3}$/u),
  occurredAt: z.iso.datetime({ offset: false }),
});

const productionBatchPayload = z.strictObject({
  productionBatchReference: z.string().regex(canonicalUuidV7),
  recipeReference: z.string().regex(canonicalUuidV7),
  recipeVersionReference: z.string().regex(canonicalUuidV7),
  aggregateVersion: z.string().regex(/^[1-9][0-9]*$/u),
  status: z.enum(["Planned", "InProgress", "Completed", "Quarantined"]),
  plannedYieldMicrounits: z.string().regex(/^[1-9][0-9]*$/u),
  actualYieldMicrounits: z
    .string()
    .regex(/^(?:0|[1-9][0-9]*)$/u)
    .nullable(),
  qualityHold: z.boolean(),
  occurredAt: z.iso.datetime({ offset: false }),
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

const paymentRefundedPayload = z.strictObject({
  refundReference: z.uuid(),
  compensationCaseReference: z.uuid(),
  paymentTransactionReference: z.uuid(),
  paymentIntentReference: z.uuid(),
  paymentAttemptReference: z.uuid(),
  orderReference: z.uuid(),
  amountMinor: z.string().regex(/^[1-9][0-9]*$/u),
  currencyCode: z.literal("CAD"),
  refundKind: z.literal("PaidWithoutFulfillableOrderCompensation"),
  providerConfirmedAt: z.iso.datetime({ offset: false }),
});

export const eventCatalog = defineEventCatalog([
  ...[
    "MetricArchived",
    "MetricCertified",
    "MetricDefinitionDraftRecorded",
    "MetricDefinitionPublished",
    "MetricDefinitionReviewSubmitted",
    "MetricDeprecated",
  ].map((eventType) => ({
    eventType,
    schemaVersion: 1,
    ownerModule: "@rms/business-intelligence" as const,
    producerModule: "@rms/business-intelligence" as const,
    stability: "stable" as const,
    consumers: ["reporting.metric-catalog-projection:v1"],
    tenantScope: "brand" as const,
    dataClassification: "indirect_identifier" as const,
    compatibility: "additive" as const,
    retentionCategory: "business_record" as const,
    replaySemantics: "idempotent" as const,
    deprecated: false,
    replacement: null,
    payloadSchema: metricDefinitionPayload,
  })),
  ...[
    "ReportDefinitionArchived",
    "ReportDefinitionDraftCreated",
    "ReportDefinitionDraftReplaced",
    "ReportDefinitionPublished",
    "ReportDefinitionReviewSubmitted",
  ].map((eventType) => ({
    eventType,
    schemaVersion: 1,
    ownerModule: "@rms/business-intelligence" as const,
    producerModule: "@rms/business-intelligence" as const,
    stability: "stable" as const,
    consumers: ["reporting.report-catalog-projection:v1"],
    tenantScope: "brand" as const,
    dataClassification: "indirect_identifier" as const,
    compatibility: "additive" as const,
    retentionCategory: "business_record" as const,
    replaySemantics: "idempotent" as const,
    deprecated: false,
    replacement: null,
    payloadSchema: reportDefinitionPayload,
  })),
  {
    eventType: "ReportScheduleVersionRecorded",
    schemaVersion: 1,
    ownerModule: "@rms/business-intelligence",
    producerModule: "@rms/business-intelligence",
    stability: "stable",
    consumers: ["reporting.report-scheduler:v1"],
    tenantScope: "brand",
    dataClassification: "indirect_identifier",
    compatibility: "additive",
    retentionCategory: "business_record",
    replaySemantics: "idempotent",
    deprecated: false,
    replacement: null,
    payloadSchema: reportSchedulePayload,
  },
  ...[
    ["ReportRunQueued", reportRunQueuedPayload],
    ["ReportRunStateRecorded", reportRunStatePayload],
    ["ReportArtifactRevisionRecorded", reportArtifactRevisionPayload],
    ["ReportArtifactRevoked", reportArtifactRevokedPayload],
  ].map(([eventType, payloadSchema]) => ({
    eventType: eventType as string,
    schemaVersion: 1,
    ownerModule: "@rms/business-intelligence" as const,
    producerModule: "@rms/business-intelligence" as const,
    stability: "stable" as const,
    consumers: ["reporting.report-run-history-projection:v1"],
    tenantScope: "brand" as const,
    dataClassification: "indirect_identifier" as const,
    compatibility: "additive" as const,
    retentionCategory: "business_record" as const,
    replaySemantics: "idempotent" as const,
    deprecated: false,
    replacement: null,
    payloadSchema: payloadSchema as z.ZodObject,
  })),
  ...[
    "ProductionBatchPlanned",
    "ProductionBatchStarted",
    "ProductionBatchObservationRecorded",
    "ProductionBatchCompleted",
    "ProductionBatchQuarantined",
  ].map((eventType) => ({
    eventType,
    schemaVersion: 1,
    ownerModule: "@rms/kitchen" as const,
    producerModule: "@rms/kitchen" as const,
    stability: "stable" as const,
    consumers:
      eventType === "ProductionBatchObservationRecorded" || eventType === "ProductionBatchCompleted"
        ? ["inventory.batch-consumption:v1", "kitchen.batch-projection:v1"]
        : ["kitchen.batch-projection:v1"],
    tenantScope: "store" as const,
    dataClassification: "indirect_identifier" as const,
    compatibility: "additive" as const,
    retentionCategory: "business_record" as const,
    replaySemantics: "idempotent" as const,
    deprecated: false,
    replacement: null,
    payloadSchema: productionBatchPayload,
  })),
  ...[
    "RecipeArchived",
    "RecipeDraftCreated",
    "RecipeDraftReplaced",
    "RecipeInvalidated",
    "RecipePublished",
  ].map((eventType) => ({
    eventType,
    schemaVersion: 1,
    ownerModule: "@rms/recipe" as const,
    producerModule: "@rms/recipe" as const,
    stability: "stable" as const,
    consumers: ["recipe.admin-projection:v1"],
    tenantScope: "brand" as const,
    dataClassification: "none" as const,
    compatibility: "additive" as const,
    retentionCategory: "business_record" as const,
    replaySemantics: "idempotent" as const,
    deprecated: false,
    replacement: null,
    payloadSchema: recipePayload,
  })),
  ...[
    "PromotionArchived",
    "PromotionDraftCreated",
    "PromotionDraftReplaced",
    "PromotionPaused",
    "PromotionPublished",
  ].map((eventType) => ({
    eventType,
    schemaVersion: 1,
    ownerModule: "@rms/pricing" as const,
    producerModule: "@rms/pricing" as const,
    stability: "stable" as const,
    consumers: ["pricing.promotion-admin-projection:v1"],
    tenantScope: "brand" as const,
    dataClassification: "none" as const,
    compatibility: "additive" as const,
    retentionCategory: "business_record" as const,
    replaySemantics: "idempotent" as const,
    deprecated: false,
    replacement: null,
    payloadSchema: promotionPayload,
  })),
  ...["TaxConfigDraftCreated", "TaxConfigDraftReplaced", "TaxConfigPublished"].map((eventType) => ({
    eventType,
    schemaVersion: 1,
    ownerModule: "@rms/pricing" as const,
    producerModule: "@rms/pricing" as const,
    stability: "stable" as const,
    consumers: ["pricing.tax-config-admin-projection:v1"],
    tenantScope: "store" as const,
    dataClassification: "none" as const,
    compatibility: "additive" as const,
    retentionCategory: "business_record" as const,
    replaySemantics: "idempotent" as const,
    deprecated: false,
    replacement: null,
    payloadSchema: taxConfigPayload,
  })),
  ...[
    "PriceBookArchived",
    "PriceBookDraftCreated",
    "PriceBookDraftReplaced",
    "PriceBookVersionPublished",
  ].map((eventType) => ({
    eventType,
    schemaVersion: 1,
    ownerModule: "@rms/pricing" as const,
    producerModule: "@rms/pricing" as const,
    stability: "stable" as const,
    consumers: ["pricing.price-book-admin-projection:v1"],
    tenantScope: "brand" as const,
    dataClassification: "none" as const,
    compatibility: "additive" as const,
    retentionCategory: "business_record" as const,
    replaySemantics: "idempotent" as const,
    deprecated: false,
    replacement: null,
    payloadSchema: priceBookPayload,
  })),
  ...[
    "AvailabilityRuleCreated",
    "AvailabilityRuleReplaced",
    "AvailabilityRuleLifecycleChanged",
  ].map((eventType) => ({
    eventType,
    schemaVersion: 1,
    ownerModule: "@rms/catalog" as const,
    producerModule: "@rms/catalog" as const,
    stability: "stable" as const,
    consumers: ["catalog.availability-workbench-projection:v1"],
    tenantScope: "brand" as const,
    dataClassification: "none" as const,
    compatibility: "additive" as const,
    retentionCategory: "business_record" as const,
    replaySemantics: "idempotent" as const,
    deprecated: false,
    replacement: null,
    payloadSchema: availabilityRulePayload,
  })),
  ...[
    ["BundleDraftCreated", "catalog.bundle-management-projection:v1"],
    ["BundleDraftReplaced", "catalog.bundle-management-projection:v1"],
    ["BundleLifecycleChanged", "catalog.bundle-management-projection:v1"],
    ["BundleVersionPublished", "catalog.bundle-menu-projection:v1"],
  ].map(([eventType, consumer]) => ({
    eventType: eventType as string,
    schemaVersion: 1,
    ownerModule: "@rms/catalog" as const,
    producerModule: "@rms/catalog" as const,
    stability: "stable" as const,
    consumers: [consumer as string],
    tenantScope: "brand" as const,
    dataClassification: "none" as const,
    compatibility: "additive" as const,
    retentionCategory: "business_record" as const,
    replaySemantics: "idempotent" as const,
    deprecated: false,
    replacement: null,
    payloadSchema: bundleLifecyclePayload,
  })),
  {
    eventType: "FulfillmentCompleted",
    schemaVersion: 1,
    ownerModule: "@rms/fulfillment",
    producerModule: "@rms/fulfillment",
    stability: "stable",
    consumers: ["ordering.fulfillment-completed:v1"],
    tenantScope: "store",
    dataClassification: "indirect_identifier",
    compatibility: "additive",
    retentionCategory: "business_record",
    replaySemantics: "idempotent",
    deprecated: false,
    replacement: null,
    payloadSchema: fulfillmentCompletedPayload,
  },
  {
    eventType: "KitchenItemCompleted",
    schemaVersion: 1,
    ownerModule: "@rms/kitchen",
    producerModule: "@rms/kitchen",
    stability: "stable",
    consumers: ["kitchen.queue-item-completed-projection:v1"],
    tenantScope: "store",
    dataClassification: "personal",
    compatibility: "additive",
    retentionCategory: "business_record",
    replaySemantics: "idempotent",
    deprecated: false,
    replacement: null,
    payloadSchema: kitchenItemCompletedPayload,
  },
  {
    eventType: "KitchenItemProgressRecorded",
    schemaVersion: 1,
    ownerModule: "@rms/kitchen",
    producerModule: "@rms/kitchen",
    stability: "stable",
    consumers: ["kitchen.queue-item-progress-projection:v1"],
    tenantScope: "store",
    dataClassification: "personal",
    compatibility: "additive",
    retentionCategory: "business_record",
    replaySemantics: "idempotent",
    deprecated: false,
    replacement: null,
    payloadSchema: kitchenItemProgressRecordedPayload,
  },
  {
    eventType: "KitchenItemReady",
    schemaVersion: 1,
    ownerModule: "@rms/kitchen",
    producerModule: "@rms/kitchen",
    stability: "stable",
    consumers: ["fulfillment.kitchen-item-ready:v1"],
    tenantScope: "store",
    dataClassification: "indirect_identifier",
    compatibility: "additive",
    retentionCategory: "business_record",
    replaySemantics: "idempotent",
    deprecated: false,
    replacement: null,
    payloadSchema: kitchenItemReadyPayload,
  },
  {
    eventType: "KitchenOrderReady",
    schemaVersion: 1,
    ownerModule: "@rms/kitchen",
    producerModule: "@rms/kitchen",
    stability: "stable",
    consumers: ["fulfillment.kitchen-order-ready:v1"],
    tenantScope: "store",
    dataClassification: "indirect_identifier",
    compatibility: "additive",
    retentionCategory: "business_record",
    replaySemantics: "idempotent",
    deprecated: false,
    replacement: null,
    payloadSchema: kitchenOrderReadyPayload,
  },
  {
    eventType: "KitchenWorkAccepted",
    schemaVersion: 1,
    ownerModule: "@rms/kitchen",
    producerModule: "@rms/kitchen",
    stability: "stable",
    consumers: ["kitchen.queue-work-accepted-projection:v1"],
    tenantScope: "store",
    dataClassification: "personal",
    compatibility: "additive",
    retentionCategory: "business_record",
    replaySemantics: "idempotent",
    deprecated: false,
    replacement: null,
    payloadSchema: kitchenWorkAcceptedPayload,
  },
  {
    eventType: "KitchenWorkCreated",
    schemaVersion: 1,
    ownerModule: "@rms/kitchen",
    producerModule: "@rms/kitchen",
    stability: "stable",
    consumers: ["kitchen.queue-projection:v1"],
    tenantScope: "store",
    dataClassification: "indirect_identifier",
    compatibility: "additive",
    retentionCategory: "business_record",
    replaySemantics: "idempotent",
    deprecated: false,
    replacement: null,
    payloadSchema: kitchenWorkCreatedPayload,
  },
  {
    eventType: "KitchenWorkStarted",
    schemaVersion: 1,
    ownerModule: "@rms/kitchen",
    producerModule: "@rms/kitchen",
    stability: "stable",
    consumers: ["kitchen.queue-work-started-projection:v1"],
    tenantScope: "store",
    dataClassification: "personal",
    compatibility: "additive",
    retentionCategory: "business_record",
    replaySemantics: "idempotent",
    deprecated: false,
    replacement: null,
    payloadSchema: kitchenWorkStartedPayload,
  },
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
    eventType: "OrderAmended",
    schemaVersion: 1,
    ownerModule: "@rms/ordering",
    producerModule: "@rms/ordering",
    stability: "stable",
    consumers: [
      "inventory.order-amendment:v1",
      "kitchen.order-amendment:v1",
      "ordering.amendment-projection:v1",
      "payment.order-amendment:v1",
    ],
    tenantScope: "store",
    dataClassification: "indirect_identifier",
    compatibility: "additive",
    retentionCategory: "business_record",
    replaySemantics: "idempotent",
    deprecated: false,
    replacement: null,
    payloadSchema: orderAmendedPayload,
  },
  {
    eventType: "OrderConfirmed",
    schemaVersion: 1,
    ownerModule: "@rms/ordering",
    producerModule: "@rms/ordering",
    stability: "stable",
    consumers: ["kitchen.confirmed-order:v1", "fulfillment.confirmed-order:v1"],
    tenantScope: "store",
    dataClassification: "indirect_identifier",
    compatibility: "additive",
    retentionCategory: "business_record",
    replaySemantics: "idempotent",
    deprecated: false,
    replacement: null,
    payloadSchema: orderConfirmedPayload,
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
    eventType: "PaymentRefunded",
    schemaVersion: 1,
    ownerModule: "@rms/payment",
    producerModule: "@rms/payment",
    stability: "stable",
    consumers: ["payment.status-projection:v1", "operations.order-exception:v1"],
    tenantScope: "store",
    dataClassification: "payment",
    compatibility: "additive",
    retentionCategory: "business_record",
    replaySemantics: "idempotent",
    deprecated: false,
    replacement: null,
    payloadSchema: paymentRefundedPayload,
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
