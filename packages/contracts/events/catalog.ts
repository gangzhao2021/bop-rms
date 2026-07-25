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

export const eventCatalog = defineEventCatalog([]);
