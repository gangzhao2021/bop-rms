import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createMerchantAvailability } from "../../../apps/api/src/merchant-availability.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { productApiGrants } from "../test-support/merchant-api-grants.mjs";
import { syntheticMerchantBrandScope } from "../test-support/merchant-brand-scope.mjs";

const { Client } = pg;
const id = (n) => "01909a1f-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** The pilot API role's grants for Store item availability (docs/spec/pilot-acl-additions.json). */
export const availabilityApiGrants = [
  "GRANT SELECT,INSERT,UPDATE ON rms_catalog.availability_rule TO ROLE_",
  "GRANT SELECT,INSERT ON rms_catalog.availability_rule_operation_record,rms_catalog.availability_rule_operation_snapshot TO ROLE_",
];

/** WP-2423 8.5: offer an item at a Store, sell out, back in stock, stop offering — under RLS. */
it("manages which items a Store sells with Brand and Store authority", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_availability" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_avail_" + context.runId;
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      manager = id(5),
      cashier = id(6),
      sku = id(12),
      at = "2026-09-20T00:00:00.000Z",
      names = JSON.stringify({ "en-CA": "Mocha" });
    // 2026-10-07 21:00 in Toronto; the business day ends at 2026-10-08T04:00Z.
    let clock = Date.parse("2026-10-08T01:00:00.000Z");
    const now = () => new Date((clock += 1000)).toISOString();
    let reference = 0x9000;
    const next = () => "019a0000-0000-7000-8000-" + (++reference).toString(16).padStart(12, "0");
    try {
      await admin.query(
        "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'MOCHA','PreparedFood','Active',1,$3,$4,$3)",
        [id(10), brandReference, at, owner],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$5)",
        [id(11), id(10), brandReference, names, at],
      );
      await admin.query(
        `INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,'MOCHA-REGULAR-12-OZ','Active','{"en-CA":"Regular (12 oz)"}'::jsonb,'[]'::jsonb,$5,'EACH',1,$6,$7)`,
        [sku, id(10), brandReference, id(11), "sha256:" + "a".repeat(64), at, owner],
      );
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      for (const sql of [...productApiGrants, ...availabilityApiGrants])
        await admin.query(sql.replaceAll("ROLE_", role));
      const persistence = {
        now,
        transactions: {
          async run(work) {
            await admin.query("BEGIN");
            try {
              await admin.query("SET LOCAL ROLE " + role);
              const value = await work(admin);
              await admin.query("COMMIT");
              return value;
            } catch (error) {
              await admin.query("ROLLBACK");
              throw error;
            }
          },
        },
      };
      const manage = ["catalog.sku.read", "catalog.sku.availability.manage"];
      const scope = syntheticMerchantBrandScope({
        tenantReference,
        brandReference,
        storeReference,
        policyReference: id(300),
        grants: { [owner]: manage, [manager]: [], [cashier]: [] },
        storeGrants: { [manager]: manage, [cashier]: [] },
      });
      const availability = createMerchantAvailability({
        persistence,
        authentication: { authorize: async () => ({ sessionReference: id(7) }) },
        references: { next },
        locale: "en-CA",
        resolveScope: scope.resolveScope,
      });
      const call = (body) => availability.command({ sessionCookie: "s", csrf: "c", body });
      const status = async () =>
        (await availability.query({ sessionCookie: "s", csrf: "c" })).items[0];

      assert.deepEqual(await status(), {
        skuReference: sku,
        skuCode: "MOCHA-REGULAR-12-OZ",
        productName: "Mocha",
        sizeName: "Regular (12 oz)",
        status: "NotOffered",
        soldOutUntil: null,
      });
      // Store authority never offers an item.
      scope.as(manager);
      await assert.rejects(
        call({ action: "Offer", operationReference: next(), skuReference: sku }),
        {
          code: "PermissionDenied",
        },
      );
      scope.as(owner);
      const offer = { action: "Offer", operationReference: next(), skuReference: sku };
      assert.equal((await call(offer)).item.status, "Available");
      assert.equal((await call(offer)).status, "Unchanged");
      // The Store Manager marks it sold out for the rest of the business day, then back in stock.
      scope.as(manager);
      const soldOut = await call({
        action: "SoldOut",
        operationReference: next(),
        skuReference: sku,
        until: "EndOfDay",
      });
      assert.deepEqual(soldOut.item, {
        status: "SoldOut",
        soldOutUntil: "2026-10-08T04:00:00.000Z",
      });
      await assert.rejects(
        call({ action: "StopOffering", operationReference: next(), skuReference: sku }),
        { code: "PermissionDenied" },
      );
      assert.equal(
        (await call({ action: "BackInStock", operationReference: next(), skuReference: sku })).item
          .status,
        "Available",
      );
      // Sold out until further notice outlives the business day.
      await call({
        action: "SoldOut",
        operationReference: next(),
        skuReference: sku,
        until: "UntilBack",
      });
      clock = Date.parse("2026-10-08T12:00:00.000Z");
      assert.deepEqual(
        { status: (await status()).status, until: (await status()).soldOutUntil },
        { status: "SoldOut", until: null },
      );
      await call({ action: "BackInStock", operationReference: next(), skuReference: sku });
      scope.as(owner);
      assert.equal(
        (await call({ action: "StopOffering", operationReference: next(), skuReference: sku })).item
          .status,
        "NotOffered",
      );
      scope.as(cashier);
      await assert.rejects(availability.query({ sessionCookie: "s", csrf: "c" }), {
        code: "PermissionDenied",
      });

      const rules = (
        await admin.query(
          "SELECT reason_code,decision,priority,lifecycle,store_id::text store,effective_until FROM rms_catalog.availability_rule ORDER BY created_at,availability_rule_id",
        )
      ).rows;
      assert.deepEqual(
        rules.map((r) => [r.reason_code, r.decision, r.priority, r.lifecycle, r.store]),
        [
          ["STORE_OFFERED", "Available", 100, "Inactive", storeReference],
          ["SOLD_OUT", "Unavailable", 900, "Inactive", storeReference],
          ["SOLD_OUT", "Unavailable", 900, "Inactive", storeReference],
        ],
      );
      const audits = (
        await admin.query(
          "SELECT action_code,store_id::text store FROM platform_audit.audit_record WHERE action_code LIKE 'CATALOG_AVAILABILITY_%' ORDER BY occurred_at,audit_id",
        )
      ).rows;
      assert.equal(audits.length, 9);
      assert.equal(audits.filter((a) => a.store === storeReference).length, 6);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM platform_eventing.outbox_event WHERE event_type LIKE 'AvailabilityRule%'",
          )
        ).rows[0].n,
        9,
      );
      const snapshots = await admin.query(
        "SELECT count(*)::int n FROM rms_catalog.availability_rule_operation_snapshot",
      );
      assert.equal(snapshots.rows[0].n, 9);
      await admin.query(
        "UPDATE rms_catalog.availability_rule_operation_snapshot SET record_json='{}'",
      );
      await admin.query("DELETE FROM rms_catalog.availability_rule_operation_snapshot");
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM rms_catalog.availability_rule_operation_snapshot WHERE record_json<>'{}'",
          )
        ).rows[0].n,
        9,
      );
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => {});
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => {});
      await admin.end();
    }
  });
});
