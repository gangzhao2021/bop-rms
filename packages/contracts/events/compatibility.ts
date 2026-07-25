import type { EventCatalogRegistration } from "./catalog.ts";
import { payloadJsonSchema } from "./catalog.ts";

export interface EventCatalogSnapshotEntry {
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly ownerModule: string;
  readonly producerModule: string;
  readonly consumers: readonly string[];
  readonly tenantScope: string;
  readonly dataClassification: string;
  readonly retentionCategory: string;
  readonly replaySemantics: string;
  readonly payloadSchema: Readonly<Record<string, unknown>>;
}

export class EventCatalogCompatibilityError extends Error {
  readonly code:
    "EVENT_REMOVED" | "FIELD_CHANGED" | "FIELD_REMOVED" | "METADATA_CHANGED" | "NEW_REQUIRED_FIELD";
  readonly field: string;

  constructor(
    code:
      | "EVENT_REMOVED"
      | "FIELD_CHANGED"
      | "FIELD_REMOVED"
      | "METADATA_CHANGED"
      | "NEW_REQUIRED_FIELD",
    field: string,
  ) {
    super(`${code}:${field}`);
    this.name = "EventCatalogCompatibilityError";
    this.code = code;
    this.field = field;
  }
}

function identity(entry: Pick<EventCatalogSnapshotEntry, "eventType" | "schemaVersion">): string {
  return `${entry.eventType}:v${entry.schemaVersion}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function createEventCatalogSnapshot(
  catalog: readonly EventCatalogRegistration[],
): readonly EventCatalogSnapshotEntry[] {
  return catalog.map((entry) => ({
    eventType: entry.eventType,
    schemaVersion: entry.schemaVersion,
    ownerModule: entry.ownerModule,
    producerModule: entry.producerModule,
    consumers: [...entry.consumers],
    tenantScope: entry.tenantScope,
    dataClassification: entry.dataClassification,
    retentionCategory: entry.retentionCategory,
    replaySemantics: entry.replaySemantics,
    payloadSchema: payloadJsonSchema(entry.payloadSchema),
  }));
}

function objectShape(schema: Readonly<Record<string, unknown>>, label: string) {
  const properties = schema.properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties))
    throw new EventCatalogCompatibilityError("FIELD_CHANGED", label);
  const required = Array.isArray(schema.required)
    ? new Set(schema.required.filter((value): value is string => typeof value === "string"))
    : new Set<string>();
  return { properties: properties as Record<string, unknown>, required };
}

export function assertEventCatalogBackwardCompatible(
  previous: readonly EventCatalogSnapshotEntry[],
  current: readonly EventCatalogSnapshotEntry[],
): void {
  const currentByIdentity = new Map(current.map((entry) => [identity(entry), entry]));
  for (const oldEntry of previous) {
    const key = identity(oldEntry);
    const nextEntry = currentByIdentity.get(key);
    if (!nextEntry) throw new EventCatalogCompatibilityError("EVENT_REMOVED", key);
    for (const field of [
      "ownerModule",
      "producerModule",
      "tenantScope",
      "dataClassification",
      "retentionCategory",
      "replaySemantics",
    ] as const) {
      if (oldEntry[field] !== nextEntry[field])
        throw new EventCatalogCompatibilityError("METADATA_CHANGED", `${key}.${field}`);
    }
    if (oldEntry.consumers.some((consumer) => !nextEntry.consumers.includes(consumer)))
      throw new EventCatalogCompatibilityError("METADATA_CHANGED", `${key}.consumers`);
    const oldShape = objectShape(oldEntry.payloadSchema, key);
    const nextShape = objectShape(nextEntry.payloadSchema, key);
    for (const [field, schema] of Object.entries(oldShape.properties)) {
      if (!(field in nextShape.properties))
        throw new EventCatalogCompatibilityError("FIELD_REMOVED", `${key}.${field}`);
      if (canonical(schema) !== canonical(nextShape.properties[field]))
        throw new EventCatalogCompatibilityError("FIELD_CHANGED", `${key}.${field}`);
      if (oldShape.required.has(field) !== nextShape.required.has(field))
        throw new EventCatalogCompatibilityError("FIELD_CHANGED", `${key}.${field}`);
    }
    for (const field of nextShape.required) {
      if (!(field in oldShape.properties))
        throw new EventCatalogCompatibilityError("NEW_REQUIRED_FIELD", `${key}.${field}`);
    }
  }
}
