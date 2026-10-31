import {
  parseRecipeProductPublicationReferenceRequestV2,
  type RecipeProductPublicationReferenceRequestV2,
} from "../../contracts/product-publication-reference-request-v2.js";
import {
  buildRecipeProductPublicationReferenceSnapshotV2,
  recipeProductPublicationReferenceSourceFieldsV2,
  type RecipeProductPublicationReferenceSnapshotV2,
} from "../../contracts/recipe-reference-source.js";
import { RecipeWorkflowError } from "../../application/recipe-service.js";
import { parseRecipeReference } from "../../domain/recipe.js";
import { parseRecipeReferenceSourceInstant } from "../../contracts/recipe-reference-source.js";
import {
  recipeReferenceSourceFields,
  recipeReferenceSourceMaximumRows,
  parseRecipeReferenceSourceRequest,
  buildRecipeReferenceSourceSnapshot,
  type RecipeReferenceSourceRequest,
  type RecipeReferenceSourceSnapshot,
} from "../../contracts/recipe-reference-source.js";
export interface RecipeReferenceTransaction {
  query<T extends Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ rows: readonly T[] }>;
}
export interface RecipeReferenceSourceOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: {
    run<T>(work: (tx: RecipeReferenceTransaction) => Promise<T>): Promise<T>;
  };
  readonly clock: { now(): string };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: RecipeReferenceTransaction,
      input: {
        readonly tenantReference: string;
        readonly request: RecipeReferenceSourceRequest;
        readonly permission: "recipe.manage";
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof recipeReferenceSourceFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
const fail = (): never => {
  throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
};
function row(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return fail();
  const rows = Object.getOwnPropertyDescriptor(value, "rows")?.value;
  if (!Array.isArray(rows) || rows.length !== 1) return fail();
  const entry = Object.getOwnPropertyDescriptor(rows, "0")?.value;
  if (
    !entry ||
    Object.getPrototypeOf(entry) !== Object.prototype ||
    Reflect.ownKeys(entry).length !== 1
  )
    return fail();
  const d = Object.getOwnPropertyDescriptor(entry, key);
  if (!d?.enumerable || !("value" in d)) return fail();
  return d.value;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const sourceLimit = recipeReferenceSourceMaximumRows + 1;
const select = `SELECT jsonb_build_object(
 'generation',(SELECT generation::text FROM rms_recipe.recipe_reference_generation WHERE brand_id=$1),
 'bindingCount',(SELECT binding_count::text FROM rms_recipe.recipe_reference_generation WHERE brand_id=$1),
 'observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},
 'counts',jsonb_build_object('recipes',(SELECT count(recipe_id)::text FROM rms_recipe.recipe WHERE brand_id=$1),'versions',(SELECT count(recipe_version_id)::text FROM rms_recipe.recipe_version WHERE brand_id=$1),'bindings',(SELECT count(recipe_scope_binding_id)::text FROM rms_recipe.recipe_reference_binding WHERE brand_id=$1),'modifiers',(SELECT count(rule_version_id)::text FROM rms_recipe.recipe_modifier_version WHERE brand_id=$1)),
 'recipes',(SELECT COALESCE(jsonb_agg(value),'[]'::jsonb) FROM (SELECT jsonb_build_object('recipeReference',c.recipe_id,'brandReference',c.brand_id,'aggregateVersion',c.aggregate_version,'currentVersionReference',c.current_version_id,'updatedAt',${utc("c.updated_at")},'precise',date_trunc('milliseconds',c.updated_at)=c.updated_at AND c.updated_at<=statement_timestamp()) value FROM rms_recipe.recipe c WHERE c.brand_id=$1 ORDER BY c.recipe_id LIMIT ${sourceLimit}) bounded),
 'versions',(SELECT COALESCE(jsonb_agg(value),'[]'::jsonb) FROM (SELECT jsonb_build_object('recipeVersionReference',c.recipe_version_id,'recipeReference',c.recipe_id,'brandReference',c.brand_id,'versionNumber',c.version_number,'lifecycle',c.lifecycle,'snapshotDigest',c.snapshot_digest,'effectiveFrom',${utc("c.effective_from")},'effectiveUntil',${utc("c.effective_until")},'timeZone',c.effective_time_zone,'createdAt',${utc("c.created_at")},'precise',date_trunc('milliseconds',c.effective_from)=c.effective_from AND (c.effective_until IS NULL OR date_trunc('milliseconds',c.effective_until)=c.effective_until) AND date_trunc('milliseconds',c.created_at)=c.created_at AND c.created_at<=statement_timestamp()) value FROM rms_recipe.recipe_version c WHERE c.brand_id=$1 ORDER BY c.recipe_version_id LIMIT ${sourceLimit}) bounded),
 'bindings',(SELECT COALESCE(jsonb_agg(value),'[]'::jsonb) FROM (SELECT jsonb_build_object('bindingReference',c.recipe_scope_binding_id,'recipeVersionReference',c.recipe_version_id,'recipeReference',c.recipe_id,'brandReference',c.brand_id,'skuReference',c.sku_id,'storeReference',c.store_id,'optionBindingReference',c.option_binding_id,'effectiveFrom',${utc("c.effective_from")},'effectiveUntil',${utc("c.effective_until")},'precise',date_trunc('milliseconds',c.effective_from)=c.effective_from AND (c.effective_until IS NULL OR date_trunc('milliseconds',c.effective_until)=c.effective_until)) value FROM rms_recipe.recipe_reference_binding c WHERE c.brand_id=$1 ORDER BY c.recipe_scope_binding_id LIMIT ${sourceLimit}) bounded),
 'modifiers',(SELECT COALESCE(jsonb_agg(value),'[]'::jsonb) FROM (SELECT jsonb_build_object('ruleVersionReference',c.rule_version_id,'ruleReference',c.rule_id,'brandReference',c.brand_id,'recipeReference',c.recipe_id,'recipeVersionReference',c.recipe_version_id,'bindingReference',c.binding_id,'optionReference',c.option_id,'version',c.version,'selectedQuantity',c.selected_quantity,'lifecycle',c.lifecycle,'ruleDigest',c.rule_digest,'effectiveFrom',${utc("c.effective_from")},'effectiveUntil',${utc("c.effective_until")},'occurredAt',${utc("c.occurred_at")},'precise',date_trunc('milliseconds',c.effective_from)=c.effective_from AND (c.effective_until IS NULL OR date_trunc('milliseconds',c.effective_until)=c.effective_until) AND date_trunc('milliseconds',c.occurred_at)=c.occurred_at AND c.occurred_at<=statement_timestamp()) value FROM rms_recipe.recipe_modifier_version c WHERE c.brand_id=$1 ORDER BY c.rule_version_id LIMIT ${sourceLimit}) bounded)) source`;
/** Supported Recipe writers are fenced through caller COMMIT. Callback must not mutate
 * Recipe sources or acquire per-rule modifier writer locks; bind the runner to the caller UoW after the owning Product holder. */
export function createPostgresRecipeReferenceSourceStore(options: RecipeReferenceSourceOptions) {
  const tenantReference = parseRecipeReference(options.tenantReference),
    brand = parseRecipeReference(options.brandReference),
    actor = parseRecipeReference(options.actorReference);
  return Object.freeze({
    async withCurrentSnapshot<T>(
      input: RecipeReferenceSourceRequest,
      work: (snapshot: RecipeReferenceSourceSnapshot) => Promise<T>,
    ): Promise<T> {
      try {
        const request = parseRecipeReferenceSourceRequest(input);
        if (request.brandReference !== brand || request.actorReference !== actor) return fail();
        let calls = 0,
          completed: { readonly value: T } | undefined;
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const authorize = () =>
            options.authority.holdUntilTransactionCompletes(
              tx,
              Object.freeze({
                tenantReference,
                request,
                permission: "recipe.manage",
                requiredScope: "FullBrandScope",
                requiredFields: recipeReferenceSourceFields,
                observedAt: parseRecipeReferenceSourceInstant(options.clock.now()),
              }),
            );
          await authorize();
          if (
            row(
              await tx.query("SELECT current_setting('transaction_isolation') AS isolation", []),
              "isolation",
            ) !== "read committed"
          )
            return fail();
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true),set_config('statement_timeout','60000',true)",
            [brand],
          );
          await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
            "RecipeCatalogReferenceV1:" + brand,
          ]);
          const source = buildRecipeReferenceSourceSnapshot(
            row(await tx.query(select, [brand]), "source"),
            request,
            options.clock.now(),
          );
          await authorize();
          completed = Object.freeze({ value: await work(source) });
          await authorize();
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
            [brand],
          );
          const current = row(
            await tx.query(
              "SELECT jsonb_build_object('generation',COALESCE((SELECT generation::text FROM rms_recipe.recipe_reference_generation WHERE brand_id=$1),'0'),'bindingCount',COALESCE((SELECT binding_count::text FROM rms_recipe.recipe_reference_generation WHERE brand_id=$1),'0')) AS header",
              [brand],
            ),
            "header",
          );
          if (
            !current ||
            typeof current !== "object" ||
            Object.getPrototypeOf(current) !== Object.prototype ||
            Reflect.ownKeys(current).length !== 2 ||
            Object.getOwnPropertyDescriptor(current, "generation")?.value !== source.generation ||
            Object.getOwnPropertyDescriptor(current, "bindingCount")?.value !== source.bindingCount
          )
            return fail();
          const at = parseRecipeReferenceSourceInstant(options.clock.now());
          if (at < source.observedAt || Date.parse(at) - Date.parse(source.observedAt) > 5000)
            return fail();
          return completed;
        });
        if (calls !== 1 || !completed || result !== completed) return fail();
        return completed.value;
      } catch (error) {
        if (error instanceof RecipeWorkflowError && error.code === "RECIPE_PERMISSION_DENIED")
          throw error;
        return fail();
      }
    },
  });
}

export interface RecipeProductPublicationReferenceSourceOptionsV2 extends Omit<
  RecipeReferenceSourceOptions,
  "authority"
> {
  readonly actorKind: "User" | "System";
  readonly registerBeforeCommit: (
    tx: RecipeReferenceTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: RecipeReferenceTransaction,
      input: {
        readonly tenantReference: string;
        readonly actorKind: "User" | "System";
        readonly request: RecipeProductPublicationReferenceRequestV2;
        readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_RECIPE_SOURCE_READ";
        readonly permission: "recipe.manage";
        readonly requiredScope: "FullBrandScope";
        readonly requiredFields: typeof recipeProductPublicationReferenceSourceFieldsV2;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
/** Independent publication protocol over the existing Brand-only Recipe SQL and
 * barrier. Current authority must prove Tenant/Brand membership and full fields;
 * setting Tenant context does not pretend these tables contain a Tenant column. */
export function createPostgresRecipeProductPublicationReferenceSourceV2(
  options: RecipeProductPublicationReferenceSourceOptionsV2,
) {
  const tenant = parseRecipeReference(options.tenantReference),
    brand = parseRecipeReference(options.brandReference),
    actor = parseRecipeReference(options.actorReference),
    kind = options.actorKind;
  if (
    (kind !== "User" && kind !== "System") ||
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    return fail();
  const now = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    authority = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    register = options.registerBeforeCommit.bind(options),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async withCurrentSnapshot<T>(
      input: RecipeProductPublicationReferenceRequestV2,
      work: (
        snapshot: RecipeProductPublicationReferenceSnapshotV2,
        tx: RecipeReferenceTransaction,
      ) => Promise<T>,
    ): Promise<T> {
      let calls = 0,
        completed: { readonly value: T } | undefined,
        transaction: RecipeReferenceTransaction | undefined,
        poisoned = false,
        finalCheck: (() => void) | undefined;
      const poison = (): never => {
        poisoned = true;
        if (transaction) failed.add(transaction);
        return fail();
      };
      try {
        const request = parseRecipeProductPublicationReferenceRequestV2(input);
        if (
          typeof work !== "function" ||
          request.tenantReference !== tenant ||
          request.brandReference !== brand ||
          request.actorReference !== actor ||
          request.actorKind !== kind
        )
          return fail();
        const result = await run(async (tx) => {
          if (!tx || typeof tx !== "object" || typeof tx.query !== "function") return poison();
          transaction = tx;
          // A caught nested refusal must taint this actual enclosing transaction.
          if (++calls !== 1 || active.has(tx) || failed.has(tx)) return poison();
          active.add(tx);
          const originalQuery = tx.query,
            queryPort = originalQuery.bind(tx);
          let latest = request.observedAt,
            ready = false,
            guardCalls = 0,
            source: RecipeProductPublicationReferenceSnapshotV2 | undefined;
          const check = () => {
            let at: string;
            try {
              at = parseRecipeReferenceSourceInstant(now());
            } catch {
              return poison();
            }
            if (
              poisoned ||
              failed.has(tx) ||
              tx.query !== originalQuery ||
              at < latest ||
              at >= request.validUntil
            )
              return poison();
            latest = at;
            return at;
          };
          const assertFinal = () => {
            if (!ready || !source) return poison();
            check();
          };
          finalCheck = assertFinal;
          const query: RecipeReferenceTransaction["query"] = async <
            R extends Record<string, unknown>,
          >(
            sql: string,
            values: readonly unknown[],
          ) => {
            check();
            const result = await queryPort<R>(sql, values);
            check();
            return result;
          };
          const authorize = async () => {
            const observedAt = check();
            if (
              (await authority(
                tx,
                Object.freeze({
                  tenantReference: tenant,
                  actorKind: kind,
                  request,
                  purposeCode: "CATALOG_PRODUCT_PUBLICATION_RECIPE_SOURCE_READ",
                  permission: "recipe.manage",
                  requiredScope: "FullBrandScope",
                  requiredFields: recipeProductPublicationReferenceSourceFieldsV2,
                  observedAt,
                }),
              )) !== undefined
            )
              return poison();
            check();
          };
          const context = () =>
            query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('statement_timeout','60000',true)",
              [tenant, brand],
            );
          const verifyGeneration = async () => {
            if (!source) return poison();
            await context();
            const current = row(
              await query(
                "SELECT jsonb_build_object('generation',COALESCE((SELECT generation::text FROM rms_recipe.recipe_reference_generation WHERE brand_id=$1),'0'),'bindingCount',COALESCE((SELECT binding_count::text FROM rms_recipe.recipe_reference_generation WHERE brand_id=$1),'0')) AS header",
                [brand],
              ),
              "header",
            );
            if (
              !current ||
              typeof current !== "object" ||
              Object.getPrototypeOf(current) !== Object.prototype ||
              Reflect.ownKeys(current).length !== 2 ||
              Object.getOwnPropertyDescriptor(current, "generation")?.value !== source.generation ||
              Object.getOwnPropertyDescriptor(current, "bindingCount")?.value !==
                source.bindingCount
            )
              return poison();
          };
          try {
            // Install before the first holder/read/clock check: a swallowed
            // early failure must still poison the enclosing transaction.
            if (
              (await register(
                tx,
                async () => {
                  try {
                    if (++guardCalls !== 1) return poison();
                    assertFinal();
                    await authorize();
                    await verifyGeneration();
                    assertFinal();
                  } catch (error) {
                    poisoned = true;
                    failed.add(tx);
                    throw error;
                  }
                },
                assertFinal,
              )) !== undefined
            )
              return poison();
            check();
            await authorize();
            if (
              row(
                await query("SELECT current_setting('transaction_isolation') AS isolation", []),
                "isolation",
              ) !== "read committed"
            )
              return poison();
            await context();
            await query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
              "RecipeCatalogReferenceV1:" + brand,
            ]);
            source = buildRecipeProductPublicationReferenceSnapshotV2(
              row(await query(select, [brand]), "source"),
              request,
              check(),
            );
            await authorize();
            const value = await work(source, tx);
            check();
            await authorize();
            await verifyGeneration();
            check();
            ready = true;
            completed = Object.freeze({ value });
            return completed;
          } catch (error) {
            poisoned = true;
            failed.add(tx);
            throw error;
          } finally {
            active.delete(tx);
          }
        });
        if (
          poisoned ||
          calls !== 1 ||
          !completed ||
          result !== completed ||
          !transaction ||
          failed.has(transaction) ||
          !finalCheck
        )
          return poison();
        finalCheck();
        return completed.value;
      } catch (error) {
        if (transaction) failed.add(transaction);
        if (error instanceof RecipeWorkflowError && error.code === "RECIPE_PERMISSION_DENIED")
          throw error;
        return fail();
      }
    },
  });
}
