import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedCartRecipeInventory } from "../test-support/cart-recipe-inventory.mjs";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
import {
  createCustomerMenuQueryService,
  createPostgresCatalogSelectionService,
  createPostgresPublishedMenuQueryStore,
} from "../../rms/catalog/src/index.ts";
import { createCustomerMenuStoreFacts } from "../../../apps/api/src/customer-menu-store-facts.ts";
import {
  createCustomerCatalogInventoryPort,
  createCustomerInventoryEvidence,
  createStaffStockShortageSource,
} from "../../../apps/api/src/customer-menu-inventory-evidence.ts";
const { Client } = pg;
const id = (n) => "01902402-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-08-02T16:00:00.000Z";
const minute = (n) => new Date(Date.parse(at) + n * 60_000).toISOString();
const digest = "sha256:" + "a".repeat(64);

/**
 * WP-2423 Q12: an item shows sold out on the customer menu when its stocked ingredient runs out and
 * available again when the hold is released or stock is received — computed on each read, with no
 * stored sold-out rule. Catalog, Recipe and Inventory rows, the stock site and the ledger movements
 * are synthetic isolated fixtures (not a real Store receipt, count or approval); every read runs
 * as a NOBYPASSRLS role in a Repeatable Read, read-only transaction, as the customer runtime does.
 */
it("shows an item sold out while its ingredient stock cannot make one, and available again after release or receipt", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_stock_soldout" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_soldout_" + context.runId;
    let active = 0;
    const scope = { brandReference: id(2), storeReference: id(20) };
    const writeRunner = {
      async run(action) {
        const client = new Client(context.clientConfig);
        await client.connect();
        active++;
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          const result = await action({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
          active--;
        }
      },
    };
    let reads = 0;
    const readRunner = {
      async run(action) {
        const client = new Client(context.clientConfig);
        await client.connect();
        active++;
        reads++;
        try {
          await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          await client.query("SET LOCAL ROLE " + role);
          await client.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          const result = await action({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          return result;
        } finally {
          await client.query("ROLLBACK");
          await client.end();
          active--;
        }
      },
    };
    try {
      await seedPublishedItem(admin);
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS",
      );
      await admin.query("GRANT USAGE ON SCHEMA platform_helpers,platform_audit TO " + role);
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      // Starting stock: 100 kg of the one stocked ingredient; one item needs 2 kg.
      const inventoryScope = await seedCartRecipeInventory({
        admin,
        role,
        runner: writeRunner,
        id,
        at,
        skuReference: id(13),
        storeReference: scope.storeReference,
      });
      await admin.query("RESET ROLE");
      // Read-only access the customer menu runtime holds.
      for (const schema of ["rms_catalog", "rms_recipe", "rms_inventory", "rms_pricing"]) {
        await admin.query("GRANT USAGE ON SCHEMA " + schema + " TO " + role);
        await admin.query("GRANT SELECT ON ALL TABLES IN SCHEMA " + schema + " TO " + role);
      }
      const evidence = createCustomerInventoryEvidence({
        scope: inventoryScope,
        resolveExpiryCutoff: async () => {
          throw new Error("NoLot fixture");
        },
      });
      let now = minute(10);
      const menu = createCustomerMenuQueryService({
        stores: {
          resolvePublic: async () => ({ ...scope, status: "Active" }),
        },
        projections: createPostgresPublishedMenuQueryStore(readRunner, scope),
        storeFacts: createCustomerMenuStoreFacts({
          transactions: readRunner,
          currencyMetadata: {
            currencyCode: "CAD",
            minorUnitExponent: 2,
            metadataVersion: 1,
            metadataVersionReference: id(90),
            metadataDigest: digest,
          },
          priceChannelCode: "CUSTOMER_WEB",
          inventory: evidence,
        }),
      });
      const shown = async () => {
        const before = reads;
        const result = await menu.getPublishedMenu({
          publicStoreReference: id(21),
          channelCode: "CUSTOMER_PWA",
          orderTypeCode: "PICKUP",
          locale: "en-CA",
          sectionReference: null,
          searchTerm: null,
          requestedAt: now,
        });
        assert.equal(result.status, "Found");
        // Projection, then the Store's facts and stock together in one read-only transaction.
        assert.equal(reads - before, 2);
        const items = result.menu.sections.flatMap((section) => section.sellables);
        assert.equal(items.length, 1, "a sold-out item stays on the menu");
        return items[0].availability;
      };
      const port = createCustomerCatalogInventoryPort({
        evidence,
        transactions: readRunner,
        menuReference: id(1),
        sourceChannel: "Qr",
      });
      const safety = {
        clock: { now: () => now },
        killSwitch: {
          loadEvidence: async (request) => ({
            kind: "KillSwitch",
            brandReference: request.brandReference,
            storeReference: request.storeReference,
            sellableReference: request.sellableReference,
            status: "Clear",
            observedAt: request.observedAt,
            expiresAt: minute(1000),
            reasonCode: "SYNTHETIC_SAFETY",
          }),
        },
        inventory: port,
      };
      const selection = createPostgresCatalogSelectionService(
        readRunner,
        {
          ...scope,
          menuReference: id(1),
          sourceChannel: "Qr",
          orderType: "Pickup",
          channelCode: "CUSTOMER_PWA",
          orderTypeCode: "PICKUP",
        },
        safety,
      );
      const cart = async () =>
        (
          await selection.validateSelection({
            ...scope,
            sourceChannel: "Qr",
            orderType: "Pickup",
            sellableReference: id(13),
            observedAt: now,
            optionSelections: [],
          })
        ).status;

      // WP-2423 (2026-10-16): staff see the same stock answer as guests, with the reason.
      const staffStock = createStaffStockShortageSource({
        scope: inventoryScope,
        resolveExpiryCutoff: async () => {
          throw new Error("NoLot fixture");
        },
        menuReference: id(1),
      });
      const explained = async () =>
        (
          await readRunner.run((tx) =>
            staffStock.explain(tx, {
              ...scope,
              observedAt: now,
              sellableReferences: [id(13)],
            }),
          )
        ).get(id(13));
      assert.deepEqual(await explained(), { status: "Available", shortages: [] });

      assert.equal(await shown(), "Available");
      assert.equal(await cart(), "Accepted");

      const ledger = createLedger(admin, inventoryScope);
      // A paid order holds all 100 kg: nothing is available to make another.
      await ledger.move("Reserve", 100, minute(11));
      now = minute(12);
      assert.equal(await shown(), "SoldOut");
      {
        const reason = await explained();
        assert.equal(reason.status, "Unavailable");
        assert.equal(reason.shortages.length, 1);
        assert.deepEqual(
          {
            onHand: reason.shortages[0].onHand,
            reserved: reason.shortages[0].reserved,
            available: reason.shortages[0].available,
            required: reason.shortages[0].required,
            unitCode: reason.shortages[0].unitCode,
          },
          { onHand: "100", reserved: "100", available: "0", required: "2", unitCode: "KG" },
        );
        assert.ok(reason.shortages[0].name.length > 0);
      }
      assert.equal(await cart(), "Rejected");
      assert.deepEqual(
        await port.loadEvidence({
          ...scope,
          sellableReference: id(13),
          channelCode: "CUSTOMER_PWA",
          orderTypeCode: "PICKUP",
          observedAt: now,
        }),
        {
          kind: "Inventory",
          ...scope,
          sellableReference: id(13),
          status: "Unavailable",
          observedAt: now,
          expiresAt: minute(13),
          reasonCode: "STOCK_DEPLETED",
        },
      );
      // The hold is released (the order was cancelled): available again on the next read.
      await ledger.move("Release", -100, minute(13));
      now = minute(14);
      assert.equal(await shown(), "Available");
      assert.equal(await cart(), "Accepted");
      // 99 kg wasted: 1 kg left cannot make one (2 kg).
      await ledger.move("Waste", -99, minute(15));
      now = minute(16);
      assert.equal(await shown(), "SoldOut");
      {
        const reason = await explained();
        assert.equal(reason.status, "Unavailable");
        assert.equal(reason.shortages[0].onHand, "1");
        assert.equal(reason.shortages[0].reserved, "0");
        assert.equal(reason.shortages[0].available, "1");
      }
      assert.equal(await cart(), "Rejected");
      // A delivery is received: available again.
      await ledger.move("Receive", 5, minute(17));
      now = minute(18);
      assert.equal(await shown(), "Available");
      assert.equal(await cart(), "Accepted");

      // A manual sold out is unchanged by stock.
      await admin.query(
        "INSERT INTO rms_catalog.availability_rule(availability_rule_id,brand_id,internal_code,aggregate_version,lifecycle,sku_id,store_id,channel_codes_json,order_type_codes_json,effective_from,effective_until,decision,priority,reason_code,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_SOLD_OUT',1,'Active',$3,$4,'[]'::jsonb,'[]'::jsonb,$5,NULL,'Unavailable',900,'SOLD_OUT',$5,$6,$5)",
        [id(61), id(2), id(13), id(20), minute(18), id(3)],
      );
      now = minute(19);
      assert.equal(await shown(), "SoldOut");

      // Nothing was written by reading: no sold-out rule derived from stock, no hold taken.
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_catalog.availability_rule WHERE sku_id=$1",
            [id(13)],
          )
        ).rows[0].n,
        2,
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_inventory.stock_reservation_version",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(active, 0);
    } finally {
      await admin.query("RESET ROLE");
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end();
    }
  });
});

/** Synthetic append-only ledger movements on the ingredient's one account (isolated fixture). */
function createLedger(admin, scope) {
  let sequence = 40000;
  const next = () => id(++sequence);
  return {
    async move(type, delta, occurredAt) {
      const account = (
        await admin.query(
          "SELECT a.account_id::text AS account,a.location_id::text AS location,a.item_id::text AS item,b.ledger_version::int AS version,b.on_hand::numeric::float8 AS on_hand,b.reserved::numeric::float8 AS reserved FROM rms_inventory.stock_account a JOIN rms_inventory.stock_balance b USING (tenant_id,brand_id,store_id,account_id) WHERE a.tenant_id=$1 AND a.store_id=$2",
          [scope.tenantReference, scope.storeReference],
        )
      ).rows;
      assert.equal(account.length, 1);
      const [row] = account;
      const onHand = row.on_hand + (["Receive", "Waste"].includes(type) ? delta : 0);
      const reserved = row.reserved + (["Reserve", "Release"].includes(type) ? delta : 0);
      const balance = (h, r, v) => ({
        onHand: String(h),
        reserved: String(r),
        available: String(h - r),
        inTransit: "0",
        unitCode: "KG",
        ledgerVersion: v,
      });
      const location = { scopeType: "Location", scopeReference: row.location };
      const movement = next(),
        audit = next();
      const record = {
        movementReference: movement,
        tenantReference: scope.tenantReference,
        brandReference: scope.brandReference,
        itemReference: row.item,
        movementType: type,
        quantityDelta: String(delta),
        unitCode: "KG",
        baseQuantityDelta: String(delta),
        baseUnitCode: "KG",
        conversionMultiplier: "1",
        sourceScope: delta < 0 ? location : null,
        destinationScope: delta > 0 ? location : null,
        lotReference: null,
        expiryDate: null,
        businessSourceType: "SYNTHETIC_" + type.toUpperCase(),
        businessSourceReference: next(),
        reasonCode: "SYNTHETIC_TEST",
        performedBy: id(3),
        occurredAt,
        before: balance(row.on_hand, row.reserved, row.version),
        after: balance(onHand, reserved, row.version + 1),
        auditReference: audit,
        correctsMovementReference: null,
      };
      await admin.query("BEGIN");
      try {
        await admin.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [scope.tenantReference, scope.brandReference, scope.storeReference],
        );
        await admin.query(
          "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            scope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            row.account,
            movement,
            row.version + 1,
            type,
            String(delta),
            record,
            audit,
            occurredAt,
          ],
        );
        await appendAuditRecordInTransaction(
          { query: (sql, values) => admin.query(sql, [...values]) },
          {
            auditId: audit,
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "User", reference: id(3) },
            actionCode: "INVENTORY_" + type.toUpperCase(),
            targetType: "StockMovement",
            targetId: movement,
            reasonCode: "SYNTHETIC_TEST",
            correlationId: next(),
            occurredAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Internal",
            retentionPolicyCode: "SYNTHETIC_AUDIT",
            retentionPolicyVersion: 1,
          },
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      }
    },
  };
}

/** One published menu offering one SKU at the Store (synthetic isolated Catalog rows). */
async function seedPublishedItem(admin) {
  const q = (sql, values) => admin.query(sql, values);
  await q(
    `INSERT INTO rms_catalog.menu (menu_id,brand_id,internal_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'ALL_DAY',1,$3,$4,$3)`,
    [id(1), id(2), at, id(3)],
  );
  await q(
    `INSERT INTO rms_catalog.menu_version (menu_version_id,menu_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES ($1,$2,$3,'Draft','en-CA','{"en-CA":"All Day"}'::jsonb,$4,$4)`,
    [id(4), id(1), id(2), at],
  );
  await q(
    "INSERT INTO rms_catalog.menu_version_store(menu_version_id,menu_id,brand_id,store_id) VALUES($1,$2,$3,$4)",
    [id(4), id(1), id(2), id(20)],
  );
  await q(
    "INSERT INTO rms_catalog.menu_version_channel(menu_version_id,menu_id,brand_id,channel_code) VALUES($1,$2,$3,'CUSTOMER_PWA')",
    [id(4), id(1), id(2)],
  );
  await q(
    "INSERT INTO rms_catalog.menu_version_order_type(menu_version_id,menu_id,brand_id,order_type_code) VALUES($1,$2,$3,'PICKUP')",
    [id(4), id(1), id(2)],
  );
  await q(
    `INSERT INTO rms_catalog.menu_publication_revision (lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,snapshot_digest,state,validation_evidence_id,approval_evidence_id,changed_at) VALUES ($1,4,$2,$3,$4,$5,'Published',$6,$7,$8)`,
    [id(5), id(1), id(4), id(2), digest, id(6), id(7), at],
  );
  await q(
    `INSERT INTO rms_catalog.menu_publication_release (release_id,lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,release_sequence,release_kind,snapshot_digest,created_at) VALUES ($1,$2,4,$3,$4,$5,1,'Publish',$6,$7)`,
    [id(8), id(5), id(1), id(4), id(2), digest, at],
  );
  await q(
    `INSERT INTO rms_catalog.published_menu_projection_generation (generation_id,brand_id,menu_id,projection_name,projection_version,generation_status,source_event_id,source_aggregate_version,source_checkpoint,last_rebuilt_at,freshness_status) VALUES ($1,$2,$3,'catalog_published_menu_v1',1,'Active',$4,4,$4,$5,'Fresh')`,
    [id(9), id(2), id(1), id(10), at],
  );
  await q(
    `INSERT INTO rms_catalog.published_menu_projection (generation_id,brand_id,menu_id,menu_version_id,release_id,snapshot_digest,default_locale,localized_names_json,store_ids_json,channel_codes_json,order_type_codes_json,time_zone,effective_from) VALUES ($1,$2,$3,$4,$5,$6,'en-CA','{"en-CA":"All Day"}'::jsonb,$8::jsonb,'["CUSTOMER_PWA"]'::jsonb,'["PICKUP"]'::jsonb,'UTC',$7)`,
    [id(9), id(2), id(1), id(4), id(8), digest, at, JSON.stringify([id(20)])],
  );
  await q(
    `INSERT INTO rms_catalog.published_menu_projection_section (generation_id,brand_id,menu_id,section_id,internal_code,localized_names_json,sort_order) VALUES ($1,$2,$3,$4,'BOWLS','{"en-CA":"Bowls"}'::jsonb,0)`,
    [id(9), id(2), id(1), id(11)],
  );
  await q(
    `INSERT INTO rms_catalog.published_menu_projection_sellable (generation_id,brand_id,menu_id,section_id,placement_id,sellable_id,product_version_id,localized_names_json,presentation_role,sort_order,pinned,configured_availability,option_rules_json,allergen_disclosure_json) VALUES ($1,$2,$3,$4,$5,$6,$7,'{"en-CA":"Rice bowl"}'::jsonb,'Standard',0,false,'Available','[]'::jsonb,'{"registryVersionReference":"018f7300-0000-7000-8000-000000000019","items":[],"allergenFreeClaim":false,"assistanceCode":"ALLERGEN_ASSISTANCE_REQUIRED"}'::jsonb)`,
    [id(9), id(2), id(1), id(11), id(12), id(13), id(14)],
  );
  await q(
    `INSERT INTO rms_catalog.published_menu_projection_checkpoint (consumer_name,brand_id,menu_id,active_generation_id,source_event_id,source_aggregate_version,projected_at) VALUES ('catalog.published-menu-projection',$1,$2,$3,$4,4,$5)`,
    [id(2), id(1), id(9), id(10), at],
  );
  await q(
    "INSERT INTO rms_catalog.menu_release_effective_period(timing_version_id,release_id,menu_id,brand_id,time_zone,effective_from,effective_until,period_digest,approval_evidence_id,created_at) VALUES($1,$2,$3,$4,'UTC',$5,NULL,$6,$7,$5)",
    [id(50), id(8), id(1), id(2), at, digest, id(7)],
  );
  await q(
    "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC','PreparedFood','Active',1,$3,$4,$3)",
    [id(40), id(2), at, id(3)],
  );
  await q(
    "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$5)",
    [id(14), id(40), id(2), JSON.stringify({ "en-CA": "Synthetic product" }), at],
  );
  await q(
    "INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,'SYNTHETIC','Active',$5::jsonb,'[]'::jsonb,$6,'EACH',1,$7,$8)",
    [
      id(13),
      id(40),
      id(2),
      id(14),
      JSON.stringify({ "en-CA": "Synthetic SKU" }),
      digest,
      at,
      id(3),
    ],
  );
  // The Store offers the item (a Store availability rule, as CAT-AVAILABILITY "Offer" creates).
  await q(
    "INSERT INTO rms_catalog.availability_rule(availability_rule_id,brand_id,internal_code,aggregate_version,lifecycle,sku_id,store_id,channel_codes_json,order_type_codes_json,effective_from,effective_until,decision,priority,reason_code,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_OFFER',1,'Active',$3,$4,'[]'::jsonb,'[]'::jsonb,$5,NULL,'Available',100,'STORE_OFFERED',$5,$6,$5)",
    [id(60), id(2), id(13), id(20), at, id(3)],
  );
}
