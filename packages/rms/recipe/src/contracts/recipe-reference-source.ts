import {
  recipeProductPublicationReferenceRequestFieldsV2,
  parseRecipeProductPublicationReferenceRequestV2,
  type RecipeProductPublicationReferenceRequestV2,
} from "./product-publication-reference-request-v2.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseRecipeReference, parseRecipeDigest } from "../domain/recipe.js";
import { RecipeWorkflowError } from "../application/recipe-service.js";
export const recipeReferenceSourceMaximumRows = 10000;
const recipeFields = [
  "recipeReference",
  "brandReference",
  "aggregateVersion",
  "currentVersionReference",
  "updatedAt",
] as const;
const versionFields = [
  "recipeVersionReference",
  "recipeReference",
  "brandReference",
  "versionNumber",
  "lifecycle",
  "snapshotDigest",
  "effectiveFrom",
  "effectiveUntil",
  "timeZone",
  "createdAt",
] as const;
const bindingFields = [
  "bindingReference",
  "recipeVersionReference",
  "recipeReference",
  "brandReference",
  "skuReference",
  "storeReference",
  "optionBindingReference",
  "effectiveFrom",
  "effectiveUntil",
] as const;
const modifierFields = [
  "ruleVersionReference",
  "ruleReference",
  "brandReference",
  "recipeReference",
  "recipeVersionReference",
  "bindingReference",
  "optionReference",
  "version",
  "selectedQuantity",
  "lifecycle",
  "ruleDigest",
  "effectiveFrom",
  "effectiveUntil",
  "occurredAt",
] as const;
export const recipeReferenceSourceFields = Object.freeze([
  ...new Set([
    "generation",
    "bindingCount",
    ...recipeFields,
    ...versionFields,
    ...bindingFields,
    ...modifierFields,
  ]),
] as const);
export interface RecipeReferenceSourceRequest {
  readonly purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ";
  readonly brandReference: string;
  readonly actorReference: string;
  readonly operationReference: string;
  readonly catalogIntentDigest: string;
}
/** Server-captured publication origin, never a replacement for the actual
 * current owner clock, lease, permission or effective-period assessment. */
export interface RecipeOptionPublicationOriginalClock {
  readonly profile: "OptionPublicationOriginalClockV1";
  readonly operationReference: string;
  readonly catalogIntentDigest: string;
  readonly observedAt: string;
  readonly validUntil: string;
}
export function parseRecipeOptionPublicationOriginalClock(
  value: unknown,
): RecipeOptionPublicationOriginalClock {
  try {
    const r = exact(value, [
      "profile",
      "operationReference",
      "catalogIntentDigest",
      "observedAt",
      "validUntil",
    ]);
    const observedAt = parseRecipeReferenceSourceInstant(r.observedAt),
      validUntil = parseRecipeReferenceSourceInstant(r.validUntil);
    if (
      r.profile !== "OptionPublicationOriginalClockV1" ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000
    )
      return fail();
    return Object.freeze({
      profile: "OptionPublicationOriginalClockV1",
      operationReference: parseRecipeReference(r.operationReference),
      catalogIntentDigest: parseRecipeDigest(r.catalogIntentDigest),
      observedAt,
      validUntil,
    });
  } catch {
    return fail();
  }
}
/** Shared only by the fixed Option metadata/yield assessments. Other Recipe and
 * legacy callers retain their future-only activation boundary. */
export function validateRecipeOptionPublicationActivation(
  request: RecipeReferenceSourceRequest,
  now: string,
  activationAt: string,
  clockValue?: unknown,
): RecipeOptionPublicationOriginalClock | undefined {
  now = parseRecipeReferenceSourceInstant(now);
  activationAt = parseRecipeReferenceSourceInstant(activationAt);
  if (clockValue === undefined) {
    if (activationAt < now) return fail();
    return undefined;
  }
  const original = parseRecipeOptionPublicationOriginalClock(clockValue);
  if (
    original.operationReference !== request.operationReference ||
    original.catalogIntentDigest !== request.catalogIntentDigest ||
    now < original.observedAt ||
    now >= original.validUntil ||
    activationAt < original.observedAt
  )
    return fail();
  return original;
}
export interface RecipeRootReference {
  readonly recipeReference: string;
  readonly brandReference: string;
  readonly aggregateVersion: number;
  readonly currentVersionReference: string | null;
  readonly updatedAt: string;
}
export interface RecipeVersionReference {
  readonly recipeVersionReference: string;
  readonly recipeReference: string;
  readonly brandReference: string;
  readonly versionNumber: number;
  readonly lifecycle: RecipeReferenceLifecycle;
  readonly snapshotDigest: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly timeZone: string;
  readonly createdAt: string;
}
export interface RecipeBindingReference {
  readonly bindingReference: string;
  readonly recipeVersionReference: string;
  readonly recipeReference: string;
  readonly brandReference: string;
  readonly skuReference: string;
  readonly storeReference: string | null;
  readonly optionBindingReference: string | null;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}
export type RecipeReferenceLifecycle = "Draft" | "Published" | "Invalidated" | "Archived";
export interface RecipeModifierReference {
  readonly ruleVersionReference: string;
  readonly ruleReference: string;
  readonly brandReference: string;
  readonly recipeReference: string;
  readonly recipeVersionReference: string;
  readonly bindingReference: string;
  readonly optionReference: string;
  readonly version: number;
  readonly selectedQuantity: number;
  readonly lifecycle: RecipeReferenceLifecycle;
  readonly ruleDigest: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly occurredAt: string;
}
export interface RecipeReferenceSourceSnapshot {
  readonly request: RecipeReferenceSourceRequest;
  readonly profile: "BrandRecipeStoredReferencesV1";
  readonly coverage: "CompleteStoredReferences";
  readonly consistency: "StatementSnapshot";
  readonly applicability: "Unavailable";
  readonly generation: string;
  readonly bindingCount: string;
  readonly observedAt: string;
  readonly digest: string;
  readonly recipes: readonly RecipeRootReference[];
  readonly versions: readonly RecipeVersionReference[];
  readonly bindings: readonly RecipeBindingReference[];
  readonly modifiers: readonly RecipeModifierReference[];
}
const fail = (): never => {
  throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
};
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const r: Record<string, unknown> = {};
  for (const f of fields) {
    const d = Object.getOwnPropertyDescriptor(value, f);
    if (!d?.enumerable || !("value" in d)) return fail();
    r[f] = d.value;
  }
  return r;
}
function array(value: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > recipeReferenceSourceMaximumRows ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value;
  });
}
export function parseRecipeReferenceSourceInstant(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) ||
    !Number.isFinite(Date.parse(v)) ||
    new Date(v).toISOString() !== v
  )
    return fail();
  return v;
}
export function parseRecipeReferenceSourceRequest(value: unknown): RecipeReferenceSourceRequest {
  try {
    const r = exact(value, [
      "purposeCode",
      "brandReference",
      "actorReference",
      "operationReference",
      "catalogIntentDigest",
    ]);
    if (r.purposeCode !== "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ") return fail();
    return Object.freeze({
      purposeCode: r.purposeCode,
      brandReference: parseRecipeReference(r.brandReference),
      actorReference: parseRecipeReference(r.actorReference),
      operationReference: parseRecipeReference(r.operationReference),
      catalogIntentDigest: parseRecipeDigest(r.catalogIntentDigest),
    });
  } catch {
    return fail();
  }
}
const families = ["recipes", "versions", "bindings", "modifiers"] as const;
const keys = {
  recipes: recipeFields,
  versions: versionFields,
  bindings: bindingFields,
  modifiers: modifierFields,
};
const integer = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 2147483647 ? v : fail();
const counter = (v: unknown): string =>
  typeof v === "string" &&
  v.length <= 19 &&
  /^(0|[1-9][0-9]*)$/.test(v) &&
  BigInt(v) <= 9223372036854775807n
    ? v
    : fail();
const nullableRef = (v: unknown) => (v === null ? null : parseRecipeReference(v));
const state = (v: unknown): RecipeReferenceLifecycle =>
  v === "Draft" || v === "Published" || v === "Invalidated" || v === "Archived" ? v : fail();
/** Complete stored Recipe references only; Store existence and present applicability remain unavailable. */
export function buildRecipeReferenceSourceSnapshot(
  value: unknown,
  input: RecipeReferenceSourceRequest,
  now: string,
): RecipeReferenceSourceSnapshot {
  try {
    const request = parseRecipeReferenceSourceRequest(input),
      { observedAt, ...graph } = recipeReferenceGraph(value, request.brandReference, now),
      body = { request, profile: "BrandRecipeStoredReferencesV1" as const, ...graph };
    return Object.freeze({
      ...body,
      observedAt,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
    });
  } catch {
    return fail();
  }
}
function recipeReferenceGraph(value: unknown, expectedBrand: string, now: string) {
  try {
    const r = exact(value, ["generation", "bindingCount", "observedAt", "counts", ...families]),
      counts = exact(r.counts, families);
    const raw = Object.fromEntries(families.map((k) => [k, array(r[k])])) as Record<
      (typeof families)[number],
      unknown[]
    >;
    const total = families.reduce((n, k) => n + raw[k].length, 0),
      observedAt = parseRecipeReferenceSourceInstant(r.observedAt),
      at = parseRecipeReferenceSourceInstant(now);
    if (
      total > recipeReferenceSourceMaximumRows ||
      at < observedAt ||
      Date.parse(at) - Date.parse(observedAt) > 5000 ||
      families.some((k) => counts[k] !== String(raw[k].length))
    )
      return fail();
    const empty = total === 0 && r.generation === null && r.bindingCount === null;
    const generation = counter(empty ? "0" : r.generation),
      bindingCount = counter(empty ? "0" : r.bindingCount);
    if (bindingCount !== String(raw.bindings.length)) return fail();
    const ref = parseRecipeReference,
      brand = (v: unknown) => {
        const b = ref(v);
        return b === expectedBrand ? b : fail();
      };
    const past = (v: unknown) => {
      const t = parseRecipeReferenceSourceInstant(v);
      return t <= observedAt ? t : fail();
    };
    const read = (v: unknown, k: readonly string[]) => {
      const e = exact(v, [...k, "precise"]);
      if (e.precise !== true) return fail();
      return e;
    };
    const period = (e: Record<string, unknown>) => {
      const effectiveFrom = parseRecipeReferenceSourceInstant(e.effectiveFrom),
        effectiveUntil =
          e.effectiveUntil === null ? null : parseRecipeReferenceSourceInstant(e.effectiveUntil);
      if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) return fail();
      return { effectiveFrom, effectiveUntil };
    };
    const recipes = raw.recipes.map((v) => {
      const e = read(v, recipeFields);
      return Object.freeze({
        recipeReference: ref(e.recipeReference),
        brandReference: brand(e.brandReference),
        aggregateVersion: integer(e.aggregateVersion),
        currentVersionReference: nullableRef(e.currentVersionReference),
        updatedAt: past(e.updatedAt),
      });
    });
    const roots = new Map(recipes.map((v) => [v.recipeReference, v]));
    if (roots.size !== recipes.length) return fail();
    const root = (e: Record<string, unknown>) => {
      const p = roots.get(ref(e.recipeReference));
      if (!p || brand(e.brandReference) !== p.brandReference) return fail();
      return p;
    };
    const versions = raw.versions.map((v) => {
      const e = read(v, versionFields),
        p = root(e);
      if (
        typeof e.timeZone !== "string" ||
        e.timeZone.length > 63 ||
        !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(e.timeZone)
      )
        return fail();
      new Intl.DateTimeFormat("en-CA", { timeZone: e.timeZone });
      return Object.freeze({
        recipeVersionReference: ref(e.recipeVersionReference),
        recipeReference: p.recipeReference,
        brandReference: p.brandReference,
        versionNumber: integer(e.versionNumber),
        lifecycle: state(e.lifecycle),
        snapshotDigest: parseRecipeDigest(e.snapshotDigest),
        ...period(e),
        timeZone: e.timeZone,
        createdAt: past(e.createdAt),
      });
    });
    const versionMap = new Map(versions.map((v) => [v.recipeVersionReference, v]));
    if (versionMap.size !== versions.length) return fail();
    const versionKeys = new Set<string>();
    for (const v of versions) {
      const k = v.recipeReference + ":" + v.versionNumber;
      if (versionKeys.has(k)) return fail();
      versionKeys.add(k);
    }
    for (const p of recipes) {
      if (
        p.currentVersionReference !== null &&
        versionMap.get(p.currentVersionReference)?.recipeReference !== p.recipeReference
      )
        return fail();
    }
    const version = (e: Record<string, unknown>) => {
      const p = root(e),
        v = versionMap.get(ref(e.recipeVersionReference));
      if (!v || v.recipeReference !== p.recipeReference) return fail();
      return v;
    };
    const bindings = raw.bindings.map((v) => {
      const e = read(v, bindingFields),
        p = version(e);
      return Object.freeze({
        bindingReference: ref(e.bindingReference),
        recipeReference: p.recipeReference,
        recipeVersionReference: p.recipeVersionReference,
        brandReference: p.brandReference,
        skuReference: ref(e.skuReference),
        storeReference: nullableRef(e.storeReference),
        optionBindingReference: nullableRef(e.optionBindingReference),
        ...period(e),
      });
    });
    if (new Set(bindings.map((v) => v.bindingReference)).size !== bindings.length) return fail();
    const modifiers = raw.modifiers.map((v) => {
      const e = read(v, modifierFields),
        p = version(e),
        selectedQuantity = integer(e.selectedQuantity);
      if (selectedQuantity > 10000) return fail();
      return Object.freeze({
        ruleVersionReference: ref(e.ruleVersionReference),
        ruleReference: ref(e.ruleReference),
        recipeReference: p.recipeReference,
        recipeVersionReference: p.recipeVersionReference,
        brandReference: p.brandReference,
        bindingReference: ref(e.bindingReference),
        optionReference: ref(e.optionReference),
        version: integer(e.version),
        selectedQuantity,
        lifecycle: state(e.lifecycle),
        ruleDigest: parseRecipeDigest(e.ruleDigest),
        ...period(e),
        occurredAt: past(e.occurredAt),
      });
    });
    if (new Set(modifiers.map((v) => v.ruleVersionReference)).size !== modifiers.length)
      return fail();
    const history = new Map<string, RecipeModifierReference[]>();
    for (const m of modifiers) {
      const h = history.get(m.ruleReference) ?? [];
      h.push(m);
      history.set(m.ruleReference, h);
    }
    for (const h of history.values()) {
      h.sort((a, b) => a.version - b.version);
      for (let i = 0; i < h.length; i++) {
        const m = h[i],
          p = h[i - 1];
        if (!m || m.version !== i + 1 || (p && m.occurredAt < p.occurredAt)) return fail();
      }
    }
    const body = {
      coverage: "CompleteStoredReferences" as const,
      consistency: "StatementSnapshot" as const,
      applicability: "Unavailable" as const,
      generation,
      bindingCount,
      recipes: Object.freeze(
        recipes.sort((a, b) => a.recipeReference.localeCompare(b.recipeReference)),
      ),
      versions: Object.freeze(
        versions.sort((a, b) => a.recipeVersionReference.localeCompare(b.recipeVersionReference)),
      ),
      bindings: Object.freeze(
        bindings.sort((a, b) => a.bindingReference.localeCompare(b.bindingReference)),
      ),
      modifiers: Object.freeze(
        modifiers.sort((a, b) => a.ruleVersionReference.localeCompare(b.ruleVersionReference)),
      ),
    };
    return Object.freeze({
      ...body,
      observedAt,
    });
  } catch {
    return fail();
  }
}
export function parseRecipeReferenceSourceSnapshot(
  value: unknown,
  input: RecipeReferenceSourceRequest,
  now: string,
): RecipeReferenceSourceSnapshot {
  try {
    const r = exact(value, [
        "request",
        "profile",
        "coverage",
        "consistency",
        "applicability",
        "generation",
        "bindingCount",
        "observedAt",
        "digest",
        ...families,
      ]),
      request = parseRecipeReferenceSourceRequest(input);
    if (
      canonicalizeRfc8785(parseRecipeReferenceSourceRequest(r.request)) !==
        canonicalizeRfc8785(request) ||
      r.profile !== "BrandRecipeStoredReferencesV1" ||
      r.coverage !== "CompleteStoredReferences" ||
      r.consistency !== "StatementSnapshot" ||
      r.applicability !== "Unavailable" ||
      typeof r.generation !== "string" ||
      typeof r.bindingCount !== "string"
    )
      return fail();
    const raw = Object.fromEntries(
      families.map((k) => [k, array(r[k]).map((v) => ({ ...exact(v, keys[k]), precise: true }))]),
    );
    const result = buildRecipeReferenceSourceSnapshot(
      {
        ...raw,
        generation: r.generation,
        bindingCount: r.bindingCount,
        observedAt: r.observedAt,
        counts: Object.fromEntries(families.map((k) => [k, String(array(r[k]).length)])),
      },
      request,
      now,
    );
    if (result.digest !== parseRecipeDigest(r.digest)) return fail();
    return result;
  } catch {
    return fail();
  }
}

/** Actual-root-derived pins plus complete owning metadata only. UUID Inventory pins
 * identify configuration operations; Recipe pins identify actual RecipeVersion rows.
 * Unit/quantity/current Binding applicability and reference eligibility are unassessed. */
export function matchOptionDraftRecipeConsumptionMetadata(
  value: unknown,
  rawSource: unknown,
  request: RecipeReferenceSourceRequest,
  nowInput: string,
  activationInput: string,
  originalPublicationClockValue?: unknown,
) {
  try {
    const source = parseRecipeReferenceSourceSnapshot(rawSource, request, nowInput),
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
      now = parseRecipeReferenceSourceInstant(nowInput),
      activationAt = parseRecipeReferenceSourceInstant(activationInput),
      brandReference = parseRecipeReference(r.brandReference),
      optionSetReference = parseRecipeReference(r.optionSetReference),
      versionReference = parseRecipeReference(r.versionReference),
      originalPublicationClock = validateRecipeOptionPublicationActivation(
        request,
        now,
        activationAt,
        originalPublicationClockValue,
      );
    if (
      r.profile !== "CurrentFullOptionDraftConsumptionPinsV1" ||
      brandReference !== request.brandReference
    )
      return fail();
    const pins = array(r.pins);
    if (pins.length > 100) return fail();
    const matches = pins
      .map((v) => {
        const p = exact(v, ["optionReference", "reference", "versionReference"]),
          optionReference = parseRecipeReference(p.optionReference),
          reference = parseRecipeReference(p.reference),
          versionReference = parseRecipeReference(p.versionReference);
        const parent = source.recipes.find((x) => x.recipeReference === reference),
          version = source.versions.find((x) => x.recipeVersionReference === versionReference);
        const covers = (at: string) =>
          !!version &&
          version.effectiveFrom <= at &&
          (version.effectiveUntil === null || at < version.effectiveUntil);
        const status = !parent
          ? "MissingRecipe"
          : !version
            ? "MissingVersion"
            : version.recipeReference !== reference
              ? "WrongRecipe"
              : parent.currentVersionReference !== versionReference
                ? "StaleVersion"
                : version.lifecycle !== "Published"
                  ? "UnpublishedVersion"
                  : !covers(now)
                    ? "InactiveObservedPeriod"
                    : !covers(activationAt)
                      ? "InactiveActivationPeriod"
                      : "CurrentPublishedMetadata";
        return Object.freeze({ optionReference, reference, versionReference, status });
      })
      .sort((a, b) => a.optionReference.localeCompare(b.optionReference));
    if (new Set(matches.map((m) => m.optionReference)).size !== matches.length) return fail();
    const body = {
      profile: "OptionDraftRecipeConsumptionMetadataV1" as const,
      brandReference,
      optionSetReference,
      versionReference,
      sourceDigest: parseRecipeDigest(r.sourceDigest),
      contentDigest: parseRecipeDigest(r.contentDigest),
      configurationDigest: parseRecipeDigest(r.configurationDigest),
      ownerSourceDigest: source.digest,
      ownerGeneration: source.generation,
      ownerObservedAt: source.observedAt,
      sourceOperationReference: request.operationReference,
      catalogIntentDigest: request.catalogIntentDigest,
      assessedAt: now,
      activationAt,
      ...(originalPublicationClock === undefined ? {} : { originalPublicationClock }),
      matches: Object.freeze(matches),
      decision: matches.every((m) => m.status === "CurrentPublishedMetadata")
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

export const recipeProductPublicationReferenceSourceFieldsV2 = Object.freeze([
  ...new Set([...recipeReferenceSourceFields, ...recipeProductPublicationReferenceRequestFieldsV2]),
] as const);
export interface RecipeProductPublicationReferenceSnapshotV2 extends Omit<
  RecipeReferenceSourceSnapshot,
  "request" | "profile"
> {
  readonly request: RecipeProductPublicationReferenceRequestV2;
  readonly profile: "BrandRecipeStoredReferencesForPublicationV2";
}
export function buildRecipeProductPublicationReferenceSnapshotV2(
  value: unknown,
  input: RecipeProductPublicationReferenceRequestV2,
  now: string,
): RecipeProductPublicationReferenceSnapshotV2 {
  try {
    const request = parseRecipeProductPublicationReferenceRequestV2(input),
      { observedAt, ...graph } = recipeReferenceGraph(value, request.brandReference, now);
    if (now < request.observedAt || now >= request.validUntil || observedAt < request.observedAt)
      return fail();
    const body = {
      request,
      profile: "BrandRecipeStoredReferencesForPublicationV2" as const,
      ...graph,
      observedAt,
    };
    return Object.freeze({
      ...body,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
    });
  } catch {
    return fail();
  }
}
export function parseRecipeProductPublicationReferenceSnapshotV2(
  value: unknown,
  input: RecipeProductPublicationReferenceRequestV2,
  now: string,
): RecipeProductPublicationReferenceSnapshotV2 {
  try {
    const r = exact(value, [
        "request",
        "profile",
        "coverage",
        "consistency",
        "applicability",
        "generation",
        "bindingCount",
        "observedAt",
        "digest",
        ...families,
      ]),
      request = parseRecipeProductPublicationReferenceRequestV2(input);
    if (
      canonicalizeRfc8785(parseRecipeProductPublicationReferenceRequestV2(r.request)) !==
        canonicalizeRfc8785(request) ||
      r.profile !== "BrandRecipeStoredReferencesForPublicationV2" ||
      r.coverage !== "CompleteStoredReferences" ||
      r.consistency !== "StatementSnapshot" ||
      r.applicability !== "Unavailable" ||
      typeof r.generation !== "string" ||
      typeof r.bindingCount !== "string"
    )
      return fail();
    const raw = Object.fromEntries(
      families.map((k) => [k, array(r[k]).map((v) => ({ ...exact(v, keys[k]), precise: true }))]),
    );
    const result = buildRecipeProductPublicationReferenceSnapshotV2(
      {
        ...raw,
        generation: r.generation,
        bindingCount: r.bindingCount,
        observedAt: r.observedAt,
        counts: Object.fromEntries(families.map((k) => [k, String(array(r[k]).length)])),
      },
      request,
      now,
    );
    if (result.digest !== parseRecipeDigest(r.digest)) return fail();
    return result;
  } catch {
    return fail();
  }
}
