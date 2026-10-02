import { createCurrentProductStoreRecipePolicySource } from "../../../apps/api/src/current-product-store-recipe-policy.ts";
import { prepareBrandRecipeOverridePublication } from "../test-support/brand-recipe-override-publication.mjs";
import {
  tenantBrandConfigurationRequiredFields,
  tenantBrandConfigurationContentDigest,
} from "../../bop/tenant/src/index.ts";
import { createCurrentProductStoreRecipeResolutionSource } from "../../../apps/api/src/current-product-store-recipe-resolution.ts";
import { createCurrentProductRecipeBindingScopeSource } from "../../../apps/api/src/current-product-recipe-binding-scope.ts";
import {
  recipeReferenceSourceFields,
  createPostgresRecipeReferenceSourceStore,
} from "../../rms/recipe/src/index.ts";
import {
  exerciseProductReferenceHistorySource,
  exerciseProductReferenceHistoryGap,
} from "../test-support/product-reference-history-source.mjs";
import { exerciseProductPricingBindingSource } from "../test-support/product-pricing-binding-source.mjs";
import { exerciseProductListBrowser } from "../test-support/catalog-product-list-browser.mjs";
import { fileURLToPath, URL } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createBrand, createTenantContext } from "../../bop/tenant/src/index.ts";
import { sha256Hex } from "../../bop/audit/src/index.ts";
import {
  CatalogError,
  productPricingBindingCurrentSourceFields,
  createPostgresProductPricingBindingSourceStore,
  CatalogProductListError,
  createPostgresCategoryRepository,
  selectCatalogCategoryProducts,
  createCatalogProductService,
  createPostgresProductCreationStore,
  createPostgresProductDraftStore,
  createPostgresProductLifecycleStore,
  createPostgresProductCategoryAssignmentAuthority,
  createPostgresProductSearchGenerationStore,
  createPostgresCatalogProductListQueryStore,
} from "../../rms/catalog/src/index.ts";
const id = (n) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0");

// Actor, association and field/Phase policy leases are synthetic; SQL, service,
// Category row locks, FK/RLS, Audit/Event/source and generation builder are actual.
it("persists classified Product Versions atomically with held current Category facts and original replay", async () => {
  await withIsolatedDatabase({ caseId: "wp2409_product_class" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const role = "wp2409_class_" + context.runId;
    assert.match(role, /^wp2409_class_[a-f0-9]+$/);
    const at = new Date().toISOString();
    let policyAllowed = true,
      expireAfterWrite = false,
      loseWriteReply = false,
      corruptClassificationRead = false,
      viewFieldsAllowed = true,
      treeFieldsAllowed = true,
      revokeTreeFieldsAfterSource = false,
      revokeViewFieldsAfterSource = false,
      allowedLifecycles = ["Active"],
      counter = 1000,
      sqlCalls = 0,
      phaseAllowed = true;
    let writeHolds = 0,
      readHolds = 0,
      rowLockProbes = 0;
    const commitChecks = new WeakMap();
    const transactions = {
      async run(work) {
        const client = new pg.Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          const tx = {
            async query(sql, values) {
              sqlCalls++;
              const result = await client.query(sql, [...values]);
              if (
                sql.includes("FROM rms_catalog.category WHERE") &&
                sql.endsWith("FOR SHARE") &&
                result.rows.length > 0
              ) {
                await assert.rejects(
                  admin.query(
                    "SELECT category_id FROM rms_catalog.category WHERE category_id=$1 FOR UPDATE NOWAIT",
                    [result.rows[0].category_reference],
                  ),
                  { code: "55P03" },
                );
                rowLockProbes++;
              }
              if (expireAfterWrite && sql.includes("INSERT INTO platform_eventing.outbox_event"))
                policyAllowed = false;
              if (revokeViewFieldsAfterSource && sql.includes("FROM rms_catalog.category c WHERE"))
                viewFieldsAllowed = false;
              if (revokeTreeFieldsAfterSource && sql.includes("FROM rms_catalog.category c WHERE"))
                treeFieldsAllowed = false;
              if (
                corruptClassificationRead &&
                sql.startsWith("SELECT product_id,source_json,row_digest,list_digest FROM")
              )
                return {
                  ...result,
                  rows: result.rows.map((row) => ({
                    ...row,
                    row_digest: "sha256:" + "f".repeat(64),
                  })),
                };
              return result;
            },
          };
          commitChecks.set(tx, []);
          const result = await work(tx);
          for (const check of commitChecks.get(tx)) await check();
          await client.query("COMMIT");
          if (loseWriteReply && result?.action === "Create") {
            loseWriteReply = false;
            throw new Error("synthetic lost reply after actual classified COMMIT");
          }
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      },
    };
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_helpers,platform_audit,platform_eventing TO " +
          role,
      );
      await admin.query("GRANT SELECT ON ALL TABLES IN SCHEMA rms_catalog TO " + role);
      await admin.query(
        "GRANT INSERT,UPDATE,DELETE ON rms_catalog.product,rms_catalog.product_version,rms_catalog.sku,rms_catalog.product_version_category_assignment,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel TO " +
          role,
      );
      await admin.query("GRANT UPDATE ON rms_catalog.category TO " + role); // SELECT FOR SHARE requires UPDATE privilege.
      await admin.query(
        "GRANT INSERT ON rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit,rms_catalog.product_search_generation,rms_catalog.product_search_row TO " +
          role,
      );
      await admin.query(
        "GRANT INSERT,UPDATE ON rms_catalog.product_source_head,rms_catalog.product_search_activation TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT ON platform_audit.audit_record TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head,platform_eventing.consumer_inbox TO " +
          role,
      );
      await admin.query("GRANT INSERT ON platform_eventing.outbox_event TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      await admin.query(
        "GRANT INSERT ON rms_catalog.category,rms_catalog.category_operation_record,rms_catalog.category_operation_snapshot,rms_catalog.category_source_commit TO " +
          role,
      );
      await admin.query("GRANT INSERT,UPDATE ON rms_catalog.category_source_head TO " + role);
      let categoryEvent = 90000;
      const categoryAuthority = {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(input.tenantReference, id(4));
          assert.equal(input.brandReference, id(1));
          assert.equal(input.actorReference, id(3));
          assert.equal(input.requiredFields.length, 15);
          if (!policyAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          commitChecks.get(tx).push(() => {
            if (!policyAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          });
        },
      };
      const categories = createPostgresCategoryRepository({
        tenantReference: id(4),
        brandReference: id(1),
        actorReference: id(3),
        transactions,
        authority: categoryAuthority,
        clock: { now: () => new Date().toISOString() },
        eventReference: () => id(categoryEvent++),
        maximumCategoryNodes: 100,
      });
      const categoryWrite = (aggregate, action, operation) => {
        const record = {
          action,
          operationReference: id(operation),
          operationIntentHash: sha256Hex(JSON.stringify({ action, aggregate })),
          aggregate,
        };
        return {
          record,
          ...(action === "Create"
            ? {}
            : { expectedAggregateVersion: aggregate.aggregateVersion - 1 }),
          audit: {
            auditId: id(operation + 100000),
            brandId: id(1),
            actor: { type: "User", reference: id(3) },
            actionCode: "CATALOG_CATEGORY_" + action.toUpperCase(),
            targetType: "CatalogCategory",
            targetId: aggregate.categoryReference,
            reasonCode: "SYNTHETIC_TEST",
            correlationId: id(operation),
            occurredAt: aggregate.updatedAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "CONFIGURATION_AUDIT",
            retentionPolicyVersion: 1,
          },
        };
      };
      for (const [category, brand, lifecycle, sort] of [
        [10, 1, "Active", 0],
        [11, 1, "Draft", 1],
        [12, 1, "Inactive", 2],
        [13, 2, "Active", 0],
      ]) {
        if (brand === 1) {
          let node = {
            categoryReference: id(category),
            brandReference: id(1),
            internalCode: "CLASS_" + category,
            lifecycle: "Draft",
            aggregateVersion: 1,
            defaultLocale: "en-CA",
            localizedNames: { "en-CA": "Synthetic category " + category },
            localizedDescriptions: {},
            parentCategoryReference: null,
            level: 1,
            sortOrder: sort,
            storeReferences: [],
            createdAt: at,
            createdByActorReference: id(3),
            updatedAt: at,
          };
          await categories.create(categoryWrite(node, "Create", 80000 + category * 10));
          if (lifecycle !== "Draft") {
            node = { ...node, lifecycle: "Active", aggregateVersion: 2 };
            await categories.commit(categoryWrite(node, "ChangeLifecycle", 80001 + category * 10));
            if (lifecycle === "Inactive")
              await categories.commit(
                categoryWrite(
                  { ...node, lifecycle: "Inactive", aggregateVersion: 3 },
                  "ChangeLifecycle",
                  80002 + category * 10,
                ),
              );
          }
        } else {
          await admin.query(
            "INSERT INTO rms_catalog.category(category_id,brand_id,internal_code,lifecycle,aggregate_version,default_locale,localized_names_json,localized_descriptions_json,parent_category_id,tree_level,sort_order,store_ids_json,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,$4,1,'en-CA',$5,'{}',NULL,1,$6,'[]',$7,$8,$7)",
            [
              id(category),
              id(brand),
              "CLASS_" + category,
              lifecycle,
              JSON.stringify({ "en-CA": "Synthetic category " + category }),
              sort,
              at,
              id(3),
            ],
          );
        }
      }
      const tenant = createTenantContext(
        {
          actorType: "User",
          actorReference: id(3),
          accountKind: "Workforce",
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "SingleFactor",
          authenticatedAt: at,
          recentMfaAt: null,
        },
        createBrand({
          brandReference: id(1),
          code: "CLASS",
          displayName: "Synthetic classification",
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
      const assignments = createPostgresProductCategoryAssignmentAuthority({
        tenantReference: id(4),
        brandReference: id(1),
        actorReference: id(3),
        clock: { now: () => at },
        async holdPolicyUntilTransactionCompletes(tx, input) {
          assert.equal(input.brandReference, id(1));
          assert.equal(input.tenantReference, id(4));
          assert.equal(input.actorReference, id(3));
          assert.deepEqual(input.requiredFields, [
            "categoryClassification",
            "categoryReferences",
            "primaryCategoryReference",
          ]);
          if (!policyAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          commitChecks.get(tx).push(() => {
            if (!policyAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
          });
          if (input.purposeCode === "CATALOG_PRODUCT_CATEGORY_MUTATION") writeHolds++;
          else readHolds++;
          return { allowedLifecycles };
        },
      });
      const options = {
        brandReference: id(1),
        transactions,
        categoryAssignments: assignments,
        authorize: async () => true,
      };
      const creation = createPostgresProductCreationStore(options),
        draft = createPostgresProductDraftStore(options),
        lifecycle = createPostgresProductLifecycleStore(options);
      const service = createCatalogProductService({
        references: {
          generate: () => id(counter++),
          hashIntent: (value) => sha256Hex(value),
          equals: (a, b) => a === b,
        },
        authorization: {
          async authorize(input) {
            return {
              tenantContext: tenant,
              permission: {
                effect: "Allow",
                reason: "ROLE_PERMISSION",
                source: "RolePermission",
                action: "catalog.product.manage",
                scopeKind: "Brand",
                policySnapshotReference: id(5),
                policyVersion: 1,
                audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
              },
              audit: {
                auditId: input.operationReference,
                brandId: id(1),
                actor: { type: "User", reference: id(3) },
                actionCode: "CATALOG_PRODUCT_" + input.action.toUpperCase(),
                targetType: "CatalogProduct",
                targetId: input.productReference ?? id(counter),
                beforeSummary: {},
                afterSummary: {},
                reasonCode: "AUTHORIZED_OPERATION",
                correlationId: id(6),
                occurredAt: at,
                sourceChannel: "API",
                dataClassification: "Internal",
                retentionPolicyCode: "AUDIT_DEFAULT",
                retentionPolicyVersion: 1,
              },
            };
          },
        },
        repository: {
          ...creation,
          commit: (input) =>
            input.record.action === "ReplaceDraft" ? draft.commit(input) : lifecycle.commit(input),
        },
        optionSets: { resolveVersion: async () => null },
      });
      const createInput = (operation, categories, primary = null) => ({
        internalCode: "PRODUCT_" + operation,
        productType: "PreparedFood",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic classified Product" },
        taxClassificationReference: null,
        skus: [
          {
            skuCode: "SKU_" + operation,
            localizedNames: { "en-CA": "Synthetic SKU" },
            variantSelections: [],
            unitOfSale: "EACH",
            unitQuantity: "1",
          },
        ],
        operationReference: id(operation),
        requestedAt: at,
        categoryClassification: {
          categoryReferences: categories.map(id),
          primaryCategoryReference: primary === null ? null : id(primary),
        },
      });
      const counts = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_catalog.product) products,(SELECT count(*)::int FROM rms_catalog.product_version_category_assignment) assignments,(SELECT count(*)::int FROM rms_catalog.product_operation_snapshot) snapshots,(SELECT count(*)::int FROM platform_audit.audit_record) audits,(SELECT count(*)::int FROM platform_eventing.outbox_event) events,(SELECT count(*)::int FROM rms_catalog.product_source_commit) commits",
          )
        ).rows[0];
      const empty = await counts();
      for (const categories of [[11], [12], [13], [99]]) {
        await assert.rejects(service.create(createInput(100, categories)), (error) =>
          ["CATALOG_LIFECYCLE_CONFLICT", "CATALOG_DEPENDENCY_UNAVAILABLE"].includes(error.code),
        );
        assert.deepEqual(await counts(), empty);
      }
      allowedLifecycles = ["Draft", "Active"];
      const input = createInput(101, [11, 10], 10);
      const original = await service.create(input);
      assert.deepEqual(original.aggregate.draft.categoryClassification, {
        categoryReferences: [id(10), id(11)],
        primaryCategoryReference: id(10),
      });
      assert.deepEqual(
        await creation.load(original.aggregate.productReference),
        original.aggregate,
      );
      const originalPricingBindings = await exerciseProductPricingBindingSource({
        transactions,
        aggregate: original.aggregate,
        tenantReference: id(4),
      });
      const originalHistory = await exerciseProductReferenceHistorySource({
        transactions,
        aggregate: original.aggregate,
        tenantReference: id(4),
      });
      await exerciseProductReferenceHistoryGap({
        admin,
        role,
        aggregate: original.aggregate,
        tenantReference: id(4),
        id,
      });
      assert.ok(rowLockProbes > 0);
      const rlsCount = (brand, store) =>
        transactions.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brand, store],
          );
          return (
            await tx.query(
              "SELECT count(*)::int count FROM rms_catalog.product_version_category_assignment",
              [],
            )
          ).rows[0].count;
        });
      assert.equal(await rlsCount(id(1), ""), 2);
      assert.equal(await rlsCount(id(2), ""), 0);
      assert.equal(await rlsCount(id(1), id(50)), 0);
      const persisted = await counts();
      assert.deepEqual(persisted, {
        products: 1,
        assignments: 2,
        snapshots: 1,
        audits: empty.audits + 1,
        events: empty.events + 1,
        commits: 1,
      });
      const generationOptions = {
        tenantReference: id(4),
        brandReference: id(1),
        actorReference: id(3),
        transactions,
        authorization: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.deepEqual(input, {
              tenantReference: id(4),
              brandReference: id(1),
              actorReference: id(3),
              purposeCode: input.purposeCode,
              permission: "catalog.manage",
              capability: "catalog.cat_product_list",
              sourceProtocolVersion: 1,
              ...(input.purposeCode === "CATALOG_PRODUCT_CATEGORY_SOURCE_READ"
                ? {
                    requiredClassificationFields: [
                      "categoryClassification",
                      "categoryReferences",
                      "primaryCategoryReference",
                    ],
                  }
                : {}),
              observedAt: input.observedAt,
            });
            assert.ok(
              ["CATALOG_PRODUCT_SEARCH_BUILD", "CATALOG_PRODUCT_CATEGORY_SOURCE_READ"].includes(
                input.purposeCode,
              ),
            );
            if (!policyAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
            commitChecks.get(tx).push(() => {
              if (!policyAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
            });
          },
        },
        clock: { now: () => new Date().toISOString() },
        maximumProducts: 100,
        categorySource: {
          authority: categoryAuthority,
          viewAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(input.tenantReference, id(4));
              assert.equal(input.brandReference, id(1));
              assert.equal(input.actorReference, id(3));
              assert.equal(input.purposeCode, "CATALOG_CATEGORY_PRODUCT_VIEW_READ");
              assert.equal(input.permission, "catalog.manage");
              assert.equal(input.capability, "catalog.cat_category_tree");
              assert.equal(input.referencedCapability, "catalog.cat_product_list");
              assert.deepEqual(input.requiredFields, [
                "productCount",
                "primaryCategoryName",
                "categoryMembership",
                "categoryFilterOptions",
              ]);
              if (!viewFieldsAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              commitChecks.get(tx).push(() => {
                if (!viewFieldsAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              });
            },
          },
          treeAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(input.tenantReference, id(4));
              assert.equal(input.brandReference, id(1));
              assert.equal(input.actorReference, id(3));
              assert.equal(input.purposeCode, "CATALOG_CATEGORY_TREE_VIEW_READ");
              assert.equal(input.permission, "catalog.manage");
              assert.equal(input.capability, "catalog.cat_category_tree");
              assert.equal(input.referencedCapability, "catalog.cat_product_list");
              assert.deepEqual(input.requiredFields, [
                "categoryReference",
                "internalCode",
                "localizedNames",
                "lifecycle",
                "parentCategoryReference",
                "level",
                "sortOrder",
                "aggregateVersion",
                "productCount",
                "source",
              ]);
              if (!treeFieldsAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              commitChecks.get(tx).push(() => {
                if (!treeFieldsAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              });
            },
          },
          maximumCategoryNodes: 100,
          maximumSourceCommits: 100,
        },
      };
      const generationStore = createPostgresProductSearchGenerationStore(generationOptions);
      const generation = await generationStore.rebuild({
        operationReference: id(150),
        actorReference: id(3),
        observedAt: at,
      });
      assert.equal(generation.state, "Current");
      const row = (
        await admin.query(
          "SELECT source_json FROM rms_catalog.product_search_row WHERE generation_id=$1",
          [generation.generation.generationReference],
        )
      ).rows[0];
      assert.deepEqual(
        row.source_json.categoryClassification,
        original.aggregate.draft.categoryClassification,
      );
      const classification = await generationStore.loadClassificationSnapshot();
      assert.equal(classification.products.length, 1);
      assert.deepEqual(
        classification.products[0].categoryClassification,
        original.aggregate.draft.categoryClassification,
      );
      assert.equal(Object.hasOwn(classification.products[0], "createdByActorReference"), false);
      const productListForScope = (scope = { brandReference: id(1), storeReference: null }) =>
        createPostgresCatalogProductListQueryStore({
          runner: transactions,
          scope,
          clock: generationOptions.clock,
          cursorKey: new Uint8Array(32).fill(29), // Explicit isolated synthetic signing configuration.
          categorySource: {
            tenantReference: generationOptions.tenantReference,
            authorization: generationOptions.authorization,
            maximumProducts: generationOptions.maximumProducts,
            categorySource: generationOptions.categorySource,
          },
          authorization: {
            async withAuthorizedProductList(input, work) {
              assert.equal(input.actorReference, id(3));
              assert.equal(input.brandReference, id(1));
              assert.equal(input.storeReference, scope.storeReference);
              assert.equal(input.purposeCode, "CATALOG_PRODUCT_LIST");
              assert.equal(input.permission, "catalog.manage");
              assert.equal(input.capability, "catalog.cat_product_list");
              assert.deepEqual(input.requiredCategoryFields, [
                "category",
                "primaryCategoryReference",
                "primaryCategoryName",
                "categoryMembership",
                "categoryFilterOptions",
              ]);
              if (!policyAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              if (!phaseAllowed) throw new CatalogProductListError("FeatureDisabled");
              const result = await work();
              if (!policyAllowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              return result;
            },
          },
        });
      const productList = productListForScope();
      const listRequest = (extra = {}) => ({
        actorReference: id(3),
        purposeCode: "CATALOG_PRODUCT_LIST",
        locale: "en-CA",
        observedAt: new Date().toISOString(),
        search: null,
        lifecycle: null,
        productType: null,
        limit: 50,
        cursor: null,
        includeArchived: false,
        hasActiveSku: null,
        missingTranslationLocale: null,
        updatedFrom: null,
        updatedUntil: null,
        createdFrom: null,
        createdUntil: null,
        sort: "updatedAt",
        direction: "DESC",
        categoryReference: id(10),
        ...extra,
      });
      assert.deepEqual(
        (await productList.load(listRequest())).items.map((row) => row.productReference),
        [original.aggregate.productReference],
      );
      const primaryView = await productList.load(listRequest());
      assert.equal(primaryView.items[0].category.status, "Known");
      assert.equal(primaryView.items[0].category.primary.categoryReference, id(10));
      assert.equal(
        primaryView.items[0].category.primary.name,
        (await categories.load(id(10))).localizedNames["en-CA"],
      );
      assert.equal(primaryView.items[0].category.matchedCategoryReference, id(10));
      assert.ok(primaryView.items[0].category.source.asOfUtc >= primaryView.projection.asOfUtc);
      assert.equal(
        (await productList.load(listRequest({ categoryReference: id(12) }))).items.length,
        0,
      );
      assert.equal((await productList.load(listRequest({ search: "NO_MATCH" }))).items.length, 0);
      assert.equal((await productList.load(listRequest({ hasActiveSku: true }))).items.length, 0);
      assert.equal((await productList.load(listRequest({ lifecycle: "Active" }))).items.length, 0);
      await assert.rejects(productList.load(listRequest({ categoryReference: id(13) })), {
        code: "Unavailable",
      });
      const combined = await generationStore.loadCategoryProductView();
      assert.equal(combined.unknownClassificationProductCount, 0);
      assert.deepEqual(
        combined.categories.find((node) => node.categoryReference === id(10)).productCount,
        { status: "Known", includingArchived: 1, excludingArchived: 1 },
      );
      assert.deepEqual(
        combined.categories.find((node) => node.categoryReference === id(12)).productCount,
        { status: "Known", includingArchived: 0, excludingArchived: 0 },
      );
      assert.equal(selectCatalogCategoryProducts(combined, id(10)).length, 1);
      viewFieldsAllowed = false;
      await assert.rejects(generationStore.loadCategoryProductView(), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      assert.equal((await generationStore.loadClassificationSnapshot()).products.length, 1);
      await assert.rejects(productList.load(listRequest()), { code: "Denied" });
      viewFieldsAllowed = true;
      const beforeExpiredView = await counts();
      revokeViewFieldsAfterSource = true;
      await assert.rejects(generationStore.loadCategoryProductView(), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      assert.deepEqual(await counts(), beforeExpiredView);
      viewFieldsAllowed = true;
      await assert.rejects(productList.load(listRequest()), { code: "Denied" });
      assert.deepEqual(await counts(), beforeExpiredView);
      revokeViewFieldsAfterSource = false;
      viewFieldsAllowed = true;
      const immutableUpdate = await admin.query(
        "UPDATE rms_catalog.product_search_row SET row_digest=$1 WHERE generation_id=$2",
        ["sha256:" + "f".repeat(64), generation.generation.generationReference],
      );
      assert.equal(immutableUpdate.rowCount, 0);
      assert.deepEqual(
        (await generationStore.loadClassificationSnapshot()).products,
        classification.products,
      );
      corruptClassificationRead = true;
      await assert.rejects(generationStore.loadClassificationSnapshot(), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      corruptClassificationRead = false;
      const changed = await service.replaceDraft({
        productReference: original.aggregate.productReference,
        expectedAggregateVersion: 1,
        draft: {
          ...original.aggregate.draft,
          categoryClassification: {
            categoryReferences: [id(11)],
            primaryCategoryReference: id(11),
          },
        },
        operationReference: id(102),
        requestedAt: at,
      });
      assert.deepEqual(changed.aggregate.draft.categoryClassification, {
        categoryReferences: [id(11)],
        primaryCategoryReference: id(11),
      });
      const changedPricingBindings = await exerciseProductPricingBindingSource({
        transactions,
        aggregate: changed.aggregate,
        tenantReference: id(4),
        request: {
          ...originalPricingBindings.request,
          expectedAggregateVersion: changed.aggregate.aggregateVersion,
        },
      });
      assert.notEqual(changedPricingBindings.digest, originalPricingBindings.digest);
      const changedHistory = await exerciseProductReferenceHistorySource({
        transactions,
        aggregate: changed.aggregate,
        tenantReference: id(4),
        request: {
          ...originalHistory.request,
          expectedAggregateVersion: changed.aggregate.aggregateVersion,
        },
        expectedAggregates: [original.aggregate, changed.aggregate],
      });
      assert.notEqual(changedHistory.digest, originalHistory.digest);
      assert.equal((await counts()).assignments, 1);
      const currentCategory = await categories.load(id(10));
      await categories.commit(
        categoryWrite(
          {
            ...currentCategory,
            lifecycle: "Inactive",
            aggregateVersion: currentCategory.aggregateVersion + 1,
          },
          "ChangeLifecycle",
          81000,
        ),
      );
      await categories.commit(
        categoryWrite(
          {
            ...currentCategory,
            lifecycle: "Archived",
            aggregateVersion: currentCategory.aggregateVersion + 2,
          },
          "ChangeLifecycle",
          81001,
        ),
      );
      await assert.rejects(generationStore.loadClassificationSnapshot(), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      const writesBeforeReplay = writeHolds;
      const replay = await service.create(input);
      assert.equal(replay.status, "AlreadyApplied");
      assert.deepEqual(replay.aggregate, original.aggregate);
      assert.equal(writeHolds, writesBeforeReplay);
      assert.ok(readHolds > 0);
      policyAllowed = false;
      await assert.rejects(service.create(input), { code: "CATALOG_PERMISSION_DENIED" });
      await assert.rejects(creation.load(original.aggregate.productReference), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      policyAllowed = true;
      const beforeExpiry = await counts();
      expireAfterWrite = true;
      await assert.rejects(service.create(createInput(103, [11], 11)), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      assert.deepEqual(await counts(), beforeExpiry);
      expireAfterWrite = false;
      policyAllowed = true;
      const cleared = await service.replaceDraft({
        productReference: changed.aggregate.productReference,
        expectedAggregateVersion: 2,
        draft: {
          ...changed.aggregate.draft,
          categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
        },
        operationReference: id(104),
        requestedAt: at,
      });
      assert.deepEqual(cleared.aggregate.draft.categoryClassification, {
        categoryReferences: [],
        primaryCategoryReference: null,
      });
      const clearedHistory = await exerciseProductReferenceHistorySource({
        transactions,
        aggregate: cleared.aggregate,
        tenantReference: id(4),
        request: {
          ...originalHistory.request,
          expectedAggregateVersion: cleared.aggregate.aggregateVersion,
        },
        expectedAggregates: [original.aggregate, changed.aggregate, cleared.aggregate],
      });
      assert.equal(clearedHistory.configurations.length, 3);
      assert.equal((await counts()).assignments, 0);
      await assert.rejects(
        admin.query(
          "UPDATE rms_catalog.product_version SET category_classification_known=false WHERE product_version_id=$1",
          [cleared.aggregate.draft.versionReference],
        ),
        { code: "23514" },
      );
      await assert.rejects(
        admin.query(
          "UPDATE rms_catalog.product_version SET primary_category_id=$1 WHERE product_version_id=$2",
          [id(11), cleared.aggregate.draft.versionReference],
        ),
        { code: "23503" },
      );
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_catalog.product_version_category_assignment(product_version_id,product_id,brand_id,category_id) VALUES($1,$2,$3,$4)",
          [
            cleared.aggregate.draft.versionReference,
            cleared.aggregate.productReference,
            id(1),
            id(13),
          ],
        ),
        { code: "23503" },
      );
      await assert.rejects(
        createPostgresProductCreationStore({ ...options, categoryAssignments: undefined }).load(
          cleared.aggregate.productReference,
        ),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.deepEqual((await service.create(input)).aggregate, original.aggregate);
      const lostInput = createInput(105, [11], 11);
      loseWriteReply = true;
      await assert.rejects(service.create(lostInput), { code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
      const afterLostReply = await counts();
      const lostReplay = await service.create(lostInput);
      assert.equal(lostReplay.status, "AlreadyApplied");
      assert.deepEqual(
        lostReplay.aggregate.draft.categoryClassification,
        lostInput.categoryClassification,
      );
      assert.deepEqual(await counts(), afterLostReply);
      const second = await service.create(createInput(107, [11], 11));
      await generationStore.rebuild({
        operationReference: id(153),
        actorReference: id(3),
        observedAt: new Date().toISOString(),
      });
      const pageRequest = { categoryReference: id(11), limit: 1 };
      const firstPage = await productList.load(listRequest(pageRequest));
      assert.equal(firstPage.items.length, 1);
      assert.equal(firstPage.hasMore, true);
      const secondPage = await productList.load(
        listRequest({ ...pageRequest, cursor: firstPage.nextCursor }),
      );
      assert.equal(secondPage.hasMore, false);
      assert.deepEqual(
        new Set([...firstPage.items, ...secondPage.items].map((row) => row.productReference)),
        new Set([lostReplay.aggregate.productReference, second.aggregate.productReference]),
      );
      await assert.rejects(
        productList.load(
          listRequest({ ...pageRequest, categoryReference: id(12), cursor: firstPage.nextCursor }),
        ),
        { code: "Invalid" },
      );
      const unfilteredPage = await productList.load(
        listRequest({ categoryReference: null, limit: 1 }),
      );
      assert.equal(unfilteredPage.hasMore, true);
      const knownEmpty = (
        await productList.load(listRequest({ categoryReference: null }))
      ).items.find((row) => row.productReference === cleared.aggregate.productReference);
      assert.equal(knownEmpty.category.status, "Known");
      assert.equal(knownEmpty.category.primary, null);
      assert.equal(knownEmpty.category.matchedCategoryReference, null);
      const category11 = await categories.load(id(11));
      await categories.commit(
        categoryWrite(
          { ...category11, lifecycle: "Active", aggregateVersion: category11.aggregateVersion + 1 },
          "ChangeLifecycle",
          81002,
        ),
      );
      // Product generation remains Current; only Category source revision/digest changed.
      await assert.rejects(
        productList.load(listRequest({ ...pageRequest, cursor: firstPage.nextCursor })),
        { code: "Stale" },
      );
      await assert.rejects(
        productList.load(
          listRequest({ categoryReference: null, limit: 1, cursor: unfilteredPage.nextCursor }),
        ),
        { code: "Stale" },
      );
      assert.equal(
        (await productList.load(listRequest({ ...pageRequest, limit: 50 }))).items.length,
        2,
      );
      const tree = await generationStore.loadCategoryTreeView("fr-CA");
      assert.equal(tree.classificationCoverage, "Known");
      assert.equal(tree.items.length, 3);
      const tree11 = tree.items.find((item) => item.categoryReference === id(11));
      assert.equal(tree11.name, "Synthetic category 11");
      assert.equal(tree11.nameLocale, "en-CA");
      assert.equal(tree11.localeFallback, true);
      assert.deepEqual(tree11.productCount, {
        status: "Known",
        includingArchived: 2,
        excludingArchived: 2,
      });
      assert.ok(tree.items.every((item) => item.menuUse.status === "Unavailable"));
      assert.equal(
        tree.source.category.revision,
        (await generationStore.loadCategoryProductView()).categorySource.revision,
      );
      const treeFilters = {
        search: null,
        lifecycle: null,
        productUsage: null,
        includeArchivedProducts: false,
      };
      const usedTree = await generationStore.loadCategoryTreeQuery("fr-CA", {
        ...treeFilters,
        search: "ＣＬＡＳＳ_１１",
        lifecycle: "Active",
        productUsage: "Used",
      });
      assert.deepEqual(usedTree.matchedCategoryReferences, [id(11)]);
      assert.equal(usedTree.tree.items.length, 3);
      assert.deepEqual(
        (
          await generationStore.loadCategoryTreeQuery("en-CA", {
            ...treeFilters,
            productUsage: "Empty",
          })
        ).matchedCategoryReferences,
        [id(10), id(12)],
      );
      assert.deepEqual(
        (
          await generationStore.loadCategoryTreeQuery("en-CA", {
            ...treeFilters,
            search: "CLASS_11",
            lifecycle: "Inactive",
          })
        ).matchedCategoryReferences,
        [],
      );
      treeFieldsAllowed = false;
      await assert.rejects(generationStore.loadCategoryTreeView("en-CA"), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      assert.equal((await generationStore.loadCategoryProductView()).categories.length, 3);
      treeFieldsAllowed = true;
      revokeTreeFieldsAfterSource = true;
      const beforeRevokedTree = await counts();
      await assert.rejects(
        generationStore.loadCategoryTreeQuery("en-CA", { ...treeFilters, productUsage: "Used" }),
        {
          code: "CATALOG_PERMISSION_DENIED",
        },
      );
      assert.deepEqual(await counts(), beforeRevokedTree);
      revokeTreeFieldsAfterSource = false;
      treeFieldsAllowed = true;
      const completeOptions = await productList.load(listRequest({ categoryReference: null }));
      assert.equal(completeOptions.categoryOptions.status, "Known");
      assert.deepEqual(
        new Set(completeOptions.categoryOptions.items.map((item) => item.categoryReference)),
        new Set([id(10), id(11), id(12)]),
      );
      assert.deepEqual(
        completeOptions.categoryOptions.items.map((item) => [item.internalCode, item.lifecycle]),
        [
          ["CLASS_10", "Archived"],
          ["CLASS_11", "Active"],
          ["CLASS_12", "Inactive"],
        ],
      );
      await exerciseProductListBrowser({
        root: fileURLToPath(new URL("../../../", import.meta.url)),
        store: productListForScope,
        request: (filters) => listRequest({ categoryReference: null, ...filters }),
        reference: (n) => (n === 2 ? id(1) : n === 3 ? id(20) : n === 30 ? id(21) : id(n)),
        getSqlCalls: () => sqlCalls,
        setAllowed: (value) => {
          policyAllowed = value;
        },
        setPhase: (value) => {
          phaseAllowed = value;
        },
        async journey({ page, expect, directory }) {
          const selector = page.getByLabel("Category", { exact: true });
          const apply = page.getByRole("button", { name: "Apply filters", exact: true });
          await expect(page.getByText("3 on this page", { exact: false })).toBeVisible();
          await expect(selector).toBeEnabled();
          await expect(selector.locator("option")).toHaveText([
            "All categories",
            "Synthetic category 10 (CLASS_10)",
            "Synthetic category 11 (CLASS_11)",
            "Synthetic category 12 (CLASS_12)",
          ]);
          await selector.selectOption(id(11));
          await apply.click();
          await expect(page.getByText("2 on this page", { exact: false })).toBeVisible();
          await expect(page.getByRole("rowheader")).toHaveCount(2);
          await expect(page.locator(".product-list-table tbody")).not.toContainText("PRODUCT_101");
          await page.screenshot({
            path: path.join(directory, "category-selector-filtered-1440.png"),
            fullPage: true,
          });
          await selector.selectOption(id(12));
          await apply.click();
          await expect(page.getByText("0 on this page", { exact: false })).toBeVisible();
          await expect(selector).toBeEnabled();
          await expect(selector.locator("option")).toHaveCount(4);
          await selector.selectOption(id(11));
          await apply.click();
          await expect(page.getByText("2 on this page", { exact: false })).toBeVisible();
          const search = page.getByLabel("Product / code / SKU", { exact: true });
          await search.fill("NO_SYNTHETIC_MATCH");
          await apply.click();
          await expect(page.getByText("0 on this page", { exact: false })).toBeVisible();
          await expect(
            page.getByRole("heading", { name: "No products", exact: true }),
          ).toBeVisible();
          await expect(selector).toHaveValue(id(11));
          await search.fill("");
          await apply.click();
          await expect(page.getByText("2 on this page", { exact: false })).toBeVisible();
          viewFieldsAllowed = false;
          await page.getByRole("button", { name: "Refresh products" }).click();
          await expect(
            page.getByRole("heading", { name: "Permission denied", exact: true }),
          ).toBeVisible();
          await expect(page.getByRole("rowheader")).toHaveCount(0);
          await expect(selector).toBeEnabled();
          await expect(selector.locator("option")).toHaveText([
            "All categories",
            "Current category filter",
          ]);
          await selector.selectOption("");
          await expect(selector).toBeDisabled();
          viewFieldsAllowed = true;
          await apply.click();
          await expect(page.getByText("3 on this page", { exact: false })).toBeVisible();
          await expect(selector).toBeEnabled();
          for (const width of [390, 320]) {
            await page.setViewportSize({ width, height: 900 });
            await selector.selectOption(id(11));
            await apply.click();
            await expect(page.getByText("2 on this page", { exact: false })).toBeVisible();
            const extent = await page.evaluate(() => ({
              width: globalThis.innerWidth,
              scroll: globalThis.document.documentElement.scrollWidth,
            }));
            assert.ok(extent.scroll <= extent.width, "category selector reflows at" + width);
            await page.screenshot({
              path: path.join(directory, "category-selector-filtered-" + width + ".png"),
              fullPage: true,
            });
          }
          const text = await page.locator("body").innerText();
          for (const reference of [id(3), id(4), id(10), id(11), id(12), id(20)])
            assert.equal(text.includes(reference), false);
        },
      });
      const legacyInput = { ...createInput(106, []) };
      delete legacyInput.categoryClassification;
      const legacy = await service.create(legacyInput);
      assert.equal(Object.hasOwn(legacy.aggregate.draft, "categoryClassification"), false);
      const legacyHistory = await exerciseProductReferenceHistorySource({
        transactions,
        aggregate: legacy.aggregate,
        tenantReference: id(4),
      });
      assert.equal(legacyHistory.configurations[0].categoryCoverage, "Unavailable");
      await exerciseProductPricingBindingSource({
        transactions,
        aggregate: legacy.aggregate,
        tenantReference: id(4),
      });
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_catalog.product_version_category_assignment(product_version_id,product_id,brand_id,category_id) VALUES($1,$2,$3,$4)",
          [
            legacy.aggregate.draft.versionReference,
            legacy.aggregate.productReference,
            id(1),
            id(11),
          ],
        ),
        { code: "23503" },
      );
      assert.equal(
        Object.hasOwn(
          (await creation.load(legacy.aggregate.productReference)).draft,
          "categoryClassification",
        ),
        false,
      );
      await generationStore.rebuild({
        operationReference: id(152),
        actorReference: id(3),
        observedAt: new Date().toISOString(),
      });
      const mixed = await generationStore.loadCategoryProductView();
      assert.equal(mixed.unknownClassificationProductCount, 1);
      const mixedTree = await generationStore.loadCategoryTreeView("en-CA");
      assert.equal(mixedTree.classificationCoverage, "Unavailable");
      assert.equal(mixedTree.items.length, 3);
      assert.ok(mixedTree.items.every((item) => item.productCount.status === "Unavailable"));
      assert.deepEqual(
        (
          await generationStore.loadCategoryTreeQuery("en-CA", {
            ...treeFilters,
            search: "CLASS_11",
          })
        ).matchedCategoryReferences,
        [id(11)],
      );
      for (const usage of ["Empty", "Used"])
        await assert.rejects(
          generationStore.loadCategoryTreeQuery("en-CA", { ...treeFilters, productUsage: usage }),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
      assert.ok(mixed.categories.every((node) => node.productCount.status === "Unavailable"));
      assert.throws(() => selectCatalogCategoryProducts(mixed, id(11)), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      await assert.rejects(productList.load(listRequest({ categoryReference: id(11) })), {
        code: "Unavailable",
      });
      const mixedList = await productList.load(listRequest({ categoryReference: null }));
      assert.equal(mixedList.items.length, 4);
      assert.equal(mixedList.categoryOptions.status, "Unavailable");
      assert.equal(
        mixedList.items.find((row) => row.productReference === legacy.aggregate.productReference)
          .category.status,
        "Unavailable",
      );
      assert.equal(
        mixedList.items.find((row) => row.productReference === cleared.aggregate.productReference)
          .category.status,
        "Known",
      );
      policyAllowed = false;
      await assert.rejects(generationStore.loadCategoryProductView(), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      policyAllowed = true;
      await exerciseProductListBrowser({
        root: fileURLToPath(new URL("../../../", import.meta.url)),
        store: productListForScope,
        request: (filters) => listRequest({ categoryReference: null, ...filters }),
        reference: (n) => (n === 2 ? id(1) : n === 3 ? id(20) : n === 30 ? id(21) : id(n)),
        getSqlCalls: () => sqlCalls,
        setAllowed: (value) => {
          policyAllowed = value;
        },
        setPhase: (value) => {
          phaseAllowed = value;
        },
        async journey({ page, context, expect, directory, openNativeZoom }) {
          await expect(page.getByText("4 on this page", { exact: false })).toBeVisible();
          await expect(page.locator(".product-list-boundary")).toContainText(
            "Primary categories are shown where available",
          );
          await expect(page.locator(".product-list-boundary")).not.toContainText("Category, menus");
          await expect(page.getByLabel("Category", { exact: true })).toBeDisabled();
          await expect(page.getByLabel("Category", { exact: true }).locator("option")).toHaveText([
            "Unavailable",
          ]);
          const legacyRow = page
            .locator(".product-list-table tbody tr")
            .filter({ hasText: "PRODUCT_106" });
          const clearedRow = page
            .locator(".product-list-table tbody tr")
            .filter({ hasText: "PRODUCT_101" });
          const classifiedRow = page
            .locator(".product-list-table tbody tr")
            .filter({ hasText: "PRODUCT_107" });
          await expect(legacyRow.locator("td").nth(1)).toHaveText("Unavailable");
          await expect(clearedRow.locator("td").nth(1)).toContainText("Primary category not set");
          await expect(classifiedRow.locator("td").nth(1)).toContainText("Synthetic category 11");
          await expect(classifiedRow.locator("td").nth(1)).toContainText("Draft classification");
          const body = await page.locator("body").innerText();
          for (const privateReference of [id(3), id(4), id(11), id(20)])
            assert.equal(body.includes(privateReference), false);
          for (const width of [1440, 390, 320]) {
            await page.setViewportSize({ width, height: 900 });
            const extent = await page.evaluate(() => ({
              width: globalThis.innerWidth,
              scroll: globalThis.document.documentElement.scrollWidth,
            }));
            assert.ok(extent.scroll <= extent.width, "classified page reflows at" + width);
            if (width < 1000) {
              await expect(
                page.locator(".product-list-card").filter({ hasText: "PRODUCT_107" }),
              ).toContainText("Synthetic category 11");
              await expect(
                page.locator(".product-list-card").filter({ hasText: "PRODUCT_101" }),
              ).toContainText("Primary category not set");
              await expect(
                page.locator(".product-list-card").filter({ hasText: "PRODUCT_106" }),
              ).not.toContainText("Primary category not set");
            }
            await page.evaluate(() => globalThis.scrollTo(0, 0));
            await page.screenshot({
              path: path.join(directory, "classified-product-list-" + width + ".png"),
              fullPage: true,
            });
          }
          const { page: zoomPage, setNativeZoom, captureNativeZoom } = await openNativeZoom();
          await expect(zoomPage.getByText("4 on this page", { exact: false })).toBeVisible();
          assert.equal(await setNativeZoom(), 2);
          const zoom = await zoomPage.evaluate(() => ({
            width: globalThis.innerWidth,
            scroll: globalThis.document.documentElement.scrollWidth,
            dpr: globalThis.devicePixelRatio,
          }));
          assert.equal(zoom.width, 720);
          assert.equal(zoom.dpr, 2);
          assert.ok(zoom.scroll <= zoom.width);
          await expect(
            zoomPage.locator(".product-list-card").filter({ hasText: "PRODUCT_107" }),
          ).toContainText("Synthetic category 11");
          await captureNativeZoom(
            path.join(directory, "classified-product-list-native-200percent.png"),
          );
          await page.setViewportSize({ width: 1440, height: 900 });
          viewFieldsAllowed = false;
          await page.getByRole("button", { name: "Refresh products" }).click();
          await expect(
            page.getByRole("heading", { name: "Permission denied", exact: true }),
          ).toBeVisible();
          await expect(page.getByRole("rowheader")).toHaveCount(0);
          viewFieldsAllowed = true;
          await page.getByRole("button", { name: "Refresh products" }).click();
          await expect(page.getByText("4 on this page", { exact: false })).toBeVisible();
          await context.setOffline(true);
          await expect(page.getByRole("heading", { name: "Offline", exact: true })).toBeVisible();
          await expect(page.getByRole("rowheader")).toHaveCount(0);
          await context.setOffline(false);
          await expect(page.getByText("4 on this page", { exact: false })).toBeVisible();
        },
      });
      // Milestone61: actual current Product graph plus owning Recipe binding periods.
      await admin.query("GRANT USAGE ON SCHEMA rms_recipe TO " + role);
      const columns61 = {
        recipe: ["recipe_id", "brand_id", "aggregate_version", "current_version_id", "updated_at"],
        recipe_version: [
          "recipe_version_id",
          "recipe_id",
          "brand_id",
          "version_number",
          "snapshot_digest",
          "lifecycle",
          "effective_from",
          "effective_until",
          "effective_time_zone",
          "created_at",
        ],
        recipe_modifier_version: [
          "rule_version_id",
          "rule_id",
          "brand_id",
          "version",
          "recipe_id",
          "recipe_version_id",
          "binding_id",
          "option_id",
          "selected_quantity",
          "lifecycle",
          "rule_digest",
          "effective_from",
          "effective_until",
          "occurred_at",
        ],
        recipe_reference_generation: ["brand_id", "generation", "binding_count"],
        recipe_reference_binding: [
          "recipe_scope_binding_id",
          "recipe_version_id",
          "recipe_id",
          "brand_id",
          "sku_id",
          "store_id",
          "option_binding_id",
          "effective_from",
          "effective_until",
        ],
      };
      for (const [table, columns] of Object.entries(columns61))
        await admin.query(`GRANT SELECT(${columns.join(",")}) ON rms_recipe.${table} TO ${role}`);
      await admin.query("GRANT UPDATE(updated_at) ON rms_recipe.recipe TO " + role);
      const past61 = "2026-08-01T12:00:00.000Z",
        digest61 = "sha256:" + "a".repeat(64);
      await admin.query(
        "INSERT INTO rms_recipe.recipe(recipe_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_SCOPE61',1,$3,$4,$3)",
        [id(33000), id(1), past61, id(3)],
      );
      await admin.query(
        "INSERT INTO rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id,version_number,snapshot_digest,lifecycle,display_name_code,yield_quantity_microunits,yield_unit_code,yield_dimension,preparation_version_id,effective_from,effective_time_zone,created_at) VALUES($1,$2,$3,1,$4,'Published','SYNTHETIC_SCOPE61',3000000,'PORTION','Count',$5,$6,'America/Toronto',$6)",
        [id(33001), id(33000), id(1), digest61, id(33002), past61],
      );
      await admin.query(
        "UPDATE rms_recipe.recipe SET current_version_id=$1,aggregate_version=2 WHERE recipe_id=$2",
        [id(33001), id(33000)],
      );
      await admin.query(
        "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,option_binding_id,effective_from) VALUES($1,$2,$3,$4,$5,NULL,NULL,$6)",
        [
          id(33010),
          id(33001),
          id(33000),
          id(1),
          legacy.aggregate.draft.skus[0].skuReference,
          past61,
        ],
      );
      const request61 = {
        purposeCode: "CATALOG_LIFECYCLE_REVIEW",
        brandReference: id(1),
        actorReference: id(3),
        productReference: legacy.aggregate.productReference,
        skuReference: null,
        operationReference: id(33020),
        expectedAggregateVersion: legacy.aggregate.aggregateVersion,
        originalProductVersionReference: legacy.aggregate.draft.versionReference,
        beforeLifecycle: legacy.aggregate.lifecycle,
        targetLifecycle: "Archived",
        reasonCode: "SYNTHETIC_SCOPE61",
        activeSkuCount: 0,
      };
      let offset61 = 0,
        catalogAllowed61 = true,
        recipeAllowed61 = true,
        actual61;
      const now61 = () => new Date(Date.now() + offset61).toISOString();
      const provider61 = () =>
        createCurrentProductRecipeBindingScopeSource({
          tenantReference: id(4),
          brandReference: id(1),
          actorReference: id(3),
          clock: { now: now61 },
          catalogAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(tx, actual61);
              assert.equal(input.tenantReference, id(4));
              assert.deepEqual(input.request, request61);
              assert.deepEqual(input.requiredFields, productPricingBindingCurrentSourceFields);
              if (!catalogAllowed61) throw new Error("synthetic Catalog fields revoked");
            },
          },
          recipeAuthority: {
            async holdUntilTransactionCompletes(tx, input) {
              assert.equal(tx, actual61);
              assert.equal(input.tenantReference, id(4));
              assert.deepEqual(input.requiredFields, recipeReferenceSourceFields);
              assert.equal(input.permission, "recipe.manage");
              if (!recipeAllowed61) throw new Error("synthetic Recipe fields revoked");
            },
          },
        });
      const input61 = () => {
        const observedAt = now61();
        return {
          request: request61,
          observedAt,
          validUntil: new Date(Date.parse(observedAt) + 30000).toISOString(),
          activationAt: new Date(Date.parse(observedAt) + 15000).toISOString(),
        };
      };
      const tables61 = [
        "rms_catalog.product",
        "rms_catalog.product_version",
        "rms_catalog.sku",
        "rms_catalog.product_option_binding",
        "rms_catalog.product_option_binding_option",
        "rms_catalog.product_option_binding_sku_scope",
        "rms_catalog.product_option_binding_channel",
        "rms_catalog.product_operation_record",
        "rms_catalog.product_operation_snapshot",
        "rms_catalog.product_source_head",
        "rms_catalog.product_source_commit",
        "rms_recipe.recipe",
        "rms_recipe.recipe_version",
        "rms_recipe.recipe_scope_binding",
        "rms_recipe.recipe_modifier_version",
        "rms_recipe.recipe_reference_generation",
        "rms_recipe.recipe_reference_binding",
        "platform_audit.audit_record",
        "platform_audit.audit_chain_head",
        "platform_eventing.outbox_event",
      ];
      const take61 = async () => {
        const snapshots = {};
        for (const table of tables61)
          snapshots[table] = (
            await admin.query(
              "SELECT to_jsonb(t) row FROM " + table + " t ORDER BY to_jsonb(t)::text",
            )
          ).rows;
        return snapshots;
      };
      const catalogAuthority61 = {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(tx, actual61);
          assert.deepEqual(input.requiredFields, productPricingBindingCurrentSourceFields);
        },
      };
      await transactions.run(async (tx) => {
        actual61 = tx;
        const current = await createPostgresProductPricingBindingSourceStore({
          tenantReference: id(4),
          brandReference: id(1),
          actorReference: id(3),
          clock: { now: now61 },
          transactions: { run: (work) => work(tx) },
          authority: catalogAuthority61,
        }).withCurrentSnapshot(request61, async (value) => value);
        assert.equal(current.skuReferences.length, 1);
      });
      await transactions.run(async (tx) => {
        actual61 = tx;
        const current = await createPostgresRecipeReferenceSourceStore({
          tenantReference: id(4),
          brandReference: id(1),
          actorReference: id(3),
          clock: { now: now61 },
          transactions: { run: (work) => work(tx) },
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              assert.equal(actual, tx);
              assert.deepEqual(input.requiredFields, recipeReferenceSourceFields);
            },
          },
        }).withCurrentSnapshot(
          {
            purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
            brandReference: id(1),
            actorReference: id(3),
            operationReference: id(33020),
            catalogIntentDigest: digest61,
          },
          async (value) => value,
        );
        assert.equal(current.bindings.length, 1);
      });
      const baseline61 = await take61();
      await transactions.run(async (tx) => {
        actual61 = tx;
        const scope = await provider61().withCurrentScope(tx, input61(), async (value) => value);
        assert.equal(scope.sourceAuthority, "CurrentProductDraftAndRecipeStoredScope");
        assert.equal(scope.recipe.decision, "PassForStoredMembershipAndPeriods");
        assert.equal(scope.recipe.bindingChecks.length, 1);
        assert.equal(
          scope.recipe.bindingChecks[0].skuReference,
          legacy.aggregate.draft.skus[0].skuReference,
        );
        assert.equal(scope.recipe.bindingChecks[0].status, "CurrentStoredMembershipAndPeriods");
        assert.equal(scope.recipe.uniqueRecipeResolution, "NotEvaluated");
      });
      assert.deepEqual(await take61(), baseline61);
      // No Ingredient/prose/allergen/yield/private preparation access is introduced.
      await assert.rejects(
        transactions.run(async (tx) => {
          actual61 = tx;
          return tx.query("SELECT yield_quantity_microunits FROM rms_recipe.recipe_version", []);
        }),
        { code: "42501" },
      );
      for (const kind of [
        "catalog-fields",
        "recipe-fields",
        "expiry",
        "backward",
        "recipe-generation",
        "catalog-revision",
        "catalog-graph",
      ]) {
        offset61 = 0;
        catalogAllowed61 = recipeAllowed61 = true;
        let reached61 = false,
          armed61 = false,
          callbackError61;
        await assert.rejects(
          transactions.run(async (tx) => {
            actual61 = tx;
            return provider61().withCurrentScope(tx, input61(), async (scope) => {
              reached61 = true;
              try {
                // Independent controlled tentative root write: a different Product cannot
                // mask the target-specific re-read or owning Recipe generation probe.
                const marker = await tx.query(
                  "UPDATE rms_catalog.product SET aggregate_version=aggregate_version+1 WHERE brand_id=$1 AND product_id=$2",
                  [id(1), original.aggregate.productReference],
                );
                assert.equal(marker.rowCount, 1);
                if (kind === "catalog-fields") catalogAllowed61 = false;
                if (kind === "recipe-fields") recipeAllowed61 = false;
                if (kind === "expiry") offset61 = Date.parse(scope.validUntil) - Date.now();
                if (kind === "backward")
                  offset61 = Date.parse(scope.originalObservedAt) - Date.now() - 1000;
                if (kind === "recipe-generation") {
                  const before = (
                    await tx.query(
                      "SELECT generation::text FROM rms_recipe.recipe_reference_generation WHERE brand_id=$1",
                      [id(1)],
                    )
                  ).rows[0].generation;
                  const result = await tx.query(
                    "UPDATE rms_recipe.recipe SET updated_at=updated_at+interval '1 millisecond' WHERE recipe_id=$1 AND brand_id=$2",
                    [id(33000), id(1)],
                  );
                  assert.equal(result.rowCount, 1);
                  assert.notEqual(
                    (
                      await tx.query(
                        "SELECT generation::text FROM rms_recipe.recipe_reference_generation WHERE brand_id=$1",
                        [id(1)],
                      )
                    ).rows[0].generation,
                    before,
                  );
                }
                if (kind === "catalog-revision") {
                  const result = await tx.query(
                    "UPDATE rms_catalog.product SET aggregate_version=aggregate_version+1 WHERE brand_id=$1 AND product_id=$2",
                    [id(1), legacy.aggregate.productReference],
                  );
                  assert.equal(result.rowCount, 1);
                }
                if (kind === "catalog-graph") {
                  const result = await tx.query(
                    "INSERT INTO rms_catalog.sku(sku_id,product_id,product_version_id,brand_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,'SYNTHETIC_SCOPE_EXTRA61','Draft',$6::jsonb,'[]',$7,'EACH',1,$5,$8)",
                    [
                      id(33099),
                      legacy.aggregate.productReference,
                      legacy.aggregate.draft.versionReference,
                      id(1),
                      at,
                      JSON.stringify({ "en-CA": "Synthetic" }),
                      "sha256:" + "b".repeat(64),
                      id(3),
                    ],
                  );
                  assert.equal(result.rowCount, 1);
                }
                armed61 = true;
                return "tentative";
              } catch (error) {
                callbackError61 = error;
                throw error;
              }
            });
          }),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
        if (callbackError61) throw callbackError61;
        assert.equal(reached61, true, kind + " reached");
        assert.equal(armed61, true, kind + " armed");
        assert.deepEqual(await take61(), baseline61, kind + " exact20-table rollback");
      }
      offset61 = 0;
      catalogAllowed61 = recipeAllowed61 = true;
      // Milestone62: actual owning current registered Store and unique base Recipe selection.
      await admin.query(
        "INSERT INTO bop_tenant.brand VALUES ($1,'SYNTHETIC_SCOPE62','Synthetic Brand','en-CA','CAD','Active',1,$2,$2)",
        [id(1), past61],
      );
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'SYNTHETIC_SCOPE62','Synthetic Store','America/Toronto','en-CA','CAD','Active',1,$3,$3)",
        [id(34000), id(1), past61],
      );
      await admin.query("GRANT USAGE ON SCHEMA bop_tenant TO " + role);
      for (const [table, columns] of Object.entries({
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
      }))
        await admin.query(`GRANT SELECT(${columns.join(",")}) ON bop_tenant.${table} TO ${role}`);
      await admin.query(
        "GRANT UPDATE(lifecycle,version,updated_at) ON bop_tenant.brand,bop_tenant.store TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT(store_id,brand_id,lifecycle,version,updated_at) ON bop_tenant.store TO " +
          role,
      );
      await admin.query("GRANT INSERT ON rms_recipe.recipe_scope_binding TO " + role);
      let storeAllowed62 = true,
        storeHeld62 = false,
        actual62,
        offset62 = 0;
      const now62 = () => new Date(Date.now() + offset62).toISOString();
      const provider62 = () =>
        createCurrentProductStoreRecipeResolutionSource({
          tenantReference: id(4),
          brandReference: id(1),
          actorReference: id(3),
          clock: { now: now62 },
          catalogAuthority: {
            async holdUntilTransactionCompletes(tx, value) {
              assert.equal(tx, actual62);
              assert.deepEqual(value.requiredFields, productPricingBindingCurrentSourceFields);
              assert.equal(value.tenantReference, id(4));
              assert.deepEqual(value.request, request61);
            },
          },
          recipeAuthority: {
            async holdUntilTransactionCompletes(tx, value) {
              assert.equal(tx, actual62);
              assert.deepEqual(value.requiredFields, recipeReferenceSourceFields);
              assert.equal(value.tenantReference, id(4));
              assert.equal(value.permission, "recipe.manage");
            },
          },
          // Full Brand field/session/Tenant holder is synthetic; complete owning metadata SQL is actual.
          storeAuthority: {
            async withCurrentBrandReferenceRead(r, work) {
              assert.equal(r.brandReference, id(1));
              assert.equal(r.actorReference, id(3));
              assert.equal(r.purposeCode, "CATALOG_PRODUCT_RECIPE_STORE_RESOLUTION");
              assert.equal(storeHeld62, false);
              if (!storeAllowed62) throw new Error("synthetic Store fields revoked");
              storeHeld62 = true;
              try {
                return await work();
              } finally {
                storeHeld62 = false;
              }
            },
            async isCurrent(tx, r) {
              assert.equal(tx, actual62);
              assert.equal(r.brandReference, id(1));
              assert.equal(storeHeld62, true);
              return storeAllowed62;
            },
          },
        });
      const input62 = () => {
        const observedAt = now62();
        return {
          request: request61,
          observedAt,
          validUntil: new Date(Date.parse(observedAt) + 30000).toISOString(),
          activationAt: new Date(Date.parse(observedAt) + 15000).toISOString(),
          storeReference: id(34000),
        };
      };
      const tables62 = [
        ...tables61,
        "bop_tenant.brand",
        "bop_tenant.store",
        "bop_tenant.store_reference_generation",
        "bop_tenant.store_reference_projection",
      ];
      const take62 = async () => {
        const snapshots = {};
        for (const table of tables62)
          snapshots[table] = (
            await admin.query(
              "SELECT to_jsonb(t) row FROM " + table + " t ORDER BY to_jsonb(t)::text",
            )
          ).rows;
        return snapshots;
      };
      const before62 = await take62();
      await transactions.run(async (tx) => {
        actual62 = tx;
        const a = await provider62().withCurrentResolution(tx, input62(), async (v) => v);
        assert.equal(a.recipe.decision, "PassForDirectBrandAndStoreBindings");
        assert.equal(a.recipe.resolutions[0].recipeVersionReference, id(33001));
        assert.equal(a.recipe.resolutions[0].source, "BrandDefault");
        assert.equal(a.recipe.storeVersion, "1");
        assert.equal(a.recipe.storeGroupResolution, "NotSupportedBySource");
        assert.equal(a.recipe.eligibility, "NotEvaluated");
      });
      assert.deepEqual(await take62(), before62, "actual current Brand selection writes nothing");
      await transactions.run(async (tx) => {
        actual62 = tx;
        const a = await provider62().withCurrentResolution(
          tx,
          { ...input62(), storeReference: id(34099) },
          async (v) => v,
        );
        assert.equal(a.recipe.resolutions[0].status, "UnknownStore");
        assert.equal(a.recipe.resolutions[0].recipeVersionReference, null);
      });
      for (const [n, store, expected] of [
        [34010, null, "AmbiguousRecipeBinding"],
        [34011, id(34000), "OverridePolicyUnavailable"],
      ]) {
        let armed = false;
        await assert.rejects(
          transactions.run(async (tx) => {
            actual62 = tx;
            await tx.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
              [id(1), store ?? ""],
            );
            const inserted = await tx.query(
              "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,option_binding_id,effective_from) VALUES($1,$2,$3,$4,$5,$6,NULL,$7)",
              [
                id(n),
                id(33001),
                id(33000),
                id(1),
                legacy.aggregate.draft.skus[0].skuReference,
                store,
                "2026-08-01T12:00:00.001Z",
              ],
            );
            assert.equal(inserted.rowCount, 1);
            const a = await provider62().withCurrentResolution(tx, input62(), async (v) => v);
            assert.equal(a.recipe.resolutions[0].status, expected);
            assert.equal(a.recipe.resolutions[0].recipeVersionReference, null);
            armed = true;
            throw new Error("SYNTHETIC_SCOPE62_ROLLBACK");
          }),
          { message: "SYNTHETIC_SCOPE62_ROLLBACK" },
        );
        assert.equal(armed, true, expected + " actual selection reached");
        assert.deepEqual(await take62(), before62, expected + " exact24-table rollback");
      }
      // These controlled probe writes are fixtures, not owning Commands or publication evidence.
      for (const kind of [
        "Store fields",
        "Store generation",
        "Brand lifecycle",
        "expiry",
        "backward",
        "query",
        "Catalog graph",
        "Recipe generation",
      ]) {
        storeAllowed62 = true;
        offset62 = 0;
        let reached = false,
          armed = false,
          callbackError;
        await assert.rejects(
          transactions.run(async (tx) => {
            actual62 = tx;
            return provider62().withCurrentResolution(tx, input62(), async (scope) => {
              reached = true;
              try {
                const marker = await tx.query(
                  "UPDATE rms_catalog.product SET aggregate_version=aggregate_version+1 WHERE brand_id=$1 AND product_id=$2",
                  [id(1), original.aggregate.productReference],
                );
                assert.equal(marker.rowCount, 1);
                if (kind === "Store fields") storeAllowed62 = false;
                if (kind === "Store generation") {
                  const before = (
                    await tx.query(
                      "SELECT generation::text FROM bop_tenant.store_reference_generation WHERE brand_id=$1",
                      [id(1)],
                    )
                  ).rows[0].generation;
                  await tx.query("SELECT set_config('bop.store_id',$1,true)", [id(34000)]);
                  const changed = await tx.query(
                    "UPDATE bop_tenant.store SET version=version+1,updated_at=updated_at+interval '1 millisecond' WHERE brand_id=$1 AND store_id=$2",
                    [id(1), id(34000)],
                  );
                  assert.equal(changed.rowCount, 1);
                  await tx.query("SELECT set_config('bop.store_id','',true)", []);
                  assert.notEqual(
                    (
                      await tx.query(
                        "SELECT generation::text FROM bop_tenant.store_reference_generation WHERE brand_id=$1",
                        [id(1)],
                      )
                    ).rows[0].generation,
                    before,
                  );
                }
                if (kind === "Brand lifecycle") {
                  const changed = await tx.query(
                    "UPDATE bop_tenant.brand SET lifecycle='Suspended',version=version+1,updated_at=updated_at+interval '1 millisecond' WHERE brand_id=$1",
                    [id(1)],
                  );
                  assert.equal(changed.rowCount, 1);
                }
                if (kind === "expiry") offset62 = Date.parse(scope.validUntil) - Date.now();
                if (kind === "backward")
                  offset62 = Date.parse(scope.originalObservedAt) - Date.now() - 1000;
                if (kind === "query") tx.query = async () => ({ rows: [], rowCount: 0 });
                if (kind === "Catalog graph") {
                  const inserted = await tx.query(
                    "INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,variant_digest,created_at,created_by_actor_id,localized_names_json,sku_code,lifecycle,variant_selections_json,unit_of_sale,unit_quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'SYNTHETIC_SCOPE62','Draft','[]','EACH',1)",
                    [
                      id(34100),
                      legacy.aggregate.productReference,
                      id(1),
                      legacy.aggregate.draft.versionReference,
                      "sha256:" + "b".repeat(64),
                      at,
                      id(3),
                      JSON.stringify({ "en-CA": "Synthetic" }),
                    ],
                  );
                  assert.equal(inserted.rowCount, 1);
                }
                if (kind === "Recipe generation") {
                  const changed = await tx.query(
                    "UPDATE rms_recipe.recipe SET updated_at=updated_at+interval '1 millisecond' WHERE brand_id=$1 AND recipe_id=$2",
                    [id(1), id(33000)],
                  );
                  assert.equal(changed.rowCount, 1);
                }
                armed = true;
                return "tentative";
              } catch (error) {
                callbackError = error;
                throw error;
              }
            });
          }),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
        if (callbackError) throw callbackError;
        assert.equal(reached, true, kind + " reached");
        assert.equal(armed, true, kind + " armed");
        assert.deepEqual(await take62(), before62, kind + " exact24-table rollback");
      }
      offset62 = 0;
      storeAllowed62 = true;
      // Milestone63: current immutable Brand content and actual owning Publishing release authorize Store overrides.
      const configuration63 = (n, version, previous, allowed) => ({
        configurationVersionReference: id(n),
        brandReference: id(1),
        configurationVersion: version,
        lifecycle: "Published",
        defaultLocale: "en-CA",
        supportedLocales: ["en-CA"],
        mediaThemeReference: null,
        catalogSourceReference: id(35090),
        platformTemplateReference: id(35091),
        overrideAllowedFieldCodes: allowed ? ["RECIPE.VERSION"] : [],
        hardRequirementFieldCodes: [],
        effectiveFrom: past61,
        effectiveUntil: new Date(Date.now() + 3600000).toISOString(),
        supersedesVersionReference: previous,
        reasonCode: "SYNTHETIC_RECIPE_POLICY63",
        authoredByReference: id(3),
        approvedByReference: id(35092),
        approvalEvidenceReference: id(n + 1),
        publicationReference: id(n + 2),
        createdAt: at,
        updatedAt: at,
        dataClassification: "ConfigurationMetadata",
      });
      const configurationAllowed63 = configuration63(35100, 1, null, true);
      const publication63 = await prepareBrandRecipeOverridePublication({
        admin,
        role,
        configuration: configurationAllowed63,
        tenantReference: id(4),
        lifecycleReference: id(35200),
        familyReference: id(35093),
        operationBase: 35300,
        id,
      });
      // Minimal complete metadata fields only, not private configuration administration permission.
      await admin.query(`GRANT SELECT(configuration_version_id,brand_id,configuration_version,lifecycle,
        default_locale,supported_locales,media_theme_reference,catalog_source_reference,platform_template_reference,
        override_allowed_field_codes,hard_requirement_field_codes,effective_from,effective_until,supersedes_version_reference,
        reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,
        created_at,updated_at,data_classification) ON bop_tenant.brand_configuration_version TO ${role}`);
      await admin.query(
        "INSERT INTO rms_recipe.recipe(recipe_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_OVERRIDE63',1,$3,$4,$3)",
        [id(35000), id(1), past61, id(3)],
      );
      await admin.query(
        "INSERT INTO rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id,version_number,snapshot_digest,lifecycle,display_name_code,yield_quantity_microunits,yield_unit_code,yield_dimension,preparation_version_id,effective_from,effective_time_zone,created_at) VALUES($1,$2,$3,1,$4,'Published','SYNTHETIC_OVERRIDE63',3000000,'PORTION','Count',$5,$6,'America/Toronto',$6)",
        [id(35001), id(35000), id(1), digest61, id(35002), past61],
      );
      await admin.query(
        "UPDATE rms_recipe.recipe SET current_version_id=$1,aggregate_version=2 WHERE recipe_id=$2",
        [id(35001), id(35000)],
      );
      await admin.query(
        "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,option_binding_id,effective_from) VALUES($1,$2,$3,$4,$5,$6,NULL,$7)",
        [
          id(35010),
          id(35001),
          id(35000),
          id(1),
          legacy.aggregate.draft.skus[0].skuReference,
          id(34000),
          past61,
        ],
      );
      let actual63,
        brandFields63 = true,
        brandDepth63 = 0,
        offset63 = 0;
      const now63 = () => new Date(Date.now() + offset63).toISOString();
      const provider63 = () =>
        createCurrentProductStoreRecipePolicySource({
          tenantReference: id(4),
          brandReference: id(1),
          actorReference: id(3),
          clock: { now: now63 },
          catalogAuthority: {
            async holdUntilTransactionCompletes(tx, v) {
              assert.equal(tx, actual63);
              assert.deepEqual(v.requiredFields, productPricingBindingCurrentSourceFields);
              assert.deepEqual(v.request, request61);
            },
          },
          recipeAuthority: {
            async holdUntilTransactionCompletes(tx, v) {
              assert.equal(tx, actual63);
              assert.deepEqual(v.requiredFields, recipeReferenceSourceFields);
              assert.equal(v.permission, "recipe.manage");
            },
          },
          storeAuthority: {
            async withCurrentBrandReferenceRead(r, work) {
              assert.equal(r.actorReference, id(3));
              assert.equal(r.brandReference, id(1));
              return work();
            },
            async isCurrent(tx) {
              assert.equal(tx, actual63);
              return true;
            },
          },
          brandAuthority: {
            async withCurrentContentRead(r, fields, work) {
              assert.equal(r.tenantReference, id(4));
              assert.equal(r.actorReference, id(3));
              assert.equal(r.purposeCode, "CATALOG_PRODUCT_CONTENT");
              assert.deepEqual(fields, tenantBrandConfigurationRequiredFields);
              if (!brandFields63) throw new Error("synthetic current Brand fields revoked");
              brandDepth63++;
              try {
                return await work();
              } finally {
                brandDepth63--;
              }
            },
            async isCurrent(tx, r, fields) {
              assert.equal(tx, actual63);
              assert.equal(r.brandReference, id(1));
              assert.deepEqual(fields, tenantBrandConfigurationRequiredFields);
              assert.ok(brandDepth63 > 0);
              return brandFields63;
            },
          },
        });
      const input63 = (configuration = configurationAllowed63) => {
        const observedAt = now63();
        return {
          request: request61,
          observedAt,
          validUntil: new Date(Date.parse(observedAt) + 30000).toISOString(),
          activationAt: new Date(Date.parse(observedAt) + 15000).toISOString(),
          storeReference: id(34000),
          configurationVersionReference: configuration.configurationVersionReference,
          expectedBrandVersion: 1,
        };
      };
      const tables63 = [
        ...tables62,
        "bop_tenant.brand_configuration_version",
        "bop_publishing.publishing_mutation_record",
      ];
      const take63 = async () => {
        const snapshots = {};
        for (const table of tables63)
          snapshots[table] = (
            await admin.query(
              "SELECT to_jsonb(t) row FROM " + table + " t ORDER BY to_jsonb(t)::text",
            )
          ).rows;
        return snapshots;
      };
      const baseline63 = await take63();
      await transactions.run(async (tx) => {
        actual63 = tx;
        const value = await provider63().withCurrentResolution(tx, input63(), async (v) => v);
        assert.equal(value.recipe.decision, "PassForDirectBrandAndStoreBindings");
        assert.equal(value.recipe.resolutions[0].source, "StoreOverride");
        assert.equal(value.recipe.resolutions[0].recipeVersionReference, id(35001));
        assert.notEqual(value.recipe.resolutions[0].recipeVersionReference, id(33001));
        assert.equal(
          value.recipe.overridePolicy.currentPublicationReference,
          publication63.release.releaseId,
        );
        assert.equal(
          value.recipe.overridePolicy.contentDigest,
          tenantBrandConfigurationContentDigest(configurationAllowed63),
        );
        assert.equal(value.recipe.eligibility, "NotEvaluated");
        assert.equal(value.publishValidation, "Incomplete");
      });
      assert.deepEqual(
        await take63(),
        baseline63,
        "current actual Store override read writes nothing",
      );
      for (const kind of [
        "unknown configuration",
        "expected Brand revision",
        "activation period",
      ]) {
        let reached = false;
        const work = async () => {
          reached = true;
          return "invalid policy reached work";
        };
        await assert.rejects(
          transactions.run(async (tx) => {
            actual63 = tx;
            const v = input63();
            if (kind === "unknown configuration") v.configurationVersionReference = id(35199);
            if (kind === "expected Brand revision") v.expectedBrandVersion = 2;
            if (kind === "activation period")
              v.activationAt = configurationAllowed63.effectiveUntil;
            return provider63().withCurrentResolution(tx, v, work);
          }),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
        assert.equal(reached, false, kind + " rejected before callback");
      }
      for (const kind of ["Brand fields", "Brand revision", "Archive", "expiry", "query"]) {
        brandFields63 = true;
        offset63 = 0;
        let reached = false,
          armed = false,
          callbackError;
        await assert.rejects(
          transactions.run(async (tx) => {
            actual63 = tx;
            return provider63().withCurrentResolution(tx, input63(), async (scope) => {
              reached = true;
              try {
                const marker = await tx.query(
                  "UPDATE rms_catalog.product SET aggregate_version=aggregate_version+1 WHERE brand_id=$1 AND product_id=$2",
                  [id(1), original.aggregate.productReference],
                );
                assert.equal(marker.rowCount, 1);
                if (kind === "Brand fields") brandFields63 = false;
                if (kind === "Brand revision") {
                  const changed = await tx.query(
                    "UPDATE bop_tenant.brand SET version=version+1,updated_at=updated_at+interval '1 millisecond' WHERE brand_id=$1",
                    [id(1)],
                  );
                  assert.equal(changed.rowCount, 1);
                }
                if (kind === "Archive") {
                  const archived = await publication63.archive(tx);
                  assert.ok(archived.auditReference);
                  const archiveRow = (
                    await tx.query(
                      "SELECT mutation_json FROM bop_publishing.publishing_mutation_record WHERE brand_id=$1 AND audit_id=$2",
                      [id(1), archived.auditReference],
                    )
                  ).rows[0];
                  assert.equal(archiveRow.mutation_json.next.state, "Archived");
                  const latest = (
                    await tx.query(
                      "SELECT count(*)::int count FROM bop_publishing.publishing_mutation_record WHERE brand_id=$1",
                      [id(1)],
                    )
                  ).rows[0].count;
                  assert.equal(
                    latest,
                    baseline63["bop_publishing.publishing_mutation_record"].length + 1,
                  );
                }
                if (kind === "expiry") offset63 = Date.parse(scope.validUntil) - Date.now();
                if (kind === "query") tx.query = async () => ({ rows: [], rowCount: 0 });
                armed = true;
                return "tentative";
              } catch (error) {
                callbackError = error;
                throw error;
              }
            });
          }),
          { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
        );
        if (callbackError) throw callbackError;
        assert.equal(reached, true, kind + " reached");
        assert.equal(armed, true, kind + " armed");
        assert.deepEqual(
          await take63(),
          baseline63,
          kind + " exact26-table rollback including owning Archive/Audit",
        );
      }
      brandFields63 = true;
      offset63 = 0;
      const configurationDenied63 = configuration63(
        35600,
        2,
        configurationAllowed63.configurationVersionReference,
        false,
      );
      await prepareBrandRecipeOverridePublication({
        admin,
        role,
        configuration: configurationDenied63,
        tenantReference: id(4),
        lifecycleReference: id(35700),
        familyReference: id(35093),
        operationBase: 35800,
        id,
        previousRelease: publication63.release,
      });
      const deniedBaseline63 = await take63();
      await transactions.run(async (tx) => {
        actual63 = tx;
        const value = await provider63().withCurrentResolution(
          tx,
          input63(configurationDenied63),
          async (v) => v,
        );
        assert.equal(value.recipe.resolutions[0].status, "StoreOverrideDenied");
        assert.equal(value.recipe.resolutions[0].recipeVersionReference, null);
        assert.equal(value.recipe.resolutions[0].source, "StoreOverride");
      });
      let supersededReached63 = false;
      await assert.rejects(
        transactions.run(async (tx) => {
          actual63 = tx;
          return provider63().withCurrentResolution(tx, input63(), async () => {
            supersededReached63 = true;
            return "superseded policy reached work";
          });
        }),
        { code: "CATALOG_DEPENDENCY_UNAVAILABLE" },
      );
      assert.equal(supersededReached63, false);
      assert.deepEqual(
        await take63(),
        deniedBaseline63,
        "current denied/superseded policy reads write nothing",
      );
    } finally {
      await admin.end(); // Isolated database harness owns database and fixture Role cleanup.
    }
  });
});
