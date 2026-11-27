import {
  parseInventoryProductPublicationReferenceRequestV2,
  inventoryProductPublicationReferenceRequestFieldsV2,
  type InventoryProductPublicationReferenceRequestV2,
} from "./product-publication-reference-request-v2.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  InventoryItemError,
  parseInventoryReference,
  parseInventoryInstant,
} from "../domain/inventory-item.js";
import {
  parseInventoryConfigurationReferenceSnapshot,
  parseInventoryProductPublicationConfigurationReferenceSnapshotV2,
  type InventoryProductPublicationConfigurationReferenceSnapshotV2,
  parseInventoryConfigurationReferenceRequest,
  inventoryConfigurationReferenceMaximumRows,
  inventoryConfigurationReferenceFields,
  type InventoryConfigurationReferenceRequest,
  type InventoryConfigurationReferenceSnapshot,
} from "./configuration-reference-source.js";
import type { InventorySkuMappingTarget } from "../domain/inventory-sku-mapping.js";
const mappingFields = [
  "tenantReference",
  "brandReference",
  "mappingReference",
  "itemReference",
  "mappingVersion",
  "sourceItemVersion",
  "sourceConfigurationOperationReference",
  "action",
  "target",
  "operationReference",
  "mappingIntentDigest",
  "occurredAt",
] as const;
export const inventorySkuMappingReferenceFields = Object.freeze([
  ...new Set([
    ...inventoryConfigurationReferenceFields,
    ...mappingFields,
    "target.productReference",
    "target.productVersionReference",
    "target.skuReference",
    "target.catalogConfigurationDigest",
    "current",
    "sourceConfigurationState",
    "currentMappingReference",
    "currentMappingVersion",
    "coverage",
    "currentLink",
  ]),
]);
export interface InventorySkuMappingReference {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly mappingReference: string;
  readonly itemReference: string;
  readonly mappingVersion: number;
  readonly sourceItemVersion: number;
  readonly sourceConfigurationOperationReference: string;
  readonly action: "Set" | "Clear";
  readonly target: InventorySkuMappingTarget | null;
  readonly operationReference: string;
  readonly mappingIntentDigest: string;
  readonly occurredAt: string;
  readonly current: boolean;
  readonly sourceConfigurationState: "Current" | "Historical";
}
export interface InventorySkuMappingItemCoverage {
  readonly itemReference: string;
  readonly currentMappingReference: string | null;
  readonly currentMappingVersion: number | null;
  readonly coverage: "Recorded" | "NotRecorded" | "NotApplicable";
  readonly currentLink: "Mapped" | "ExplicitlyCleared" | "Unknown" | "NotApplicable";
}
export interface InventorySkuMappingReferenceSnapshot {
  readonly request: InventoryConfigurationReferenceRequest;
  readonly profile: "BrandInventorySkuMappingReferencesV1";
  readonly coverage: "CompleteStoredMappingReferences";
  readonly consistency: "HeldInventoryConfigurationSnapshot";
  readonly applicability: "Unavailable";
  readonly sourceVersionKind: "InventoryItemSkuMappingVersion";
  readonly generation: string;
  readonly observedAt: string;
  readonly digest: string;
  readonly configuration: InventoryConfigurationReferenceSnapshot;
  readonly mappings: readonly InventorySkuMappingReference[];
  readonly items: readonly InventorySkuMappingItemCoverage[];
}
const fail = (): never => {
  throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
};
function exact(v: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).length !== fields.length
  )
    return fail();
  const r: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(v, field);
    if (!d?.enumerable || !("value" in d)) return fail();
    r[field] = d.value;
  }
  return r;
}
function list(v: unknown): unknown[] {
  if (
    !Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Array.prototype ||
    v.length > inventoryConfigurationReferenceMaximumRows ||
    Reflect.ownKeys(v).length !== v.length + 1
  )
    return fail();
  return Array.from({ length: v.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(v, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value;
  });
}
function version(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "string" || v.length > 16 || !/^[1-9][0-9]*$/.test(v)) return fail();
  const n = Number(v);
  return Number.isSafeInteger(n) && n <= max ? n : fail();
}
function hash(v: unknown): string {
  return typeof v === "string" && /^sha256:[0-9a-f]{64}$/.test(v) ? v : fail();
}
/** Complete stored direct links, with explicit unknown coverage for legacy Items.
 * Does not resolve Recipe usage, Catalog current configuration or stock applicability. */
function parseMappingGraph(
  value: unknown,
  configuration: Pick<
    InventoryConfigurationReferenceSnapshot,
    "items" | "versions" | "operations" | "generation" | "observedAt"
  >,
  request: { readonly tenantReference: string; readonly brandReference: string },
  now: string,
) {
  try {
    const r = exact(value, ["generation", "observedAt", "count", "mappings"]),
      raw = list(r.mappings),
      at = parseInventoryInstant(now),
      mappingObservedAt = parseInventoryInstant(r.observedAt);
    if (
      (r.generation === null && raw.length === 0 && configuration.items.length === 0
        ? "0"
        : r.generation) !== configuration.generation ||
      r.count !== String(raw.length) ||
      at < mappingObservedAt ||
      Date.parse(at) - Date.parse(mappingObservedAt) > 5000 ||
      raw.length +
        configuration.items.length +
        configuration.versions.length +
        configuration.operations.length >
        inventoryConfigurationReferenceMaximumRows
    )
      return fail();
    const observedAt =
      mappingObservedAt < configuration.observedAt ? mappingObservedAt : configuration.observedAt;
    const roots = new Map(configuration.items.map((v) => [v.itemReference, v])),
      versions = new Map(
        configuration.versions.map((v) => [v.itemReference + ":" + v.itemVersion, v]),
      ),
      operations = new Map(configuration.operations.map((v) => [v.operationReference, v]));
    const parsed = raw.map((value) => {
      const e = exact(value, [...mappingFields, "precise"]);
      if (
        e.precise !== true ||
        e.tenantReference !== request.tenantReference ||
        e.brandReference !== request.brandReference
      )
        return fail();
      const itemReference = parseInventoryReference(e.itemReference),
        root = roots.get(itemReference),
        sourceItemVersion = version(e.sourceItemVersion),
        mappingVersion = version(e.mappingVersion, 2147483647),
        sourceConfigurationOperationReference = parseInventoryReference(
          e.sourceConfigurationOperationReference,
        ),
        source = versions.get(itemReference + ":" + sourceItemVersion),
        operation = operations.get(sourceConfigurationOperationReference),
        occurredAt = parseInventoryInstant(e.occurredAt);
      if (
        !root ||
        root.itemType !== "FinishedGood" ||
        !source ||
        source.lifecycle === "Archived" ||
        !operation ||
        operation.itemReference !== itemReference ||
        operation.itemVersion !== sourceItemVersion ||
        occurredAt < source.recordedAt ||
        occurredAt > observedAt
      )
        return fail();
      if (e.action !== "Set" && e.action !== "Clear") return fail();
      let target: InventorySkuMappingTarget | null = null;
      if (e.action === "Set") {
        const t = exact(e.target, [
          "productReference",
          "productVersionReference",
          "skuReference",
          "catalogConfigurationDigest",
        ]);
        target = Object.freeze({
          productReference: parseInventoryReference(t.productReference),
          productVersionReference: parseInventoryReference(t.productVersionReference),
          skuReference: parseInventoryReference(t.skuReference),
          catalogConfigurationDigest: hash(t.catalogConfigurationDigest),
        });
      } else if (e.target !== null) return fail();
      return Object.freeze({
        tenantReference: request.tenantReference,
        brandReference: request.brandReference,
        mappingReference: parseInventoryReference(e.mappingReference),
        itemReference,
        mappingVersion,
        sourceItemVersion,
        sourceConfigurationOperationReference,
        action: e.action,
        target,
        operationReference: parseInventoryReference(e.operationReference),
        mappingIntentDigest: hash(e.mappingIntentDigest),
        occurredAt,
      });
    });
    const histories = new Map<string, typeof parsed>(),
      identities = new Map<string, string>();
    if (new Set(parsed.map((v) => v.operationReference)).size !== parsed.length) return fail();
    for (const v of parsed) {
      const owner = identities.get(v.mappingReference);
      if (owner && owner !== v.itemReference) return fail();
      identities.set(v.mappingReference, v.itemReference);
      const h = histories.get(v.itemReference) ?? [];
      h.push(v);
      histories.set(v.itemReference, h);
    }
    const latest = new Map<string, (typeof parsed)[number]>(),
      skuItems = new Map<string, string>();
    for (const [item, h] of histories) {
      h.sort((a, b) => a.mappingVersion - b.mappingVersion);
      for (let i = 0; i < h.length; i++) {
        const v = h[i],
          prev = h[i - 1];
        if (
          !v ||
          v.mappingVersion !== i + 1 ||
          (prev &&
            (v.mappingReference !== prev.mappingReference ||
              v.occurredAt < prev.occurredAt ||
              v.sourceItemVersion < prev.sourceItemVersion))
        )
          return fail();
      }
      const v = h.at(-1);
      if (!v) return fail();
      latest.set(item, v);
      if (v.target) {
        if (skuItems.has(v.target.skuReference)) return fail();
        skuItems.set(v.target.skuReference, item);
      }
    }
    const mappings = parsed
      .map((v) => {
        const root = roots.get(v.itemReference);
        if (!root) return fail();
        return Object.freeze({
          ...v,
          current: latest.get(v.itemReference) === v,
          sourceConfigurationState:
            root.currentItemVersion === v.sourceItemVersion &&
            root.currentOperationReference === v.sourceConfigurationOperationReference
              ? ("Current" as const)
              : ("Historical" as const),
        });
      })
      .sort(
        (a, b) =>
          a.itemReference.localeCompare(b.itemReference) || a.mappingVersion - b.mappingVersion,
      );
    const items = configuration.items
      .map((root) => {
        const last = latest.get(root.itemReference),
          applicable = root.itemType === "FinishedGood";
        return Object.freeze({
          itemReference: root.itemReference,
          currentMappingReference: last?.mappingReference ?? null,
          currentMappingVersion: last?.mappingVersion ?? null,
          coverage: last
            ? ("Recorded" as const)
            : applicable
              ? ("NotRecorded" as const)
              : ("NotApplicable" as const),
          currentLink: last
            ? last.target
              ? ("Mapped" as const)
              : ("ExplicitlyCleared" as const)
            : applicable
              ? ("Unknown" as const)
              : ("NotApplicable" as const),
        });
      })
      .sort((a, b) => a.itemReference.localeCompare(b.itemReference));
    return Object.freeze({
      mappings: Object.freeze(mappings),
      items: Object.freeze(items),
      observedAt,
    });
  } catch {
    return fail();
  }
}
export function buildInventorySkuMappingReferenceSnapshot(
  value: unknown,
  baseInput: InventoryConfigurationReferenceSnapshot,
  input: InventoryConfigurationReferenceRequest,
  now: string,
): InventorySkuMappingReferenceSnapshot {
  try {
    const request = parseInventoryConfigurationReferenceRequest(input),
      configuration = parseInventoryConfigurationReferenceSnapshot(baseInput, request, now),
      { mappings, items, observedAt } = parseMappingGraph(value, configuration, request, now);
    const content = {
      request,
      profile: "BrandInventorySkuMappingReferencesV1" as const,
      coverage: "CompleteStoredMappingReferences" as const,
      consistency: "HeldInventoryConfigurationSnapshot" as const,
      applicability: "Unavailable" as const,
      sourceVersionKind: "InventoryItemSkuMappingVersion" as const,
      generation: configuration.generation,
      configurationDigest: configuration.digest,
      mappings,
      items,
    };
    const metadata = {
      request: content.request,
      profile: content.profile,
      coverage: content.coverage,
      consistency: content.consistency,
      applicability: content.applicability,
      sourceVersionKind: content.sourceVersionKind,
      generation: content.generation,
    };
    // Source observations are freshness metadata, excluded from stable content identity.
    return Object.freeze({
      ...metadata,
      configuration,
      mappings: Object.freeze(mappings),
      items: Object.freeze(items),
      observedAt,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(content)),
    });
  } catch {
    return fail();
  }
}
export function parseInventorySkuMappingReferenceSnapshot(
  value: unknown,
  request: InventoryConfigurationReferenceRequest,
  now: string,
): InventorySkuMappingReferenceSnapshot {
  try {
    const r = exact(value, [
        "request",
        "profile",
        "coverage",
        "consistency",
        "applicability",
        "sourceVersionKind",
        "generation",
        "observedAt",
        "digest",
        "configuration",
        "mappings",
        "items",
      ]),
      mappings = list(r.mappings);
    const raw = mappings.map((v) => {
      const e = exact(v, [...mappingFields, "current", "sourceConfigurationState"]);
      return {
        ...Object.fromEntries(mappingFields.map((k) => [k, e[k]])),
        mappingVersion: typeof e.mappingVersion === "number" ? String(e.mappingVersion) : fail(),
        sourceItemVersion:
          typeof e.sourceItemVersion === "number" ? String(e.sourceItemVersion) : fail(),
        precise: true,
      };
    });
    const built = buildInventorySkuMappingReferenceSnapshot(
      {
        generation: r.generation,
        observedAt: r.observedAt,
        count: String(raw.length),
        mappings: raw,
      },
      r.configuration as InventoryConfigurationReferenceSnapshot,
      request,
      now,
    );
    for (const field of [
      "profile",
      "coverage",
      "consistency",
      "applicability",
      "sourceVersionKind",
      "generation",
      "observedAt",
      "digest",
    ] as const)
      if (r[field] !== built[field]) return fail();
    if (
      canonicalizeRfc8785(parseInventoryConfigurationReferenceRequest(r.request)) !==
      canonicalizeRfc8785(built.request)
    )
      return fail();
    for (let i = 0; i < mappings.length; i++) {
      const e = exact(mappings[i], [...mappingFields, "current", "sourceConfigurationState"]),
        v = built.mappings[i];
      if (
        !v ||
        e.current !== v.current ||
        e.sourceConfigurationState !== v.sourceConfigurationState ||
        e.itemReference !== v.itemReference ||
        e.mappingVersion !== v.mappingVersion
      )
        return fail();
    }
    const items = list(r.items);
    if (items.length !== built.items.length) return fail();
    for (let i = 0; i < items.length; i++) {
      const fields = [
          "itemReference",
          "currentMappingReference",
          "currentMappingVersion",
          "coverage",
          "currentLink",
        ] as const,
        e = exact(items[i], fields),
        v = built.items[i];
      if (!v || fields.some((k) => e[k] !== v[k])) return fail();
    }
    return built;
  } catch {
    return fail();
  }
}

export const inventoryProductPublicationSkuMappingReferenceFieldsV2 = Object.freeze([
  ...new Set([
    ...inventorySkuMappingReferenceFields,
    ...inventoryProductPublicationReferenceRequestFieldsV2,
  ]),
]);
export function buildInventoryProductPublicationSkuMappingReferenceSnapshotV2(
  value: unknown,
  baseInput: InventoryProductPublicationConfigurationReferenceSnapshotV2,
  input: InventoryProductPublicationReferenceRequestV2,
  now: string,
) {
  try {
    const request = parseInventoryProductPublicationReferenceRequestV2(input),
      configuration = parseInventoryProductPublicationConfigurationReferenceSnapshotV2(
        baseInput,
        request,
        now,
      ),
      graph = parseMappingGraph(value, configuration, request, now),
      at = parseInventoryInstant(now);
    if (graph.observedAt < request.observedAt || at >= request.validUntil) return fail();
    const body = {
      request,
      profile: "BrandInventoryProductPublicationSkuMappingReferencesV2" as const,
      coverage: "CompleteStoredMappingReferences" as const,
      consistency: "HeldInventoryConfigurationSnapshot" as const,
      applicability: "Unavailable" as const,
      sourceVersionKind: "InventoryItemSkuMappingVersion" as const,
      generation: configuration.generation,
      configuration,
      ...graph,
      validUntil: request.validUntil,
    };
    return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
  } catch {
    return fail();
  }
}
export type InventoryProductPublicationSkuMappingReferenceSnapshotV2 = ReturnType<
  typeof buildInventoryProductPublicationSkuMappingReferenceSnapshotV2
>;
export function parseInventoryProductPublicationSkuMappingReferenceSnapshotV2(
  value: unknown,
  input: InventoryProductPublicationReferenceRequestV2,
  now: string,
): InventoryProductPublicationSkuMappingReferenceSnapshotV2 {
  try {
    const r = exact(value, [
        "request",
        "profile",
        "coverage",
        "consistency",
        "applicability",
        "sourceVersionKind",
        "generation",
        "observedAt",
        "validUntil",
        "digest",
        "configuration",
        "mappings",
        "items",
      ]),
      configuration = parseInventoryProductPublicationConfigurationReferenceSnapshotV2(
        r.configuration,
        input,
        now,
      ),
      mappings = list(r.mappings).map((value) => {
        const e = exact(value, [...mappingFields, "current", "sourceConfigurationState"]);
        if (
          typeof e.mappingVersion !== "number" ||
          !Number.isSafeInteger(e.mappingVersion) ||
          typeof e.sourceItemVersion !== "number" ||
          !Number.isSafeInteger(e.sourceItemVersion)
        )
          return fail();
        return {
          ...Object.fromEntries(mappingFields.map((k) => [k, e[k]])),
          mappingVersion: String(e.mappingVersion),
          sourceItemVersion: String(e.sourceItemVersion),
          precise: true,
        };
      });
    list(r.items).forEach((value) =>
      exact(value, [
        "itemReference",
        "currentMappingReference",
        "currentMappingVersion",
        "coverage",
        "currentLink",
      ]),
    );
    const actualRequest = parseInventoryProductPublicationReferenceRequestV2(r.request),
      expectedRequest = parseInventoryProductPublicationReferenceRequestV2(input);
    if (
      canonicalizeRfc8785(actualRequest) !== canonicalizeRfc8785(expectedRequest) ||
      r.profile !== "BrandInventoryProductPublicationSkuMappingReferencesV2" ||
      r.coverage !== "CompleteStoredMappingReferences" ||
      r.consistency !== "HeldInventoryConfigurationSnapshot" ||
      r.applicability !== "Unavailable" ||
      r.sourceVersionKind !== "InventoryItemSkuMappingVersion" ||
      r.validUntil !== expectedRequest.validUntil ||
      typeof r.generation !== "string"
    )
      return fail();
    hash(r.digest);
    const source = buildInventoryProductPublicationSkuMappingReferenceSnapshotV2(
      {
        generation: r.generation,
        observedAt: r.observedAt,
        count: String(mappings.length),
        mappings,
      },
      configuration,
      input,
      now,
    );
    if (canonicalizeRfc8785(r) !== canonicalizeRfc8785(source)) return fail();
    return source;
  } catch {
    return fail();
  }
}
