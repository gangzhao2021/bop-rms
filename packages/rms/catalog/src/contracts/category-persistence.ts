import {
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogHash,
} from "./product.js";
import {
  parseCategoryAggregate,
  transitionCategoryLifecycle,
  type CategoryAggregate,
} from "../domain/category-menu.js";
import type { CategoryOperationRecord } from "../application/ports/category-menu-ports.js";

const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_INPUT_INVALID",
): never => {
  throw new CatalogError(code);
};
/** Copy descriptors before Domain parsing. No getter, prototype, arbitrary depth,
 * sparse array or oversized payload can provide persistence facts. */
export function copyCategoryPersistenceValue(value: unknown): unknown {
  let budget = 100_000;
  const copy = (item: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 12) return fail();
    if (item === undefined || item === null || typeof item === "boolean") return item;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return fail();
      return item;
    }
    if (typeof item === "string") {
      if (item.length > 4096) return fail();
      return item;
    }
    if (!item || typeof item !== "object") return fail();
    if (Array.isArray(item)) {
      if (
        Object.getPrototypeOf(item) !== Array.prototype ||
        item.length > 10_000 ||
        Reflect.ownKeys(item).length !== item.length + 1
      )
        return fail();
      return Array.from({ length: item.length }, (_, index) => {
        const d = Object.getOwnPropertyDescriptor(item, String(index));
        if (!d?.enumerable || !("value" in d)) return fail();
        return copy(d.value, depth + 1);
      });
    }
    if (Object.getPrototypeOf(item) !== Object.prototype) return fail();
    const keys = Reflect.ownKeys(item),
      descriptors = Object.getOwnPropertyDescriptors(item);
    if (keys.length > 128) return fail();
    return Object.fromEntries(
      keys.map((key) => {
        if (typeof key !== "string") return fail();
        const d = descriptors[key];
        if (!d?.enumerable || !("value" in d)) return fail();
        return [key, copy(d.value, depth + 1)];
      }),
    );
  };
  return copy(value, 0);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail();
  return value as Record<string, unknown>;
}
export function parseCategoryOperationRecord(value: unknown): CategoryOperationRecord {
  const r = record(copyCategoryPersistenceValue(value), [
    "action",
    "operationReference",
    "operationIntentHash",
    "aggregate",
  ]);
  if (r.action !== "Create" && r.action !== "Move" && r.action !== "ChangeLifecycle") return fail();
  return Object.freeze({
    action: r.action,
    operationReference: parseCatalogReference(r.operationReference),
    operationIntentHash: parseCatalogHash(r.operationIntentHash),
    aggregate: parseCategoryAggregate(r.aggregate),
  });
}
export type CategorySourceEventType =
  | "CategoryCreated"
  | "CategoryUpdated"
  | "CategoryMoved"
  | "CategoryReordered"
  | "CategoryDeactivated"
  | "CategoryArchived"
  | "CategoryRestored";
export interface CategoryPersistenceWrite {
  readonly record: CategoryOperationRecord;
  readonly expectedAggregateVersion: number | null;
  readonly audit: AppendAuditRecordInput;
}
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
/** Validate request and Audit even on a cache hit. No current mutable state is
 * required here: an authorized retry must return its original version. */
export function parseCategoryPersistenceWrite(
  value: unknown,
  scope: {
    readonly brandReference: string;
    readonly actorReference: string;
    readonly observedAt: string;
  },
): CategoryPersistenceWrite {
  const input = record(copyCategoryPersistenceValue(value), [
      "record",
      "expectedAggregateVersion",
      "audit",
    ]),
    parsed = parseCategoryOperationRecord(input.record),
    next = parsed.aggregate,
    brand = parseCatalogReference(scope.brandReference),
    actor = parseCatalogReference(scope.actorReference),
    observedAt = parseCatalogInstant(scope.observedAt);
  if (next.brandReference !== brand) return fail("CATALOG_PERMISSION_DENIED");
  if (next.updatedAt > observedAt) return fail();
  let audit: AppendAuditRecordInput;
  try {
    audit = validateAuditRecord(input.audit as AppendAuditRecordInput, Date.parse(observedAt));
  } catch {
    return fail("CATALOG_PERMISSION_DENIED");
  }
  if (
    audit.brandId !== brand ||
    audit.storeId !== undefined ||
    audit.actor.type === "System" ||
    audit.actor.reference !== actor ||
    audit.targetType !== "CatalogCategory" ||
    audit.targetId !== next.categoryReference ||
    audit.occurredAt !== next.updatedAt ||
    audit.actionCode !== `CATALOG_CATEGORY_${parsed.action.toUpperCase()}`
  )
    return fail("CATALOG_PERMISSION_DENIED");
  if (parsed.action === "Create") {
    if (
      input.expectedAggregateVersion !== null ||
      next.aggregateVersion !== 1 ||
      next.lifecycle !== "Draft" ||
      next.createdAt !== next.updatedAt ||
      next.createdByActorReference !== actor
    )
      return fail();
  } else if (
    !Number.isSafeInteger(input.expectedAggregateVersion) ||
    (input.expectedAggregateVersion as number) < 1 ||
    (input.expectedAggregateVersion as number) >= 2147483647 ||
    next.aggregateVersion !== (input.expectedAggregateVersion as number) + 1
  )
    return fail();
  return Object.freeze({
    record: parsed,
    expectedAggregateVersion: input.expectedAggregateVersion as number | null,
    audit,
  });
}
/** Validate actual locked owner state; a retry uses the separate request parser. */
export function validateCategoryPersistenceWrite(
  value: unknown,
  currentValue: unknown,
  scope: {
    readonly brandReference: string;
    readonly actorReference: string;
    readonly observedAt: string;
  },
): CategoryPersistenceWrite & {
  readonly eventType: CategorySourceEventType;
  readonly snapshotDigest: string;
} {
  const input = parseCategoryPersistenceWrite(value, scope),
    parsed = input.record,
    next = parsed.aggregate,
    brand = parseCatalogReference(scope.brandReference),
    actor = parseCatalogReference(scope.actorReference),
    audit = input.audit;
  let eventType: CategorySourceEventType;
  if (parsed.action === "Create") {
    if (
      input.expectedAggregateVersion !== null ||
      next.aggregateVersion !== 1 ||
      next.lifecycle !== "Draft" ||
      next.createdAt !== next.updatedAt ||
      next.createdByActorReference !== actor
    )
      return fail();
    if (currentValue !== null) return fail("CATALOG_VERSION_CONFLICT");
    eventType = "CategoryCreated";
  } else {
    if (
      !Number.isSafeInteger(input.expectedAggregateVersion) ||
      (input.expectedAggregateVersion as number) < 1 ||
      (input.expectedAggregateVersion as number) >= 2147483647
    )
      return fail();
    if (currentValue === null) return fail("CATALOG_UNAVAILABLE");
    const current = parseCategoryAggregate(copyCategoryPersistenceValue(currentValue));
    if (current.brandReference !== brand || current.categoryReference !== next.categoryReference)
      return fail("CATALOG_PERMISSION_DENIED");
    if (current.aggregateVersion !== input.expectedAggregateVersion)
      return fail("CATALOG_VERSION_CONFLICT");
    if (
      next.aggregateVersion !== current.aggregateVersion + 1 ||
      next.updatedAt < current.updatedAt
    )
      return fail();
    const mutable = new Set([
      "aggregateVersion",
      "updatedAt",
      ...(parsed.action === "Move"
        ? ["parentCategoryReference", "level", "sortOrder"]
        : ["lifecycle"]),
    ]);
    for (const key of Object.keys(current) as (keyof CategoryAggregate)[])
      if (!mutable.has(key) && !equal(current[key], next[key])) return fail();
    if (parsed.action === "Move")
      eventType =
        current.parentCategoryReference === next.parentCategoryReference
          ? "CategoryReordered"
          : "CategoryMoved";
    else {
      if (transitionCategoryLifecycle(current.lifecycle, next.lifecycle) !== next.lifecycle)
        return fail("CATALOG_LIFECYCLE_CONFLICT");
      eventType =
        next.lifecycle === "Inactive"
          ? "CategoryDeactivated"
          : next.lifecycle === "Archived"
            ? "CategoryArchived"
            : current.lifecycle === "Archived"
              ? "CategoryRestored"
              : "CategoryUpdated";
    }
  }
  return Object.freeze({
    record: parsed,
    expectedAggregateVersion: input.expectedAggregateVersion as number | null,
    audit,
    eventType,
    snapshotDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(next)),
  });
}
/** Entire Brand graph required: missing parents/duplicate nodes/depth/sibling order
 * cannot become a complete source snapshot. Resource exhaustion fails, no truncation. */
export function validateCategoryTreeSnapshot(
  value: unknown,
  brandReference: string,
  maximumNodes: number,
): readonly CategoryAggregate[] {
  const brand = parseCatalogReference(brandReference);
  if (
    !Number.isSafeInteger(maximumNodes) ||
    maximumNodes < 1 ||
    maximumNodes > 1_000_000 ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximumNodes ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  const nodes = Array.from({ length: value.length }, (_, index) => {
    const d = Object.getOwnPropertyDescriptor(value, String(index));
    if (!d?.enumerable || !("value" in d)) return fail();
    return parseCategoryAggregate(copyCategoryPersistenceValue(d.value));
  });
  const byId = new Map(nodes.map((node) => [node.categoryReference, node])),
    codes = new Set<string>(),
    siblings = new Set<string>();
  if (byId.size !== nodes.length) return fail();
  for (const node of nodes) {
    if (node.brandReference !== brand || codes.has(node.internalCode)) return fail();
    codes.add(node.internalCode);
    const sibling = `${node.parentCategoryReference ?? "root"}:${node.sortOrder}`;
    if (siblings.has(sibling)) return fail();
    siblings.add(sibling);
    const seen = new Set([node.categoryReference]);
    let parent = node.parentCategoryReference,
      depth = 1;
    while (parent !== null) {
      if (seen.has(parent) || ++depth > 3) return fail();
      seen.add(parent);
      const ancestor = byId.get(parent);
      if (!ancestor) return fail();
      parent = ancestor.parentCategoryReference;
    }
    if (depth !== node.level) return fail();
  }
  return Object.freeze(nodes);
}
