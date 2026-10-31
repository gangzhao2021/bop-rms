import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  createRecipeSnapshot,
  parseRecipeReference,
  parseRecipeDigest,
  type RecipeSnapshot,
} from "../../domain/recipe.js";
import {
  parseRecipeSourceCoverage,
  type RecipeSourceCoverage,
  type RecipeSourceDependency,
} from "../../application/recipe-source-coverage.js";
import { parseRecipeModifierPublicationEvidence } from "../../domain/publication-review.js";
import { parseRecipeModifierRule } from "../../domain/recipe-modifier.js";
import { parseRecipePreparationPublication } from "../../domain/recipe-preparation-publication.js";
import type { RecipeTransaction, RecipeTransactionRunner } from "./recipe-query-store.js";
export type RecipeOwnerCoverageErrorCode =
  | "RECIPE_SOURCE_INPUT_INVALID"
  | "RECIPE_SOURCE_PERMISSION_DENIED"
  | "RECIPE_SOURCE_UNAVAILABLE"
  | "RECIPE_SOURCE_CHANGED"
  | "RECIPE_SOURCE_INTEGRITY_CONFLICT";
export class RecipeOwnerCoverageError extends Error {
  constructor(readonly code: RecipeOwnerCoverageErrorCode) {
    super("Recipe owner coverage is unavailable");
    this.name = "RecipeOwnerCoverageError";
  }
}
export interface RecipeOwnerCoverageRequest {
  readonly actorReference: string;
  readonly purpose: "RecipeProjectionBuild";
  readonly observedAtUtc: string;
}
export interface RecipeOwnerCoverageRead {
  readonly coverage: RecipeSourceCoverage;
  readonly capturedAtUtc: string;
  readonly asOfUtc: string;
}
/** Internal restricted projection facts, available only while the source callback is held. */
export interface RecipeProjectionGraphFacts {
  readonly source: RecipeOwnerCoverageRead;
  readonly currentRecipes: readonly RecipeSnapshot[];
  readonly recipes: readonly RecipeSnapshot[];
}
export interface RecipeProjectionFactsAuthorization extends RecipeOwnerCoverageAuthorizationInput {
  readonly access: "ProjectionFacts";
}
export type RecipeOwnedSourceFamily = "Recipe" | "Preparation" | "Substitution" | "Usage";
export interface RecipeOwnerCoverageAuthorizationInput extends RecipeOwnerCoverageRequest {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly family: RecipeOwnedSourceFamily;
}
export interface RecipeUsageStoreCoverage {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly snapshotReference: string;
  readonly digest: string;
  readonly complete: true;
  readonly storeReferences: readonly string[];
}
/** Public capability: authorize complete Brand coverage and hold its directory through work COMMIT. */
export interface RecipeUsageStoreCoverageFence {
  withCurrent<T>(
    input: RecipeOwnerCoverageAuthorizationInput,
    work: (coverage: unknown) => Promise<T>,
  ): Promise<T>;
}
function fail(code: RecipeOwnerCoverageErrorCode = "RECIPE_SOURCE_UNAVAILABLE"): never {
  throw new RecipeOwnerCoverageError(code);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[key] = descriptor.value;
  }
  return result;
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  )
    return fail();
  return value;
}
function request(value: unknown): RecipeOwnerCoverageRequest {
  const raw = record(value, ["actorReference", "purpose", "observedAtUtc"]);
  if (raw.purpose !== "RecipeProjectionBuild") return fail();
  return Object.freeze({
    actorReference: parseRecipeReference(raw.actorReference),
    purpose: raw.purpose,
    observedAtUtc: instant(raw.observedAtUtc),
  });
}
function rows(value: unknown, max: number): readonly unknown[] {
  if (value === null || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Array.isArray(descriptor.value) ||
    Object.getPrototypeOf(descriptor.value) !== Array.prototype ||
    descriptor.value.length > max ||
    Reflect.ownKeys(descriptor.value).length !== descriptor.value.length + 1
  )
    return fail();
  const result: unknown[] = [];
  for (let i = 0; i < descriptor.value.length; i += 1) {
    const item = Object.getOwnPropertyDescriptor(descriptor.value, String(i));
    if (!item?.enumerable || !("value" in item)) return fail();
    result.push(item.value);
  }
  return result;
}
function digestOf(
  tenant: string,
  brand: string,
  dependencies: readonly RecipeSourceDependency[],
  roots: readonly { readonly objectReference: string; readonly versionReference: string }[],
): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalizeRfc8785({
        family: "Recipe",
        tenantReference: tenant,
        brandReference: brand,
        dependencies,
        roots,
      }),
    )
    .digest("hex")}`;
}
const selectCurrent = `SELECT r.recipe_id AS "recipeReference",r.current_version_id AS "versionReference",r.aggregate_version AS "aggregateVersion",r.stable_code AS "stableCode",v.snapshot_digest AS digest,v.snapshot_json AS snapshot,v.brand_id AS "brandReference"
  FROM rms_recipe.recipe r LEFT JOIN rms_recipe.recipe_version v ON v.recipe_version_id=r.current_version_id AND v.recipe_id=r.recipe_id AND v.brand_id=r.brand_id
  WHERE r.brand_id=$1 ORDER BY r.recipe_id LIMIT 2049`;
const captureFields = ["coverage", "capturedAtUtc"] as const;
const selectCapture = `SELECT coverage_json AS coverage,to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "capturedAtUtc" FROM rms_recipe.recipe_admin_source_capture WHERE tenant_id=$1 AND brand_id=$2 AND source_family=$3 AND `;
/** Actual Recipe-owned source families. Authorizer validates scope/Actor/purpose/permission/phase.
 * withCurrent holds source locks through its callback; callback must not mutate locked collections.
 * Full publication additionally needs its own held authorization and all other owner source fences. */
function createPostgresOwnedCoverageSource(
  options: {
    readonly runner: RecipeTransactionRunner;
    readonly scope: { readonly tenantReference: string; readonly brandReference: string };
    readonly generateReference: () => string;
    readonly usageStores?: RecipeUsageStoreCoverageFence;
    readonly authorize: (
      tx: RecipeTransaction,
      input: RecipeOwnerCoverageAuthorizationInput,
    ) => Promise<boolean>;
  },
  family: RecipeOwnedSourceFamily,
) {
  const tenant = parseRecipeReference(options.scope.tenantReference),
    brand = parseRecipeReference(options.scope.brandReference);
  const runner = options.runner,
    authorize = options.authorize,
    generateReference = options.generateReference;
  function validateCoverage(value: unknown): RecipeSourceCoverage {
    const coverage = parseRecipeSourceCoverage(value);
    if (
      coverage.family !== family ||
      coverage.tenantReference !== tenant ||
      coverage.brandReference !== brand ||
      !coverage.complete
    )
      return fail();
    return coverage;
  }
  function decode(value: unknown, at: string): RecipeOwnerCoverageRead {
    const row = record(value, captureFields),
      coverage = validateCoverage(row.coverage),
      capturedAtUtc = instant(row.capturedAtUtc);
    if (capturedAtUtc > at) return fail();
    return Object.freeze({ coverage, capturedAtUtc, asOfUtc: at });
  }
  function storeCoverage(value: unknown): RecipeUsageStoreCoverage {
    const raw = record(value, [
      "tenantReference",
      "brandReference",
      "snapshotReference",
      "digest",
      "complete",
      "storeReferences",
    ]);
    if (raw.tenantReference !== tenant || raw.brandReference !== brand || raw.complete !== true)
      return fail();
    const storeReferences = rows({ rows: raw.storeReferences }, 2048)
      .map(parseRecipeReference)
      .sort();
    if (new Set(storeReferences).size !== storeReferences.length) return fail();
    return Object.freeze({
      tenantReference: tenant,
      brandReference: brand,
      snapshotReference: parseRecipeReference(raw.snapshotReference),
      digest: parseRecipeDigest(raw.digest),
      complete: true,
      storeReferences: Object.freeze(storeReferences),
    });
  }
  async function authorized<T>(
    input: RecipeOwnerCoverageRequest,
    work: (tx: RecipeTransaction, stores?: RecipeUsageStoreCoverage) => Promise<T>,
  ): Promise<T> {
    try {
      const invoke = (stores?: RecipeUsageStoreCoverage) =>
        runner.run(async (tx) => {
          await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED", []);
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
            [tenant, brand],
          );
          const authorization = Object.freeze({
            ...input,
            tenantReference: tenant,
            brandReference: brand,
            family,
          });
          if ((await authorize(tx, authorization)) !== true)
            return fail("RECIPE_SOURCE_PERMISSION_DENIED");
          await tx.query(
            "SELECT set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
            [],
          );
          const result = await work(tx, stores);
          if ((await authorize(tx, authorization)) !== true)
            return fail("RECIPE_SOURCE_PERMISSION_DENIED");
          return result;
        });
      if (family !== "Usage") return await invoke();
      if (options.usageStores === undefined) return fail();
      return await options.usageStores.withCurrent(
        Object.freeze({ ...input, tenantReference: tenant, brandReference: brand, family }),
        async (coverage) => invoke(storeCoverage(coverage)),
      );
    } catch (error) {
      if (error instanceof RecipeOwnerCoverageError) throw error;
      return fail();
    }
  }
  async function current(
    tx: RecipeTransaction,
    at: string,
  ): Promise<{
    readonly dependencies: readonly RecipeSourceDependency[];
    readonly digest: string;
    readonly unresolvedSubstitutionPolicy: boolean;
    readonly currentRecipes: readonly RecipeSnapshot[];
    readonly recipes: readonly RecipeSnapshot[];
  }> {
    await tx.query("LOCK TABLE rms_recipe.recipe IN SHARE MODE", []);
    const found = rows(await tx.query(selectCurrent, [brand]), 2049);
    if (found.length > 2048) return fail();
    const seen = new Set<string>();
    const snapshots = found.map((value) => {
      const row = record(value, [
        "recipeReference",
        "versionReference",
        "aggregateVersion",
        "stableCode",
        "digest",
        "snapshot",
        "brandReference",
      ]);
      const snapshot = createRecipeSnapshot(row.snapshot as RecipeSnapshot);
      if (
        snapshot.brandReference !== brand ||
        row.brandReference !== brand ||
        snapshot.recipeReference !== row.recipeReference ||
        snapshot.versionReference !== row.versionReference ||
        snapshot.aggregateVersion !== row.aggregateVersion ||
        snapshot.stableCode !== row.stableCode ||
        snapshot.snapshotDigest !== row.digest ||
        snapshot.createdAt > at ||
        seen.has(snapshot.recipeReference)
      )
        return fail();
      seen.add(snapshot.recipeReference);
      return snapshot;
    });
    const covered = new Map<string, RecipeSnapshot>(
      snapshots.map((snapshot) => [
        `${snapshot.recipeReference}:${snapshot.versionReference}`,
        snapshot,
      ]),
    );
    let inspect: readonly RecipeSnapshot[] = snapshots;
    while (inspect.length > 0) {
      const needed = new Map<string, { recipeReference: string; versionReference: string }>();
      for (const snapshot of inspect)
        for (const ingredient of snapshot.ingredients) {
          if (ingredient.sourceKind !== "SubRecipe") continue;
          const identity = `${ingredient.sourceReference}:${ingredient.sourceVersionReference}`;
          if (!covered.has(identity))
            needed.set(identity, {
              recipeReference: ingredient.sourceReference,
              versionReference: ingredient.sourceVersionReference,
            });
        }
      if (needed.size === 0) break;
      if (covered.size + needed.size > 2048) return fail();
      const pinned = rows(
        await tx.query(
          `SELECT v.recipe_id AS "recipeReference",v.recipe_version_id AS "versionReference",v.snapshot_digest AS digest,v.snapshot_json AS snapshot
        FROM jsonb_to_recordset($2::jsonb) AS i("recipeReference" uuid,"versionReference" uuid)
        JOIN rms_recipe.recipe_version v ON v.recipe_id=i."recipeReference" AND v.recipe_version_id=i."versionReference" AND v.brand_id=$1`,
          [brand, JSON.stringify([...needed.values()])],
        ),
        needed.size,
      );
      if (pinned.length !== needed.size) return fail();
      const next: RecipeSnapshot[] = [];
      for (const value of pinned) {
        const row = record(value, ["recipeReference", "versionReference", "digest", "snapshot"]);
        const snapshot = createRecipeSnapshot(row.snapshot as RecipeSnapshot);
        const identity = `${snapshot.recipeReference}:${snapshot.versionReference}`;
        if (
          snapshot.brandReference !== brand ||
          snapshot.recipeReference !== row.recipeReference ||
          snapshot.versionReference !== row.versionReference ||
          snapshot.snapshotDigest !== row.digest ||
          snapshot.createdAt > at ||
          !needed.has(identity) ||
          covered.has(identity)
        )
          return fail();
        covered.set(identity, snapshot);
        next.push(snapshot);
      }
      inspect = next;
    }
    const dependencies = Object.freeze(
      [...covered.values()]
        .map((snapshot) =>
          Object.freeze({
            objectReference: snapshot.recipeReference,
            versionReference: snapshot.versionReference,
            digest: snapshot.snapshotDigest,
          }),
        )
        .sort(
          (a, b) =>
            a.objectReference.localeCompare(b.objectReference) ||
            a.versionReference.localeCompare(b.versionReference),
        ),
    );
    const roots = snapshots
      .map((snapshot) => ({
        objectReference: snapshot.recipeReference,
        versionReference: snapshot.versionReference,
      }))
      .sort((a, b) => a.objectReference.localeCompare(b.objectReference));
    return Object.freeze({
      dependencies,
      currentRecipes: Object.freeze(
        [...snapshots].sort((a, b) => a.recipeReference.localeCompare(b.recipeReference)),
      ),
      recipes: Object.freeze(
        [...covered.values()].sort(
          (a, b) =>
            a.recipeReference.localeCompare(b.recipeReference) ||
            a.versionReference.localeCompare(b.versionReference),
        ),
      ),
      digest: digestOf(tenant, brand, dependencies, roots),
      unresolvedSubstitutionPolicy: [...covered.values()].some(
        (snapshot) => snapshot.substitutionPolicyReference !== null,
      ),
    });
  }
  function collectionDigest(
    family: RecipeOwnedSourceFamily,
    recipeSourceDigest: string,
    dependencies: readonly RecipeSourceDependency[],
  ) {
    return `sha256:${createHash("sha256")
      .update(
        canonicalizeRfc8785({
          family,
          tenantReference: tenant,
          brandReference: brand,
          recipeSourceDigest,
          dependencies,
        }),
      )
      .digest("hex")}`;
  }
  async function substitutionCurrent(tx: RecipeTransaction, at: string, recipeDigest: string) {
    await tx.query("LOCK TABLE rms_recipe.recipe_modifier_version IN SHARE MODE", []);
    const found = rows(
      await tx.query(
        `SELECT m.rule_id AS "objectReference",m.rule_version_id AS "versionReference",m.recipe_id AS "recipeReference",m.recipe_version_id AS "recipeVersionReference",m.rule_digest AS "ruleDigest",m.rule_json AS rule,m.version,m.lifecycle,m.review_evidence_json AS publication,to_char(m.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",to_char(m.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveFrom",to_char(m.effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveUntil",v.snapshot_json AS snapshot
      FROM rms_recipe.recipe_modifier_version m LEFT JOIN rms_recipe.recipe_version v ON v.recipe_version_id=m.recipe_version_id AND v.recipe_id=m.recipe_id AND v.brand_id=m.brand_id
      WHERE m.brand_id=$1 ORDER BY m.rule_id,m.version LIMIT 2049`,
        [brand],
      ),
      2049,
    );
    if (found.length > 2048) return fail();
    const dependencies = found
      .map((value) => {
        const row = record(value, [
          "objectReference",
          "versionReference",
          "recipeReference",
          "recipeVersionReference",
          "ruleDigest",
          "rule",
          "version",
          "lifecycle",
          "publication",
          "occurredAt",
          "effectiveFrom",
          "effectiveUntil",
          "snapshot",
        ]);
        const snapshot = createRecipeSnapshot(row.snapshot as RecipeSnapshot);
        const rule = parseRecipeModifierRule(row.rule, snapshot);
        const occurredAt = instant(row.occurredAt),
          effectiveFrom = instant(row.effectiveFrom),
          effectiveUntil = row.effectiveUntil === null ? null : instant(row.effectiveUntil);
        if (
          snapshot.brandReference !== brand ||
          snapshot.recipeReference !== row.recipeReference ||
          snapshot.versionReference !== row.recipeVersionReference ||
          rule.ruleReference !== row.objectReference ||
          rule.ruleVersionReference !== row.versionReference ||
          rule.ruleDigest !== row.ruleDigest ||
          snapshot.createdAt > occurredAt ||
          occurredAt > at ||
          !Number.isSafeInteger(row.version) ||
          (row.version as number) < 1 ||
          typeof row.lifecycle !== "string" ||
          !["Draft", "Published", "Invalidated", "Archived"].includes(row.lifecycle) ||
          (effectiveUntil !== null && effectiveUntil <= effectiveFrom) ||
          snapshot.substitutionPolicyReference !== null
        )
          return fail();
        const publication =
          row.lifecycle === "Published"
            ? parseRecipeModifierPublicationEvidence(row.publication, rule, occurredAt)
            : null;
        if (row.lifecycle !== "Published" && row.publication !== null) return fail();
        const digest = `sha256:${createHash("sha256")
          .update(
            canonicalizeRfc8785({
              rule,
              version: row.version,
              lifecycle: row.lifecycle,
              occurredAt,
              effectiveFrom,
              effectiveUntil,
              publication,
            }),
          )
          .digest("hex")}`;
        return Object.freeze({
          objectReference: rule.ruleReference,
          versionReference: rule.ruleVersionReference,
          digest,
        });
      })
      .sort(
        (a, b) =>
          a.objectReference.localeCompare(b.objectReference) ||
          a.versionReference.localeCompare(b.versionReference),
      );
    if (
      new Set(dependencies.map((entry) => `${entry.objectReference}:${entry.versionReference}`))
        .size !== dependencies.length
    )
      return fail();
    return Object.freeze({
      dependencies: Object.freeze(dependencies),
      digest: collectionDigest("Substitution", recipeDigest, dependencies),
    });
  }
  async function usageCurrent(
    tx: RecipeTransaction,
    at: string,
    recipeDigest: string,
    stores: RecipeUsageStoreCoverage,
  ) {
    await tx.query("LOCK TABLE rms_recipe.recipe_scope_binding IN SHARE MODE", []);
    const found: unknown[] = [];
    for (const store of [null, ...stores.storeReferences]) {
      await tx.query("SELECT set_config('bop.store_id',$1,true)", [store ?? ""]);
      found.push(
        ...rows(
          await tx.query(
            `SELECT b.recipe_scope_binding_id AS "bindingReference",b.recipe_id AS "recipeReference",b.recipe_version_id AS "recipeVersionReference",b.sku_id AS "skuReference",b.store_id AS "storeReference",b.option_binding_id AS "optionBindingReference",to_char(b.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveFrom",to_char(b.effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveUntil",v.snapshot_json AS snapshot
      FROM rms_recipe.recipe_scope_binding b LEFT JOIN rms_recipe.recipe_version v ON v.recipe_version_id=b.recipe_version_id AND v.recipe_id=b.recipe_id AND v.brand_id=b.brand_id
      WHERE b.brand_id=$1 AND b.store_id IS NOT DISTINCT FROM $2::uuid ORDER BY b.recipe_scope_binding_id LIMIT 2049`,
            [brand, store],
          ),
          2049,
        ),
      );
      if (found.length > 2047) return fail();
    }
    await tx.query("SELECT set_config('bop.store_id','',true)", []);
    const dependencies: RecipeSourceDependency[] = found
      .map((value) => {
        const row = record(value, [
          "bindingReference",
          "recipeReference",
          "recipeVersionReference",
          "skuReference",
          "storeReference",
          "optionBindingReference",
          "effectiveFrom",
          "effectiveUntil",
          "snapshot",
        ]);
        const snapshot = createRecipeSnapshot(row.snapshot as RecipeSnapshot);
        const effectiveFrom = instant(row.effectiveFrom),
          effectiveUntil = row.effectiveUntil === null ? null : instant(row.effectiveUntil);
        if (
          snapshot.brandReference !== brand ||
          snapshot.recipeReference !== row.recipeReference ||
          snapshot.versionReference !== row.recipeVersionReference ||
          snapshot.createdAt > at ||
          (effectiveUntil !== null && effectiveUntil <= effectiveFrom)
        )
          return fail();
        const binding = Object.freeze({
          bindingReference: parseRecipeReference(row.bindingReference),
          recipeReference: snapshot.recipeReference,
          recipeVersionReference: snapshot.versionReference,
          skuReference: parseRecipeReference(row.skuReference),
          storeReference:
            row.storeReference === null ? null : parseRecipeReference(row.storeReference),
          optionBindingReference:
            row.optionBindingReference === null
              ? null
              : parseRecipeReference(row.optionBindingReference),
          effectiveFrom,
          effectiveUntil,
        });
        return Object.freeze({
          objectReference: binding.bindingReference,
          versionReference: binding.bindingReference,
          digest: `sha256:${createHash("sha256").update(canonicalizeRfc8785(binding)).digest("hex")}`,
        });
      })
      .sort((a, b) => a.objectReference.localeCompare(b.objectReference));
    dependencies.push(
      Object.freeze({
        objectReference: brand,
        versionReference: stores.snapshotReference,
        digest: `sha256:${createHash("sha256").update(canonicalizeRfc8785(stores)).digest("hex")}`,
      }),
    );
    dependencies.sort(
      (a, b) =>
        a.objectReference.localeCompare(b.objectReference) ||
        a.versionReference.localeCompare(b.versionReference),
    );
    if (
      new Set(dependencies.map((entry) => `${entry.objectReference}:${entry.versionReference}`))
        .size !== dependencies.length
    )
      return fail();
    return Object.freeze({
      dependencies: Object.freeze(dependencies),
      digest: collectionDigest("Usage", recipeDigest, dependencies),
    });
  }
  async function sourceCurrent(
    tx: RecipeTransaction,
    at: string,
    stores?: RecipeUsageStoreCoverage,
  ): Promise<{
    readonly dependencies: readonly RecipeSourceDependency[];
    readonly digest: string;
    readonly currentRecipes?: readonly RecipeSnapshot[];
    readonly recipes?: readonly RecipeSnapshot[];
  }> {
    const recipe = await current(tx, at);
    if (family === "Recipe") return recipe;
    if (family === "Substitution") {
      if (recipe.unresolvedSubstitutionPolicy) return fail();
      return substitutionCurrent(tx, at, recipe.digest);
    }
    if (family === "Usage") {
      if (stores === undefined) return fail();
      return usageCurrent(tx, at, recipe.digest, stores);
    }
    await tx.query("LOCK TABLE rms_recipe.recipe_preparation_content IN SHARE MODE", []);
    const publications = rows(
      await tx.query(
        `SELECT p.content_id AS "contentReference",p.recipe_id AS "recipeReference",p.recipe_version_id AS "versionReference",p.modifier_rule_version_id AS "modifierVersionReference",p.operation_id AS "operationReference",p.content_digest AS digest,p.record_json AS record,to_char(p.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "publishedAt",v.snapshot_json AS snapshot,m.rule_json AS rule,m.lifecycle AS "modifierLifecycle",to_char(m.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "modifierOccurredAt",m.review_evidence_json AS "modifierPublication"
      FROM rms_recipe.recipe_preparation_content p
      LEFT JOIN rms_recipe.recipe_version v ON v.recipe_id=p.recipe_id AND v.recipe_version_id=p.recipe_version_id AND v.brand_id=p.brand_id
      LEFT JOIN rms_recipe.recipe_modifier_version m ON m.rule_version_id=p.modifier_rule_version_id AND m.recipe_version_id=p.recipe_version_id AND m.brand_id=p.brand_id
      WHERE p.brand_id=$1 ORDER BY p.content_id LIMIT 2049`,
        [brand],
      ),
      2049,
    );
    if (publications.length > 2048) return fail();
    const dependencies = publications
      .map((value) => {
        const row = record(value, [
          "contentReference",
          "recipeReference",
          "versionReference",
          "modifierVersionReference",
          "operationReference",
          "digest",
          "record",
          "publishedAt",
          "snapshot",
          "rule",
          "modifierLifecycle",
          "modifierOccurredAt",
          "modifierPublication",
        ]);
        const snapshot = createRecipeSnapshot(row.snapshot as RecipeSnapshot);
        if (
          snapshot.brandReference !== brand ||
          snapshot.recipeReference !== row.recipeReference ||
          snapshot.versionReference !== row.versionReference ||
          snapshot.createdAt > at
        )
          return fail();
        const rule =
          row.modifierVersionReference === null
            ? null
            : parseRecipeModifierRule(row.rule, snapshot);
        if ((rule?.ruleVersionReference ?? null) !== row.modifierVersionReference) return fail();
        const publication = parseRecipePreparationPublication(
          row.record,
          snapshot,
          rule,
          (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`,
        );
        if (rule !== null) {
          const occurredAt = instant(row.modifierOccurredAt);
          if (row.modifierLifecycle !== "Published" || occurredAt > publication.publishedAt)
            return fail();
          parseRecipeModifierPublicationEvidence(row.modifierPublication, rule, occurredAt);
        } else if (
          row.rule !== null ||
          row.modifierLifecycle !== null ||
          row.modifierOccurredAt !== null ||
          row.modifierPublication !== null
        )
          return fail();
        if (
          publication.brandReference !== brand ||
          publication.recipeReference !== row.recipeReference ||
          publication.recipeVersionReference !== row.versionReference ||
          publication.modifierRuleVersionReference !== row.modifierVersionReference ||
          publication.operationReference !== row.operationReference ||
          publication.content.contentReference !== row.contentReference ||
          publication.content.contentDigest !== row.digest ||
          publication.publishedAt !== row.publishedAt ||
          publication.publishedAt > at
        )
          return fail();
        return Object.freeze({
          objectReference: publication.content.contentReference,
          versionReference: publication.operationReference,
          digest: publication.content.contentDigest,
        });
      })
      .sort(
        (a, b) =>
          a.objectReference.localeCompare(b.objectReference) ||
          a.versionReference.localeCompare(b.versionReference),
      );
    if (
      new Set(dependencies.map((entry) => `${entry.objectReference}:${entry.versionReference}`))
        .size !== dependencies.length
    )
      return fail();
    return Object.freeze({
      dependencies: Object.freeze(dependencies),
      digest: `sha256:${createHash("sha256")
        .update(
          canonicalizeRfc8785({
            family,
            tenantReference: tenant,
            brandReference: brand,
            recipeSourceDigest: recipe.digest,
            dependencies,
          }),
        )
        .digest("hex")}`,
    });
  }
  function parseRequest(value: unknown): RecipeOwnerCoverageRequest {
    try {
      return request(value);
    } catch {
      return fail("RECIPE_SOURCE_INPUT_INVALID");
    }
  }
  async function holdCurrent<T>(
    value: unknown,
    captured: unknown,
    work: (
      read: RecipeOwnerCoverageRead,
      source: Awaited<ReturnType<typeof sourceCurrent>>,
    ) => Promise<T>,
  ): Promise<T> {
    const input = parseRequest(value);
    let expected: RecipeOwnerCoverageRead;
    try {
      const raw = record(captured, ["coverage", "capturedAtUtc", "asOfUtc"]);
      const asOf = instant(raw.asOfUtc);
      expected = decode({ coverage: raw.coverage, capturedAtUtc: raw.capturedAtUtc }, asOf);
      if (asOf > input.observedAtUtc) return fail();
    } catch {
      return fail("RECIPE_SOURCE_INPUT_INVALID");
    }
    return authorized(input, async (tx, stores) => {
      const currentSource = await sourceCurrent(tx, input.observedAtUtc, stores);
      const { dependencies, digest } = currentSource;
      const persisted = rows(
        await tx.query(selectCapture + "snapshot_id=$4", [
          tenant,
          brand,
          family,
          expected.coverage.snapshotReference,
        ]),
        1,
      );
      if (persisted.length !== 1) return fail();
      const read = decode(persisted[0], input.observedAtUtc);
      if (
        canonicalizeRfc8785(read.coverage) !== canonicalizeRfc8785(expected.coverage) ||
        read.capturedAtUtc !== expected.capturedAtUtc
      )
        return fail("RECIPE_SOURCE_INTEGRITY_CONFLICT");
      if (read.coverage.digest !== digest) return fail("RECIPE_SOURCE_CHANGED");
      if (canonicalizeRfc8785(read.coverage.dependencies) !== canonicalizeRfc8785(dependencies))
        return fail("RECIPE_SOURCE_INTEGRITY_CONFLICT");
      return work(read, currentSource);
    });
  }
  return Object.freeze({
    async capture(value: unknown): Promise<RecipeOwnerCoverageRead> {
      const input = parseRequest(value);
      return authorized(input, async (tx, stores) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `RecipeSourceCapture:${tenant}:${brand}:${family}`,
        ]);
        const { dependencies, digest } = await sourceCurrent(tx, input.observedAtUtc, stores);
        const contradictions = rows(
          await tx.query(
            `SELECT 1 AS conflict FROM rms_recipe.recipe_admin_source_capture c
          CROSS JOIN LATERAL jsonb_array_elements(c.coverage_json->'dependencies') h
          JOIN jsonb_to_recordset($4::jsonb) AS n("objectReference" text,"versionReference" text,digest text)
            ON h->>'objectReference'=n."objectReference" AND h->>'versionReference'=n."versionReference"
          WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.source_family=$3 AND h->>'digest'<>n.digest LIMIT 1`,
            [tenant, brand, family, JSON.stringify(dependencies)],
          ),
          1,
        );
        if (contradictions.length !== 0) return fail("RECIPE_SOURCE_INTEGRITY_CONFLICT");
        const existing = rows(
          await tx.query(selectCapture + "content_digest=$4", [tenant, brand, family, digest]),
          1,
        );
        if (existing.length === 1) {
          const found = decode(existing[0], input.observedAtUtc);
          if (
            found.coverage.digest !== digest ||
            canonicalizeRfc8785(found.coverage.dependencies) !== canonicalizeRfc8785(dependencies)
          )
            return fail("RECIPE_SOURCE_INTEGRITY_CONFLICT");
          return found;
        }
        const coverage = parseRecipeSourceCoverage({
          family,
          tenantReference: tenant,
          brandReference: brand,
          snapshotReference: parseRecipeReference(generateReference()),
          digest,
          complete: true,
          dependencies,
        });
        const inserted = rows(
          await tx.query(
            `INSERT INTO rms_recipe.recipe_admin_source_capture(snapshot_id,tenant_id,brand_id,source_family,content_digest,captured_at,captured_by_actor_id,coverage_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING coverage_json AS coverage,to_char(captured_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "capturedAtUtc"`,
            [
              coverage.snapshotReference,
              tenant,
              brand,
              family,
              digest,
              input.observedAtUtc,
              input.actorReference,
              JSON.stringify(coverage),
            ],
          ),
          1,
        );
        if (inserted.length !== 1) return fail();
        const result = decode(inserted[0], input.observedAtUtc);
        if (canonicalizeRfc8785(result.coverage) !== canonicalizeRfc8785(coverage)) return fail();
        return result;
      });
    },
    withCurrent<T>(
      value: unknown,
      captured: unknown,
      work: (read: RecipeOwnerCoverageRead) => Promise<T>,
    ): Promise<T> {
      return holdCurrent(value, captured, (read) => work(read));
    },
    withCurrentRecipeFacts<T>(
      value: unknown,
      captured: unknown,
      work: (facts: RecipeProjectionGraphFacts) => Promise<T>,
    ): Promise<T> {
      if (family !== "Recipe") return fail();
      return holdCurrent(value, captured, (read, source) => {
        if (source.currentRecipes === undefined || source.recipes === undefined) return fail();
        return work(
          Object.freeze({
            source: read,
            currentRecipes: source.currentRecipes,
            recipes: source.recipes,
          }),
        );
      });
    },
  });
}

type OwnedCoverageSourceOptions = Parameters<typeof createPostgresOwnedCoverageSource>[0];
/** Recipe roots and transitive immutable pinned versions. */
export function createPostgresRecipeOwnerCoverageSource(options: OwnedCoverageSourceOptions) {
  const source = createPostgresOwnedCoverageSource(options, "Recipe");
  return Object.freeze({ capture: source.capture, withCurrent: source.withCurrent });
}
/** Committed Preparation content history and its actual Recipe source dependency.
 * Empty history is not evidence that every current Recipe is ready for execution. */
export function createPostgresRecipePreparationCoverageSource(options: OwnedCoverageSourceOptions) {
  const source = createPostgresOwnedCoverageSource(options, "Preparation");
  return Object.freeze({ capture: source.capture, withCurrent: source.withCurrent });
}

/** Modifier history; unresolved substitution policies fail closed. */
export function createPostgresRecipeSubstitutionCoverageSource(
  options: OwnedCoverageSourceOptions,
) {
  const source = createPostgresOwnedCoverageSource(options, "Substitution");
  return Object.freeze({ capture: source.capture, withCurrent: source.withCurrent });
}
/** Recipe-owned SKU/Store/Option binding history; Catalog presentation is a separate source. */
export function createPostgresRecipeUsageCoverageSource(options: OwnedCoverageSourceOptions) {
  const source = createPostgresOwnedCoverageSource(options, "Usage");
  return Object.freeze({ capture: source.capture, withCurrent: source.withCurrent });
}

/** Separate field-authorized internal facts feed. It confers no safety/cost approval or HTTP access. */
export function createPostgresRecipeProjectionFactsSource(
  options: OwnedCoverageSourceOptions & {
    readonly authorizeFacts: (
      tx: RecipeTransaction,
      input: RecipeProjectionFactsAuthorization,
    ) => Promise<boolean>;
  },
) {
  const authorize = options.authorize,
    authorizeFacts = options.authorizeFacts;
  const source = createPostgresOwnedCoverageSource(
    {
      ...options,
      authorize: async (tx, input) =>
        (await authorize(tx, input)) === true &&
        (await authorizeFacts(tx, Object.freeze({ ...input, access: "ProjectionFacts" }))) === true,
    },
    "Recipe",
  );
  return Object.freeze({
    capture: source.capture,
    withCurrentFacts: source.withCurrentRecipeFacts,
  });
}
