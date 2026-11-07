import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { createMerchantDishAllergens } from "../../../apps/api/src/merchant-dish-allergens.ts";
import { createMenuRecipeAllergenSource } from "../../../apps/api/src/menu-recipe-allergen-source.ts";
import { createMerchantProducts } from "../../../apps/api/src/merchant-products.ts";
import { createAllergenRegistryVersion } from "../../rms/catalog/src/index.ts";
import { listInventoryRecipeIngredientFacts } from "../../rms/inventory/src/index.ts";
import {
  createPostgresKitchenRoutingConfigurationStore,
  rebindKitchenRoutingEvidence,
} from "../../rms/kitchen/src/index.ts";
import { listRecipes, listStaffDeclaredAllergenSources } from "../../rms/recipe/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { syntheticMerchantBrandScope } from "../test-support/merchant-brand-scope.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a6f-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (coordinator 2026-10-28, accepted with four conditions):
 * staff declare a dish's allergens in the one-page menu. Through the real command under the
 * restricted NOBYPASSRLS role with the rendered pilot API grants:
 * 1. the dish size gets an inventory item standing for it — Finished good, not stock-tracked —
 *    holding a StaffDeclaration, and a generated recipe with that one item, reviewed alone at the
 *    one store (marked), published with kitchen instructions and bound to the size; all labelled
 *    AllergensDeclaredByStaff; the recipe carries no cost;
 * 2. the same request again changes nothing; new allergens publish a revision and rebind it;
 * 3. someone without the recipe, allergen and inventory permissions cannot declare;
 * 4. a second store (a draft one) refuses it;
 * 5. the label is append-only and names the Brand's own recipe.
 */
it("dish allergens: staff declare them; generated recipe labelled, never stock, single store only", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_ss_dish" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      kai = id(5),
      taxClass = id(100),
      peanut = id(60),
      sesame = id(61),
      wheat = id(62);
    let operation = 0x7000;
    const op = () => "019a0003-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_ssda");
      const start = Date.parse(await dbNow(admin));
      const from = new Date(start - 3 * 3600_000).toISOString();
      // TEST-ONLY Store tax configuration covering the tax class the product uses (13 %).
      await admin.query(
        "INSERT INTO rms_pricing.tax_configuration(tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'TEST_STORE_TAX',1,'2026-01-01T00:00:00Z',$4,'2026-01-01T00:00:00Z')",
        [id(200), brandReference, storeReference, owner],
      );
      await admin.query(
        `INSERT INTO rms_pricing.tax_configuration_version(tax_configuration_version_id,tax_configuration_id,brand_id,store_id,version_number,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_until,effective_time_zone,registration_applicability_id,operating_entity_tax_reference_id,jurisdiction_profile_id,registration_evidence_valid_until,professional_evidence_id,professional_review_reference_id,fixture_suite_reference_id,fixture_suite_digest,professional_evidence_valid_until,created_at)
         VALUES($1,$2,$3,$4,1,$5,'Published','CA-ON','CAD',1,$6,$5,'2026-01-01T00:00:00Z',NULL,'America/Toronto',$7,$8,$9,'2027-01-01T00:00:00Z',$10,$11,$12,$5,'2027-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
        [
          id(201),
          id(200),
          brandReference,
          storeReference,
          "sha256:" + "a".repeat(64),
          id(202),
          id(203),
          id(204),
          id(205),
          id(206),
          id(207),
          id(208),
        ],
      );
      for (const [n, orderType] of [
        [210, "Pickup"],
        [211, "DineIn"],
      ])
        await admin.query(
          "INSERT INTO rms_pricing.tax_configuration_rule(tax_configuration_rule_id,tax_configuration_version_id,tax_configuration_id,brand_id,store_id,tax_classification_id,order_type,charge_type,tax_component_code,treatment,tax_rate,price_inclusion,rounding_mode,calculation_order,compound_on_prior_tax,exception_evidence_id,receipt_presentation_code) VALUES($1,$2,$3,$4,$5,$6,$7,'Sellable','TEST_TAX','Taxable',0.13,'Exclusive','HalfUp',1,false,NULL,'TEST_TAX_LINE')",
          [id(n), id(201), id(200), brandReference, storeReference, taxClass, orderType],
        );
      await admin.query(
        "UPDATE rms_pricing.tax_configuration SET current_version_id=$1 WHERE tax_configuration_id=$2",
        [id(201), id(200)],
      );

      // Organization, Membership and Permission facts: one store; the owner holds the recipe,
      // allergen and inventory permissions, Kai (front of house) does not.
      await seedBrand(admin, { brandReference, policyReference: id(300), from });
      const store = (reference, code, lifecycle) =>
        admin.query(
          "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,$3,$4,'America/Toronto','en-CA','CAD',$5,1,$6,$6)",
          [reference, brandReference, code, "Synthetic " + code, lifecycle, from],
        );
      await store(storeReference, "STORE_ONE", "Active");
      const ownerActions = [
        "recipe.read",
        "recipe.update",
        "recipe.approve",
        "recipe.publish",
        "catalog.allergen.declare",
        "inventory.item.create",
        "inventory.item.activate",
      ];
      const approver = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(310),
        code: "brand_owner",
        actions: ownerActions,
        from,
      });
      const enrolledAt = new Date(start - 2 * 3600_000).toISOString();
      await seedBrandMember(admin, {
        id,
        base: 400,
        brandReference,
        storeReference,
        actorReference: owner,
        name: "Sam",
        roles: [approver],
        from,
        enrolledAt,
      });
      const editor = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(320),
        code: "front_of_house",
        actions: ["recipe.read", "recipe.update"],
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 600,
        brandReference,
        storeReference,
        actorReference: kai,
        name: "Kai",
        roles: [editor],
        from,
        enrolledAt,
      });
      const scope = { tenantReference, brandReference, storeReference };
      const setup = async (work) => {
        await admin.query("BEGIN");
        try {
          await admin.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenantReference, brandReference, storeReference],
          );
          const value = await work(admin);
          await admin.query("COMMIT");
          return value;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      // TEST-ONLY kitchen station of the Store (owner write path, synthetic operator authority).
      const routing = createPostgresKitchenRoutingConfigurationStore({
        ...scope,
        sha256,
        authorizeRead: async () => true,
        authorizeWrite: async () => true,
        validateConfiguration: async () => true,
        audit: async (record) => ({
          auditId: op(),
          brandId: brandReference,
          storeId: storeReference,
          actor: { type: "User", reference: record.actorReference },
          actionCode: "KITCHEN_ROUTING_CONFIGURATION_RECORDED",
          targetType: "KitchenRoutingConfiguration",
          targetId: record.configuration.evidenceReference,
          correlationId: record.operationReference,
          reasonCode: record.reasonCode,
          occurredAt: record.recordedAt,
          sourceChannel: "MERCHANT_WEB",
          afterSummary: { version: record.configuration.evidenceVersion },
          dataClassification: "Restricted",
          retentionPolicyCode: "KITCHEN_BUSINESS_RECORD",
          retentionPolicyVersion: 1,
        }),
      });
      const stationAt = new Date(start - 3600_000).toISOString();
      await setup((t) =>
        routing.commit({
          transaction: t,
          record: {
            operationReference: op(),
            actorReference: owner,
            purposeCode: "SyntheticConfiguration",
            permissionCode: "synthetic.configure",
            reasonCode: "SYNTHETIC_SETUP",
            recordedAt: stationAt,
            expectedVersion: 0,
            configuration: rebindKitchenRoutingEvidence(
              {
                brandReference,
                storeReference,
                evidenceReference: op(),
                evidenceVersion: 1,
                effectiveAt: stationAt,
                evidenceDigest: sha256("placeholder"),
                candidates: [
                  {
                    stationReference: id(13),
                    stationVersion: 1,
                    stationStatus: "Active",
                    stationCapabilityReferences: [id(12)],
                    routingRuleReference: id(14),
                    routingRuleVersion: 1,
                    routingRuleStatus: "Active",
                    selector: { kind: "AllPreparedItems" },
                    targetStationReference: id(13),
                    routingRuleDigest: sha256("placeholder"),
                  },
                ],
              },
              stationAt,
              sha256,
            ),
          },
        }),
      );
      // TEST-ONLY Brand allergen list.
      await setup((t) =>
        createAllergenRegistryVersion(t, scope, {
          registryVersionReference: id(63),
          jurisdictionCode: "CA",
          policyDocument: "TEST-ONLY synthetic allergen list",
          entries: [
            { allergenReference: peanut, code: "PEANUT", localizedNames: { "en-CA": "Peanuts" } },
            { allergenReference: sesame, code: "SESAME", localizedNames: { "en-CA": "Sesame" } },
            { allergenReference: wheat, code: "WHEAT", localizedNames: { "en-CA": "Wheat" } },
          ],
          actorReference: owner,
          at: new Date(start - 3600_000).toISOString(),
          auditReference: op(),
        }),
      );

      // The command's transaction. `intercept` (tests only) sees each statement first.
      let intercept = null;
      const tx = {
        query: async (sql, values) => {
          const seen = intercept === null ? undefined : await intercept(sql, values);
          if (seen === "skip") return { rows: [], rowCount: 1 };
          if (seen !== undefined && typeof seen === "object") return seen;
          return admin.query(sql, values);
        },
      };
      const persistence = {
        now: () => new Date().toISOString(),
        transactions: {
          async run(work) {
            await admin.query("BEGIN");
            try {
              await admin.query("SET LOCAL ROLE " + role);
              await admin.query("SELECT set_config('bop.tenant_id',$1,true)", [tenantReference]);
              const value = await work(tx);
              await admin.query("COMMIT");
              return value;
            } catch (error) {
              await admin.query("ROLLBACK");
              throw error;
            }
          },
        },
      };
      const grants = syntheticMerchantBrandScope({
        tenantReference,
        brandReference,
        storeReference,
        policyReference: id(300),
        grants: {
          [owner]: [
            ...ownerActions,
            "catalog.product.read",
            "catalog.product.create",
            "catalog.product.update",
            "catalog.product.manage",
            "catalog.sku.create",
            "catalog.product.publish",
            "catalog.sku.activate",
          ],
          [kai]: ["recipe.read", "recipe.update"],
        },
      });
      const authentication = { authorize: async () => ({ sessionReference: id(7) }) };
      const common = {
        persistence,
        authentication,
        locale: "en-CA",
        resolveScope: grants.resolveScope,
      };
      const products = createMerchantProducts({ ...common, references: { next: op } });
      const dishAllergens = createMerchantDishAllergens({ ...common, references: { next: op } });
      const session = { sessionCookie: "cookie", csrf: "csrf" };
      const declare = (skuReference, allergens, operationReference = op()) =>
        dishAllergens.command({
          ...session,
          body: { action: "DeclareDish", operationReference, skuReference, allergens },
        });
      const rejects = (promise, code) =>
        assert.rejects(promise, (error) => error.code === code || assert.fail(String(error.code)));
      const read = (work) => persistence.transactions.run(work);
      grants.as(owner);

      // A TEST-ONLY dish with one size.
      const dish = (
        await products.command({
          ...session,
          body: {
            action: "Create",
            operationReference: op(),
            internalCode: "DANDAN",
            productType: "PreparedFood",
            name: "Dan dan noodles (TEST)",
            taxClassificationReference: taxClass,
            sizes: [{ skuReference: null, skuCode: "DANDAN-1", name: "Dan dan noodles (TEST)" }],
          },
        })
      ).product;
      const sku = dish.sizes[0].skuReference;
      await products.command({
        ...session,
        body: {
          action: "StartSelling",
          operationReference: op(),
          productReference: dish.productReference,
          expectedAggregateVersion: dish.aggregateVersion,
        },
      });

      // 1. Peanuts contained, sesame possible.
      const first = op();
      assert.equal(
        (
          await declare(
            sku,
            [
              { allergenReference: peanut, classification: "Contains" },
              { allergenReference: sesame, classification: "CrossContactPossible" },
            ],
            first,
          )
        ).status,
        "Applied",
      );
      const labels = await read((t) => listStaffDeclaredAllergenSources(t, scope));
      assert.equal(labels.length, 1);
      assert.deepEqual([labels[0].subject, labels[0].skuReference], ["Dish", sku]);
      const item = (await read((t) => listInventoryRecipeIngredientFacts(t, scope))).find(
        (candidate) => candidate.itemReference === labels[0].itemReference,
      );
      assert.deepEqual([item.stockTracked, item.dimension, item.unitCode], [false, "Count", "EA"]);
      const itemRow = (
        await admin.query("SELECT item_type FROM rms_inventory.inventory_item WHERE item_id=$1", [
          item.itemReference,
        ])
      ).rows[0];
      assert.equal(itemRow?.item_type, "FinishedGood");
      const declarations = (
        await admin.query(
          "SELECT declaration_json->>'sourceKind' source,(SELECT jsonb_agg(jsonb_build_array(a.allergen_id::text,a.classification) ORDER BY a.allergen_id) FROM rms_catalog.allergen_source_assertion a WHERE a.evidence_id=e.evidence_id) assertions FROM rms_catalog.allergen_source_evidence e WHERE subject_id=$1",
          [item.itemReference],
        )
      ).rows;
      assert.deepEqual(declarations, [
        {
          source: "StaffDeclaration",
          assertions: [
            [peanut, "Contains"],
            [sesame, "CrossContactPossible"],
          ],
        },
      ]);
      const recipes = await read((t) => listRecipes(t, scope, new Date().toISOString()));
      assert.equal(recipes.length, 1);
      const recipe = recipes[0];
      assert.equal(recipe.familyReference, labels[0].recipeReference);
      assert.equal(recipe.lifecycle, "Published");
      assert.equal(recipe.kitchenInstructions, "Published");
      assert.equal(recipe.standardCostCents, "0");
      assert.match(recipe.name, /Allergens declared by staff/u);
      assert.deepEqual(
        recipe.bindings.map((binding) => [binding.skuReference, binding.storeReference]),
        [[sku, null]],
      );
      const reviews = (
        await admin.query(
          "SELECT subject,review_kind,review_mode,listing_store_id::text s FROM rms_recipe.recipe_authoring_review ORDER BY subject,review_kind",
        )
      ).rows;
      assert.deepEqual(
        reviews.map((r) => [r.subject, r.review_kind, r.review_mode, r.s]),
        [
          ["Preparation", "Cost", "SingleStoreListing", storeReference],
          ["Preparation", "FoodSafety", "SingleStoreListing", storeReference],
          ["Recipe", "Cost", "SingleStoreListing", storeReference],
          ["Recipe", "FoodSafety", "SingleStoreListing", storeReference],
        ],
      );

      // 2. The same allergens again change nothing; new ones publish a revision and rebind it.
      assert.equal(
        (
          await declare(sku, [
            { allergenReference: sesame, classification: "CrossContactPossible" },
            { allergenReference: peanut, classification: "Contains" },
          ])
        ).status,
        "AlreadyApplied",
      );
      assert.equal(
        (await declare(sku, [{ allergenReference: wheat, classification: "Contains" }])).status,
        "Applied",
      );
      const revised = await read((t) => listRecipes(t, scope, new Date().toISOString()));
      const bound = revised.filter((r) => r.bindings.some((b) => b.skuReference === sku));
      assert.equal(bound.length, 1);
      assert.equal(bound[0].familyReference, labels[0].recipeReference);
      assert.equal(bound[0].familyRevision, 2);
      assert.equal((await read((t) => listStaffDeclaredAllergenSources(t, scope))).length, 1);
      // The menu review reads the size's allergens through the generated recipe: wheat now.
      const reviewed = await read((t) =>
        createMenuRecipeAllergenSource({
          brandReference,
          authorize: async () => true,
        }).resolve(t, {
          recipe: {
            actorType: "User",
            actorReference: owner,
            action: "ResolveMenuRecipeFacts",
            purpose: "ReviewMenu",
            brandReference,
            storeReference,
            skuReference: sku,
            observedAt: new Date().toISOString(),
            selections: [],
          },
          registryVersionReference: id(63),
          defaultLocale: "en-CA",
        }),
      );
      assert.deepEqual(
        reviewed.allergens.evidence.map((e) => [e.subjectReference, e.status, e.assertions]),
        [
          [
            item.itemReference,
            "Approved",
            [{ allergenReference: wheat, classification: "Contains" }],
          ],
        ],
      );

      // 3. Kai holds no recipe approval, allergen or inventory permission.
      grants.as(kai);
      await rejects(declare(sku, []), "PermissionDenied");
      grants.as(owner);

      // 4. A second (draft) store: declaring without review is refused.
      await store(id(8), "STORE_TWO", "Draft");
      await rejects(declare(sku, []), "NotSingleStore");
      await admin.query(
        "UPDATE bop_tenant.store SET lifecycle='Archived',version=2 WHERE store_id=$1",
        [id(8)],
      );

      // 5. The label is append-only and names the Brand's own recipe.
      await assert.rejects(
        admin.query("UPDATE rms_recipe.staff_declared_allergen_source SET actor_id=$1", [kai]),
        /append-only staff declared allergen source/u,
      );
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_recipe.staff_declared_allergen_source(brand_id,inventory_item_id,label,subject_kind,sku_id,recipe_id,actor_id,recorded_at,operation_id,audit_id) VALUES($1,$2,'AllergensDeclaredByStaff','Dish',$3,$4,$5,now(),$6,$7)",
          [brandReference, op(), op(), op(), owner, op(), op()],
        ),
        /needs the brand's recipe/u,
      );
    } finally {
      await admin.end();
    }
  });
}, 240_000);
