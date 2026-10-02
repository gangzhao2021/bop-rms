import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { createEffectivePeriod } from "@bop/effective-period";
import {
  parseRecipeReference,
  parseRecipeDigest,
  parseRecipeCode,
  type RecipeSnapshot,
} from "../domain/recipe.js";
import {
  parseRecipeCoverageSnapshot,
  parseRecipeSourceCoverage,
  type RecipeCoverageSnapshot,
} from "./recipe-source-coverage.js";
import type { RecipeProjectionCore, RecipeProjectionCoreRow } from "./recipe-projection-core.js";
export class RecipeCoreQueryError extends Error {
  constructor(
    readonly code:
      | "RECIPE_CORE_QUERY_INPUT_INVALID"
      | "RECIPE_CORE_QUERY_PERMISSION_DENIED"
      | "RECIPE_CORE_QUERY_UNAVAILABLE"
      | "RECIPE_CORE_QUERY_INTEGRITY_CONFLICT",
  ) {
    super("Recipe core query is unavailable");
    this.name = "RecipeCoreQueryError";
  }
}
const fail = (): never => {
  throw new RecipeCoreQueryError("RECIPE_CORE_QUERY_INTEGRITY_CONFLICT");
};
export function coreQueryRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[key] = d.value;
  }
  return result;
}
export function coreQueryList(value: unknown, max = 2048): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail();
  const d = Object.getOwnPropertyDescriptor(value, "length");
  if (!d || !("value" in d) || d.value > max || Reflect.ownKeys(value).length !== d.value + 1)
    return fail();
  const result: unknown[] = [];
  for (let i = 0; i < d.value; i++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(i));
    if (!entry?.enumerable || !("value" in entry)) return fail();
    result.push(entry.value);
  }
  return result;
}
export function coreQueryInstant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  )
    return fail();
  return value;
}
export function coreQueryRevision(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,18})$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return fail();
  return value;
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    return fail();
  return value as number;
}
function natural(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,30}$/u.test(value) || BigInt(value) > 10n ** 30n)
    return fail();
  return value;
}
function choice<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== "string" || !options.includes(value as T)) return fail();
  return value as T;
}
/** Clone driver JSON before any nested consumer can read untrusted array getters. */
function safeJson(value: unknown): unknown {
  let remaining = 8_000_000;
  function copy(item: unknown, depth = 0): unknown {
    if (--remaining < 0 || depth > 32) return fail();
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      if (item.length > 4096) return fail();
      return item;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return fail();
      return item;
    }
    if (Array.isArray(item))
      return Object.freeze(coreQueryList(item, 524288).map((child) => copy(child, depth + 1)));
    if (typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype) return fail();
    const keys = Reflect.ownKeys(item);
    if (
      keys.length > 2048 ||
      keys.some(
        (key) => typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key),
      )
    )
      return fail();
    const raw = coreQueryRecord(item, keys as string[]),
      result: Record<string, unknown> = {};
    for (const key of keys as string[]) result[key] = copy(raw[key], depth + 1);
    return Object.freeze(result);
  }
  return copy(value);
}
function coreRow(value: unknown): RecipeProjectionCoreRow {
  const row = coreQueryRecord(value, [
    "recipeReference",
    "versionReference",
    "stableCode",
    "aggregateVersion",
    "versionNumber",
    "snapshotDigest",
    "lifecycle",
    "displayNameCode",
    "yieldQuantityMicrounits",
    "yieldUnitCode",
    "yieldDimension",
    "ingredients",
    "preparationVersionReference",
    "steps",
    "substitutionPolicyReference",
    "effectivePeriod",
    "invalidationReasonCode",
    "createdAt",
  ]);
  const ingredients = coreQueryList(row.ingredients, 256).map((value) => {
    const raw = coreQueryRecord(value, [
      "requirementReference",
      "sourceKind",
      "sourceReference",
      "sourceVersionReference",
      "quantityMicrounits",
      "unitDimension",
      "conversionNumerator",
      "conversionDenominator",
      "lossBasisPoints",
    ]);
    return Object.freeze({
      requirementReference: parseRecipeReference(raw.requirementReference),
      sourceKind: choice(raw.sourceKind, ["InventoryItem", "SubRecipe"]),
      sourceReference: parseRecipeReference(raw.sourceReference),
      sourceVersionReference: parseRecipeReference(raw.sourceVersionReference),
      quantityMicrounits: natural(raw.quantityMicrounits),
      unitDimension: choice(raw.unitDimension, ["Mass", "Volume", "Count"]),
      conversionNumerator: natural(raw.conversionNumerator),
      conversionDenominator: natural(raw.conversionDenominator),
      lossBasisPoints: integer(raw.lossBasisPoints, 0, 10000),
    });
  });
  const steps = coreQueryList(row.steps, 128).map((value) => {
    const raw = coreQueryRecord(value, [
      "stepReference",
      "sequenceGroup",
      "instructionCode",
      "durationSeconds",
      "capabilityCode",
    ]);
    return Object.freeze({
      stepReference: parseRecipeReference(raw.stepReference),
      sequenceGroup: integer(raw.sequenceGroup, 0),
      instructionCode: parseRecipeCode(raw.instructionCode),
      durationSeconds: integer(raw.durationSeconds, 1, 86400),
      capabilityCode: parseRecipeCode(raw.capabilityCode),
    });
  });
  if (
    !ingredients.length ||
    !steps.length ||
    new Set(ingredients.map((item) => item.requirementReference)).size !== ingredients.length ||
    new Set(steps.map((item) => item.stepReference)).size !== steps.length
  )
    return fail();
  const lifecycle = choice(row.lifecycle, ["Draft", "Published", "Invalidated", "Archived"]);
  if ((lifecycle === "Invalidated") !== (row.invalidationReasonCode !== null)) return fail();
  return Object.freeze({
    recipeReference: parseRecipeReference(row.recipeReference),
    versionReference: parseRecipeReference(row.versionReference),
    stableCode: parseRecipeCode(row.stableCode),
    aggregateVersion: integer(row.aggregateVersion, 1),
    versionNumber: integer(row.versionNumber, 1),
    snapshotDigest: parseRecipeDigest(row.snapshotDigest),
    lifecycle,
    displayNameCode: parseRecipeCode(row.displayNameCode),
    yieldQuantityMicrounits: natural(row.yieldQuantityMicrounits),
    yieldUnitCode: parseRecipeCode(row.yieldUnitCode),
    yieldDimension: choice(row.yieldDimension, ["Mass", "Volume", "Count"]),
    ingredients: Object.freeze(ingredients),
    preparationVersionReference: parseRecipeReference(row.preparationVersionReference),
    steps: Object.freeze(steps),
    substitutionPolicyReference:
      row.substitutionPolicyReference === null
        ? null
        : parseRecipeReference(row.substitutionPolicyReference),
    effectivePeriod: createEffectivePeriod(
      row.effectivePeriod as RecipeSnapshot["effectivePeriod"],
    ),
    invalidationReasonCode:
      row.invalidationReasonCode === null ? null : parseRecipeCode(row.invalidationReasonCode),
    createdAt: coreQueryInstant(row.createdAt),
  });
}
export interface DecodedRecipeCoreGeneration {
  readonly generationReference: string;
  readonly publicationRevision: string;
  readonly builtAt: string;
  readonly coverage: RecipeCoverageSnapshot;
  readonly coreDigest: string;
  readonly core: RecipeProjectionCore;
}
/** Internal persisted owner result only; no field permission, source freshness or Merchant DTO. */
export function decodeRecipeCoreGeneration(
  value: unknown,
  scope: { readonly tenantReference: string; readonly brandReference: string },
): DecodedRecipeCoreGeneration {
  try {
    const raw = coreQueryRecord(safeJson(value), [
      "generationReference",
      "tenantReference",
      "brandReference",
      "revision",
      "projectionVersion",
      "coreDigest",
      "rowCount",
      "graph",
      "sourceRecord",
      "rows",
    ]);
    if (
      raw.tenantReference !== scope.tenantReference ||
      raw.brandReference !== scope.brandReference ||
      raw.projectionVersion !== 2
    )
      return fail();
    const generationReference = parseRecipeReference(raw.generationReference),
      publicationRevision = coreQueryRevision(raw.revision);
    if (publicationRevision === "0") return fail();
    const intent = coreQueryRecord(raw.sourceRecord, [
        "generationReference",
        "actorReference",
        "purpose",
        "expectedRevision",
        "builtAt",
        "coverage",
      ]),
      coverage = parseRecipeCoverageSnapshot(intent.coverage),
      builtAt = coreQueryInstant(intent.builtAt);
    parseRecipeReference(intent.actorReference);
    if (
      intent.generationReference !== generationReference ||
      intent.purpose !== "RecipeProjectionBuild" ||
      BigInt(coreQueryRevision(intent.expectedRevision)) + 1n !== BigInt(publicationRevision) ||
      coverage.tenantReference !== scope.tenantReference ||
      coverage.brandReference !== scope.brandReference ||
      coverage.sources.some((item) => !item.complete)
    )
      return fail();
    const g = coreQueryRecord(raw.graph, [
        "source",
        "currentRoots",
        "nodes",
        "edges",
        "postorderVersions",
      ]),
      s = coreQueryRecord(g.source, ["coverage", "capturedAtUtc", "asOfUtc"]),
      recipeCoverage = parseRecipeSourceCoverage(s.coverage),
      capturedAtUtc = coreQueryInstant(s.capturedAtUtc),
      asOfUtc = coreQueryInstant(s.asOfUtc);
    if (
      capturedAtUtc > asOfUtc ||
      asOfUtc !== builtAt ||
      canonicalizeRfc8785(recipeCoverage) !==
        canonicalizeRfc8785(coverage.sources.find((item) => item.family === "Recipe"))
    )
      return fail();
    const node = (value: unknown) => {
      const n = coreQueryRecord(value, ["recipeReference", "versionReference", "snapshotDigest"]);
      return Object.freeze({
        recipeReference: parseRecipeReference(n.recipeReference),
        versionReference: parseRecipeReference(n.versionReference),
        snapshotDigest: parseRecipeDigest(n.snapshotDigest),
      });
    };
    const nodes = Object.freeze(coreQueryList(g.nodes).map(node)),
      currentRoots = Object.freeze(coreQueryList(g.currentRoots).map(node)),
      byVersion = new Map(nodes.map((n) => [n.versionReference, n]));
    if (
      byVersion.size !== nodes.length ||
      new Set(currentRoots.map((n) => n.recipeReference)).size !== currentRoots.length
    )
      return fail();
    const sorted = [...nodes].sort(
      (a, b) =>
        a.recipeReference.localeCompare(b.recipeReference) ||
        a.versionReference.localeCompare(b.versionReference),
    );
    if (
      canonicalizeRfc8785(sorted) !== canonicalizeRfc8785(nodes) ||
      canonicalizeRfc8785(
        [...currentRoots].sort((a, b) => a.recipeReference.localeCompare(b.recipeReference)),
      ) !== canonicalizeRfc8785(currentRoots)
    )
      return fail();
    for (const root of currentRoots)
      if (canonicalizeRfc8785(byVersion.get(root.versionReference)) !== canonicalizeRfc8785(root))
        return fail();
    const dependencies = nodes.map((n) => ({
      objectReference: n.recipeReference,
      versionReference: n.versionReference,
      digest: n.snapshotDigest,
    }));
    if (canonicalizeRfc8785(dependencies) !== canonicalizeRfc8785(recipeCoverage.dependencies))
      return fail();
    const recipeDigest = `sha256:${createHash("sha256")
      .update(
        canonicalizeRfc8785({
          family: "Recipe",
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          dependencies,
          roots: currentRoots.map((n) => ({
            objectReference: n.recipeReference,
            versionReference: n.versionReference,
          })),
        }),
      )
      .digest("hex")}`;
    if (recipeDigest !== recipeCoverage.digest) return fail();
    const edges = Object.freeze(
      coreQueryList(g.edges, 524288).map((value) => {
        const e = coreQueryRecord(value, [
          "requirementReference",
          "fromRecipeReference",
          "fromVersionReference",
          "toRecipeReference",
          "toVersionReference",
        ]);
        return Object.freeze({
          requirementReference: parseRecipeReference(e.requirementReference),
          fromRecipeReference: parseRecipeReference(e.fromRecipeReference),
          fromVersionReference: parseRecipeReference(e.fromVersionReference),
          toRecipeReference: parseRecipeReference(e.toRecipeReference),
          toVersionReference: parseRecipeReference(e.toVersionReference),
        });
      }),
    );
    if (
      new Set(edges.map((e) => `${e.fromVersionReference}:${e.requirementReference}`)).size !==
      edges.length
    )
      return fail();
    const postorderVersions = Object.freeze(
        coreQueryList(g.postorderVersions).map(parseRecipeReference),
      ),
      positions = new Map(postorderVersions.map((v, i) => [v, i])),
      heights = new Map<string, number>();
    if (positions.size !== nodes.length || postorderVersions.length !== nodes.length) return fail();
    const children = new Map<string, string[]>(),
      edgesByVersion = new Map<string, (typeof edges)[number][]>();
    for (const e of edges) {
      const targets = children.get(e.fromVersionReference) ?? [],
        group = edgesByVersion.get(e.fromVersionReference) ?? [];
      if (group.length >= 256) return fail();
      targets.push(e.toVersionReference);
      group.push(e);
      children.set(e.fromVersionReference, targets);
      edgesByVersion.set(e.fromVersionReference, group);
    }

    for (const e of edges) {
      const from = byVersion.get(e.fromVersionReference),
        to = byVersion.get(e.toVersionReference),
        fromPosition = positions.get(e.fromVersionReference),
        toPosition = positions.get(e.toVersionReference);
      if (
        from?.recipeReference !== e.fromRecipeReference ||
        to?.recipeReference !== e.toRecipeReference ||
        fromPosition === undefined ||
        toPosition === undefined ||
        toPosition >= fromPosition
      )
        return fail();
    }
    for (const version of postorderVersions) {
      if (!byVersion.has(version)) return fail();
      const height = Math.max(
        0,
        ...(children.get(version) ?? []).map((child) => 1 + (heights.get(child) ?? 17)),
      );
      if (height > 16) return fail();
      heights.set(version, height);
    }
    const reachable = new Set<string>();
    function visit(version: string) {
      if (reachable.has(version)) return;
      reachable.add(version);
      for (const child of children.get(version) ?? []) visit(child);
    }
    for (const root of currentRoots) visit(root.versionReference);
    if (reachable.size !== nodes.length) return fail();
    const rows = Object.freeze(coreQueryList(raw.rows).map(coreRow));
    if (integer(raw.rowCount, 0, 2048) !== rows.length || rows.length !== currentRoots.length)
      return fail();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i],
        root = currentRoots[i];
      if (
        !row ||
        !root ||
        row.recipeReference !== root.recipeReference ||
        row.versionReference !== root.versionReference ||
        row.snapshotDigest !== root.snapshotDigest ||
        row.createdAt > asOfUtc
      )
        return fail();
      const requirements = row.ingredients.filter((item) => item.sourceKind === "SubRecipe");
      const rowEdges = edgesByVersion.get(row.versionReference) ?? [];
      if (requirements.length !== rowEdges.length) return fail();
      for (const item of requirements)
        if (
          !rowEdges.some(
            (e) =>
              e.requirementReference === item.requirementReference &&
              e.toRecipeReference === item.sourceReference &&
              e.toVersionReference === item.sourceVersionReference,
          )
        )
          return fail();
    }
    const core = Object.freeze({
        graph: Object.freeze({
          source: Object.freeze({ coverage: recipeCoverage, capturedAtUtc, asOfUtc }),
          currentRoots,
          nodes,
          edges,
          postorderVersions,
        }),
        rows,
      }),
      coreDigest = parseRecipeDigest(raw.coreDigest);
    if (
      `sha256:${createHash("sha256").update(canonicalizeRfc8785(core)).digest("hex")}` !==
      coreDigest
    )
      return fail();
    return Object.freeze({
      generationReference,
      publicationRevision,
      builtAt,
      coverage,
      coreDigest,
      core,
    });
  } catch (error) {
    if (error instanceof RecipeCoreQueryError) throw error;
    return fail();
  }
}
