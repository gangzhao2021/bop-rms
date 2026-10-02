import assert from "node:assert/strict";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { CatalogError, parseProductPublicationCommand } from "../../rms/catalog/src/index.ts";
import { recipeReferenceSourceFields } from "../../rms/recipe/src/index.ts";
import { tenantBrandConfigurationRequiredFields } from "../../bop/tenant/src/index.ts";
import { prepareBrandRecipeOverridePublication } from "./brand-recipe-override-publication.mjs";
import { createCurrentProductCandidateStoreRecipePolicySource } from "../../../apps/api/src/current-product-candidate-store-recipe-policy.ts";

/** Real public owner readers/native Publishing lifecycle, controlled synthetic
 * Tenant/Recipe metadata and Actor policies; no ordinary writer/IAM proof. */
export async function exerciseCurrentProductCandidateStoreRecipePolicy({
  admin,
  role,
  id,
  transactions,
  candidateCommand,
  candidateAuthority,
  skuReference,
  createMarker,
  changeCandidate,
}) {
  const brand = candidateCommand.brandReference,
    actor = candidateCommand.actorReference,
    tenant = candidateCommand.tenantReference,
    storeReference = id(88000),
    configurationReference = id(88020),
    past = candidateCommand.occurredAt,
    publishedAt = new Date().toISOString();
  assert.equal(typeof createMarker, "function");
  await admin.query("GRANT USAGE ON SCHEMA bop_tenant TO " + role);
  const columns = {
    brand: ["brand_id", "lifecycle", "version", "updated_at"],
    store_reference_generation: ["brand_id", "generation", "reference_count"],
    store_reference_projection: [
      "brand_id",
      "store_id",
      "lifecycle",
      "version",
      "created_at",
      "updated_at",
    ],
    brand_configuration_version: [
      "configuration_version_id",
      "brand_id",
      "configuration_version",
      "lifecycle",
      "default_locale",
      "supported_locales",
      "media_theme_reference",
      "catalog_source_reference",
      "platform_template_reference",
      "override_allowed_field_codes",
      "hard_requirement_field_codes",
      "effective_from",
      "effective_until",
      "supersedes_version_reference",
      "reason_code",
      "authored_by_reference",
      "approved_by_reference",
      "approval_evidence_reference",
      "publication_reference",
      "created_at",
      "updated_at",
      "data_classification",
    ],
  };
  for (const [table, fields] of Object.entries(columns))
    await admin.query(`GRANT SELECT(${fields.join(",")}) ON bop_tenant.${table} TO ${role}`);
  await admin.query(
    "GRANT UPDATE(lifecycle,version,updated_at) ON bop_tenant.brand,bop_tenant.store TO " + role,
  );
  await admin.query(
    "GRANT SELECT(store_id,brand_id,version,updated_at) ON bop_tenant.store TO " + role,
  );
  // Reuse the already exact, current synthetic Brand seeded by the protected
  // Tax acceptance portion. Never ignore a conflicting or missing Brand fact.
  const existingBrand = await admin.query(
    "SELECT lifecycle,version::int version FROM bop_tenant.brand WHERE brand_id=$1",
    [brand],
  );
  assert.equal(existingBrand.rows.length, 1);
  assert.equal(existingBrand.rows[0].lifecycle, "Active");
  assert.equal(existingBrand.rows[0].version, 1);
  await admin.query(
    "INSERT INTO bop_tenant.store VALUES($1,$2,'SYNTHETIC_VALIDATE82','Synthetic Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
    [storeReference, brand, past],
  );
  const configuration = {
    configurationVersionReference: configurationReference,
    brandReference: brand,
    configurationVersion: 1,
    lifecycle: "Published",
    defaultLocale: "en-CA",
    supportedLocales: ["en-CA"],
    mediaThemeReference: null,
    catalogSourceReference: id(88023),
    platformTemplateReference: id(88024),
    overrideAllowedFieldCodes: ["RECIPE.VERSION"],
    hardRequirementFieldCodes: [],
    effectiveFrom: past,
    effectiveUntil: new Date(Date.now() + 7200000).toISOString(),
    supersedesVersionReference: null,
    reasonCode: "SYNTHETIC_VALIDATE82",
    authoredByReference: actor,
    approvedByReference: id(88025),
    approvalEvidenceReference: id(88026),
    publicationReference: id(88027),
    createdAt: publishedAt,
    updatedAt: publishedAt,
    dataClassification: "ConfigurationMetadata",
  };
  const publication = await prepareBrandRecipeOverridePublication({
    admin,
    role,
    configuration,
    tenantReference: tenant,
    lifecycleReference: id(88100),
    familyReference: id(88101),
    operationBase: 88150,
    id,
  });
  // Exact Store override in addition to80's Brand binding. Both use synthetic
  // Published metadata, not a full V2 or real Store Recipe publication.
  await admin.query(
    "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,option_binding_id,effective_from) VALUES($1,$2,$3,$4,$5,$6,NULL,$7)",
    [id(88010), id(86001), id(86000), brand, skuReference, storeReference, past],
  );
  const tables = (
    await admin.query(
      "SELECT schemaname,tablename FROM pg_tables WHERE schemaname=ANY($1) ORDER BY schemaname,tablename",
      [
        [
          "rms_catalog",
          "rms_recipe",
          "bop_tenant",
          "bop_publishing",
          "platform_audit",
          "platform_eventing",
        ],
      ],
    )
  ).rows;
  const state = async () => {
    const result = [];
    for (const { schemaname, tablename } of tables) {
      assert.match(schemaname, /^[a-z][a-z0-9_]*$/);
      assert.match(tablename, /^[a-z][a-z0-9_]*$/);
      result.push(
        (
          await admin.query(
            `SELECT to_jsonb(t) row FROM "${schemaname}"."${tablename}" t ORDER BY to_jsonb(t)::text`,
          )
        ).rows,
      );
    }
    return result;
  };
  let baseline = await state();
  let operation = 88500;
  async function run(mode = null) {
    let actual,
      entered = false,
      armed = false,
      reached = false,
      consumerError,
      denyCandidate = false,
      denyRecipe = false,
      denyStore = false,
      denyBrand = false,
      brandDepth = 0,
      current;
    const activation = new Date(Date.now() + (mode === "past" ? -60000 : 600000)).toISOString();
    const command = parseProductPublicationCommand({
      ...candidateCommand,
      operationReference: id(++operation),
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: {
          instant: activation,
          localDateTime: activation.slice(0, 23),
          utcOffsetMinutes: 0,
        },
        effectiveUntil: null,
      },
    });
    const intent = "sha256:" + sha256Hex(canonicalizeRfc8785(command));
    const provider = createCurrentProductCandidateStoreRecipePolicySource({
      tenantReference: tenant,
      brandReference: brand,
      actorReference: actor,
      clock: { now: () => current ?? new Date().toISOString() },
      candidateAuthority: {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(tx, actual);
          if (denyCandidate) {
            reached = armed;
            throw new CatalogError("CATALOG_PERMISSION_DENIED");
          }
          await candidateAuthority.holdUntilTransactionCompletes(tx, input);
        },
      },
      recipeAuthority: {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(tx, actual);
          assert.deepEqual(input.requiredFields, recipeReferenceSourceFields);
          assert.equal(input.request.catalogIntentDigest, intent);
          assert.equal(input.request.operationReference, command.operationReference);
          assert.equal(input.permission, "recipe.manage");
          assert.equal(input.requiredScope, "FullBrandScope");
          if (denyRecipe) {
            reached = armed;
            throw new Error("synthetic late Recipe fields");
          }
        },
      },
      storeAuthority: {
        async withCurrentBrandReferenceRead(r, work) {
          assert.equal(r.brandReference, brand);
          assert.equal(r.actorReference, actor);
          assert.equal(r.originalIntentDigest, intent);
          assert.equal(r.purposeCode, "CATALOG_PRODUCT_RECIPE_STORE_RESOLUTION");
          return work();
        },
        async isCurrent(tx, r) {
          assert.equal(tx, actual);
          assert.equal(r.originalIntentDigest, intent);
          if (denyStore) reached = armed;
          return !denyStore;
        },
      },
      brandAuthority: {
        async withCurrentContentRead(r, fields, work) {
          assert.equal(r.tenantReference, tenant);
          assert.equal(r.brandReference, brand);
          assert.equal(r.actorReference, actor);
          assert.equal(r.originalIntentDigest, intent);
          assert.deepEqual(fields, tenantBrandConfigurationRequiredFields);
          if (denyBrand) {
            reached = armed;
            throw new Error("synthetic late Brand fields");
          }
          brandDepth++;
          try {
            return await work();
          } finally {
            brandDepth--;
          }
        },
        async isCurrent(tx, r, fields) {
          assert.equal(tx, actual);
          assert(brandDepth > 0);
          assert.deepEqual(fields, tenantBrandConfigurationRequiredFields);
          assert.equal(r.originalIntentDigest, intent);
          if (denyBrand) reached = armed;
          return !denyBrand;
        },
      },
    });
    const input = {
      command,
      storeReference:
        mode === "unknown Store"
          ? id(88999)
          : mode === "Brand default"
            ? id(20)
            : mode === "inactive Store"
              ? id(21)
              : storeReference,
      configurationVersionReference:
        mode === "unknown configuration"
          ? id(88998)
          : mode === "denied override"
            ? id(88040)
            : configurationReference,
      expectedBrandVersion: mode === "wrong Brand revision" ? 2 : 1,
    };
    const rejectBefore = ["past", "unknown configuration", "wrong Brand revision"].includes(mode);
    const late = [
      "candidate fields",
      "recipe fields",
      "Store fields",
      "Brand fields",
      "expiry",
      "query",
      "Store generation",
      "Brand lifecycle",
      "Archive",
      "target drift",
    ].includes(mode);
    const execute = () =>
      transactions.run(async (tx) => {
        actual = tx;
        const query = tx.query;
        try {
          return await provider.withCurrentResolution(tx, input, async (scope) => {
            entered = true;
            assert.equal(scope.originalIntentDigest, intent);
            assert.equal(scope.configurationDigest, command.configurationDigest);
            assert.equal(scope.recipe.activationAt, activation);
            assert.equal(scope.publishValidation, "Incomplete");
            assert.equal(scope.eligibility, "NotEvaluated");
            assert.equal(Object.hasOwn(scope, "aggregate"), false);
            if (["unknown Store", "inactive Store", "denied override"].includes(mode)) {
              assert.equal(
                scope.recipe.resolutions[0].status,
                mode === "unknown Store"
                  ? "UnknownStore"
                  : mode === "inactive Store"
                    ? "InactiveStore"
                    : "StoreOverrideDenied",
              );
              assert.equal(scope.recipe.resolutions[0].recipeVersionReference, null);
              return scope;
            }
            assert.equal(scope.recipe.decision, "PassForDirectBrandAndStoreBindings");
            assert.equal(
              scope.recipe.resolutions[0].source,
              mode === "Brand default" ? "BrandDefault" : "StoreOverride",
            );
            assert.equal(scope.recipe.resolutions[0].recipeVersionReference, id(86001));
            assert.equal(
              scope.recipe.overridePolicy.currentPublicationReference,
              configuration.publicationReference,
            );
            if (!late) return scope;
            try {
              await createMarker(tx);
              armed = true;
              if (mode === "candidate fields") denyCandidate = true;
              if (mode === "recipe fields") denyRecipe = true;
              if (mode === "Store fields") denyStore = true;
              if (mode === "Brand fields") denyBrand = true;
              if (mode === "expiry") {
                current = scope.validUntil;
                reached = true;
              }
              if (mode === "query") {
                tx.query = async () => ({ rows: [] });
                reached = true;
              }
              if (mode === "Store generation") {
                await tx.query("SELECT set_config('bop.store_id',$1,true)", [storeReference]);
                const change = await tx.query(
                  "UPDATE bop_tenant.store SET version=version+1,updated_at=updated_at+interval '1 millisecond' WHERE brand_id=$1 AND store_id=$2",
                  [brand, storeReference],
                );
                assert.equal(change.rowCount, 1);
                await tx.query("SELECT set_config('bop.store_id','',true)", []);
                reached = true;
              }
              if (mode === "Brand lifecycle") {
                const change = await tx.query(
                  "UPDATE bop_tenant.brand SET lifecycle='Suspended',version=version+1,updated_at=updated_at+interval '1 millisecond' WHERE brand_id=$1",
                  [brand],
                );
                assert.equal(change.rowCount, 1);
                reached = true;
              }
              if (mode === "Archive") {
                await publication.archive(tx);
                const release = await tx.query(
                  "SELECT count(*)::int n FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND lifecycle_id=$2 AND operation_code='Archive'",
                  [tenant, id(88100)],
                );
                assert.equal(release.rows[0].n, 1);
                reached = true;
              }
              if (mode === "target drift") {
                await changeCandidate(tx);
                reached = true;
              }
              return scope;
            } catch (error) {
              consumerError = error;
              throw error;
            }
          });
        } finally {
          tx.query = query;
        }
      });
    if (late || rejectBefore) {
      await assert.rejects(execute, (error) => {
        assert.ifError(consumerError);
        if (rejectBefore) assert.equal(entered, false);
        else
          assert(
            entered && armed && reached,
            "late82 refusal must follow real independent marker: " + mode,
          );
        assert.equal(
          error.code,
          mode === "candidate fields"
            ? "CATALOG_PERMISSION_DENIED"
            : "CATALOG_DEPENDENCY_UNAVAILABLE",
        );
        return true;
      });
    } else {
      const result = await execute();
      assert(entered);
      assert.equal(result.profile, "CurrentProductCandidateStoreRecipePolicyV1");
    }
    assert.deepEqual(await state(), baseline, "actual82 every-table rollback: " + mode);
  }
  await run();
  await run("unknown Store");
  await run("Brand default");
  await run("inactive Store");
  for (const mode of [
    "candidate fields",
    "recipe fields",
    "Store fields",
    "Brand fields",
    "expiry",
    "query",
    "Store generation",
    "Brand lifecycle",
    "Archive",
    "target drift",
    "past",
    "unknown configuration",
    "wrong Brand revision",
  ])
    await run(mode);
  // Actual native replacement release; approval/immutable Tenant facts synthetic.
  const deniedAt = new Date().toISOString();
  await prepareBrandRecipeOverridePublication({
    admin,
    role,
    id,
    tenantReference: tenant,
    configuration: {
      ...configuration,
      configurationVersionReference: id(88040),
      configurationVersion: 2,
      supersedesVersionReference: configurationReference,
      overrideAllowedFieldCodes: [],
      approvalEvidenceReference: id(88046),
      publicationReference: id(88047),
      createdAt: deniedAt,
      updatedAt: deniedAt,
    },
    lifecycleReference: id(88400),
    familyReference: id(88101),
    operationBase: 89500,
    previousRelease: publication.release,
  });
  baseline = await state();
  await run("denied override");
  return Object.freeze({ tableCount: tables.length, lateRefusals: 10, beforeRefusals: 3 });
}
