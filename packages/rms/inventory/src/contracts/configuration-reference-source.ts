import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  InventoryItemError,
  parseInventoryReference,
  parseInventoryInstant,
  type InventoryItemType,
  type InventoryLifecycle,
} from "../domain/inventory-item.js";
export const inventoryConfigurationReferenceMaximumRows = 10000;
const rootFields = [
  "tenantReference",
  "brandReference",
  "itemReference",
  "itemType",
  "createdAt",
] as const;
const versionFields = [
  "tenantReference",
  "brandReference",
  "itemReference",
  "itemVersion",
  "itemType",
  "lifecycle",
  "recordedAt",
] as const;
const operationFields = [
  "tenantReference",
  "brandReference",
  "itemReference",
  "itemVersion",
  "operationReference",
  "action",
] as const;
export const inventoryConfigurationReferenceFields = Object.freeze([
  ...new Set([
    "generation",
    ...rootFields,
    ...versionFields,
    ...operationFields,
    "currentItemVersion",
    "currentOperationReference",
  ]),
] as const);
export const inventoryConfigurationReferencePermissions = Object.freeze([
  "inventory.item.read",
  "inventory.item.history.read",
] as const);
export interface InventoryConfigurationReferenceRequest {
  readonly purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly operationReference: string;
  readonly catalogIntentDigest: string;
}
export interface InventoryConfigurationRootReference {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly itemReference: string;
  readonly itemType: InventoryItemType;
  readonly createdAt: string;
  readonly currentItemVersion: number;
  readonly currentOperationReference: string;
}
export interface InventoryConfigurationVersionReference {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly itemReference: string;
  readonly itemVersion: number;
  readonly itemType: InventoryItemType;
  readonly lifecycle: InventoryLifecycle;
  readonly recordedAt: string;
}
export interface InventoryConfigurationOperationReference {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly itemReference: string;
  readonly itemVersion: number;
  readonly operationReference: string;
  readonly action:
    "Create" | "Update" | "Activate" | "Deactivate" | "Archive" | "Restore" | "SetReorderPolicy";
}
export interface InventoryConfigurationReferenceSnapshot {
  readonly request: InventoryConfigurationReferenceRequest;
  readonly profile: "BrandInventoryConfigurationReferencesV1";
  readonly coverage: "CompleteStoredConfigurationReferences";
  readonly consistency: "StatementSnapshot";
  readonly applicability: "Unavailable";
  readonly directSkuMappingCoverage: "Unavailable";
  readonly sourceVersionKind: "InventoryItemConfigurationOperation";
  readonly generation: string;
  readonly observedAt: string;
  readonly digest: string;
  readonly items: readonly InventoryConfigurationRootReference[];
  readonly versions: readonly InventoryConfigurationVersionReference[];
  readonly operations: readonly InventoryConfigurationOperationReference[];
}
const fail = (): never => {
  throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const d = Object.getOwnPropertyDescriptor(value, f);
    if (!d?.enumerable || !("value" in d)) return fail();
    out[f] = d.value;
  }
  return out;
}
function list(value: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > inventoryConfigurationReferenceMaximumRows ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value;
  });
}
const ref = parseInventoryReference,
  instant = parseInventoryInstant;
function digest(v: unknown): string {
  if (typeof v !== "string" || !/^sha256:[0-9a-f]{64}$/.test(v)) return fail();
  return v;
}
function version(v: unknown): number {
  if (typeof v !== "string" || v.length > 16 || !/^[1-9][0-9]*$/.test(v)) return fail();
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : fail();
}
function itemType(v: unknown): InventoryItemType {
  if (
    v !== "RawMaterial" &&
    v !== "Packaging" &&
    v !== "SemiFinished" &&
    v !== "FinishedGood" &&
    v !== "NonFoodSupply"
  )
    return fail();
  return v;
}
function lifecycle(v: unknown): InventoryLifecycle {
  if (v !== "Active" && v !== "Inactive" && v !== "Archived") return fail();
  return v;
}
function action(v: unknown): InventoryConfigurationOperationReference["action"] {
  if (
    v !== "Create" &&
    v !== "Update" &&
    v !== "Activate" &&
    v !== "Deactivate" &&
    v !== "Archive" &&
    v !== "Restore" &&
    v !== "SetReorderPolicy"
  )
    return fail();
  return v;
}
export function parseInventoryConfigurationReferenceRequest(
  value: unknown,
): InventoryConfigurationReferenceRequest {
  try {
    const r = exact(value, [
      "purposeCode",
      "tenantReference",
      "brandReference",
      "actorReference",
      "operationReference",
      "catalogIntentDigest",
    ]);
    if (r.purposeCode !== "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ") return fail();
    return Object.freeze({
      purposeCode: r.purposeCode,
      tenantReference: ref(r.tenantReference),
      brandReference: ref(r.brandReference),
      actorReference: ref(r.actorReference),
      operationReference: ref(r.operationReference),
      catalogIntentDigest: digest(r.catalogIntentDigest),
    });
  } catch {
    return fail();
  }
}
const families = ["items", "versions", "operations"] as const;
export function buildInventoryConfigurationReferenceSnapshot(
  value: unknown,
  input: InventoryConfigurationReferenceRequest,
  now: string,
): InventoryConfigurationReferenceSnapshot {
  try {
    const request = parseInventoryConfigurationReferenceRequest(input),
      r = exact(value, ["generation", "counts", "observedAt", ...families]),
      counts = exact(r.counts, families),
      raw = Object.fromEntries(families.map((k) => [k, list(r[k])])) as Record<
        (typeof families)[number],
        unknown[]
      >;
    const total = families.reduce((n, k) => n + raw[k].length, 0),
      observedAt = instant(r.observedAt),
      at = instant(now);
    if (
      total > inventoryConfigurationReferenceMaximumRows ||
      families.some((k) => counts[k] !== String(raw[k].length)) ||
      at < observedAt ||
      Date.parse(at) - Date.parse(observedAt) > 5000
    )
      return fail();
    const generation = r.generation === null && total === 0 ? "0" : r.generation;
    if (
      typeof generation !== "string" ||
      generation.length > 19 ||
      !/^(0|[1-9][0-9]*)$/.test(generation) ||
      BigInt(generation) > 9223372036854775807n
    )
      return fail();
    const scope = (e: Record<string, unknown>) => {
      const tenantReference = ref(e.tenantReference),
        brandReference = ref(e.brandReference);
      if (tenantReference !== request.tenantReference || brandReference !== request.brandReference)
        return fail();
      return { tenantReference, brandReference };
    };
    const past = (v: unknown) => {
      const t = instant(v);
      return t <= observedAt ? t : fail();
    };
    const precise = (v: unknown, f: readonly string[]) => {
      const e = exact(v, [...f, "precise"]);
      if (e.precise !== true) return fail();
      return e;
    };
    const roots = raw.items.map((v) => {
      const e = precise(v, rootFields);
      return Object.freeze({
        ...scope(e),
        itemReference: ref(e.itemReference),
        itemType: itemType(e.itemType),
        createdAt: past(e.createdAt),
      });
    });
    const rootMap = new Map(roots.map((i) => [i.itemReference, i]));
    if (rootMap.size !== roots.length) return fail();
    const parent = (e: Record<string, unknown>) => {
      scope(e);
      const p = rootMap.get(ref(e.itemReference));
      return p ?? fail();
    };
    const versions = raw.versions.map((v) => {
      const e = precise(v, versionFields),
        p = parent(e),
        type = itemType(e.itemType),
        recordedAt = past(e.recordedAt);
      if (type !== p.itemType || recordedAt < p.createdAt) return fail();
      return Object.freeze({
        tenantReference: p.tenantReference,
        brandReference: p.brandReference,
        itemReference: p.itemReference,
        itemVersion: version(e.itemVersion),
        itemType: type,
        lifecycle: lifecycle(e.lifecycle),
        recordedAt,
      });
    });
    const versionMap = new Map(versions.map((v) => [v.itemReference + ":" + v.itemVersion, v]));
    if (versionMap.size !== versions.length) return fail();
    const history = new Map<string, InventoryConfigurationVersionReference[]>();
    for (const v of versions) {
      const h = history.get(v.itemReference) ?? [];
      h.push(v);
      history.set(v.itemReference, h);
    }
    for (const p of roots) {
      const h = (history.get(p.itemReference) ?? []).sort((a, b) => a.itemVersion - b.itemVersion);
      if (h.length === 0 || h[0]?.recordedAt !== p.createdAt) return fail();
      for (let i = 0; i < h.length; i++) {
        const v = h[i],
          prev = h[i - 1];
        if (!v || v.itemVersion !== i + 1 || (prev && v.recordedAt < prev.recordedAt))
          return fail();
      }
    }
    const operations = raw.operations.map((v) => {
      const e = exact(v, operationFields),
        p = parent(e),
        itemVersion = version(e.itemVersion),
        a = action(e.action);
      if (
        !versionMap.has(p.itemReference + ":" + itemVersion) ||
        (a === "Create") !== (itemVersion === 1)
      )
        return fail();
      return Object.freeze({
        tenantReference: p.tenantReference,
        brandReference: p.brandReference,
        itemReference: p.itemReference,
        itemVersion,
        operationReference: ref(e.operationReference),
        action: a,
      });
    });
    const operationMap = new Map(operations.map((o) => [o.itemReference + ":" + o.itemVersion, o]));
    if (
      operationMap.size !== operations.length ||
      new Set(operations.map((o) => o.operationReference)).size !== operations.length ||
      operations.length !== versions.length
    )
      return fail();
    const items = roots.map((p) => {
      const h = history.get(p.itemReference),
        latest = h?.[h.length - 1];
      if (!latest) return fail();
      const operation = operationMap.get(p.itemReference + ":" + latest.itemVersion);
      if (!operation) return fail();
      return Object.freeze({
        ...p,
        currentItemVersion: latest.itemVersion,
        currentOperationReference: operation.operationReference,
      });
    });
    const body = {
      request,
      profile: "BrandInventoryConfigurationReferencesV1" as const,
      coverage: "CompleteStoredConfigurationReferences" as const,
      consistency: "StatementSnapshot" as const,
      applicability: "Unavailable" as const,
      directSkuMappingCoverage: "Unavailable" as const,
      sourceVersionKind: "InventoryItemConfigurationOperation" as const,
      generation,
      items: Object.freeze(items.sort((a, b) => a.itemReference.localeCompare(b.itemReference))),
      versions: Object.freeze(
        versions.sort(
          (a, b) => a.itemReference.localeCompare(b.itemReference) || a.itemVersion - b.itemVersion,
        ),
      ),
      operations: Object.freeze(
        operations.sort((a, b) => a.operationReference.localeCompare(b.operationReference)),
      ),
    };
    return Object.freeze({
      ...body,
      observedAt,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
    });
  } catch {
    return fail();
  }
}
export function parseInventoryConfigurationReferenceSnapshot(
  value: unknown,
  input: InventoryConfigurationReferenceRequest,
  now: string,
): InventoryConfigurationReferenceSnapshot {
  try {
    const r = exact(value, [
        "request",
        "profile",
        "coverage",
        "consistency",
        "applicability",
        "directSkuMappingCoverage",
        "sourceVersionKind",
        "generation",
        "observedAt",
        "digest",
        ...families,
      ]),
      request = parseInventoryConfigurationReferenceRequest(input);
    if (
      canonicalizeRfc8785(parseInventoryConfigurationReferenceRequest(r.request)) !==
        canonicalizeRfc8785(request) ||
      r.profile !== "BrandInventoryConfigurationReferencesV1" ||
      r.coverage !== "CompleteStoredConfigurationReferences" ||
      r.consistency !== "StatementSnapshot" ||
      r.applicability !== "Unavailable" ||
      r.directSkuMappingCoverage !== "Unavailable" ||
      r.sourceVersionKind !== "InventoryItemConfigurationOperation" ||
      typeof r.generation !== "string"
    )
      return fail();
    const publicRoots = list(r.items).map((v) =>
      exact(v, [...rootFields, "currentItemVersion", "currentOperationReference"]),
    );
    const items = publicRoots.map((e) =>
      Object.fromEntries([...rootFields.map((f) => [f, e[f]]), ["precise", true]]),
    );
    const versions = list(r.versions).map((v) => {
      const e = exact(v, versionFields);
      if (
        typeof e.itemVersion !== "number" ||
        !Number.isSafeInteger(e.itemVersion) ||
        e.itemVersion < 1
      )
        return fail();
      return { ...e, itemVersion: String(e.itemVersion), precise: true };
    });
    const operations = list(r.operations).map((v) => {
      const e = exact(v, operationFields);
      if (
        typeof e.itemVersion !== "number" ||
        !Number.isSafeInteger(e.itemVersion) ||
        e.itemVersion < 1
      )
        return fail();
      return { ...e, itemVersion: String(e.itemVersion) };
    });
    const s = buildInventoryConfigurationReferenceSnapshot(
      {
        generation: r.generation,
        observedAt: r.observedAt,
        counts: {
          items: String(items.length),
          versions: String(versions.length),
          operations: String(operations.length),
        },
        items,
        versions,
        operations,
      },
      request,
      now,
    );
    const computed = new Map(s.items.map((i) => [i.itemReference, i]));
    for (const e of publicRoots) {
      const i = computed.get(ref(e.itemReference));
      if (
        !i ||
        e.currentItemVersion !== i.currentItemVersion ||
        e.currentOperationReference !== i.currentOperationReference
      )
        return fail();
    }
    if (digest(r.digest) !== s.digest) return fail();
    return s;
  } catch {
    return fail();
  }
}

/** Actual-root-derived pins plus complete owning metadata only. UUID Inventory pins
 * identify configuration operations; Recipe pins identify actual RecipeVersion rows.
 * Unit/quantity/current Binding applicability and reference eligibility are unassessed. */
export function matchOptionDraftInventoryConsumptionMetadata(
  value: unknown,
  rawSource: unknown,
  request: InventoryConfigurationReferenceRequest,
  nowInput: string,
  activationInput: string,
) {
  try {
    const source = parseInventoryConfigurationReferenceSnapshot(rawSource, request, nowInput),
      r = exact(value, [
        "profile",
        "brandReference",
        "optionSetReference",
        "versionReference",
        "sourceDigest",
        "contentDigest",
        "configurationDigest",
        "pins",
      ]),
      now = parseInventoryInstant(nowInput),
      activationAt = parseInventoryInstant(activationInput),
      brandReference = parseInventoryReference(r.brandReference),
      optionSetReference = parseInventoryReference(r.optionSetReference),
      versionReference = parseInventoryReference(r.versionReference);
    if (
      r.profile !== "CurrentFullOptionDraftConsumptionPinsV1" ||
      brandReference !== request.brandReference ||
      activationAt < now
    )
      return fail();
    const pins = list(r.pins);
    if (pins.length > 100) return fail();
    const matches = pins
      .map((v) => {
        const p = exact(v, ["optionReference", "reference", "versionReference"]),
          optionReference = parseInventoryReference(p.optionReference),
          reference = parseInventoryReference(p.reference),
          versionReference = parseInventoryReference(p.versionReference);
        const parent = source.items.find((x) => x.itemReference === reference),
          operation = source.operations.find((x) => x.operationReference === versionReference),
          version = operation
            ? source.versions.find(
                (x) => x.itemReference === reference && x.itemVersion === operation.itemVersion,
              )
            : undefined;
        const status = !parent
          ? "MissingItem"
          : !operation
            ? "MissingVersion"
            : operation.itemReference !== reference
              ? "WrongItem"
              : !version
                ? "MissingVersion"
                : parent.currentOperationReference !== versionReference ||
                    parent.currentItemVersion !== version.itemVersion
                  ? "StaleVersion"
                  : version.lifecycle !== "Active"
                    ? "InactiveItem"
                    : "CurrentActiveMetadata";
        return Object.freeze({ optionReference, reference, versionReference, status });
      })
      .sort((a, b) => a.optionReference.localeCompare(b.optionReference));
    if (new Set(matches.map((m) => m.optionReference)).size !== matches.length) return fail();
    const body = {
      profile: "OptionDraftInventoryConsumptionMetadataV1" as const,
      brandReference,
      optionSetReference,
      versionReference,
      sourceDigest: digest(r.sourceDigest),
      contentDigest: digest(r.contentDigest),
      configurationDigest: digest(r.configurationDigest),
      ownerSourceDigest: source.digest,
      ownerGeneration: source.generation,
      ownerObservedAt: source.observedAt,
      sourceOperationReference: request.operationReference,
      catalogIntentDigest: request.catalogIntentDigest,
      assessedAt: now,
      activationAt,
      matches: Object.freeze(matches),
      decision: matches.every((m) => m.status === "CurrentActiveMetadata")
        ? ("PassForMetadata" as const)
        : ("HardError" as const),
      quantityEligibility: "NotEvaluated" as const,
      unitConversionEligibility: "NotEvaluated" as const,
      bindingApplicability: "NotEvaluated" as const,
      scopeApplicability: "NotEvaluated" as const,
      referenceEligibility: "NotEvaluated" as const,
      eligibility: "NotEvaluated" as const,
    };
    return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
  } catch {
    return fail();
  }
}
