import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { validateDomainEventEnvelope, type DomainEventEnvelope } from "@bop/eventing";
import { CatalogError, parseCatalogReference, parseCatalogInstant } from "./product.js";
import {
  copyCategoryPersistenceValue,
  type CategorySourceEventType,
} from "./category-persistence.js";
import type { CategoryAggregate } from "../domain/category-menu.js";
export const categorySourceEventTypes = Object.freeze([
  "CategoryCreated",
  "CategoryUpdated",
  "CategoryMoved",
  "CategoryReordered",
  "CategoryDeactivated",
  "CategoryArchived",
  "CategoryRestored",
] as const);
export interface CategorySourceSnapshot {
  readonly brandReference: string;
  readonly sourceRevision: string;
  readonly observedAt: string;
  readonly categories: readonly CategoryAggregate[];
  readonly sourceDigest: string;
}
export interface CategorySourcePort {
  loadSnapshot(): Promise<CategorySourceSnapshot>;
  proveEvent(
    event: unknown,
  ): Promise<{ readonly sourceRevision: string; readonly snapshotDigest: string }>;
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
export const categorySourceDigest = (value: unknown) =>
  "sha256:" + sha256Hex(canonicalizeRfc8785(value));
export function categorySourceRevision(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,18})$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return fail();
  return value;
}
export function categorySourceEventDigest(event: DomainEventEnvelope): string {
  return categorySourceDigest(
    JSON.parse(
      JSON.stringify(parseCategorySourceEvent(event), (_key, item: unknown) =>
        typeof item === "bigint" ? item.toString() : item,
      ),
    ),
  );
}
/** Closed Category-owned Event shape; copy descriptors before generic Eventing validation. */
export function parseCategorySourceEvent(
  value: unknown,
): DomainEventEnvelope & { readonly eventType: CategorySourceEventType } {
  try {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return fail();
    const keys = [
      "eventId",
      "eventType",
      "schemaVersion",
      "occurredAt",
      "producerModule",
      "tenantId",
      "aggregateType",
      "aggregateId",
      "aggregateVersion",
      "correlationId",
      "causationId",
      "actor",
      "payload",
      "redactionClassification",
      "replayMetadata",
    ];
    if (Reflect.ownKeys(value).length !== keys.length) return fail();
    const data: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !keys.includes(key)) return fail();
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d?.enumerable || !("value" in d)) return fail();
      data[key] =
        key === "aggregateVersion" && typeof d.value === "bigint" ? d.value.toString() : d.value;
    }
    const copied = copyCategoryPersistenceValue(data) as Record<string, unknown>;
    if (
      typeof copied.aggregateVersion !== "string" ||
      !/^[1-9][0-9]{0,9}$/u.test(copied.aggregateVersion) ||
      BigInt(copied.aggregateVersion) > 2147483647n
    )
      return fail();
    copied.aggregateVersion = BigInt(copied.aggregateVersion);
    const event = validateDomainEventEnvelope(copied as unknown as DomainEventEnvelope);
    const payload = event.payload;
    if (
      event.schemaVersion !== 1 ||
      event.producerModule !== "@rms/catalog" ||
      event.aggregateType !== "Category" ||
      event.actor.type !== "Actor" ||
      event.redactionClassification !== "indirect_identifier" ||
      !categorySourceEventTypes.includes(event.eventType as CategorySourceEventType) ||
      Object.keys(payload).length !== 6 ||
      Object.keys(payload).some(
        (key) =>
          ![
            "categoryReference",
            "aggregateVersion",
            "lifecycle",
            "operationReference",
            "sourceRevision",
            "snapshotDigest",
          ].includes(key),
      ) ||
      payload.categoryReference !== event.aggregateId ||
      payload.aggregateVersion !== event.aggregateVersion.toString() ||
      payload.operationReference !== event.causationId ||
      categorySourceRevision(payload.sourceRevision) === "0" ||
      typeof payload.snapshotDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(payload.snapshotDigest) ||
      !["Draft", "Active", "Inactive", "Archived"].includes(String(payload.lifecycle)) ||
      canonicalizeRfc8785(event.replayMetadata) !== canonicalizeRfc8785({ replaySafe: true })
    )
      return fail();
    for (const ref of [
      event.eventId,
      event.tenantId,
      event.aggregateId,
      event.correlationId,
      event.causationId,
      event.actor.actorId,
    ])
      parseCatalogReference(ref);
    parseCatalogInstant(event.occurredAt);
    if (
      (event.eventType === "CategoryCreated" &&
        (event.aggregateVersion !== 1n || payload.lifecycle !== "Draft")) ||
      (event.eventType === "CategoryDeactivated" && payload.lifecycle !== "Inactive") ||
      (event.eventType === "CategoryArchived" && payload.lifecycle !== "Archived") ||
      (event.eventType === "CategoryRestored" && payload.lifecycle !== "Draft") ||
      (event.eventType === "CategoryUpdated" && payload.lifecycle !== "Active")
    )
      return fail();
    Object.freeze(event.actor);
    Object.freeze(event.payload);
    Object.freeze(event.replayMetadata);
    return Object.freeze(event) as DomainEventEnvelope & {
      readonly eventType: CategorySourceEventType;
    };
  } catch {
    return fail();
  }
}
