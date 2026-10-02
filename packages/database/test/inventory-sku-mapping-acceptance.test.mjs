import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { it } from "vitest";
import {
  createInventoryItem,
  createPostgresInventoryItemStore,
  createPostgresInventorySkuMappingStore,
  createPostgresInventorySkuMappingReferenceSourceStore,
  inventorySkuMappingIntentDigest,
  inventorySkuMappingReferenceFields,
  inventorySkuMappingWritePermissions,
  inventorySkuMappingWriteFields,
  inventoryConfigurationReferencePermissions,
} from "../../rms/inventory/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => `01902419-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = { tenantReference: id(1), brandReference: id(2) },
  actor = id(3),
  past = "2026-08-01T00:00:00.000Z",
  hash = "sha256:" + "a".repeat(64);
const mapInsert =
  "INSERT INTO rms_inventory.item_sku_mapping_version(tenant_id,brand_id,item_id,mapping_id,mapping_version,item_version,configuration_operation_id,action,product_id,product_version_id,sku_id,catalog_configuration_digest,operation_id,intent_digest,actor_id,occurred_at,reason_code,audit_id,audit_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)";
function audit(v, auditId = id(200 + v.mappingVersion)) {
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
function args(v) {
  const a = audit(v);
  return [
    v.tenantReference,
    v.brandReference,
    v.itemReference,
    v.mappingReference,
    v.mappingVersion,
    v.sourceItemVersion,
    v.sourceConfigurationOperationReference,
    v.action,
    v.target?.productReference ?? null,
    v.target?.productVersionReference ?? null,
    v.target?.skuReference ?? null,
    v.target?.catalogConfigurationDigest ?? null,
    v.operationReference,
    v.mappingIntentDigest,
    v.actorReference,
    v.occurredAt,
    v.reasonCode,
    a.auditId,
    JSON.stringify(a),
  ];
}
it("persists Inventory mapping history, recovery, one-to-one and minimal held read source in actual PostgreSQL (Catalog capability is synthetic)", async () => {
  await withIsolatedDatabase({ caseId: "inv_sku_mapping" }, async (context) => {
    const admin = new Client(context.clientConfig),
      reader = new Client(context.clientConfig),
      writer = new Client(context.clientConfig);
    await Promise.all([admin.connect(), reader.connect(), writer.connect()]);
    const writeRole = "wp2419w_" + context.runId,
      readRole = "wp2419r_" + context.runId;
    const bind = (client, tenant = id(1), brand = id(2), store = "") =>
      client.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [tenant, brand, store],
      );
    let auditSequence = 1000,
      permissionCalls = 0,
      catalogCalls = 0,
      deny = false,
      failAudit = false,
      loseAck = false,
      mutateAfter = false;
    try {
      for (const role of [writeRole, readRole]) {
        assert.match(role, /^wp2419[wr]_[a-f0-9]+$/u);
        await admin.query(
          `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
        );
        await admin.query(`GRANT USAGE ON SCHEMA rms_inventory,platform_helpers TO ${role}`);
        await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
        await admin.query(
          `GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
        );
        await admin.query(
          `GRANT SELECT(tenant_id,brand_id,item_id,item_type,created_at) ON rms_inventory.inventory_item TO ${role}`,
        );
        await admin.query(
          `GRANT SELECT(tenant_id,brand_id,item_id,version,snapshot_json,recorded_at) ON rms_inventory.inventory_item_version TO ${role}`,
        );
        await admin.query(
          `GRANT SELECT(tenant_id,brand_id,item_id,version,operation_id,action) ON rms_inventory.inventory_item_operation TO ${role}`,
        );
        await admin.query(
          `GRANT SELECT ON rms_inventory.configuration_reference_generation TO ${role}`,
        );
      }
      // Explicit row locking needs UPDATE privilege; the owning root's immutable
      // trigger still refuses actual UPDATE. Read-only source role gets no grant.
      await admin.query(`GRANT UPDATE(item_id) ON rms_inventory.inventory_item TO ${writeRole}`);
      await admin.query(`GRANT USAGE ON SCHEMA platform_audit TO ${writeRole}`);
      await admin.query(
        `GRANT SELECT,INSERT ON rms_inventory.item_sku_mapping_version,platform_audit.audit_record TO ${writeRole}`,
      );
      await admin.query(
        `GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ${writeRole}`,
      );
      await admin.query(
        `GRANT SELECT(tenant_id,brand_id,item_id,mapping_id,mapping_version,item_version,configuration_operation_id,action,product_id,product_version_id,sku_id,catalog_configuration_digest,operation_id,intent_digest,occurred_at) ON rms_inventory.item_sku_mapping_version TO ${readRole}`,
      );
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
      await seed(6);
      await seed(20);
      await seed(30, 1, 2, "RawMaterial");
      await seed(6, 60, 2);
      await seed(6, 1, 62);
      let currentItemVersion = 1;
      function command({ item = 6, version = 0, action = "Set", operation = 40 } = {}) {
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
          expectedItemVersion: item === 6 ? currentItemVersion : 1,
          configurationOperationReference: id(item * 100 + (item === 6 ? currentItemVersion : 1)),
          action,
          target:
            action === "Clear"
              ? null
              : {
                  productReference: id(8),
                  productVersionReference: id(9),
                  skuReference: id(10),
                  catalogConfigurationDigest: hash,
                },
          reasonCode: action === "Clear" ? "UNLINK_FINISHED_GOOD" : "LINK_FINISHED_GOOD",
        };
      }
      const transactions = {
        async run(work) {
          await writer.query("BEGIN");
          await writer.query(`SET LOCAL ROLE ${writeRole}`);
          let committed = false,
            wrote = false;
          try {
            const tx = {
              async query(sql, values) {
                if (sql.startsWith("INSERT INTO rms_inventory.item_sku_mapping_version"))
                  wrote = true;
                if (failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                  throw new Error("Synthetic Audit rollback");
                return writer.query(sql, [...values]);
              },
            };
            const result = await work(tx);
            await writer.query("COMMIT");
            committed = true;
            if (loseAck && wrote) throw new Error("Synthetic committed response loss");
            return result;
          } catch (error) {
            if (!committed) await writer.query("ROLLBACK");
            throw error;
          }
        },
      };
      const options = {
        ...scope,
        actorReference: actor,
        clock: { now: () => new Date().toISOString() },
        transactions,
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.equal(input.requiredPermissions, inventorySkuMappingWritePermissions);
            assert.equal(input.requiredFields, inventorySkuMappingWriteFields);
            assert.equal(input.requiredScope, "FullBrandScope");
            permissionCalls++;
            if (deny) {
              const { InventoryItemError } = await import("../../rms/inventory/src/index.ts");
              throw new InventoryItemError("INVENTORY_ITEM_PERMISSION_DENIED");
            }
            await tx.query("SELECT 1", []);
          },
        },
        // Explicit synthetic public capability. This fixture proves Inventory persistence,
        // not an actual owning Catalog current-SKU/authority lease or runtime assembly.
        catalog: {
          async withHeldCurrentSku(tx, input, work) {
            catalogCalls++;
            const c = input.command;
            assert.equal(input.mappingIntentDigest, inventorySkuMappingIntentDigest(c));
            const result = await work({
              tenantReference: c.tenantReference,
              brandReference: c.brandReference,
              actorReference: c.actorReference,
              operationReference: c.operationReference,
              mappingIntentDigest: input.mappingIntentDigest,
              ...c.target,
              coverage: "HeldCurrentSku",
              observedAt: new Date().toISOString(),
            });
            if (mutateAfter) deny = true;
            return result;
          },
        },
        audit: { create: (v) => audit(v, id(++auditSequence)) },
      };
      const store = createPostgresInventorySkuMappingStore(options),
        c1 = command();
      const first = await store.execute(c1);
      assert.equal(first.outcome, "Applied");
      assert.equal(first.version.mappingVersion, 1);
      assert.equal(permissionCalls, 4);
      assert.equal(catalogCalls, 1);
      const count = async (table) => {
        const allowed = new Set(["item_sku_mapping_version", "inventory_item_version"]);
        assert.ok(allowed.has(table));
        return (
          await admin.query(
            `SELECT count(item_id)::text n FROM rms_inventory.${table} WHERE tenant_id=$1 AND brand_id=$2`,
            [id(1), id(2)],
          )
        ).rows[0].n;
      };
      const generation = async () =>
        (
          await admin.query(
            "SELECT generation::text n FROM rms_inventory.configuration_reference_generation WHERE tenant_id=$1 AND brand_id=$2",
            [id(1), id(2)],
          )
        ).rows[0].n;
      const originalGeneration = await generation();
      assert.equal(await count("item_sku_mapping_version"), "1");
      assert.equal(await count("inventory_item_version"), "3");
      failAudit = true;
      await assert.rejects(
        store.execute(command({ version: 1, action: "Clear", operation: 41 })),
        (e) => e.code === "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
      );
      failAudit = false;
      assert.equal(await count("item_sku_mapping_version"), "1");
      assert.equal(await generation(), originalGeneration);
      const c2 = command({ version: 1, action: "Clear", operation: 42 }),
        cleared = await store.execute(c2);
      assert.equal(cleared.version.mappingVersion, 2);
      assert.equal(cleared.version.target, null);
      assert.equal((await store.execute(c1)).outcome, "AlreadyApplied");
      assert.equal(catalogCalls, 1);
      await assert.rejects(
        store.execute({ ...c1, reasonCode: "DIFFERENT" }),
        (e) => e.code === "INVENTORY_ITEM_IDEMPOTENCY_CONFLICT",
      );
      const c3 = command({ version: 2, operation: 43 });
      loseAck = true;
      await assert.rejects(
        store.execute(c3),
        (e) => e.code === "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
      );
      loseAck = false;
      assert.equal(await count("item_sku_mapping_version"), "3");
      const recovered = await store.execute(c3);
      assert.equal(recovered.outcome, "AlreadyApplied");
      assert.equal(recovered.version.mappingVersion, 3);
      await assert.rejects(
        store.execute(command({ item: 20, operation: 44 })),
        (e) => e.code === "INVENTORY_ITEM_CONFLICT",
      );
      await assert.rejects(
        store.execute(command({ item: 30, operation: 45 })),
        (e) => e.code === "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
      );
      const beforeDenied = await generation();
      mutateAfter = true;
      await assert.rejects(
        store.execute(command({ version: 3, operation: 46 })),
        (e) => e.code === "INVENTORY_ITEM_PERMISSION_DENIED",
      );
      mutateAfter = false;
      deny = false;
      assert.equal(await generation(), beforeDenied);
      assert.equal(await count("item_sku_mapping_version"), "3");
      deny = true;
      await assert.rejects(store.execute(c1), (e) => e.code === "INVENTORY_ITEM_PERMISSION_DENIED");
      deny = false;
      // Normal owner Item writer holds the root first. Mapping must wait for FK
      // KEY SHARE before taking the global fence, allowing that writer to commit.
      const writerPid = (await writer.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      await admin.query("BEGIN");
      await bind(admin);
      await admin.query("SET LOCAL lock_timeout='150ms'");
      await admin.query(
        "SELECT item_id FROM rms_inventory.inventory_item WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 FOR UPDATE",
        [id(1), id(2), id(6)],
      );
      const competing = store.execute(command({ version: 3, action: "Clear", operation: 48 })).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let parentWaiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        await admin.query("SELECT pg_stat_clear_snapshot()");
        const row = (
          await admin.query(
            "SELECT wait_event_type='Lock' AND query LIKE '%FOR KEY SHARE%' parent_wait FROM pg_stat_activity WHERE pid=$1",
            [writerPid],
          )
        ).rows[0];
        if (row?.parent_wait === true) {
          parentWaiting = true;
          break;
        }
        await delay(10);
      }
      assert.equal(parentWaiting, true);
      const normalStore = createPostgresInventoryItemStore({ run: (work) => work(admin) }, scope),
        currentItem = await normalStore.load(id(6));
      assert.ok(currentItem);
      const updatedAt = new Date(Date.now() - 10).toISOString(),
        operation = id(602),
        nextItem = { ...currentItem, aggregateVersion: 2, updatedAt, updatedBy: actor };
      await normalStore.commit({
        operationReference: operation,
        intentHash: hash,
        action: "Update",
        item: nextItem,
        outcome: "Applied",
        audit: {
          auditId: id(9000),
          brandId: id(2),
          actor: { type: "User", reference: actor },
          actionCode: "INVENTORY_ITEM_UPDATE",
          targetType: "InventoryItem",
          targetId: id(6),
          reasonCode: "SYNTHETIC_ITEM_UPDATE",
          correlationId: operation,
          occurredAt: updatedAt,
          sourceChannel: "API",
          dataClassification: "Internal",
          retentionPolicyCode: "OPERATIONAL",
          retentionPolicyVersion: 1,
        },
      });
      await admin.query("COMMIT");
      const refused = await competing;
      assert.equal(refused.error?.code, "INVENTORY_ITEM_CONFLICT");
      assert.equal(await count("item_sku_mapping_version"), "3");
      assert.equal(await count("inventory_item_version"), "4");
      currentItemVersion = 2;
      const afterNormalUpdate = await generation();
      const request = {
        purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ",
        ...scope,
        actorReference: actor,
        operationReference: id(90),
        catalogIntentDigest: hash,
      };
      const c4 = command({ version: 3, action: "Clear", operation: 47 }),
        v4 = {
          ...recovered.version,
          mappingVersion: 4,
          sourceItemVersion: 2,
          sourceConfigurationOperationReference: id(602),
          action: "Clear",
          target: null,
          operationReference: c4.operationReference,
          mappingIntentDigest: inventorySkuMappingIntentDigest(c4),
          occurredAt: c4.occurredAt,
          reasonCode: c4.reasonCode,
        };
      // Probe the static SQL guard independently of adapter prechecks.
      for (const mutation of [
        (values) => {
          values[4] = 6;
        },
        (values) => {
          values[5] = 1;
        },
        (values) => {
          values[3] = id(999);
        },
        (values) => {
          values[11] = null;
        },
        (values) => {
          values[2] = id(30);
          values[3] = id(130);
          values[4] = 1;
          values[5] = 1;
          values[6] = id(3001);
        },
        (values) => {
          values[2] = id(20);
          values[3] = id(120);
          values[4] = 1;
          values[5] = 1;
          values[6] = id(2001);
        },
      ]) {
        const probe = {
          ...recovered.version,
          sourceItemVersion: 2,
          sourceConfigurationOperationReference: id(602),
          mappingVersion: 4,
          operationReference: id(91),
          occurredAt: new Date(Date.now() - 10).toISOString(),
        };
        const values = args(probe);
        mutation(values);
        // Rebind the copied Audit to the mutated identity tuple so failures test the
        // owning sequence/configuration/one-to-one/nullable-target guards.
        const a = JSON.parse(values[18]);
        a.targetId = values[3];
        values[18] = JSON.stringify(a);
        await admin.query("BEGIN");
        await bind(admin);
        try {
          await assert.rejects(admin.query(mapInsert, values), (e) => e.code === "23514");
        } finally {
          await admin.query("ROLLBACK");
        }
      }
      assert.equal(await count("item_sku_mapping_version"), "3");
      assert.equal(await generation(), afterNormalUpdate);
      const blocked = async () => {
        await writer.query("BEGIN");
        await bind(writer);
        await writer.query("SET LOCAL lock_timeout='150ms'");
        try {
          await assert.rejects(writer.query(mapInsert, args(v4)), (e) => e.code === "55P03");
        } finally {
          await writer.query("ROLLBACK");
        }
      };
      const sourceOptions = {
        ...scope,
        actorReference: actor,
        clock: { now: () => new Date().toISOString() },
        transactions: {
          async run(work) {
            await reader.query("BEGIN");
            await reader.query(`SET LOCAL ROLE ${readRole}`);
            try {
              const result = await work(reader);
              await blocked();
              await reader.query("COMMIT");
              return result;
            } catch (error) {
              await reader.query("ROLLBACK");
              throw error;
            }
          },
        },
        authority: {
          async holdUntilTransactionCompletes(tx, input) {
            assert.equal(input.requiredFields, inventorySkuMappingReferenceFields);
            assert.equal(input.requiredPermissions, inventoryConfigurationReferencePermissions);
            assert.equal(input.requiredScope, "FullBrandScope");
            if (deny) {
              const { InventoryItemError } = await import("../../rms/inventory/src/index.ts");
              throw new InventoryItemError("INVENTORY_ITEM_PERMISSION_DENIED");
            }
            await tx.query("SELECT 1", []);
          },
        },
      };
      const source = createPostgresInventorySkuMappingReferenceSourceStore(sourceOptions);
      let observed;
      await source.withCurrentSnapshot(request, async (snapshot) => {
        observed = snapshot;
        assert.equal(snapshot.mappings.length, 3);
        assert.equal(snapshot.items.find((v) => v.itemReference === id(20)).currentLink, "Unknown");
        assert.equal(
          snapshot.items.find((v) => v.itemReference === id(30)).currentLink,
          "NotApplicable",
        );
        assert.equal(snapshot.items.find((v) => v.itemReference === id(6)).currentLink, "Mapped");
        assert.equal(snapshot.configuration.items.length, 3);
        assert.ok(
          snapshot.mappings.every((v) => v.tenantReference === id(1) && v.brandReference === id(2)),
        );
        assert.doesNotMatch(
          JSON.stringify(snapshot),
          /actor_id|audit_json|snapshot_json|cost|allergen|quantity/,
        );
        await blocked();
      });
      assert.ok(observed);
      await store.execute(c4);
      assert.equal(await count("item_sku_mapping_version"), "4");
      await source.withCurrentSnapshot(request, async (snapshot) =>
        assert.equal(
          snapshot.items.find((v) => v.itemReference === id(6)).currentLink,
          "ExplicitlyCleared",
        ),
      );
      await assert.rejects(
        source.withCurrentSnapshot(request, async () => {
          deny = true;
        }),
        (e) => e.code === "INVENTORY_ITEM_PERMISSION_DENIED",
      );
      deny = false;
      for (const sql of [
        "UPDATE rms_inventory.item_sku_mapping_version SET reason_code=reason_code",
        "DELETE FROM rms_inventory.item_sku_mapping_version",
        "TRUNCATE rms_inventory.item_sku_mapping_version",
      ]) {
        await assert.rejects(admin.query(sql), (e) => e.code === "55000");
      }
      await reader.query("BEGIN");
      await reader.query(`SET LOCAL ROLE ${readRole}`);
      await bind(reader, id(1), id(2), id(99));
      assert.equal(
        (
          await reader.query(
            "SELECT count(item_id)::text n FROM rms_inventory.item_sku_mapping_version",
          )
        ).rows[0].n,
        "0",
      );
      await assert.rejects(
        reader.query("SELECT actor_id FROM rms_inventory.item_sku_mapping_version"),
        (e) => e.code === "42501",
      );
      await reader.query("ROLLBACK");
      for (const [tenant, brand] of [
        [id(60), id(2)],
        [id(1), id(62)],
      ]) {
        await reader.query("BEGIN");
        await reader.query(`SET LOCAL ROLE ${readRole}`);
        await bind(reader, tenant, brand);
        assert.equal(
          (
            await reader.query(
              "SELECT count(item_id)::text n FROM rms_inventory.item_sku_mapping_version",
            )
          ).rows[0].n,
          "0",
        );
        await reader.query("ROLLBACK");
      }
      assert.equal(
        (
          await admin.query(
            "SELECT has_function_privilege('public','rms_inventory.enforce_item_sku_mapping_version()','EXECUTE') allowed",
          )
        ).rows[0].allowed,
        false,
      );
      const trigger = (
        await admin.query(
          "SELECT prosecdef,proconfig FROM pg_proc WHERE oid='rms_inventory.enforce_item_sku_mapping_version()'::regprocedure",
        )
      ).rows[0];
      assert.equal(trigger.prosecdef, true);
      assert.ok(trigger.proconfig.includes("search_path=pg_catalog"));
      assert.ok(trigger.proconfig.includes("row_security=on"));
    } finally {
      await Promise.allSettled([admin.end(), reader.end(), writer.end()]);
    }
  });
});
