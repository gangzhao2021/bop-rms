import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import { CatalogError, parseProductPublicationCommand } from "../../rms/catalog/src/index.ts";
import {
  createBrand,
  createTenantContext,
  tenantBrandConfigurationRequiredFields,
} from "../../bop/tenant/src/index.ts";
import {
  createRecipeMeasurementDraftService,
  createPostgresRecipeMeasurementDraftStore,
  digestRecipeMeasurementContentV2,
  requireRecipeMeasurementContentDigest,
  recipeReferenceSourceFields,
  currentPublishedRecipeDependencyGraphFields,
  currentPublishedRecipeMeasurementGraphFields,
} from "../../rms/recipe/src/index.ts";
import {
  createPostgresInventoryItemStore,
  executeInventoryItemCommand,
  inventoryConfigurationReferenceFields,
  inventoryConfigurationReferencePermissions,
  inventoryRecipeIngredientUnitFields,
} from "../../rms/inventory/src/index.ts";
import { createCurrentRecipeMeasurementPublicationService } from "../../../apps/api/src/current-recipe-measurement-publication.ts";
import { createCurrentProductCandidateRecipeMeasurementsSource } from "../../../apps/api/src/current-product-candidate-recipe-measurements.ts";
import { prepareBrandRecipeOverridePublication } from "./brand-recipe-override-publication.mjs";
/** Actual owning native V2/Item writes and original Validate all-source composition.
 * Synthetic Identity/current fields/reference reviews/Store/configuration/binding facts only. */
export async function exerciseCurrentProductCandidateRecipeMeasurements({
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
  const tenant = candidateCommand.tenantReference,
    brand = candidateCommand.brandReference,
    actor = candidateCommand.actorReference,
    scope = { tenantReference: tenant, brandReference: brand },
    at = candidateCommand.occurredAt,
    storeReference = id(90000);
  let sequence = 91000;
  const next = () => id(++sequence),
    hashIntent = (v) => "sha256:" + createHash("sha256").update(v).digest("hex");
  // Finite isolated owning writer/read assets. Never production grants or new DDL.
  await admin.query("GRANT USAGE ON SCHEMA rms_inventory,rms_recipe TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON rms_inventory.inventory_item,rms_recipe.recipe TO " + role,
  );
  for (const table of [
    "rms_inventory.inventory_item_version",
    "rms_inventory.inventory_item_operation",
    "rms_recipe.recipe_version",
    "rms_recipe.recipe_ingredient_requirement",
    "rms_recipe.recipe_allergen_evidence",
    "rms_recipe.recipe_preparation_step",
    "rms_recipe.recipe_scope_binding",
    "rms_recipe.recipe_review_record",
    "rms_recipe.recipe_operation_record",
    "rms_recipe.recipe_measurement_content",
  ])
    await admin.query("GRANT SELECT,INSERT ON " + table + " TO " + role);
  for (const table of [
    "rms_inventory.configuration_reference_generation",
    "rms_recipe.recipe_reference_generation",
    "rms_recipe.recipe_reference_binding",
  ])
    await admin.query("GRANT SELECT ON " + table + " TO " + role);
  const audit = (targetType, targetId, operation, action, occurredAt = at) => ({
    auditId: next(),
    brandId: brand,
    actor: { type: "User", reference: actor },
    actionCode: action,
    targetType,
    targetId,
    reasonCode: "SYNTHETIC_VALIDATE84",
    correlationId: operation,
    occurredAt,
    sourceChannel: "API",
    dataClassification: "Internal",
    retentionPolicyCode: "SYNTHETIC_AUDIT",
    retentionPolicyVersion: 1,
  });
  const inventoryPorts = (tx) => ({
    authorization: { authorize: async () => ({ authorized: true }) },
    references: { generate: next, hashIntent, equals: (a, b) => a === b },
    audit: {
      create: async ({ command, after }) =>
        audit(
          "InventoryItem",
          after.itemReference,
          command.operationReference,
          "INVENTORY_ITEM_" + command.action.toUpperCase(),
          command.occurredAt,
        ),
    },
    repository: createPostgresInventoryItemStore({ run: (w) => w(tx) }, scope),
  });
  const item = await transactions.run(async (tx) => {
    const common = {
      ...scope,
      actorReference: actor,
      purpose: "InventoryItemManagement",
      occurredAt: at,
    };
    const created = await executeInventoryItemCommand(
      {
        ...common,
        action: "Create",
        operationReference: next(),
        payload: {
          internalCode: "SYNTHETIC_VALIDATE84_ITEM",
          itemType: "RawMaterial",
          localizedNames: { en: "Synthetic ingredient" },
          baseUnit: {
            unitCode: "KG",
            dimension: "Mass",
            displayPrecision: 2,
            ledgerPrecision: 4,
            roundingMode: "HalfEven",
          },
          trackingPolicy: {
            stockTrackingEnabled: true,
            lotTrackingMode: "NoLot",
            defaultShelfLifeDays: null,
            expiryWarningDays: null,
            issuePolicy: "FIFO",
            negativeStockPolicy: "Block",
          },
        },
      },
      inventoryPorts(tx),
    );
    assert.equal(created.outcome, "Applied");
    const operationReference = next();
    const activated = await executeInventoryItemCommand(
      {
        ...common,
        action: "Activate",
        operationReference,
        payload: {
          itemReference: created.item.itemReference,
          expectedVersion: 1,
          reasonCode: "SYNTHETIC_READY",
        },
      },
      inventoryPorts(tx),
    );
    assert.equal(activated.outcome, "Applied");
    assert.equal(activated.item.lifecycle, "Active");
    return { reference: activated.item.itemReference, operationReference };
  });
  const tenantContext = createTenantContext(
    {
      actorType: "User",
      actorReference: actor,
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    },
    createBrand({
      brandReference: brand,
      code: "B84",
      displayName: "Synthetic Brand",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    null,
    at,
  );
  const permission = (action) => ({
    effect: "Allow",
    reason: "ROLE_PERMISSION",
    source: "RolePermission",
    action,
    scopeKind: "Brand",
    policySnapshotReference: id(90030),
    policyVersion: 1,
    audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
  });
  const complete = (raw) =>
    requireRecipeMeasurementContentDigest({
      ...raw,
      snapshot: { ...raw.snapshot, snapshotDigest: digestRecipeMeasurementContentV2(raw) },
    });
  function ports(candidate, children = []) {
    return {
      authorization: {
        authorize: async (request) => ({
          tenantContext,
          permission: permission("recipe.manage"),
          costReviewPermission: permission("recipe.cost-review"),
          foodSafetyReviewPermission: permission("recipe.food-safety-review"),
          draftAuthorActorReference: actor,
          costReviewerActorReference: id(90031),
          foodSafetyReviewerActorReference: id(90032),
          publicationEvidence: {
            recipeReference: candidate.snapshot.recipeReference,
            versionReference: candidate.snapshot.versionReference,
            brandReference: brand,
            snapshotDigest: candidate.snapshot.snapshotDigest,
            draftAuthorActorReference: actor,
            reviews: [
              {
                reviewReference: next(),
                reviewKind: "Cost",
                reviewerActorReference: id(90031),
                evidenceDigest: "sha256:" + "c".repeat(64),
                decision: "Approved",
                reviewedAt: at,
              },
              {
                reviewReference: next(),
                reviewKind: "FoodSafety",
                reviewerActorReference: id(90032),
                evidenceDigest: "sha256:" + "d".repeat(64),
                decision: "Approved",
                reviewedAt: at,
              },
            ],
          },
          audit: audit(
            "Recipe",
            request.recipeReference,
            request.operationReference,
            "RECIPE_" + request.action.toUpperCase(),
            request.observedAt,
          ),
        }),
      },
      references: { hashIntent, equals: (a, b) => a === b },
      facts: {
        validate: async () => ({
          referencesValid: true,
          mappingsComplete: true,
          allergenEvidenceVerified: true,
          costEvidenceVerified: true,
          graphSnapshots: children.map((c) => c.snapshot),
        }),
      },
    };
  }
  const ingredient = {
    requirementReference: id(90064),
    sourceKind: "InventoryItem",
    sourceReference: item.reference,
    sourceVersionReference: item.operationReference,
    quantityMicrounits: "1000000",
    unitDimension: "Mass",
    conversionNumerator: "1",
    conversionDenominator: "1",
    lossBasisPoints: 500,
    unitCostMinorNumerator: "1",
    unitCostDenominator: "1000000",
    allergens: [{ allergenReference: id(90065), evidenceReference: id(90066), verified: true }],
  };
  const childRaw = {
    profile: "RecipeMeasurementContentV2",
    snapshot: {
      recipeReference: id(90060),
      versionReference: id(90061),
      brandReference: brand,
      stableCode: "SYNTHETIC_VALIDATE84_CHILD",
      aggregateVersion: 1,
      versionNumber: 1,
      snapshotDigest: "sha256:" + "a".repeat(64),
      lifecycle: "Draft",
      displayNameCode: "SYNTHETIC_RECIPE",
      yieldQuantityMicrounits: "1000000",
      yieldUnitCode: "PORTION",
      yieldDimension: "Count",
      ingredients: [ingredient],
      preparationVersionReference: id(90067),
      steps: [
        {
          stepReference: id(90068),
          sequenceGroup: 0,
          instructionCode: "MIX",
          durationSeconds: 10,
          capabilityCode: "PREP",
        },
      ],
      substitutionPolicyReference: null,
      effectivePeriod: candidateCommand.effectivePeriod,
      invalidationReasonCode: null,
      createdAt: at,
    },
    measurements: [
      {
        requirementReference: ingredient.requirementReference,
        usageUnitCode: "KG",
        usageDimension: "Mass",
        targetUnitCode: "KG",
        targetDimension: "Mass",
        conversionKind: "InventoryBaseUnitIdentity",
        conversionReference: null,
      },
    ],
  };
  // Original fixture period is past but unbounded; native publication still qualifies current/future.
  assert.equal(childRaw.snapshot.effectivePeriod.effectiveUntil, null);
  async function publish(raw, version, children = []) {
    const draft = complete(raw);
    await transactions.run(async (tx) => {
      const service = createRecipeMeasurementDraftService({
        ...ports(draft, children),
        repositoryForContent: () =>
          createPostgresRecipeMeasurementDraftStore({ run: (w) => w(tx) }, brand, next, draft),
      });
      const result = await service.execute({
        action: "CreateDraft",
        operationReference: next(),
        expectedAggregateVersion: null,
        candidate: draft,
        occurredAt: at,
      });
      assert.equal(result.status, "Applied");
    });
    const candidate = complete({
      ...raw,
      snapshot: {
        ...raw.snapshot,
        lifecycle: "Published",
        aggregateVersion: 2,
        versionNumber: 2,
        versionReference: version,
      },
    });
    await transactions.run(async (tx) => {
      const hold = async (actual) => assert.equal(actual, tx);
      const service = createCurrentRecipeMeasurementPublicationService({
        ...scope,
        actorReference: actor,
        clock: { now: () => new Date().toISOString() },
        generateReference: next,
        recipeAuthority: { holdUntilTransactionCompletes: hold },
        recipePorts: ports(candidate, children),
        inventory: {
          authority: { holdUntilTransactionCompletes: hold },
          unitAuthority: { holdUntilTransactionCompletes: hold },
        },
        pinnedRecipes: {
          authority: { holdUntilTransactionCompletes: hold },
          measurementAuthority: { holdUntilTransactionCompletes: hold },
        },
      });
      const result = await service.execute(tx, {
        action: "Publish",
        operationReference: next(),
        expectedAggregateVersion: 1,
        candidate,
        occurredAt: at,
      });
      assert.equal(result.status, "Applied");
      assert.deepEqual(result.content, candidate);
    });
    return candidate;
  }
  const child = await publish(childRaw, id(90062));
  const parentRaw = {
    ...childRaw,
    snapshot: {
      ...childRaw.snapshot,
      recipeReference: id(90070),
      versionReference: id(90071),
      stableCode: "SYNTHETIC_VALIDATE84_PARENT",
      ingredients: [
        {
          ...ingredient,
          requirementReference: id(90074),
          sourceKind: "SubRecipe",
          sourceReference: child.snapshot.recipeReference,
          sourceVersionReference: child.snapshot.versionReference,
          quantityMicrounits: "2000000",
          unitDimension: "Count",
          lossBasisPoints: 0,
        },
      ],
    },
    measurements: [
      {
        requirementReference: id(90074),
        usageUnitCode: "PORTION",
        usageDimension: "Count",
        targetUnitCode: "PORTION",
        targetDimension: "Count",
        conversionKind: "PinnedSubrecipeYieldIdentity",
        conversionReference: null,
      },
    ],
  };
  const parent = await publish(parentRaw, id(90072), [child]);
  const native = await admin.query(
    "SELECT count(*)::int n FROM rms_recipe.recipe_operation_record WHERE brand_id=$1 AND recipe_id=ANY($2) AND action_code='Publish'",
    [brand, [child.snapshot.recipeReference, parent.snapshot.recipeReference]],
  );
  assert.equal(native.rows[0].n, 2);
  await admin.query(
    "INSERT INTO bop_tenant.store VALUES($1,$2,'SYNTHETIC_VALIDATE84','Synthetic Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
    [storeReference, brand, at],
  );
  const oldRelease = await admin.query(
    "SELECT release_id,release_sequence::int sequence FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND family_id=$3 AND release_id IS NOT NULL ORDER BY release_sequence DESC LIMIT 1",
    [tenant, brand, id(88101)],
  );
  assert.equal(oldRelease.rows[0].release_id, id(88047));
  assert.equal(oldRelease.rows[0].sequence, 2);
  const publishedAt = new Date().toISOString(),
    configurationReference = id(90020);
  const configuration = {
    configurationVersionReference: configurationReference,
    brandReference: brand,
    configurationVersion: 3,
    lifecycle: "Published",
    defaultLocale: "en-CA",
    supportedLocales: ["en-CA"],
    mediaThemeReference: null,
    catalogSourceReference: id(88023),
    platformTemplateReference: id(88024),
    overrideAllowedFieldCodes: ["RECIPE.VERSION"],
    hardRequirementFieldCodes: [],
    effectiveFrom: at,
    effectiveUntil: new Date(Date.now() + 7200000).toISOString(),
    supersedesVersionReference: id(88040),
    reasonCode: "SYNTHETIC_VALIDATE84",
    authoredByReference: actor,
    approvedByReference: id(88025),
    approvalEvidenceReference: id(90026),
    publicationReference: id(90027),
    createdAt: publishedAt,
    updatedAt: publishedAt,
    dataClassification: "ConfigurationMetadata",
  };
  const publication = await prepareBrandRecipeOverridePublication({
    admin,
    role,
    id,
    tenantReference: tenant,
    configuration,
    lifecycleReference: id(90100),
    familyReference: id(88101),
    operationBase: 90300,
    previousRelease: {
      releaseId: oldRelease.rows[0].release_id,
      sequence: oldRelease.rows[0].sequence,
    },
  });
  await admin.query(
    "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,option_binding_id,effective_from) VALUES($1,$2,$3,$4,$5,$6,NULL,$7)",
    [
      id(90010),
      parent.snapshot.versionReference,
      parent.snapshot.recipeReference,
      brand,
      skuReference,
      storeReference,
      at,
    ],
  );
  const tables = (
    await admin.query(
      "SELECT schemaname,tablename FROM pg_tables WHERE schemaname=ANY($1) ORDER BY schemaname,tablename",
      [
        [
          "rms_catalog",
          "rms_recipe",
          "rms_inventory",
          "bop_tenant",
          "bop_publishing",
          "platform_audit",
          "platform_eventing",
        ],
      ],
    )
  ).rows;
  const state = async () => {
    const rows = [];
    for (const { schemaname, tablename } of tables) {
      assert.match(schemaname, /^[a-z][a-z0-9_]*$/);
      assert.match(tablename, /^[a-z][a-z0-9_]*$/);
      rows.push(
        (
          await admin.query(
            `SELECT to_jsonb(t) row FROM "${schemaname}"."${tablename}" t ORDER BY to_jsonb(t)::text`,
          )
        ).rows,
      );
    }
    return rows;
  };
  const baseline = await state();
  async function run(mode = null) {
    let actual,
      entered = false,
      armed = false,
      reached = false,
      consumerError,
      current,
      brandDepth = 0;
    const deny = new Set(),
      activation = new Date(Date.now() + (mode === "past" ? -60000 : 600000)).toISOString();
    const command = parseProductPublicationCommand({
      ...candidateCommand,
      operationReference: next(),
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
    const check = (tx, kind) => {
      assert.equal(tx, actual);
      if (deny.has(kind)) {
        reached = armed;
        throw Error("synthetic late " + kind + " fields");
      }
    };
    const recipeFields = (kind, fields) => ({
      async holdUntilTransactionCompletes(tx, input) {
        check(tx, kind);
        assert.deepEqual(input.requiredFields, fields);
        assert.equal(input.permission, "recipe.manage");
        assert.equal(input.requiredScope, "FullBrandScope");
        assert.equal(input.request.catalogIntentDigest, intent);
        assert.equal(input.request.operationReference, command.operationReference);
      },
    });
    const provider = createCurrentProductCandidateRecipeMeasurementsSource({
      ...scope,
      actorReference: actor,
      clock: { now: () => current ?? new Date().toISOString() },
      candidateAuthority: {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(tx, actual);
          if (deny.has("Candidate")) {
            reached = armed;
            throw new CatalogError("CATALOG_PERMISSION_DENIED");
          }
          await candidateAuthority.holdUntilTransactionCompletes(tx, input);
        },
      },
      recipeAuthority: recipeFields("Recipe", recipeReferenceSourceFields),
      graphAuthority: recipeFields("Graph", currentPublishedRecipeDependencyGraphFields),
      measurementAuthority: recipeFields(
        "Measurement",
        currentPublishedRecipeMeasurementGraphFields,
      ),
      storeAuthority: {
        async withCurrentBrandReferenceRead(request, work) {
          assert.equal(request.originalIntentDigest, intent);
          assert.equal(request.actorReference, actor);
          return work();
        },
        async isCurrent(tx, request) {
          assert.equal(request.originalIntentDigest, intent);
          check(tx, "Store");
          return true;
        },
      },
      brandAuthority: {
        async withCurrentContentRead(request, fields, work) {
          assert.deepEqual(fields, tenantBrandConfigurationRequiredFields);
          assert.equal(request.originalIntentDigest, intent);
          assert.equal(request.actorReference, actor);
          brandDepth++;
          try {
            return await work();
          } finally {
            brandDepth--;
          }
        },
        async isCurrent(tx, request, fields) {
          assert(brandDepth > 0);
          assert.deepEqual(fields, tenantBrandConfigurationRequiredFields);
          assert.equal(request.originalIntentDigest, intent);
          check(tx, "Brand");
          return true;
        },
      },
      inventoryAuthority: {
        async holdUntilTransactionCompletes(tx, input) {
          check(tx, "Inventory");
          assert.equal(input.requiredScope, "FullBrandScope");
          assert.deepEqual(input.requiredFields, inventoryConfigurationReferenceFields);
          assert.deepEqual(input.requiredPermissions, inventoryConfigurationReferencePermissions);
          assert.equal(input.request.catalogIntentDigest, intent);
          assert.equal(input.request.operationReference, command.operationReference);
        },
      },
      unitAuthority: {
        async holdUntilTransactionCompletes(tx, input) {
          check(tx, "Units");
          assert.deepEqual(input.requiredFields, inventoryRecipeIngredientUnitFields);
          assert.equal(input.requiredScope, "FullBrandScope");
          assert.deepEqual(input.requiredPermissions, [
            "inventory.item.read",
            "inventory.item.history.read",
          ]);
          assert.equal(input.request.catalogIntentDigest, intent);
          assert.deepEqual(input.itemReferences, [item.reference]);
        },
      },
    });
    const early = ["past", "unknown Store", "legacy"].includes(mode),
      late = mode !== null && !early;
    const execute = () =>
      transactions.run(async (tx) => {
        actual = tx;
        const query = tx.query;
        try {
          return await provider.withCurrentAssessment(
            tx,
            {
              command,
              storeReference:
                mode === "unknown Store" ? id(90999) : mode === "legacy" ? id(20) : storeReference,
              configurationVersionReference: configurationReference,
              expectedBrandVersion: 1,
            },
            async (result) => {
              entered = true;
              assert.equal(result.selection.originalIntentDigest, intent);
              assert.equal(result.selection.recipe.activationAt, activation);
              assert.equal(
                result.selection.recipe.resolutions[0].recipeVersionReference,
                parent.snapshot.versionReference,
              );
              assert.equal(result.graph.contents.length, 2);
              assert.equal(result.batches.batches.length, 1);
              assert.equal(result.precision[0].aggregates[0].baseQuantityMicrounits, "2100000");
              assert.equal(result.batches.batches[0].demands[0].sourcePath.length, 2);
              assert.equal(result.publishValidation, "Incomplete");
              assert.equal(result.productQuantity, "NotEvaluated");
              assert.equal(result.eligibility, "NotEvaluated");
              assert.equal(result.graph.request.operationReference, command.operationReference);
              assert.equal(result.graph.request.catalogIntentDigest, intent);
              assert.equal(
                result.selection.recipe.overridePolicy.currentPublicationReference,
                configuration.publicationReference,
              );
              if (!late) return result;
              try {
                await createMarker(tx);
                armed = true;
                if (
                  [
                    "Candidate",
                    "Recipe",
                    "Store",
                    "Brand",
                    "Graph",
                    "Measurement",
                    "Inventory",
                    "Units",
                  ].includes(mode)
                )
                  deny.add(mode);
                if (mode === "expiry") {
                  current = result.validUntil;
                  reached = true;
                }
                if (mode === "query") {
                  tx.query = async () => ({ rows: [] });
                  reached = true;
                }
                if (mode === "Deactivate") {
                  const changed = await executeInventoryItemCommand(
                    {
                      ...scope,
                      actorReference: actor,
                      purpose: "InventoryItemManagement",
                      action: "Deactivate",
                      operationReference: next(),
                      occurredAt: new Date().toISOString(),
                      payload: {
                        itemReference: item.reference,
                        expectedVersion: 2,
                        reasonCode: "SYNTHETIC_LATE84",
                      },
                    },
                    inventoryPorts(tx),
                  );
                  assert.equal(changed.outcome, "Applied");
                  assert.equal(changed.item.lifecycle, "Inactive");
                  reached = true;
                }
                if (mode === "Archive") {
                  await publication.archive(tx);
                  const archived = await tx.query(
                    "SELECT count(*)::int n FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND lifecycle_id=$2 AND operation_code='Archive'",
                    [tenant, id(90100)],
                  );
                  assert.equal(archived.rows[0].n, 1);
                  reached = true;
                }
                if (mode === "target drift") {
                  await changeCandidate(tx);
                  reached = true;
                }
                return result;
              } catch (error) {
                consumerError = error;
                throw error;
              }
            },
          );
        } finally {
          tx.query = query;
        }
      });
    if (early || late)
      await assert.rejects(execute, (error) => {
        assert.ifError(consumerError);
        if (early) assert.equal(entered, false);
        else
          assert(
            entered && armed && reached,
            "late84 native marker and final source reached: " + mode,
          );
        assert.equal(
          error.code,
          mode === "Candidate" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
        );
        return true;
      });
    else {
      const result = await execute();
      assert(entered);
      assert.equal(result.profile, "CurrentProductCandidateRecipeMeasurementsV2");
    }
    assert.deepEqual(await state(), baseline, "actual84 every-table read-only/rollback: " + mode);
  }
  await run();
  for (const mode of [
    "Candidate",
    "Recipe",
    "Store",
    "Brand",
    "Graph",
    "Measurement",
    "Inventory",
    "Units",
    "expiry",
    "query",
    "Deactivate",
    "Archive",
    "target drift",
    "past",
    "unknown Store",
    "legacy",
  ])
    await run(mode);
  return Object.freeze({
    tableCount: tables.length,
    lateRefusals: 13,
    beforeRefusals: 3,
    nativePublishedRecipes: 2,
  });
}
