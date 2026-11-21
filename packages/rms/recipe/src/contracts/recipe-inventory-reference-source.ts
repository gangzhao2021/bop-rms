import {
  recipeProductPublicationReferenceRequestFieldsV2,
  parseRecipeInventoryProductPublicationReferenceRequestV2,
  type RecipeInventoryProductPublicationReferenceRequestV2,
} from "./product-publication-reference-request-v2.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseRecipeReference, parseRecipeDigest } from "../domain/recipe.js";
import { RecipeWorkflowError } from "../application/recipe-service.js";
import {
  parseRecipeReferenceSourceInstant,
  type RecipeRootReference,
  type RecipeVersionReference,
  type RecipeReferenceLifecycle,
} from "./recipe-reference-source.js";
export const recipeInventoryReferenceMaximumRows = 10000;
const rootFields = [
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
const ingredientFields = [
  "requirementReference",
  "recipeVersionReference",
  "recipeReference",
  "brandReference",
  "sourceKind",
  "sourceReference",
  "sourceVersionReference",
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
  "lifecycle",
  "ruleDigest",
  "effectiveFrom",
  "effectiveUntil",
  "occurredAt",
  "changeCount",
] as const;
export const recipeInventoryReferenceFields = Object.freeze([
  ...new Set([
    "generation",
    ...rootFields,
    ...versionFields,
    ...ingredientFields,
    ...modifierFields,
    "sequence",
    "action",
    "replacementRequirementReference",
  ]),
] as const);
export interface RecipeInventoryReferenceRequest {
  readonly purposeCode: "CATALOG_LIFECYCLE_INVENTORY_RECIPE_SOURCE_READ";
  readonly brandReference: string;
  readonly actorReference: string;
  readonly operationReference: string;
  readonly catalogIntentDigest: string;
}
export interface RecipeIngredientReference {
  readonly requirementReference: string;
  readonly recipeVersionReference: string;
  readonly recipeReference: string;
  readonly brandReference: string;
  readonly sourceKind: "InventoryItem" | "SubRecipe";
  readonly sourceReference: string;
  readonly sourceVersionReference: string;
}
export interface RecipeInventoryModifierReference {
  readonly ruleVersionReference: string;
  readonly ruleReference: string;
  readonly recipeVersionReference: string;
  readonly recipeReference: string;
  readonly brandReference: string;
  readonly bindingReference: string;
  readonly optionReference: string;
  readonly version: number;
  readonly lifecycle: RecipeReferenceLifecycle;
  readonly ruleDigest: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly occurredAt: string;
  readonly changeCount: number;
}
export type RecipeInventoryChangeReference =
  | {
      readonly ruleVersionReference: string;
      readonly sequence: number;
      readonly action: "Add";
      readonly requirementReference: string;
      readonly sourceKind: "InventoryItem" | "SubRecipe";
      readonly sourceReference: string;
      readonly sourceVersionReference: string;
    }
  | {
      readonly ruleVersionReference: string;
      readonly sequence: number;
      readonly action: "Remove";
      readonly requirementReference: string;
    }
  | {
      readonly ruleVersionReference: string;
      readonly sequence: number;
      readonly action: "Replace";
      readonly requirementReference: string;
      readonly replacementRequirementReference: string;
      readonly sourceKind: "InventoryItem" | "SubRecipe";
      readonly sourceReference: string;
      readonly sourceVersionReference: string;
    };
export interface RecipeInventoryReferenceSnapshot {
  readonly request: RecipeInventoryReferenceRequest;
  readonly profile: "BrandRecipeInventoryStoredReferencesV1";
  readonly coverage: "CompleteStoredReferences";
  readonly consistency: "StatementSnapshot";
  readonly applicability: "Unavailable";
  readonly removalResolution: "Unavailable";
  readonly conditionalApplicability: "Unavailable";
  readonly generation: string;
  readonly observedAt: string;
  readonly digest: string;
  readonly recipes: readonly RecipeRootReference[];
  readonly versions: readonly RecipeVersionReference[];
  readonly ingredients: readonly RecipeIngredientReference[];
  readonly modifiers: readonly RecipeInventoryModifierReference[];
  readonly changes: readonly RecipeInventoryChangeReference[];
}
const fail = (): never => {
  throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
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
    v.length > recipeInventoryReferenceMaximumRows ||
    Reflect.ownKeys(v).length !== v.length + 1
  )
    return fail();
  return Array.from({ length: v.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(v, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value;
  });
}
const ref = parseRecipeReference,
  instant = parseRecipeReferenceSourceInstant;
const integer = (v: unknown, min = 1, max = 2147483647): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail();
const kind = (v: unknown): "InventoryItem" | "SubRecipe" =>
  v === "InventoryItem" || v === "SubRecipe" ? v : fail();
const state = (v: unknown): RecipeReferenceLifecycle =>
  v === "Draft" || v === "Published" || v === "Invalidated" || v === "Archived" ? v : fail();
export function parseRecipeInventoryReferenceRequest(
  value: unknown,
): RecipeInventoryReferenceRequest {
  try {
    const r = exact(value, [
      "purposeCode",
      "brandReference",
      "actorReference",
      "operationReference",
      "catalogIntentDigest",
    ]);
    if (r.purposeCode !== "CATALOG_LIFECYCLE_INVENTORY_RECIPE_SOURCE_READ") return fail();
    return Object.freeze({
      purposeCode: r.purposeCode,
      brandReference: ref(r.brandReference),
      actorReference: ref(r.actorReference),
      operationReference: ref(r.operationReference),
      catalogIntentDigest: parseRecipeDigest(r.catalogIntentDigest),
    });
  } catch {
    return fail();
  }
}
const families = ["recipes", "versions", "ingredients", "modifiers", "changes"] as const;
const addFields = [
  "ruleVersionReference",
  "sequence",
  "action",
  "requirementReference",
  "sourceKind",
  "sourceReference",
  "sourceVersionReference",
] as const;
const removeFields = [
  "ruleVersionReference",
  "sequence",
  "action",
  "requirementReference",
] as const;
const replaceFields = [...addFields, "replacementRequirementReference"] as const;
function changeFields(v: unknown) {
  const d = v && typeof v === "object" ? Object.getOwnPropertyDescriptor(v, "action") : undefined;
  if (!d?.enumerable || !("value" in d)) return fail();
  return d.value === "Add"
    ? addFields
    : d.value === "Remove"
      ? removeFields
      : d.value === "Replace"
        ? replaceFields
        : fail();
}
/** Stored dependency graph: base SubRecipe cycles are invalid; historical conditional
 * modifiers are never applied together, nor used to claim active Inventory consumption. */
export function buildRecipeInventoryReferenceSnapshot(
  value: unknown,
  input: RecipeInventoryReferenceRequest,
  now: string,
): RecipeInventoryReferenceSnapshot {
  try {
    const request = parseRecipeInventoryReferenceRequest(input),
      { observedAt, ...graph } = recipeInventoryReferenceGraph(value, request.brandReference, now),
      body = { request, profile: "BrandRecipeInventoryStoredReferencesV1" as const, ...graph };
    return Object.freeze({
      ...body,
      observedAt,
      digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)),
    });
  } catch {
    return fail();
  }
}
function recipeInventoryReferenceGraph(value: unknown, expectedBrand: string, now: string) {
  try {
    const r = exact(value, ["generation", "counts", "observedAt", ...families]),
      counts = exact(r.counts, families),
      raw = Object.fromEntries(families.map((k) => [k, list(r[k])])) as Record<
        (typeof families)[number],
        unknown[]
      >;
    const observedAt = instant(r.observedAt),
      at = instant(now),
      total = families.reduce((n, k) => n + raw[k].length, 0);
    if (
      total > recipeInventoryReferenceMaximumRows ||
      at < observedAt ||
      Date.parse(at) - Date.parse(observedAt) > 5000 ||
      families.some((k) => counts[k] !== String(raw[k].length))
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
    const brand = (v: unknown) => {
        const b = ref(v);
        return b === expectedBrand ? b : fail();
      },
      past = (v: unknown) => {
        const t = instant(v);
        return t <= observedAt ? t : fail();
      },
      read = (v: unknown, k: readonly string[]) => {
        const e = exact(v, [...k, "precise"]);
        if (e.precise !== true) return fail();
        return e;
      },
      period = (e: Record<string, unknown>) => {
        const effectiveFrom = instant(e.effectiveFrom),
          effectiveUntil = e.effectiveUntil === null ? null : instant(e.effectiveUntil);
        if (effectiveUntil !== null && effectiveUntil <= effectiveFrom) return fail();
        return { effectiveFrom, effectiveUntil };
      };
    const recipes = raw.recipes.map((v) => {
      const e = read(v, rootFields);
      return Object.freeze({
        recipeReference: ref(e.recipeReference),
        brandReference: brand(e.brandReference),
        aggregateVersion: integer(e.aggregateVersion),
        currentVersionReference:
          e.currentVersionReference === null ? null : ref(e.currentVersionReference),
        updatedAt: past(e.updatedAt),
      });
    });
    const roots = new Map(recipes.map((p) => [p.recipeReference, p]));
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
    const versionMap = new Map(versions.map((v) => [v.recipeVersionReference, v])),
      versionKeys = new Set<string>();
    if (versionMap.size !== versions.length) return fail();
    for (const v of versions) {
      const k = v.recipeReference + ":" + v.versionNumber;
      if (versionKeys.has(k)) return fail();
      versionKeys.add(k);
    }
    for (const p of recipes)
      if (
        p.currentVersionReference !== null &&
        versionMap.get(p.currentVersionReference)?.recipeReference !== p.recipeReference
      )
        return fail();
    const parent = (e: Record<string, unknown>) => {
      const p = root(e),
        v = versionMap.get(ref(e.recipeVersionReference));
      if (!v || v.recipeReference !== p.recipeReference) return fail();
      return v;
    };
    const subRecipe = (
      sourceKind: string,
      sourceReference: string,
      sourceVersionReference: string,
    ) => {
      if (
        sourceKind === "SubRecipe" &&
        versionMap.get(ref(sourceVersionReference))?.recipeReference !== sourceReference
      )
        return fail();
    };
    const ingredients = raw.ingredients.map((v) => {
      const e = exact(v, ingredientFields),
        p = parent(e),
        sourceKind = kind(e.sourceKind),
        sourceReference = ref(e.sourceReference),
        sourceVersionReference = ref(e.sourceVersionReference);
      subRecipe(sourceKind, sourceReference, sourceVersionReference);
      return Object.freeze({
        requirementReference: ref(e.requirementReference),
        recipeReference: p.recipeReference,
        recipeVersionReference: p.recipeVersionReference,
        brandReference: p.brandReference,
        sourceKind,
        sourceReference,
        sourceVersionReference,
      });
    });
    if (
      new Set(ingredients.map((i) => i.recipeVersionReference + ":" + i.requirementReference))
        .size !== ingredients.length
    )
      return fail();
    const modifiers = raw.modifiers.map((v) => {
      const e = read(v, modifierFields),
        p = parent(e);
      return Object.freeze({
        ruleVersionReference: ref(e.ruleVersionReference),
        ruleReference: ref(e.ruleReference),
        recipeReference: p.recipeReference,
        recipeVersionReference: p.recipeVersionReference,
        brandReference: p.brandReference,
        bindingReference: ref(e.bindingReference),
        optionReference: ref(e.optionReference),
        version: integer(e.version),
        lifecycle: state(e.lifecycle),
        ruleDigest: parseRecipeDigest(e.ruleDigest),
        ...period(e),
        occurredAt: past(e.occurredAt),
        changeCount: integer(e.changeCount, 0, 256),
      });
    });
    const modifierMap = new Map(modifiers.map((m) => [m.ruleVersionReference, m]));
    if (modifierMap.size !== modifiers.length) return fail();
    const ruleHistory = new Map<string, RecipeInventoryModifierReference[]>();
    for (const m of modifiers) {
      const h = ruleHistory.get(m.ruleReference) ?? [];
      h.push(m);
      ruleHistory.set(m.ruleReference, h);
    }
    for (const h of ruleHistory.values()) {
      h.sort((a, b) => a.version - b.version);
      for (let i = 0; i < h.length; i++) {
        const m = h[i],
          p = h[i - 1];
        if (!m || m.version !== i + 1 || (p && m.occurredAt < p.occurredAt)) return fail();
      }
    }
    const changeKeys = new Set<string>(),
      changeHistory = new Map<string, RecipeInventoryChangeReference[]>();
    const changes = raw.changes.map((v): RecipeInventoryChangeReference => {
      const e = exact(v, changeFields(v)),
        ruleVersionReference = ref(e.ruleVersionReference),
        sequence = integer(e.sequence, 1, 256),
        m = modifierMap.get(ruleVersionReference),
        k = ruleVersionReference + ":" + sequence;
      if (!m || changeKeys.has(k)) return fail();
      changeKeys.add(k);
      const base = {
        ruleVersionReference,
        sequence,
        requirementReference: ref(e.requirementReference),
      };
      let c: RecipeInventoryChangeReference;
      if (e.action === "Remove") c = Object.freeze({ ...base, action: "Remove" });
      else {
        const sourceKind = kind(e.sourceKind),
          sourceReference = ref(e.sourceReference),
          sourceVersionReference = ref(e.sourceVersionReference);
        subRecipe(sourceKind, sourceReference, sourceVersionReference);
        const added = { sourceKind, sourceReference, sourceVersionReference };
        c =
          e.action === "Add"
            ? Object.freeze({ ...base, action: "Add", ...added })
            : Object.freeze({
                ...base,
                action: "Replace",
                replacementRequirementReference: ref(e.replacementRequirementReference),
                ...added,
              });
      }
      const h = changeHistory.get(ruleVersionReference) ?? [];
      h.push(c);
      changeHistory.set(ruleVersionReference, h);
      return c;
    });
    for (const m of modifiers) {
      const h = (changeHistory.get(m.ruleVersionReference) ?? []).sort(
        (a, b) => a.sequence - b.sequence,
      );
      if (h.length !== m.changeCount || h.some((c, i) => c.sequence !== i + 1)) return fail();
    }
    // Kahn traversal covers base-only pinned versions, including unrelated empty nodes, without recursion overflow.
    const edges = new Map<string, Set<string>>(
        versions.map((v) => [v.recipeVersionReference, new Set<string>()]),
      ),
      indegree = new Map<string, number>(versions.map((v) => [v.recipeVersionReference, 0]));
    for (const i of ingredients)
      if (i.sourceKind === "SubRecipe") {
        const targets = edges.get(i.recipeVersionReference);
        if (!targets) return fail();
        if (!targets.has(i.sourceVersionReference)) {
          targets.add(i.sourceVersionReference);
          indegree.set(i.sourceVersionReference, (indegree.get(i.sourceVersionReference) ?? 0) + 1);
        }
      }
    const queue = [...indegree].filter(([, n]) => n === 0).map(([v]) => v);
    let processed = 0;
    // Array iteration visits newly appended zero-indegree nodes.
    for (const v of queue) {
      processed++;
      for (const child of edges.get(v) ?? []) {
        const remaining = (indegree.get(child) ?? 0) - 1;
        indegree.set(child, remaining);
        if (remaining === 0) queue.push(child);
      }
    }
    if (processed !== versions.length) return fail();
    const body = {
      coverage: "CompleteStoredReferences" as const,
      consistency: "StatementSnapshot" as const,
      applicability: "Unavailable" as const,
      removalResolution: "Unavailable" as const,
      conditionalApplicability: "Unavailable" as const,
      generation,
      recipes: Object.freeze(
        recipes.sort((a, b) => a.recipeReference.localeCompare(b.recipeReference)),
      ),
      versions: Object.freeze(
        versions.sort((a, b) => a.recipeVersionReference.localeCompare(b.recipeVersionReference)),
      ),
      ingredients: Object.freeze(
        ingredients.sort(
          (a, b) =>
            a.recipeVersionReference.localeCompare(b.recipeVersionReference) ||
            a.requirementReference.localeCompare(b.requirementReference),
        ),
      ),
      modifiers: Object.freeze(
        modifiers.sort((a, b) => a.ruleVersionReference.localeCompare(b.ruleVersionReference)),
      ),
      changes: Object.freeze(
        changes.sort(
          (a, b) =>
            a.ruleVersionReference.localeCompare(b.ruleVersionReference) || a.sequence - b.sequence,
        ),
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
export function parseRecipeInventoryReferenceSnapshot(
  value: unknown,
  input: RecipeInventoryReferenceRequest,
  now: string,
): RecipeInventoryReferenceSnapshot {
  try {
    const r = exact(value, [
        "request",
        "profile",
        "coverage",
        "consistency",
        "applicability",
        "removalResolution",
        "conditionalApplicability",
        "generation",
        "observedAt",
        "digest",
        ...families,
      ]),
      request = parseRecipeInventoryReferenceRequest(input);
    if (
      canonicalizeRfc8785(parseRecipeInventoryReferenceRequest(r.request)) !==
        canonicalizeRfc8785(request) ||
      r.profile !== "BrandRecipeInventoryStoredReferencesV1" ||
      r.coverage !== "CompleteStoredReferences" ||
      r.consistency !== "StatementSnapshot" ||
      r.applicability !== "Unavailable" ||
      r.removalResolution !== "Unavailable" ||
      r.conditionalApplicability !== "Unavailable" ||
      typeof r.generation !== "string"
    )
      return fail();
    const keys = {
      recipes: rootFields,
      versions: versionFields,
      ingredients: ingredientFields,
      modifiers: modifierFields,
    };
    const raw = Object.fromEntries(
      families.map((k) => [
        k,
        list(r[k]).map((v) => {
          const fields = k === "changes" ? changeFields(v) : keys[k];
          return {
            ...exact(v, fields),
            ...(k === "recipes" || k === "versions" || k === "modifiers" ? { precise: true } : {}),
          };
        }),
      ]),
    );
    const result = buildRecipeInventoryReferenceSnapshot(
      {
        ...raw,
        generation: r.generation,
        observedAt: r.observedAt,
        counts: Object.fromEntries(families.map((k) => [k, String(list(r[k]).length)])),
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

export const recipeInventoryProductPublicationReferenceSourceFieldsV2 = Object.freeze([
  ...new Set([
    ...recipeInventoryReferenceFields,
    ...recipeProductPublicationReferenceRequestFieldsV2,
  ]),
] as const);
export interface RecipeInventoryProductPublicationReferenceSnapshotV2 extends Omit<
  RecipeInventoryReferenceSnapshot,
  "request" | "profile"
> {
  readonly request: RecipeInventoryProductPublicationReferenceRequestV2;
  readonly profile: "BrandRecipeInventoryStoredReferencesForPublicationV2";
}
export function buildRecipeInventoryProductPublicationReferenceSnapshotV2(
  value: unknown,
  input: RecipeInventoryProductPublicationReferenceRequestV2,
  now: string,
): RecipeInventoryProductPublicationReferenceSnapshotV2 {
  try {
    const request = parseRecipeInventoryProductPublicationReferenceRequestV2(input),
      { observedAt, ...graph } = recipeInventoryReferenceGraph(value, request.brandReference, now);
    if (now < request.observedAt || now >= request.validUntil || observedAt < request.observedAt)
      return fail();
    const body = {
      request,
      profile: "BrandRecipeInventoryStoredReferencesForPublicationV2" as const,
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
export function parseRecipeInventoryProductPublicationReferenceSnapshotV2(
  value: unknown,
  input: RecipeInventoryProductPublicationReferenceRequestV2,
  now: string,
): RecipeInventoryProductPublicationReferenceSnapshotV2 {
  try {
    const r = exact(value, [
        "request",
        "profile",
        "coverage",
        "consistency",
        "applicability",
        "removalResolution",
        "conditionalApplicability",
        "generation",
        "observedAt",
        "digest",
        ...families,
      ]),
      request = parseRecipeInventoryProductPublicationReferenceRequestV2(input);
    if (
      canonicalizeRfc8785(parseRecipeInventoryProductPublicationReferenceRequestV2(r.request)) !==
        canonicalizeRfc8785(request) ||
      r.profile !== "BrandRecipeInventoryStoredReferencesForPublicationV2" ||
      r.coverage !== "CompleteStoredReferences" ||
      r.consistency !== "StatementSnapshot" ||
      r.applicability !== "Unavailable" ||
      r.removalResolution !== "Unavailable" ||
      r.conditionalApplicability !== "Unavailable" ||
      typeof r.generation !== "string"
    )
      return fail();
    const keys = {
      recipes: rootFields,
      versions: versionFields,
      ingredients: ingredientFields,
      modifiers: modifierFields,
    };
    const raw = Object.fromEntries(
      families.map((k) => [
        k,
        list(r[k]).map((v) => {
          const fields = k === "changes" ? changeFields(v) : keys[k];
          return {
            ...exact(v, fields),
            ...(k === "recipes" || k === "versions" || k === "modifiers" ? { precise: true } : {}),
          };
        }),
      ]),
    );
    const result = buildRecipeInventoryProductPublicationReferenceSnapshotV2(
      {
        ...raw,
        generation: r.generation,
        observedAt: r.observedAt,
        counts: Object.fromEntries(families.map((k) => [k, String(list(r[k]).length)])),
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
