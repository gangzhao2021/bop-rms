import { createMerchantProductRecipeInventoryReferenceSource } from "../../../apps/api/src/merchant-product-recipe-inventory-reference-source.ts";
import {
  RecipeWorkflowError,
  recipeReferenceSourceFields,
  recipeInventoryReferenceFields,
} from "../../rms/recipe/src/index.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createMerchantProductInventoryReferenceSource } from "../../../apps/api/src/merchant-product-inventory-reference-source.ts";
import { createMerchantInventorySkuMappingStore } from "../../../apps/api/src/merchant-inventory-sku-mapping-store.ts";
import {
  CatalogError,
  createPostgresCatalogInventorySkuReferenceSourceStore,
  createPostgresProductCreationStore,
  catalogInventorySkuReferenceFields,
  catalogInventorySkuReferencePermissions,
} from "../../rms/catalog/src/index.ts";
import {
  InventoryItemError,
  createInventoryItem,
  createPostgresInventoryItemStore,
  inventorySkuMappingIntentDigest,
  inventorySkuMappingWritePermissions,
  inventorySkuMappingWriteFields,
  inventorySkuMappingReferenceFields,
  inventoryConfigurationReferencePermissions,
} from "../../rms/inventory/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `01902419-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = { tenantReference: id(1), brandReference: id(2) },
  actor = id(3),
  past = "2026-08-01T00:00:00.000Z",
  hash = "sha256:" + "a".repeat(64);
function audit(v, auditId) {
  return {
    auditId,
    brandId: v.brandReference,
    actor: { type: "User", reference: v.actorReference },
    actionCode: "INVENTORY_SKU_MAPPING_" + v.action.toUpperCase(),
    targetType: "InventorySkuMapping",
    targetId: v.mappingReference,
    reasonCode: v.reasonCode,
    correlationId: v.operationReference,
    occurredAt: v.occurredAt,
    sourceChannel: "API",
    dataClassification: "Internal",
    retentionPolicyCode: "OPERATIONAL",
    retentionPolicyVersion: 1,
  };
}
it("uses real Catalog source and Inventory mapping/Audit in one PostgreSQL transaction with rollback, authority and recovery", async () => {
  await withIsolatedDatabase({ caseId: "catalog_inv_bridge" }, async (context) => {
    const admin = new Client(context.clientConfig),
      writer = new Client(context.clientConfig),
      competitorClient = new Client(context.clientConfig);
    await Promise.all([admin.connect(), writer.connect(), competitorClient.connect()]);
    const role = "wp2409_bridge_" + context.runId;
    let auditSequence = 1000,
      catalogChecks = 0,
      inventoryChecks = 0,
      denyCatalogAt = 0,
      denyInventoryAt = 0,
      failAudit = false,
      loseAck = false,
      checkFences = false,
      checkRecipeFence = false,
      runnerCalls = 0,
      activeTx,
      trace = [],
      currentCommand;
    try {
      assert.match(role, /^wp2409_bridge_[a-f0-9]+$/u);
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(
        `GRANT USAGE ON SCHEMA rms_catalog,rms_inventory,platform_audit,platform_helpers TO ${role}`,
      );
      await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT(tenant_id,brand_id,item_id,item_type,created_at) ON rms_inventory.inventory_item TO ${role}`,
      );
      await admin.query(`GRANT UPDATE(item_id) ON rms_inventory.inventory_item TO ${role}`);
      await admin.query(
        `GRANT SELECT(tenant_id,brand_id,item_id,version,snapshot_json,recorded_at) ON rms_inventory.inventory_item_version TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT(tenant_id,brand_id,item_id,version,operation_id,action) ON rms_inventory.inventory_item_operation TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT ON rms_inventory.configuration_reference_generation TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT ON rms_inventory.item_sku_mapping_version,platform_audit.audit_record TO ${role}`,
      );
      await admin.query(`GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${role}`);
      const grants = {
        product: "brand_id,product_id,lifecycle,aggregate_version,created_at,updated_at",
        product_version:
          "brand_id,product_id,product_version_id,status,category_classification_known,primary_category_id,tax_classification_id,created_at,updated_at",
        sku: "brand_id,product_id,product_version_id,sku_id,lifecycle,created_at",
        product_source_head: "brand_id,source_revision",
        product_version_category_assignment: "brand_id,product_id,product_version_id,category_id",
        product_option_binding:
          "brand_id,product_id,product_version_id,binding_id,option_set_id,option_set_version_id",
        product_option_binding_option: "brand_id,product_id,binding_id,option_id",
        product_option_binding_sku_scope: "brand_id,product_id,binding_id,sku_id,scope_kind",
        product_option_binding_channel: "brand_id,product_id,binding_id,channel_code",
      };
      for (const [table, columns] of Object.entries(grants)) {
        assert.match(table, /^[a-z_]+$/);
        assert.match(columns, /^[a-z_,]+$/);
        await admin.query(`GRANT SELECT(${columns}) ON rms_catalog.${table} TO ${role}`);
      }
      async function seed(item, tenant = 1, brand = 2, type = "FinishedGood") {
        const snapshot = createInventoryItem({
          tenantReference: id(tenant),
          brandReference: id(brand),
          itemReference: id(item),
          internalCode: "SYNTHETIC_" + item,
          itemType: type,
          localizedNames: { en: "Synthetic Item" },
          baseUnit: {
            unitCode: "EA",
            dimension: "Count",
            displayPrecision: 0,
            ledgerPrecision: 0,
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
          occurredAt: past,
          actorReference: actor,
        });
        await admin.query(
          "INSERT INTO rms_inventory.inventory_item(tenant_id,brand_id,item_id,internal_code,item_type,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [id(tenant), id(brand), id(item), snapshot.internalCode, type, past, actor],
        );
        await admin.query(
          "INSERT INTO rms_inventory.inventory_item_version(tenant_id,brand_id,item_id,version,snapshot_json,recorded_at) VALUES($1,$2,$3,1,$4,$5)",
          [id(tenant), id(brand), id(item), JSON.stringify(snapshot), past],
        );
        await admin.query(
          "INSERT INTO rms_inventory.inventory_item_operation(tenant_id,brand_id,operation_id,item_id,version,intent_hash,action,audit_id) VALUES($1,$2,$3,$4,1,$5,'Create',$6)",
          [id(tenant), id(brand), id(item * 100 + 1), id(item), hash, id(item * 100 + 2)],
        );
      }
      // Synthetic fixed owning facts seed only; no real merchant/source receipt claim.
      await admin.query(
        "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_BOTTLE','NonAlcoholicBeverage','Draft',1,$3,$4,$3)",
        [id(8), id(2), past, id(3)],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4,$5,$5)",
        [id(9), id(8), id(2), JSON.stringify({ "en-CA": "Synthetic bottle" }), past],
      );
      await admin.query(
        "INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,'SYNTHETIC_BOTTLE_ONE','Draft',$5,'[]',$6,'EACH',1,$7,$8)",
        [
          id(10),
          id(8),
          id(2),
          id(9),
          JSON.stringify({ "en-CA": "Synthetic bottle one" }),
          hash,
          past,
          id(3),
        ],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_source_head(brand_id,source_revision) VALUES($1,1)",
        [id(2)],
      );

      await seed(6);
      await seed(20);
      await admin.query(
        `GRANT SELECT(operation_id,brand_id,product_id,action_code,result_aggregate_version,occurred_at,intent_digest) ON rms_catalog.product_operation_record TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT(operation_id,brand_id,product_id,result_aggregate_version,occurred_at,snapshot_json) ON rms_catalog.product_operation_snapshot TO ${role}`,
      );
      // Recorded-history now verifies publication/source receipts; only this isolated reader role.
      await admin.query(
        `GRANT SELECT(operation_id,brand_id,product_id,result_aggregate_version,occurred_at,intent_digest,action_code) ON rms_catalog.product_publication_revision TO ${role}`,
      );
      await admin.query(
        `GRANT SELECT(operation_id,brand_id,product_id,result_aggregate_version,occurred_at,event_type) ON rms_catalog.product_source_commit TO ${role}`,
      );
      // Explicit synthetic owning history, not a real merchant Command/Event receipt.
      async function history(version, known, recordedAt) {
        const draft = {
          status: "Draft",
          versionReference: id(9),
          taxClassificationReference: null,
          skus: [{ skuReference: id(10), productReference: id(8), brandReference: id(2) }],
          optionBindings: [],
          ...(known
            ? { categoryClassification: { categoryReferences: [], primaryCategoryReference: null } }
            : {}),
        };
        const snapshot = {
          brandReference: id(2),
          productReference: id(8),
          aggregateVersion: version,
          updatedAt: recordedAt,
          draft,
        };
        await admin.query(
          "INSERT INTO rms_catalog.product_operation_record(operation_id,brand_id,product_id,action_code,intent_digest,result_aggregate_version,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            id(700 + version),
            id(2),
            id(8),
            version === 1 ? "Create" : "ReplaceDraft",
            hash,
            version,
            recordedAt,
          ],
        );
        await admin.query(
          "INSERT INTO rms_catalog.product_operation_snapshot(operation_id,brand_id,product_id,result_aggregate_version,occurred_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6)",
          [id(700 + version), id(2), id(8), version, recordedAt, JSON.stringify(snapshot)],
        );
      }
      await history(1, false, past);
      const competitor = createPostgresProductCreationStore({
        brandReference: id(2),
        authorize: async () => true,
        transactions: {
          async run(work) {
            await competitorClient.query("BEGIN");
            await competitorClient.query("SET LOCAL lock_timeout='150ms'");
            try {
              const result = await work(competitorClient);
              await competitorClient.query("COMMIT");
              return result;
            } catch (error) {
              await competitorClient.query("ROLLBACK");
              throw error;
            }
          },
        },
      });
      const prepare = () =>
        competitor.codeAvailable({
          brandReference: id(2),
          productCode: "SYNTHETIC_OTHER",
          skuCodes: [],
          excludingProductReference: null,
        });
      async function inventoryFence() {
        await competitorClient.query("BEGIN");
        await competitorClient.query("SET LOCAL lock_timeout='150ms'");
        try {
          await competitorClient.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('InventoryCatalogReferenceV1:' || $1::text || ':' || $2::text,0))",
            [id(1), id(2)],
          );
          await competitorClient.query("COMMIT");
        } catch (error) {
          await competitorClient.query("ROLLBACK");
          throw error;
        }
      }
      const transactions = {
        async run(work) {
          runnerCalls++;
          await writer.query("BEGIN");
          await writer.query(`SET LOCAL ROLE ${role}`);
          let committed = false,
            wrote = false;
          try {
            activeTx = {
              async query(sql, values) {
                trace.push({
                  sql,
                  catalogFence: values[0] === "CatalogProductSource:" + id(2),
                  inventoryFence:
                    values[0] === "InventoryCatalogReferenceV1:" + id(1) + ":" + id(2),
                });
                if (sql.startsWith("INSERT INTO rms_inventory.item_sku_mapping_version"))
                  wrote = true;
                if (failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                  throw new Error("Synthetic audit refusal");
                return writer.query(sql, [...values]);
              },
            };
            const result = await work(activeTx);
            if (checkFences) {
              await assert.rejects(prepare(), (e) => e.code === "55P03");
              await assert.rejects(inventoryFence(), (e) => e.code === "55P03");
            }
            if (checkRecipeFence) await assert.rejects(recipeFence(), (e) => e.code === "55P03");
            await writer.query("COMMIT");
            committed = true;
            if (loseAck && wrote) throw new Error("Synthetic response loss");
            return result;
          } catch (error) {
            if (!committed) await writer.query("ROLLBACK");
            throw error;
          }
        },
      };
      const catalogAuthority = {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(tx, activeTx);
          assert.equal(input.requiredPermissions, catalogInventorySkuReferencePermissions);
          assert.equal(input.requiredFields, catalogInventorySkuReferenceFields);
          assert.equal(input.requiredScope, "FullBrandScope");
          if (currentCommand) {
            assert.equal(
              input.request.consumerIntentDigest,
              inventorySkuMappingIntentDigest(currentCommand),
            );
            assert.equal(input.request.operationReference, currentCommand.operationReference);
          }
          if (++catalogChecks === denyCatalogAt)
            throw new CatalogError("CATALOG_PERMISSION_DENIED");
        },
      };
      // Preview gets the actual owning reference graph digest; no synthetic held-SKU DTO.
      const source = createPostgresCatalogInventorySkuReferenceSourceStore({
        ...scope,
        actorReference: actor,
        clock: { now: () => new Date().toISOString() },
        transactions,
        authority: catalogAuthority,
      });
      let digest;
      await source.withCurrentSnapshot(
        {
          purposeCode: "INVENTORY_FINISHED_GOOD_SKU_SOURCE_READ",
          ...scope,
          actorReference: actor,
          operationReference: id(4),
          consumerIntentDigest: hash,
          productReference: id(8),
          productVersionReference: id(9),
          skuReference: id(10),
          expectedConfigurationDigest: null,
        },
        async (snapshot) => {
          digest = snapshot.configurationDigest;
          assert.equal(snapshot.configuration.categoryCoverage, "Unavailable");
        },
      );
      const store = createMerchantInventorySkuMappingStore({
        ...scope,
        actorReference: actor,
        clock: { now: () => new Date().toISOString() },
        transactions,
        catalogAuthority,
        inventoryAuthority: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.equal(tx, activeTx);
            assert.equal(input.requiredPermissions, inventorySkuMappingWritePermissions);
            assert.equal(input.requiredFields, inventorySkuMappingWriteFields);
            assert.equal(input.requiredScope, "FullBrandScope");
            assert.deepEqual(input.command, currentCommand);
            if (++inventoryChecks === denyInventoryAt)
              throw new InventoryItemError("INVENTORY_ITEM_PERMISSION_DENIED");
          },
        },
        audit: { create: (v) => audit(v, id(++auditSequence)) },
      });
      function command({
        item = 6,
        version = 0,
        operation = 40,
        action = "Set",
        configDigest = digest,
      } = {}) {
        return {
          purpose: "InventorySkuMappingManagement",
          permission: "inventory.item.update",
          ...scope,
          actorReference: actor,
          operationReference: id(operation),
          occurredAt: new Date(Date.now() - 10).toISOString(),
          mappingReference: id(item + 100),
          itemReference: id(item),
          expectedMappingVersion: version,
          expectedItemVersion: 1,
          configurationOperationReference: id(item * 100 + 1),
          action,
          target:
            action === "Clear"
              ? null
              : {
                  productReference: id(8),
                  productVersionReference: id(9),
                  skuReference: id(10),
                  catalogConfigurationDigest: configDigest,
                },
          reasonCode: action === "Clear" ? "UNLINK_FINISHED_GOOD" : "LINK_FINISHED_GOOD",
        };
      }
      async function execute(c) {
        currentCommand = c;
        trace = [];
        catalogChecks = inventoryChecks = runnerCalls = 0;
        return store.execute(c);
      }
      async function state() {
        return (
          await admin.query(
            "SELECT (SELECT count(*)::text FROM rms_inventory.item_sku_mapping_version) maps,(SELECT count(*)::text FROM platform_audit.audit_record) audits,(SELECT generation::text FROM rms_inventory.configuration_reference_generation WHERE tenant_id=$1 AND brand_id=$2) generation",
            [id(1), id(2)],
          )
        ).rows[0];
      }
      const c1 = command();
      checkFences = true;
      const first = await execute(c1);
      checkFences = false;
      assert.equal(first.outcome, "Applied");
      assert.equal(first.version.mappingVersion, 1);
      assert.equal(first.version.target.catalogConfigurationDigest, digest);
      assert.equal(runnerCalls, 1);
      assert.equal(catalogChecks, 3);
      assert.equal(inventoryChecks, 4);
      const catalogLock = trace.findIndex((entry) => entry.catalogFence);
      const parentLock = trace.findIndex((entry) => entry.sql.includes("FOR KEY SHARE"));
      const inventoryLock = trace.findIndex((entry) => entry.inventoryFence);
      const auditWrite = trace.findIndex((entry) =>
        entry.sql.startsWith("INSERT INTO platform_audit.audit_record"),
      );
      assert.ok(
        catalogLock >= 0 &&
          parentLock > catalogLock &&
          inventoryLock > parentLock &&
          auditWrite > inventoryLock,
      );
      await prepare();
      await inventoryFence();
      const baseline = await state();
      assert.equal(baseline.maps, "1");
      assert.equal(baseline.audits, "1");
      // Both late Catalog denial (after write) and owning Inventory denial roll back mapping, Audit and generation.
      for (const [catalogAt, inventoryAt] of [
        [1, 0],
        [2, 0],
        [3, 0],
        [0, 1],
        [0, 2],
        [0, 3],
        [0, 4],
      ]) {
        denyCatalogAt = catalogAt;
        denyInventoryAt = inventoryAt;
        await assert.rejects(
          execute(command({ version: 1, operation: 50 + catalogAt + inventoryAt })),
          (e) => e.code === "INVENTORY_ITEM_PERMISSION_DENIED",
        );
        assert.deepEqual(await state(), baseline);
      }
      denyCatalogAt = denyInventoryAt = 0;
      failAudit = true;
      await assert.rejects(
        execute(command({ version: 1, operation: 60 })),
        (e) => e.code === "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
      );
      failAudit = false;
      assert.deepEqual(await state(), baseline);
      await assert.rejects(
        execute(command({ item: 20, operation: 61 })),
        (e) => e.code === "INVENTORY_ITEM_CONFLICT",
      );
      assert.deepEqual(await state(), baseline);
      await assert.rejects(
        execute({ ...c1, reasonCode: "ALTERED" }),
        (e) => e.code === "INVENTORY_ITEM_IDEMPOTENCY_CONFLICT",
      );
      assert.equal(catalogChecks, 0);
      assert.deepEqual(await state(), baseline);
      await assert.rejects(
        execute(command({ version: 1, operation: 62, configDigest: hash })),
        (e) => e.code === "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
      );
      assert.deepEqual(await state(), baseline);
      // Committed result loss recovers original immutable response without re-reading today's Catalog.
      const c2 = command({ version: 1, operation: 63 });
      loseAck = true;
      await assert.rejects(execute(c2), (e) => e.code === "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
      loseAck = false;
      assert.equal((await state()).maps, "2");
      assert.equal((await state()).audits, "2");
      const changedAt = new Date().toISOString();
      await admin.query(
        "UPDATE rms_catalog.product_version SET category_classification_known=true,updated_at=$3 WHERE brand_id=$1 AND product_version_id=$2",
        [id(2), id(9), changedAt],
      );
      await admin.query(
        "UPDATE rms_catalog.product SET aggregate_version=2,updated_at=$3 WHERE brand_id=$1 AND product_id=$2",
        [id(2), id(8), changedAt],
      );
      await history(2, true, changedAt);
      await admin.query(
        "UPDATE rms_catalog.product_source_head SET source_revision=source_revision+1 WHERE brand_id=$1",
        [id(2)],
      );
      const recovered = await execute(c2);
      assert.equal(recovered.outcome, "AlreadyApplied");
      assert.equal(recovered.version.mappingVersion, 2);
      assert.equal(catalogChecks, 0);
      assert.equal(inventoryChecks, 2);
      await assert.rejects(
        execute(command({ version: 2, operation: 64 })),
        (e) => e.code === "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
      );
      denyInventoryAt = 2;
      await assert.rejects(execute(c2), (e) => e.code === "INVENTORY_ITEM_PERMISSION_DENIED");
      denyInventoryAt = 0;
      const clear = await execute(command({ version: 2, operation: 65, action: "Clear" }));
      assert.equal(clear.version.mappingVersion, 3);
      assert.equal(clear.version.target, null);
      assert.equal(catalogChecks, 0);
      assert.equal((await state()).maps, "3");
      assert.equal((await state()).audits, "3");
      assert.equal((await execute(c1)).outcome, "AlreadyApplied");
      assert.equal(catalogChecks, 0);
      const review = {
        purposeCode: "CATALOG_LIFECYCLE_REVIEW",
        brandReference: id(2),
        actorReference: actor,
        productReference: id(8),
        skuReference: null,
        operationReference: id(800),
        expectedAggregateVersion: 2,
        originalProductVersionReference: id(9),
        beforeLifecycle: "Draft",
        targetLifecycle: "Archived",
        reasonCode: "SYNTHETIC",
        activeSkuCount: 0,
      };
      let readChecks = 0,
        denyReadAt = 0,
        callbackCalled = false,
        currentReads = 0,
        historyReads = 0;
      const readInventory = {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(tx, activeTx);
          assert.equal(input.requiredFields, inventorySkuMappingReferenceFields);
          assert.equal(input.requiredPermissions, inventoryConfigurationReferencePermissions);
          assert.equal(input.requiredScope, "FullBrandScope");
          assert.equal(input.request.tenantReference, id(1));
          if (++readChecks === denyReadAt)
            throw new InventoryItemError("INVENTORY_ITEM_PERMISSION_DENIED");
        },
      };
      const currentAuthority = {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(tx, activeTx);
          assert.deepEqual(input.request, review);
          assert.equal(input.permission, "catalog.manage");
          assert.ok(input.requiredFields.includes("productLifecycle"));
          currentReads++;
        },
      };
      const recordedAuthority = {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(tx, activeTx);
          assert.deepEqual(input.request, review);
          assert.equal(input.owningAction, "catalog.product.history.read");
          assert.ok(input.requiredFields.includes("recordCoverage"));
          historyReads++;
        },
      };
      async function readMatches() {
        readChecks = 0;
        callbackCalled = false;
        return transactions.run((tx) =>
          createMerchantProductInventoryReferenceSource({
            transaction: tx,
            tenantReference: id(1),
            request: review,
            clock: { now: () => new Date().toISOString() },
            currentAuthority,
            recordedAuthority,
            inventoryAuthority: readInventory,
          }).withCurrentMatches(async (matches) => {
            callbackCalled = true;
            assert.equal(matches.current.references.length, 2);
            assert.equal(matches.current.clears.length, 1);
            assert.deepEqual(matches.current.references[0].gaps, ["ConfigurationDigestChanged"]);
            const original = matches.recorded.find(
              (r) => r.configuration.categoryCoverage === "Unavailable",
            );
            assert.ok(original);
            assert.equal(original.matches.target.catalogConfigurationDigest, digest);
            assert.equal(original.matches.references[0].configurationMatch, "Matched");
            assert.equal(original.matches.references[0].mapping.current, false);
            assert.equal(matches.current.clears[0].current, true);
            assert.equal(matches.current.unresolvedItemCoverage[0].itemReference, id(20));
            assert.equal(matches.current.unresolvedItemCoverage[0].currentLink, "Unknown");
            assert.equal(matches.applicability, "Unavailable");
            assert.equal(matches.publicationCoverage, "Unavailable");
            assert.doesNotMatch(
              JSON.stringify(matches),
              /localizedNames|unitQuantity|audit_json|snapshot_json|quantity|allergen|cost/,
            );
            await assert.rejects(prepare(), (e) => e.code === "55P03");
            await assert.rejects(inventoryFence(), (e) => e.code === "55P03");
            return matches.digest;
          }),
        );
      }
      checkFences = true;
      const readDigest = await readMatches();
      assert.match(readDigest, /^sha256:[a-f0-9]{64}$/);
      assert.equal(readChecks, 5);
      assert.equal(currentReads, 3);
      assert.equal(historyReads, 3);
      const beforeRead = await state();
      denyReadAt = 5;
      await assert.rejects(readMatches(), (e) => e.code === "CATALOG_PERMISSION_DENIED");
      assert.equal(callbackCalled, true);
      assert.deepEqual(await state(), beforeRead);
      denyReadAt = 0;
      checkFences = false;
      await prepare();
      await inventoryFence();
      // Supported owning Item writer creates configuration2/op602; the stored
      // Recipe requirement still pins original configuration1/op601.
      await admin.query("BEGIN");
      await admin.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
        [id(1), id(2)],
      );
      const normalItemStore = createPostgresInventoryItemStore(
          { run: (work) => work(admin) },
          scope,
        ),
        item1 = await normalItemStore.load(id(6));
      assert.ok(item1);
      const itemUpdatedAt = new Date(Date.now() - 10).toISOString();
      await normalItemStore.commit({
        operationReference: id(602),
        intentHash: hash,
        action: "Update",
        outcome: "Applied",
        item: { ...item1, aggregateVersion: 2, updatedAt: itemUpdatedAt, updatedBy: actor },
        audit: {
          ...audit(
            {
              brandReference: id(2),
              actorReference: actor,
              action: "Set",
              mappingReference: id(6),
              reasonCode: "SYNTHETIC_ITEM_UPDATE",
              operationReference: id(602),
              occurredAt: itemUpdatedAt,
            },
            id(9000),
          ),
          actionCode: "INVENTORY_ITEM_UPDATE",
          targetType: "InventoryItem",
        },
      });
      await admin.query("COMMIT");
      await admin.query(`GRANT USAGE ON SCHEMA rms_recipe TO ${role}`);
      const recipeColumns = {
        recipe: "recipe_id,brand_id,aggregate_version,current_version_id,updated_at",
        recipe_version:
          "recipe_version_id,recipe_id,brand_id,version_number,snapshot_digest,lifecycle,effective_from,effective_until,effective_time_zone,created_at",
        recipe_reference_generation: "brand_id,generation,binding_count",
        recipe_reference_binding:
          "recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,option_binding_id,effective_from,effective_until",
        recipe_ingredient_requirement:
          "requirement_id,recipe_version_id,recipe_id,brand_id,source_kind,source_id,source_version_id",
        recipe_modifier_version:
          "rule_version_id,rule_id,brand_id,version,recipe_id,recipe_version_id,binding_id,option_id,selected_quantity,lifecycle,rule_digest,rule_json,effective_from,effective_until,occurred_at",
      };
      for (const [table, columns] of Object.entries(recipeColumns)) {
        assert.match(table, /^[a-z_]+$/);
        assert.match(columns, /^[a-z_,]+$/);
        await admin.query(`GRANT SELECT(${columns}) ON rms_recipe.${table} TO ${role}`);
      }
      const future = "2027-01-01T00:00:00.000Z";
      // Fixed synthetic owning Recipe seed, not publication/active-consumption evidence.
      for (const n of [900, 910])
        await admin.query(
          "INSERT INTO rms_recipe.recipe(recipe_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,1,$4,$5,$4)",
          [id(n), id(2), "SYNTHETIC_RECURSIVE_" + n, past, actor],
        );
      for (const [version, parent, number, lifecycle] of [
        [901, 900, 1, "Draft"],
        [911, 910, 1, "Archived"],
        [912, 910, 2, "Draft"],
      ])
        await admin.query(
          "INSERT INTO rms_recipe.recipe_version(recipe_version_id,recipe_id,brand_id,version_number,snapshot_digest,lifecycle,display_name_code,yield_quantity_microunits,yield_unit_code,yield_dimension,preparation_version_id,effective_from,effective_time_zone,created_at) VALUES($1,$2,$3,$4,$5,$6,'SYNTHETIC_NAME',1,'PORTION','Count',$7,$8,'America/Toronto',$9)",
          [id(version), id(parent), id(2), number, hash, lifecycle, id(920), future, past],
        );
      await admin.query(
        "UPDATE rms_recipe.recipe SET current_version_id=$2,aggregate_version=$3 WHERE recipe_id=$1",
        [id(900), id(901), 2],
      );
      await admin.query(
        "UPDATE rms_recipe.recipe SET current_version_id=$2,aggregate_version=$3 WHERE recipe_id=$1",
        [id(910), id(912), 3],
      );
      await admin.query(
        "INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,effective_from) VALUES($1,$2,$3,$4,$5,$6)",
        [id(930), id(901), id(900), id(2), id(10), future],
      );
      const ingredientSql =
        "INSERT INTO rms_recipe.recipe_ingredient_requirement(requirement_id,recipe_version_id,recipe_id,brand_id,source_kind,source_id,source_version_id,quantity_microunits,unit_dimension,conversion_numerator,conversion_denominator,loss_basis_points,unit_cost_minor_numerator,unit_cost_denominator) VALUES($1,$2,$3,$4,$5,$6,$7,1,'Count',1,1,0,0,1)";
      await admin.query(ingredientSql, [
        id(950),
        id(901),
        id(900),
        id(2),
        "SubRecipe",
        id(910),
        id(911),
      ]);
      await admin.query(ingredientSql, [
        id(951),
        id(911),
        id(910),
        id(2),
        "InventoryItem",
        id(6),
        id(601),
      ]);
      const privateRequirement = (
        requirement,
        sourceKind,
        sourceReference,
        sourceVersionReference,
      ) => ({
        requirementReference: id(requirement),
        sourceKind,
        sourceReference: id(sourceReference),
        sourceVersionReference: id(sourceVersionReference),
        quantityMicrounits: "1",
        unitDimension: "Count",
        conversionNumerator: "1",
        conversionDenominator: "1",
        lossBasisPoints: 0,
        unitCostMinorNumerator: "0",
        unitCostDenominator: "1",
        allergens: [],
      });
      const changesByVersion = [
        [
          { action: "Add", ingredient: privateRequirement(960, "InventoryItem", 20, 2001) },
          { action: "Remove", requirementReference: id(950) },
        ],
        [
          {
            action: "Replace",
            requirementReference: id(950),
            ingredient: privateRequirement(961, "SubRecipe", 900, 901),
          },
        ],
      ];
      for (const number of [1, 2]) {
        const ruleVersion = id(940 + number),
          rule = {
            ruleReference: id(940),
            ruleVersionReference: ruleVersion,
            ruleDigest: hash,
            brandReference: id(2),
            recipeVersionReference: id(901),
            selection: { bindingReference: id(970), optionReference: id(971), quantity: 1 },
            changes: changesByVersion[number - 1],
          };
        await admin.query(
          "INSERT INTO rms_recipe.recipe_modifier_version(rule_version_id,rule_id,brand_id,version,recipe_id,recipe_version_id,binding_id,option_id,selected_quantity,lifecycle,rule_digest,rule_json,effective_from,operation_id,actor_id,audit_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11::jsonb,$12,$13,$14,$15,$16)",
          [
            ruleVersion,
            id(940),
            id(2),
            number,
            id(900),
            id(901),
            id(970),
            id(971),
            number === 1 ? "Draft" : "Archived",
            hash,
            JSON.stringify(rule),
            future,
            id(980 + number),
            actor,
            id(990 + number),
            past,
          ],
        );
      }
      async function recipeFence() {
        await competitorClient.query("BEGIN");
        await competitorClient.query("SET LOCAL lock_timeout='150ms'");
        try {
          await competitorClient.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
            [id(2)],
          );
          await competitorClient.query(ingredientSql, [
            id(979),
            id(911),
            id(910),
            id(2),
            "InventoryItem",
            id(20),
            id(2001),
          ]);
          await competitorClient.query("COMMIT");
        } catch (error) {
          await competitorClient.query("ROLLBACK");
          throw error;
        }
      }
      let recipeReads = 0,
        recipeInventoryReads = 0,
        denyRecipeInventoryAt = 0;
      const recipeAuthority = {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(tx, activeTx);
          assert.equal(input.permission, "recipe.manage");
          assert.equal(input.requiredScope, "FullBrandScope");
          assert.equal(input.requiredFields, recipeReferenceSourceFields);
          recipeReads++;
        },
      };
      const recipeInventoryAuthority = {
        async holdUntilTransactionCompletes(tx, input) {
          assert.equal(tx, activeTx);
          assert.equal(input.permission, "recipe.manage");
          assert.equal(input.requiredScope, "FullBrandScope");
          assert.equal(input.requiredFields, recipeInventoryReferenceFields);
          if (++recipeInventoryReads === denyRecipeInventoryAt)
            throw new RecipeWorkflowError("RECIPE_PERMISSION_DENIED");
        },
      };
      async function readRecursive() {
        recipeReads = recipeInventoryReads = readChecks = 0;
        callbackCalled = false;
        return transactions.run((tx) =>
          createMerchantProductRecipeInventoryReferenceSource({
            transaction: tx,
            tenantReference: id(1),
            request: review,
            clock: { now: () => new Date().toISOString() },
            currentAuthority,
            recordedAuthority,
            recipeAuthority,
            recipeInventoryAuthority,
            inventoryAuthority: readInventory,
          }).withCurrentMatches(async (matches) => {
            callbackCalled = true;
            const base = matches.current.inventoryReferences.find(
              (r) => r.requirement.kind === "BaseIngredient" && !r.requirement.conditional,
            );
            assert.ok(base);
            assert.equal(base.resolution.state, "ResolvedStoredConfiguration");
            assert.equal(base.resolution.operation.operationReference, id(601));
            assert.equal(base.resolution.version.itemVersion, 1);
            assert.equal(base.resolution.item.currentItemVersion, 2);
            assert.equal(base.resolution.isCurrentItemConfiguration, false);
            const conditional = matches.current.inventoryReferences.find(
              (r) => r.requirement.kind === "ModifierAdd",
            );
            assert.ok(conditional);
            assert.equal(conditional.requirement.conditional, true);
            assert.equal(conditional.resolution.isCurrentItemConfiguration, true);
            assert.equal(
              matches.current.recipeReachability.requirements.filter(
                (r) => r.kind === "ModifierAdd",
              ).length,
              1,
            );
            assert.ok(
              matches.current.recipeReachability.requirements.some(
                (r) => r.kind === "ModifierRemove",
              ),
            );
            assert.ok(
              matches.current.recipeReachability.requirements.some(
                (r) => r.kind === "ModifierReplace" && r.modifier.lifecycle === "Archived",
              ),
            );
            assert.ok(
              matches.current.recipeReachability.reachableVersions.some(
                (v) => v.version.recipeVersionReference === id(911) && !v.isCurrentRecipeVersion,
              ),
            );
            assert.equal(
              matches.current.catalogConfigurationDigest,
              matches.recorded.find((r) => r.configuration.categoryCoverage === "Known").matches
                .catalogConfigurationDigest,
            );
            assert.equal(matches.applicability, "Unavailable");
            assert.equal(matches.removalResolution, "Unavailable");
            assert.equal(matches.conditionalApplicability, "Unavailable");
            assert.doesNotMatch(
              JSON.stringify(matches),
              /selectedQuantity|quantity|cost|allergen|snapshot_json|audit_json/,
            );
            await assert.rejects(prepare(), (e) => e.code === "55P03");
            await assert.rejects(recipeFence(), (e) => e.code === "55P03");
            await assert.rejects(inventoryFence(), (e) => e.code === "55P03");
            return matches.digest;
          }),
        );
      }
      checkFences = checkRecipeFence = true;
      await readRecursive();
      assert.equal(recipeReads, 3);
      assert.equal(recipeInventoryReads, 3);
      assert.equal(readChecks, 5);
      const beforeRecursive = await state();
      denyRecipeInventoryAt = 3;
      await assert.rejects(readRecursive(), (e) => e.code === "CATALOG_PERMISSION_DENIED");
      assert.equal(callbackCalled, true);
      assert.deepEqual(await state(), beforeRecursive);
      denyRecipeInventoryAt = 0;
      denyReadAt = 5;
      await assert.rejects(readRecursive(), (e) => e.code === "CATALOG_PERMISSION_DENIED");
      assert.equal(callbackCalled, true);
      assert.deepEqual(await state(), beforeRecursive);
      denyReadAt = 0;
      checkFences = checkRecipeFence = false;
      await prepare();
      await recipeFence();
      await inventoryFence();
    } finally {
      await Promise.allSettled([admin.end(), writer.end(), competitorClient.end()]);
    }
  });
});
