import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import {
  createInventoryItem,
  transitionInventoryItem,
  createPostgresInventoryRecipeConfigurationSource,
} from "../../rms/inventory/src/index.ts";
import { parseRecipeSourceCoverage } from "../../rms/recipe/src/index.ts";
import { ensureSyntheticStockPlace } from "./stock-place.mjs";
/** Actual Inventory source/storage/locks; synthetic authority/item/received-stock facts only. */
export async function exerciseInventoryRecipeCoverage({ admin, context, role, id, scope, at }) {
  await admin.query(`GRANT USAGE ON SCHEMA rms_inventory TO ${role}`);
  await admin.query(
    `GRANT SELECT ON rms_inventory.inventory_item,rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation TO ${role}`,
  );
  await admin.query(
    `GRANT MAINTAIN ON rms_inventory.inventory_item,rms_inventory.inventory_item_version,rms_inventory.inventory_item_operation TO ${role}`,
  );
  await admin.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON rms_inventory.recipe_configuration_source_version,rms_inventory.recipe_configuration_source_capture TO ${role}`,
  );
  let sequence = 31000,
    allowed = true;
  const request = { actorReference: id(3), purpose: "RecipeProjectionBuild", observedAtUtc: at };
  function runner(failCapture = false) {
    return {
      async run(work) {
        const client = new pg.Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL ROLE ${role}`);
          const result = await work({
            query: async (sql, values) => {
              if (
                failCapture &&
                sql.startsWith("INSERT INTO rms_inventory.recipe_configuration_source_capture")
              )
                throw Error("synthetic seal failure");
              return client.query(sql, [...values]);
            },
          });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      },
    };
  }
  function source(failure = false) {
    return createPostgresInventoryRecipeConfigurationSource({
      runner: runner(failure),
      scope,
      generateReference: () => id(++sequence),
      authorize: async (_tx, input) =>
        allowed &&
        input.actorReference === id(3) &&
        input.tenantReference === scope.tenantReference &&
        input.brandReference === scope.brandReference &&
        input.family === "Inventory" &&
        input.purpose === "RecipeProjectionBuild",
    });
  }
  const empty = await source().capture(request);
  assert.equal(empty.coverage.dependencies.length, 0);
  assert.deepEqual(parseRecipeSourceCoverage(empty.coverage), empty.coverage);
  assert.equal(
    (await source().capture(request)).coverage.snapshotReference,
    empty.coverage.snapshotReference,
  );
  function item(n) {
    return createInventoryItem({
      itemReference: id(n),
      ...scope,
      internalCode: `SYNTHETIC_SOURCE_${n}`,
      itemType: "RawMaterial",
      localizedNames: { en: "Synthetic configuration source item" },
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
      occurredAt: at,
      actorReference: id(3),
    });
  }
  async function seed(client, snapshot) {
    await client.query("BEGIN");
    try {
      await client.query(
        "INSERT INTO rms_inventory.inventory_item(tenant_id,brand_id,item_id,internal_code,item_type,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          scope.tenantReference,
          scope.brandReference,
          snapshot.itemReference,
          snapshot.internalCode,
          snapshot.itemType,
          snapshot.createdAt,
          snapshot.createdBy,
        ],
      );
      await client.query(
        "INSERT INTO rms_inventory.inventory_item_version(tenant_id,brand_id,item_id,version,snapshot_json,recorded_at) VALUES($1,$2,$3,1,$4::jsonb,$5)",
        [
          scope.tenantReference,
          scope.brandReference,
          snapshot.itemReference,
          JSON.stringify(snapshot),
          at,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  const first = item(30000);
  await seed(admin, first);
  await assert.rejects(
    source().withCurrent(request, empty, async () => null),
    (error) => error.code === "INVENTORY_SOURCE_CHANGED",
  );
  const initial = await source().capture(request);
  assert.equal(initial.coverage.dependencies.length, 1);
  assert.equal(
    (await source().capture(request)).coverage.snapshotReference,
    initial.coverage.snapshotReference,
  );
  const active = transitionInventoryItem(first, "Active", {
    expectedVersion: 1,
    hasOpenWork: false,
    hasNonZeroStock: false,
    occurredAt: at,
    actorReference: id(3),
  });
  const writer = new pg.Client(context.clientConfig);
  await writer.connect();
  async function held(captured, mutation) {
    let release, ready;
    const hold = new Promise((resolve) => {
        release = resolve;
      }),
      acquired = new Promise((resolve) => {
        ready = resolve;
      });
    const reading = source().withCurrent(request, captured, async () => {
      ready();
      await hold;
      return "held";
    });
    try {
      await acquired;
      const writing = Promise.resolve()
        .then(mutation)
        .then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        );
      try {
        let blocked = false;
        for (let n = 0; n < 100; n += 1) {
          const row = (
            await admin.query("SELECT wait_event_type AS kind FROM pg_stat_activity WHERE pid=$1", [
              writer.processID,
            ])
          ).rows[0];
          if (row?.kind === "Lock") {
            blocked = true;
            break;
          }
          await delay(10);
        }
        assert.equal(blocked, true);
      } finally {
        release();
      }
      await reading;
      const outcome = await writing;
      if (!outcome.ok) throw outcome.error;
    } finally {
      release();
      await reading.catch(() => undefined);
    }
  }
  try {
    await writer.query("SET lock_timeout='5s'");
    await held(initial, () =>
      writer.query(
        "INSERT INTO rms_inventory.inventory_item_version(tenant_id,brand_id,item_id,version,snapshot_json,recorded_at) VALUES($1,$2,$3,2,$4::jsonb,$5)",
        [
          scope.tenantReference,
          scope.brandReference,
          first.itemReference,
          JSON.stringify(active),
          at,
        ],
      ),
    );
    const beforeSequence = sequence;
    await assert.rejects(
      source().withCurrent(request, initial, async () => null),
      (error) => error.code === "INVENTORY_SOURCE_CHANGED",
    );
    assert.equal(sequence, beforeSequence);
    const beforeFailure = (
      await admin.query(
        "SELECT count(*)::int AS count FROM rms_inventory.recipe_configuration_source_version",
      )
    ).rows[0].count;
    await assert.rejects(
      source(true).capture(request),
      (error) => error.code === "INVENTORY_SOURCE_UNAVAILABLE",
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM rms_inventory.recipe_configuration_source_version",
        )
      ).rows[0].count,
      beforeFailure,
    );
    const updated = await source().capture(request);
    assert.equal(updated.coverage.dependencies.length, 2);
    assert.equal(
      updated.coverage.dependencies.find(
        (entry) => entry.versionReference === initial.coverage.dependencies[0].versionReference,
      )?.digest,
      initial.coverage.dependencies[0].digest,
    );
    await ensureSyntheticStockPlace(admin, {
      tenantId: scope.tenantReference,
      brandId: scope.brandReference,
      storeId: id(30010),
      stockSiteId: id(30011),
      locationId: id(30012),
      at,
    });
    await admin.query(
      "INSERT INTO rms_inventory.stock_account(tenant_id,brand_id,store_id,stock_site_id,location_id,account_id,item_id,item_version,unit_code,ledger_precision,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,2,'KG',4,$8)",
      [
        scope.tenantReference,
        scope.brandReference,
        id(30010),
        id(30011),
        id(30012),
        id(30013),
        first.itemReference,
        at,
      ],
    );
    await admin.query(
      "INSERT INTO rms_inventory.stock_balance(tenant_id,brand_id,store_id,account_id,ledger_version,on_hand,reserved,in_transit) VALUES($1,$2,$3,$4,1,0,0,0)",
      [scope.tenantReference, scope.brandReference, id(30010), id(30013)],
    );
    const movement = {
      ...scope,
      movementReference: id(30014),
      movementType: "Receive",
      baseQuantityDelta: "1",
      auditReference: id(30015),
      occurredAt: at,
      performedBy: id(3),
      itemReference: first.itemReference,
      lotReference: null,
      expiryDate: null,
      baseUnitCode: "KG",
      sourceScope: null,
      destinationScope: { scopeType: "Location", scopeReference: id(30012) },
      before: {
        onHand: "0",
        reserved: "0",
        available: "0",
        inTransit: "0",
        unitCode: "KG",
        ledgerVersion: 1,
      },
      after: {
        onHand: "1",
        reserved: "0",
        available: "1",
        inTransit: "0",
        unitCode: "KG",
        ledgerVersion: 2,
      },
    };
    await held(updated, () =>
      writer.query(
        "INSERT INTO rms_inventory.stock_movement(tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES($1,$2,$3,$4,$5,2,'Receive',1,$6::jsonb,$7,$8)",
        [
          scope.tenantReference,
          scope.brandReference,
          id(30010),
          id(30013),
          movement.movementReference,
          JSON.stringify(movement),
          movement.auditReference,
          at,
        ],
      ),
    );
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int AS count FROM rms_inventory.inventory_item_operation WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 AND version=3",
          [scope.tenantReference, scope.brandReference, first.itemReference],
        )
      ).rows[0].count,
      0,
    );
    await assert.rejects(
      source().withCurrent(request, updated, async () => null),
      (error) => error.code === "INVENTORY_SOURCE_CHANGED",
    );
    const moved = await source().capture(request);
    assert.equal(moved.coverage.dependencies.length, 3);
    assert.equal(
      (
        await admin.query(
          "SELECT snapshot_json->>'hasMovementHistory' AS moved FROM rms_inventory.inventory_item_version WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 AND version=3",
          [scope.tenantReference, scope.brandReference, first.itemReference],
        )
      ).rows[0].moved,
      "true",
    );
    await held(moved, () => seed(writer, item(30100)));
    const both = await source().capture(request);
    assert.equal(both.coverage.dependencies.length, 4);
    assert.equal(
      (await source().capture(request)).coverage.snapshotReference,
      both.coverage.snapshotReference,
    );
    const operation = id(30200),
      auditReference = id(30201);
    const audit = {
      auditId: auditReference,
      brandId: scope.brandReference,
      actor: { type: "User", reference: id(3) },
      actionCode: "INVENTORY_ITEM_CREATE",
      targetType: "InventoryItem",
      targetId: first.itemReference,
      reasonCode: "AUTHORIZED_CHANGE",
      correlationId: operation,
      occurredAt: at,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Internal",
      retentionPolicyCode: "SYNTHETIC_AUDIT",
      retentionPolicyVersion: 1,
    };
    await held(both, () =>
      writer.query(
        "INSERT INTO rms_inventory.inventory_item_operation(tenant_id,brand_id,operation_id,item_id,version,intent_hash,action,audit_id,audit_json) VALUES($1,$2,$3,$4,1,$5,'Create',$6,$7::jsonb)",
        [
          scope.tenantReference,
          scope.brandReference,
          operation,
          first.itemReference,
          `sha256:${"a".repeat(64)}`,
          auditReference,
          JSON.stringify(audit),
        ],
      ),
    );
    await assert.rejects(
      source().withCurrent(request, both, async () => null),
      (error) => error.code === "INVENTORY_SOURCE_CHANGED",
    );
    const configured = await source().capture(request);
    assert.equal(configured.coverage.dependencies.length, 5);
    assert.equal(
      configured.coverage.dependencies.find((entry) => entry.versionReference === operation)
        ?.digest,
      initial.coverage.dependencies[0].digest,
    );
    await assert.rejects(
      source().withCurrent(request, configured, async () => {
        throw Error("synthetic callback failure");
      }),
      (error) => error.code === "INVENTORY_SOURCE_UNAVAILABLE",
    );
    assert.equal(
      (await source().capture(request)).coverage.snapshotReference,
      configured.coverage.snapshotReference,
    );
    await assert.rejects(
      source().withCurrent(request, configured, async () => {
        allowed = false;
        return "private";
      }),
      (error) => error.code === "INVENTORY_SOURCE_PERMISSION_DENIED",
    );
    allowed = true;
    await admin.query(`SET ROLE ${role}`);
    await admin.query(
      "SELECT set_config('bop.tenant_id',$1,false),set_config('bop.brand_id',$2,false)",
      [scope.tenantReference, scope.brandReference],
    );
    await assert.rejects(
      admin.query(
        "UPDATE rms_inventory.recipe_configuration_source_version SET content_digest=$1",
        [`sha256:${"f".repeat(64)}`],
      ),
      (error) => error.code === "55000",
    );
    await assert.rejects(
      admin.query("DELETE FROM rms_inventory.recipe_configuration_source_capture"),
      (error) => error.code === "55000",
    );
    await admin.query("SELECT set_config('bop.tenant_id',$1,false)", [id(30999)]);
    assert.equal(
      (await admin.query("SELECT * FROM rms_inventory.recipe_configuration_source_capture"))
        .rowCount,
      0,
    );
    assert.equal(
      (await admin.query("SELECT * FROM rms_inventory.recipe_configuration_source_version"))
        .rowCount,
      0,
    );
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await writer.end();
  }
}
