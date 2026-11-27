import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { it } from "vitest";
import {
  createInventoryItem,
  createPostgresInventoryConfigurationReferenceSourceStore,
  inventoryConfigurationReferenceFields,
  inventoryConfigurationReferencePermissions,
  InventoryItemError,
} from "../../rms/inventory/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const { Client } = pg;
const id = (n) => `01902418-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const past = "2026-08-01T00:00:00.000Z",
  hash = "sha256:" + "a".repeat(64);
const tables = ["inventory_item", "inventory_item_version", "inventory_item_operation"];
const rootInsert =
  "INSERT INTO rms_inventory.inventory_item(tenant_id,brand_id,item_id,internal_code,item_type,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,'FinishedGood',$5,$6)";
const versionInsert =
  "INSERT INTO rms_inventory.inventory_item_version(tenant_id,brand_id,item_id,version,snapshot_json,recorded_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)";
const operationInsert =
  "INSERT INTO rms_inventory.inventory_item_operation(tenant_id,brand_id,operation_id,item_id,version,intent_hash,action,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)";
const rootArgs = (item = 10, tenant = 4, brand = 1) => [
  id(tenant),
  id(brand),
  id(item),
  "SYNTHETIC_ITEM_" + item,
  past,
  id(2),
];
function snapshot(item = 10, version = 1, tenant = 4, brand = 1) {
  return {
    ...createInventoryItem({
      tenantReference: id(tenant),
      brandReference: id(brand),
      itemReference: id(item),
      internalCode: "SYNTHETIC_ITEM_" + item,
      itemType: "FinishedGood",
      localizedNames: { en: "Synthetic item" },
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
      actorReference: id(2),
    }),
    aggregateVersion: version,
    lifecycle: version === 1 ? "Inactive" : version === 2 ? "Archived" : "Active",
  };
}
const versionArgs = (version = 1, item = 10, tenant = 4, brand = 1) => [
  id(tenant),
  id(brand),
  id(item),
  version,
  JSON.stringify(snapshot(item, version, tenant, brand)),
  past,
];
const operationArgs = (version = 1, item = 10, tenant = 4, brand = 1) => [
  id(tenant),
  id(brand),
  id(item * 100 + version),
  id(item),
  version,
  hash,
  version === 1 ? "Create" : version === 2 ? "Archive" : "Restore",
  id(item * 100 + version + 10000),
];
async function seed(client, item = 10, tenant = 4, brand = 1) {
  await client.query(rootInsert, rootArgs(item, tenant, brand));
  for (const version of [1, 2]) {
    await client.query(versionInsert, versionArgs(version, item, tenant, brand));
    await client.query(operationInsert, operationArgs(version, item, tenant, brand));
  }
}
it("holds minimal Inventory configuration operations through caller COMMIT and full Tenant/Brand scope", async () => {
  await withIsolatedDatabase({ caseId: "inv_config_refs", root }, async (context) => {
    const admin = new Client(context.clientConfig),
      reader = new Client(context.clientConfig),
      writer = new Client(context.clientConfig);
    await Promise.all([admin.connect(), reader.connect(), writer.connect()]);
    const role = `wp2418_${context.runId}`,
      request = {
        purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ",
        tenantReference: id(4),
        brandReference: id(1),
        actorReference: id(2),
        operationReference: id(3),
        catalogIntentDigest: hash,
      };
    let deny = false,
      seeded = false,
      nextVersion = 3,
      now = () => new Date().toISOString();
    const scope = (client, tenant = id(4), brand = id(1), store = "") =>
      client.query(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [tenant, brand, store],
      );
    const barrier = "InventoryCatalogReferenceV1:" + id(4) + ":" + id(1);
    async function blocked(
      sql = "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      values = [barrier],
    ) {
      await writer.query("BEGIN");
      await scope(writer);
      await writer.query("SET LOCAL lock_timeout='150ms'");
      try {
        await assert.rejects(writer.query(sql, values), (e) => e.code === "55P03");
      } finally {
        await writer.query("ROLLBACK");
      }
    }
    const transactions = {
      async run(work) {
        await reader.query("BEGIN");
        await reader.query(`SET LOCAL ROLE ${role}`);
        try {
          const result = await work(reader);
          await blocked(rootInsert, rootArgs(12));
          if (seeded) await blocked(versionInsert, versionArgs(nextVersion));
          await reader.query("COMMIT");
          return result;
        } catch (e) {
          await reader.query("ROLLBACK");
          throw e;
        }
      },
    };
    const options = {
      tenantReference: id(4),
      brandReference: id(1),
      actorReference: id(2),
      transactions,
      clock: { now: () => now() },
      authority: {
        async holdUntilTransactionCompletes(actual, input) {
          assert.equal(actual, reader);
          assert.deepEqual(input.request, request);
          assert.deepEqual(input.requiredPermissions, inventoryConfigurationReferencePermissions);
          assert.equal(input.requiredScope, "FullBrandScope");
          assert.deepEqual(input.requiredFields, inventoryConfigurationReferenceFields);
          if (deny) throw new InventoryItemError("INVENTORY_ITEM_PERMISSION_DENIED");
        },
      },
    };
    const source = () => createPostgresInventoryConfigurationReferenceSourceStore(options);
    const generation = async () =>
      (
        await admin.query(
          "SELECT generation::text FROM rms_inventory.configuration_reference_generation WHERE tenant_id=$1 AND brand_id=$2",
          [id(4), id(1)],
        )
      ).rows[0].generation;
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA rms_inventory,platform_helpers TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO ${role}`,
      );
      const columns = {
        inventory_item: ["tenant_id", "brand_id", "item_id", "item_type", "created_at"],
        inventory_item_version: [
          "tenant_id",
          "brand_id",
          "item_id",
          "version",
          "snapshot_json",
          "recorded_at",
        ],
        inventory_item_operation: [
          "tenant_id",
          "brand_id",
          "item_id",
          "version",
          "operation_id",
          "action",
        ],
        configuration_reference_generation: ["tenant_id", "brand_id", "generation"],
      };
      for (const [table, fields] of Object.entries(columns))
        await admin.query(`GRANT SELECT(${fields.join(",")}) ON rms_inventory.${table} TO ${role}`);
      assert.equal((await source().withCurrentSnapshot(request, async (s) => s)).items.length, 0);
      await admin.query("BEGIN");
      await seed(admin);
      await seed(admin, 10, 60, 1);
      await seed(admin, 10, 4, 60);
      await admin.query("COMMIT");
      seeded = true;
      let beforeDigest;
      await source().withCurrentSnapshot(request, async (s) => {
        assert.equal(s.items.length, 1);
        assert.equal(s.versions.length, 2);
        assert.equal(s.operations.length, 2);
        assert.equal(s.items[0].currentItemVersion, 2);
        assert.equal(s.items[0].currentOperationReference, id(1002));
        assert.equal(s.sourceVersionKind, "InventoryItemConfigurationOperation");
        assert.equal(s.directSkuMappingCoverage, "Unavailable");
        assert.deepEqual(
          s.versions.map((v) => v.lifecycle),
          ["Inactive", "Archived"],
        );
        for (const key of [
          "baseUnit",
          "localizedNames",
          "trackingPolicy",
          "auditId",
          "snapshot_json",
          "reorderPolicies",
        ])
          assert(!JSON.stringify(s).includes(key));
        beforeDigest = s.digest;
        await blocked(rootInsert, rootArgs(12));
        await blocked(versionInsert, versionArgs(3));
        await scope(reader, id(60), id(60), id(99));
      });
      assert.equal(
        await source().withCurrentSnapshot(request, async (s) => s.digest),
        beforeDigest,
      );
      for (const [sql, args] of [
        [rootInsert, rootArgs(12)],
        [versionInsert, versionArgs(3)],
      ]) {
        await writer.query("BEGIN");
        await scope(writer);
        assert.equal((await writer.query(sql, args)).rowCount, 1);
        await writer.query("ROLLBACK");
      }
      // A valid operation INSERT requires a pre-existing version without its operation. It is
      // therefore probed independently under the same physical shared barrier, then completed.
      await admin.query(versionInsert, versionArgs(3));
      let called = false;
      await assert.rejects(
        source().withCurrentSnapshot(request, async () => {
          called = true;
        }),
        (e) => e.code === "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
      );
      assert.equal(called, false);
      await reader.query("BEGIN");
      await reader.query(`SET LOCAL ROLE ${role}`);
      await scope(reader);
      await reader.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [barrier]);
      await blocked(operationInsert, operationArgs(3));
      await reader.query("COMMIT");
      const beforeOperation = await generation();
      await writer.query("BEGIN");
      await scope(writer);
      assert.equal((await writer.query(operationInsert, operationArgs(3))).rowCount, 1);
      await writer.query("COMMIT");
      assert.equal(await generation(), String(BigInt(beforeOperation) + 1n));
      nextVersion = 4;
      assert.equal(
        await source().withCurrentSnapshot(request, async (s) => s.items[0].currentItemVersion),
        3,
      );
      for (const [table, column] of [
        ["inventory_item", "internal_code"],
        ["inventory_item", "created_by_actor_id"],
        ["inventory_item_operation", "audit_json"],
        ["inventory_item_operation", "audit_id"],
        ["inventory_item_operation", "intent_hash"],
        ["stock_balance", "on_hand"],
      ])
        assert.equal(
          (
            await admin.query("SELECT has_column_privilege($1,$2,$3,'SELECT') allowed", [
              role,
              "rms_inventory." + table,
              column,
            ])
          ).rows[0].allowed,
          false,
        );
      assert.equal(
        (
          await admin.query(
            "SELECT has_table_privilege($1,'rms_inventory.configuration_reference_generation','UPDATE') allowed",
            [role],
          )
        ).rows[0].allowed,
        false,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT has_function_privilege($1,'rms_inventory.advance_configuration_reference_generation()','EXECUTE') allowed",
            [role],
          )
        ).rows[0].allowed,
        false,
      );
      const proc = (
        await admin.query(
          "SELECT prosecdef,proconfig FROM pg_proc WHERE oid='rms_inventory.advance_configuration_reference_generation()'::regprocedure",
        )
      ).rows[0];
      assert(proc.prosecdef);
      assert(proc.proconfig.includes("search_path=pg_catalog"));
      assert(proc.proconfig.includes("row_security=on"));
      assert.deepEqual(
        (
          await admin.query(
            "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='rms_inventory.configuration_reference_generation'::regclass",
          )
        ).rows[0],
        { relrowsecurity: true, relforcerowsecurity: true },
      );
      await admin.query(`GRANT INSERT ON rms_inventory.inventory_item TO ${role}`);
      await writer.query("BEGIN");
      await writer.query(`SET LOCAL ROLE ${role}`);
      await scope(writer, id(4), id(1), id(99));
      assert.equal((await writer.query(rootInsert, rootArgs(12))).rowCount, 1);
      assert.deepEqual(
        (
          await writer.query(
            "SELECT current_setting('bop.tenant_id') tenant,current_setting('bop.brand_id') brand,current_setting('bop.store_id') store",
          )
        ).rows[0],
        { tenant: id(4), brand: id(1), store: id(99) },
      );
      assert.equal(
        (
          await writer.query(
            "SELECT count(tenant_id)::text n FROM rms_inventory.configuration_reference_generation",
          )
        ).rows[0].n,
        "0",
      );
      await writer.query("ROLLBACK");
      await assert.rejects(
        source().withCurrentSnapshot(request, async () => {
          deny = true;
        }),
        (e) => e.code === "INVENTORY_ITEM_PERMISSION_DENIED",
      );
      deny = false;
      await assert.rejects(
        source().withCurrentSnapshot(request, async () => {
          now = () => new Date(Date.now() + 6000).toISOString();
        }),
        (e) => e.code === "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
      );
      now = () => new Date().toISOString();
      // Owning callback source mutation is rejected by final generation, and rolled back.
      const before = await generation();
      await assert.rejects(
        source().withCurrentSnapshot(request, async () => {
          await reader.query(rootInsert, rootArgs(12));
          await scope(reader, id(60), id(60), id(99));
          return true;
        }),
        (e) => e.code === "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
      );
      assert.equal(await generation(), before);
      for (const table of tables) {
        await assert.rejects(
          admin.query(`UPDATE rms_inventory.${table} SET brand_id=brand_id`),
          (e) => e.code === "55000",
        );
        await assert.rejects(
          admin.query(`DELETE FROM rms_inventory.${table}`),
          (e) => e.code === "55000",
        );
        await assert.rejects(
          admin.query(`TRUNCATE rms_inventory.${table} CASCADE`),
          (e) => e.code === "55000",
        );
      }
      await admin.query("BEGIN");
      await admin.query(
        "DROP TRIGGER item_sku_mapping_version_configuration_reference_fence ON rms_inventory.item_sku_mapping_version",
      );
      for (const table of tables)
        await admin.query(
          `DROP TRIGGER ${table}_configuration_reference_fence ON rms_inventory.${table}`,
        );
      await admin.query(
        "DROP FUNCTION rms_inventory.advance_configuration_reference_generation(); DROP TABLE rms_inventory.configuration_reference_generation",
      );
      await admin.query(
        await readFile(
          path.join(
            root,
            "migrations/1900-rms-inventory/1900_012_create_configuration_reference_generation.sql",
          ),
          "utf8",
        ),
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT tenant_id::text,brand_id::text,generation::text FROM rms_inventory.configuration_reference_generation ORDER BY tenant_id,brand_id",
          )
        ).rows,
        [
          { tenant_id: id(4), brand_id: id(1), generation: "0" },
          { tenant_id: id(4), brand_id: id(60), generation: "0" },
          { tenant_id: id(60), brand_id: id(1), generation: "0" },
        ],
      );
      await admin.query("ROLLBACK");
      await admin.query("BEGIN");
      await admin.query(
        "UPDATE rms_inventory.configuration_reference_generation SET generation=9223372036854775807 WHERE tenant_id=$1 AND brand_id=$2",
        [id(4), id(1)],
      );
      await assert.rejects(admin.query(rootInsert, rootArgs(12)), (e) => e.code === "22003");
      await admin.query("ROLLBACK");
      const saved = (
        await admin.query(
          "DELETE FROM rms_inventory.configuration_reference_generation WHERE tenant_id=$1 AND brand_id=$2 RETURNING *",
          [id(4), id(1)],
        )
      ).rows[0];
      try {
        called = false;
        await assert.rejects(
          source().withCurrentSnapshot(request, async () => {
            called = true;
          }),
          (e) => e.code === "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
        );
        assert.equal(called, false);
        await assert.rejects(admin.query(rootInsert, rootArgs(12)), (e) => e.code === "55000");
      } finally {
        await admin.query(
          "INSERT INTO rms_inventory.configuration_reference_generation SELECT * FROM jsonb_populate_record(NULL::rms_inventory.configuration_reference_generation,$1::jsonb)",
          [JSON.stringify(saved)],
        );
      }
    } finally {
      await Promise.allSettled([
        admin.query("ROLLBACK"),
        reader.query("ROLLBACK"),
        writer.query("ROLLBACK"),
      ]);
      await Promise.allSettled([admin.end(), reader.end(), writer.end()]);
    }
  });
});
