import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createMerchantAllergens } from "../../../apps/api/src/merchant-allergens.ts";
import { listInventoryRecipeIngredientFacts } from "../../rms/inventory/src/index.ts";
import {
  createPostgresAllergenReviewFactsStore,
  listCurrentIngredientDeclarations,
} from "../../rms/catalog/src/index.ts";
import {
  loadRecipe,
  parseRecipeDraft,
  publishRecipe,
  saveRecipeDraft,
} from "../../rms/recipe/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { kilogram, litre, syntheticInventoryItems } from "../test-support/inventory-items.mjs";
import { syntheticMerchantBrandScope } from "../test-support/merchant-brand-scope.mjs";
import { ensureSyntheticStockPlace } from "../test-support/stock-place.mjs";

const { Client } = pg;
const id = (n) => "01909a1e-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** The pilot API role's grants for allergens (docs/spec/pilot-acl-additions.json). */
export const allergenApiGrants = [
  "GRANT USAGE ON SCHEMA rms_catalog,rms_recipe,rms_inventory,rms_kitchen,platform_audit,platform_eventing,platform_helpers TO ROLE_",
  "GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ROLE_",
  "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ROLE_",
  "GRANT SELECT,INSERT ON rms_catalog.allergen_registry_version,rms_catalog.allergen_registry_entry,rms_catalog.allergen_source_evidence,rms_catalog.allergen_source_assertion TO ROLE_",
  // Menu review locks these sources in SHARE mode (UPDATE privilege); their update rules do nothing.
  "GRANT UPDATE ON rms_catalog.allergen_registry_version,rms_catalog.allergen_registry_entry,rms_catalog.allergen_source_evidence,rms_catalog.allergen_source_assertion TO ROLE_",
  "GRANT SELECT ON rms_inventory.inventory_item,rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation,rms_inventory.stock_movement TO ROLE_",
  "GRANT SELECT,INSERT,UPDATE ON rms_recipe.recipe,rms_recipe.recipe_scope_binding,rms_recipe.recipe_reference_generation TO ROLE_",
  "GRANT SELECT,INSERT ON rms_recipe.recipe_version,rms_recipe.recipe_ingredient_requirement,rms_recipe.recipe_allergen_evidence,rms_recipe.recipe_preparation_step,rms_recipe.recipe_operation_record,rms_recipe.recipe_review_record,rms_recipe.recipe_preparation_content,rms_recipe.recipe_version_presentation,rms_recipe.recipe_authoring_review,rms_recipe.recipe_scope_binding_end,rms_recipe.recipe_reference_binding TO ROLE_",
  "GRANT SELECT,INSERT ON platform_audit.audit_record TO ROLE_",
  "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ROLE_",
  "GRANT INSERT ON platform_eventing.outbox_event TO ROLE_",
];

/** WP-2423 / DEC-ALLERGEN-DECLARATIONS: registry, declarations, recipes carrying them, menu facts. */
it("approves the allergen list, records declarations and makes recipes carry them", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_allergens" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_allergen_" + context.runId;
    let sequence = 1000,
      second = 0;
    const next = () => id(++sequence);
    const now = () => new Date(Date.UTC(2026, 9, 7, 10, 0, ++second)).toISOString();
    let operation = 0x7000;
    const op = () => "019a0000-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
    const [owner, cook, reader] = [id(4), id(5), id(6)];
    const run = (asRole) => async (work) => {
      await admin.query("BEGIN");
      try {
        if (asRole) await admin.query("SET LOCAL ROLE " + role);
        const value = await work(admin);
        await admin.query("COMMIT");
        return value;
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    };
    const setupTx = run(false);
    const tx = run(true);
    try {
      await ensureSyntheticStockPlace(admin, {
        tenantId: scope.tenantReference,
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        stockSiteId: id(10),
        locationId: id(11),
        at: "2026-10-07T09:00:00.000Z",
      });
      const items = syntheticInventoryItems({ tx: setupTx, scope, actor: owner, next, clock: now });
      const milk = await items.create("MILK", litre, "NoLot");
      const beans = await items.create("BEANS", kilogram, "NoLot");
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      for (const sql of allergenApiGrants) await admin.query(sql.replaceAll("ROLE_", role));
      const brandScope = syntheticMerchantBrandScope({
        ...scope,
        policyReference: id(300),
        grants: {
          [owner]: [
            "catalog.allergen.read",
            "catalog.allergen.declare",
            "catalog.allergen_registry.manage",
          ],
          [cook]: ["catalog.allergen.read", "catalog.allergen.declare"],
          [reader]: ["catalog.allergen.read"],
        },
      });
      const allergens = createMerchantAllergens({
        persistence: { now, transactions: { run: tx } },
        authentication: { authorize: async () => ({ sessionReference: id(7) }) },
        references: { next },
        locale: "en-CA",
        resolveScope: brandScope.resolveScope,
      });
      const session = { sessionCookie: "c", csrf: "c" };
      const command = (body) => allergens.command({ ...session, body });
      const rejects = async (promise, code) =>
        assert.rejects(promise, (error) => error.code === code || assert.fail(String(error.code)));

      // No list yet: nothing can be declared; the owner approves the TEST Canadian list.
      const empty = await allergens.query({ ...session, itemReference: null });
      assert.equal(empty.registry, null);
      assert.deepEqual(
        empty.items.map((item) => [item.internalCode, item.status]),
        [
          ["BEANS", "Missing"],
          ["MILK", "Missing"],
        ],
      );
      const declareBody = (item, version, list, overrides = {}) => ({
        action: "Declare",
        operationReference: op(),
        itemReference: item,
        expectedItemVersion: version,
        allergens: list,
        sourceKind: "SupplierSpecification",
        documentReference: "Dairy Co. spec sheet 2026-09",
        note: null,
        validUntilDate: "2027-10-08",
        ...overrides,
      });
      const versionOf = (item) =>
        empty.items.find((row) => row.itemReference === item).itemVersionReference;
      await rejects(command(declareBody(milk, versionOf(milk), [])), "RegistryMissing");
      brandScope.as(cook);
      await rejects(
        command({
          action: "ApproveRegistry",
          operationReference: op(),
          template: "CA_PRIORITY_TEST",
        }),
        "PermissionDenied",
      );
      brandScope.as(owner);
      const approve = {
        action: "ApproveRegistry",
        operationReference: op(),
        template: "CA_PRIORITY_TEST",
      };
      assert.equal((await command(approve)).status, "Applied");
      assert.equal((await command(approve)).status, "AlreadyApplied");
      const listed = await allergens.query({ ...session, itemReference: null });
      assert.equal(listed.registry.entries.length, 12);
      const allergen = (code) =>
        listed.registry.entries.find((entry) => entry.code === code).allergenReference;

      // The cook declares milk (contains milk) and beans (none); a retry replays.
      brandScope.as(cook);
      const milkBody = declareBody(milk, versionOf(milk), [
        { allergenReference: allergen("MILK"), classification: "Contains" },
      ]);
      const milkDeclared = await command(milkBody);
      assert.equal(milkDeclared.status, "Applied");
      assert.equal((await command(milkBody)).status, "AlreadyApplied");
      await command(
        declareBody(beans, versionOf(beans), [], {
          sourceKind: "ProductLabel",
          documentReference: "Roaster label, lot 2410",
        }),
      );
      // Refusals: stale item version, unknown allergen, expired validity, reader.
      await rejects(command(declareBody(milk, id(999), [])), "Conflict");
      await rejects(
        command(
          declareBody(milk, versionOf(milk), [
            { allergenReference: id(998), classification: "Contains" },
          ]),
        ),
        "Invalid",
      );
      await rejects(
        command(declareBody(milk, versionOf(milk), [], { validUntilDate: "2026-01-01" })),
        "Invalid",
      );
      brandScope.as(reader);
      await rejects(command(declareBody(milk, versionOf(milk), [])), "PermissionDenied");
      const after = await allergens.query({ ...session, itemReference: null });
      assert.deepEqual(
        after.items.map((item) => [
          item.internalCode,
          item.status,
          item.declaration?.allergens.length,
        ]),
        [
          ["BEANS", "Current", 0],
          ["MILK", "Current", 1],
        ],
      );
      const detail = await allergens.query({ ...session, itemReference: milk });
      assert.equal(detail.history.length, 1);
      assert.equal(detail.history[0].declaredBy, cook);
      assert.equal(detail.history[0].validUntil, "2027-10-09T04:00:00.000Z");

      // A recipe saved without declarations cannot be published; saved with them it carries them.
      const recipeScope = scope;
      const declarations = await tx((t) =>
        listCurrentIngredientDeclarations(t, recipeScope, now()),
      );
      const inventory = await tx((t) => listInventoryRecipeIngredientFacts(t, recipeScope));
      const facts = (withDeclarations) => ({
        items: new Map(
          inventory.map((item) => {
            const d = declarations.find((x) => x.itemReference === item.itemReference);
            return [
              item.itemReference,
              {
                configurationOperationReference: item.configurationOperationReference,
                dimension: item.dimension,
                unitCode: item.unitCode,
                active: item.active,
                allergenDeclaration:
                  withDeclarations && d
                    ? {
                        evidenceReference: d.evidenceReference,
                        allergenReferences: d.allergens.map((a) => a.allergenReference),
                      }
                    : null,
              },
            ];
          }),
        ),
        subRecipes: new Map(),
        capabilityReferences: new Set([id(20)]),
      });
      const draft = parseRecipeDraft({
        name: "Latte",
        code: "LATTE",
        yieldQuantity: "1",
        yieldUnit: "EACH",
        ingredients: [
          {
            kind: "InventoryItem",
            sourceReference: milk,
            quantity: "0.25",
            lossPercent: "0",
            unitCostCents: "289",
          },
          {
            kind: "InventoryItem",
            sourceReference: beans,
            quantity: "0.018",
            lossPercent: "0",
            unitCostCents: "2450",
          },
        ],
        steps: [
          {
            sequence: 0,
            instruction: "Pull and pour.",
            durationSeconds: 60,
            capabilityReference: id(20),
          },
        ],
      });
      const recipe = id(100);
      const writer = () => ({ actorReference: owner, at: now(), nextReference: next });
      const first = await tx((t) =>
        saveRecipeDraft(t, recipeScope, {
          ...writer(),
          operationReference: next(),
          recipeReference: recipe,
          expectedAggregateVersion: null,
          revisionOf: null,
          draft,
          facts: facts(false),
          auditReference: next(),
        }),
      );
      const publish = (expected, f) =>
        tx((t) =>
          publishRecipe(t, recipeScope, {
            ...writer(),
            operationReference: next(),
            recipeReference: recipe,
            expectedAggregateVersion: expected,
            facts: f,
            reviewersAuthorized: async () => true,
            auditReference: next(),
          }),
        );
      await assert.rejects(
        publish(first.snapshot?.aggregateVersion ?? 1, facts(true)),
        (error) => error.code === "RECIPE_AUTHORING_ALLERGEN_UNDECLARED" && error.line === 1,
      );
      const saved = await tx((t) =>
        saveRecipeDraft(t, recipeScope, {
          ...writer(),
          operationReference: next(),
          recipeReference: recipe,
          expectedAggregateVersion: 1,
          revisionOf: null,
          draft,
          facts: facts(true),
          auditReference: next(),
        }),
      );
      const loaded = await tx((t) => loadRecipe(t, recipeScope, recipe, now()));
      const [milkLine, beansLine] = loaded.snapshot.ingredients;
      assert.equal(
        milkLine.allergenDeclarationReference,
        milkDeclared.declaration.evidenceReference,
      );
      assert.deepEqual(
        milkLine.allergens.map((a) => a.allergenReference),
        [allergen("MILK")],
      );
      assert.equal(beansLine.allergens.length, 0);
      assert.ok(beansLine.allergenDeclarationReference);
      assert.equal(
        Number(
          (
            await admin.query(
              "SELECT count(*) FROM rms_recipe.recipe_ingredient_requirement WHERE allergen_declaration_evidence_id IS NOT NULL",
            )
          ).rows[0].count,
        ),
        2,
      );
      // Declarations pass; publication then needs the independent reviews.
      await assert.rejects(
        publish(saved.snapshot?.aggregateVersion ?? 2, facts(true)),
        (error) => error.code === "RECIPE_AUTHORING_REVIEW_REQUIRED",
      );

      // Menu review reads both declarations, including the one listing no allergens.
      const evidence = [
        milkLine.allergenDeclarationReference,
        beansLine.allergenDeclarationReference,
      ];
      const factsStore = createPostgresAllergenReviewFactsStore({
        brandReference: scope.brandReference,
        authorize: async () => true,
      });
      const reviewFacts = await tx((t) =>
        factsStore(t, {
          registryVersionReference: listed.registry.registryVersionReference,
          evidenceReferences: evidence,
          defaultLocale: "en-CA",
          observedAt: now(),
        }),
      );
      assert.deepEqual(reviewFacts.evidence.map((e) => e.assertions.length).sort(), [0, 1]);
      // A new list version: the old declarations no longer speak for it.
      brandScope.as(owner);
      await command({
        action: "ApproveRegistry",
        operationReference: op(),
        template: "CA_PRIORITY_TEST",
      });
      const relisted = await allergens.query({ ...session, itemReference: null });
      assert.notEqual(
        relisted.registry.registryVersionReference,
        listed.registry.registryVersionReference,
      );
      assert.equal(
        relisted.registry.entries.find((e) => e.code === "MILK").allergenReference,
        allergen("MILK"),
      );
      assert.deepEqual(
        relisted.items.map((item) => item.status),
        ["RegistryChanged", "RegistryChanged"],
      );
      await assert.rejects(
        tx((t) =>
          factsStore(t, {
            registryVersionReference: relisted.registry.registryVersionReference,
            evidenceReferences: evidence,
            defaultLocale: "en-CA",
            observedAt: now(),
          }),
        ),
      );
      // Append-only: declarations and assertions cannot be changed.
      await admin.query(
        "UPDATE rms_catalog.allergen_source_assertion SET classification='Unverified'",
      );
      assert.equal(
        Number(
          (
            await admin.query(
              "SELECT count(*) FROM rms_catalog.allergen_source_assertion WHERE classification='Unverified'",
            )
          ).rows[0].count,
        ),
        0,
      );
      const audits = (
        await admin.query(
          "SELECT action_code,actor_reference FROM platform_audit.audit_record WHERE action_code LIKE 'CATALOG_ALLERGEN_%' ORDER BY occurred_at",
        )
      ).rows.map(
        (row) => row.action_code + ":" + (row.actor_reference === owner ? "owner" : "cook"),
      );
      assert.deepEqual(audits, [
        "CATALOG_ALLERGEN_REGISTRY_APPROVE:owner",
        "CATALOG_ALLERGEN_DECLARE:cook",
        "CATALOG_ALLERGEN_DECLARE:cook",
        "CATALOG_ALLERGEN_REGISTRY_APPROVE:owner",
      ]);
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end();
    }
  });
});
