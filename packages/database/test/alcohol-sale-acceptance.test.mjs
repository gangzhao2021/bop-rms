import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  alcoholMaySell,
  readAlcoholSale,
  withinAlcoholHours,
} from "../../../apps/api/src/alcohol-sale-rule.ts";
import { createMerchantProducts } from "../../../apps/api/src/merchant-products.ts";
import { changeProductAlcoholMark } from "../../rms/catalog/src/index.ts";
import { changeStoreFeatureSetting, loadStoreFeatureSetting } from "../../rms/store/src/index.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { syntheticMerchantBrandScope } from "../test-support/merchant-brand-scope.mjs";

const { Client } = pg;
const id = (n) => "01909a1b-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 DEC-ALCOHOL (Owner 2026-11-04 "要卖酒"): a dish marked as containing alcohol is sold only
 * at tables, only while the Store's switch is on and only from 9:00 to 2:00, under the pilot API
 * role with exactly the rendered pilot grants. Test-controlled seed: the Store's tax configuration
 * and its published configuration (the clock); nothing here is a real licence or Store fact.
 */
it("sells a marked dish only at tables, while switched on and within the hours", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_alcohol" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_alc_" + context.runId,
      worker = "wp2423_alc_w_" + context.runId;
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      taxClass = id(100);
    let second = 0;
    const now = () => {
      second += 1;
      return new Date(Date.UTC(2026, 9, 7, 12, 0, second)).toISOString();
    };
    let operation = 0x7000;
    const op = () => "019a0000-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    try {
      // TEST-ONLY tax configuration: one Published version covering one tax class (13 %).
      const at = "2026-09-20T00:00:00.000Z";
      await admin.query(
        "INSERT INTO rms_pricing.tax_configuration(tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'TEST_STORE_TAX',1,$4,$5,$4)",
        [id(200), brandReference, storeReference, at, owner],
      );
      await admin.query(
        `INSERT INTO rms_pricing.tax_configuration_version(tax_configuration_version_id,tax_configuration_id,brand_id,store_id,version_number,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_until,effective_time_zone,registration_applicability_id,operating_entity_tax_reference_id,jurisdiction_profile_id,registration_evidence_valid_until,professional_evidence_id,professional_review_reference_id,fixture_suite_reference_id,fixture_suite_digest,professional_evidence_valid_until,created_at)
         VALUES($1,$2,$3,$4,1,$5,'Published','CA-ON','CAD',1,$6,$5,$7,NULL,'America/Toronto',$8,$9,$10,'2027-01-01T00:00:00.000Z',$11,$12,$13,$5,'2027-01-01T00:00:00.000Z',$7)`,
        [
          id(201),
          id(200),
          brandReference,
          storeReference,
          "sha256:" + "a".repeat(64),
          id(202),
          at,
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

      await admin.query(
        `INSERT INTO rms_store.store_configuration_version(configuration_id,brand_id,store_id,configuration_version,lifecycle,configuration_source,brand_base_version_reference,default_locale,currency_code,time_zone,address_reference,contact_reference,receipt_reference,tax_configuration_reference,payment_configuration_reference,enabled_service_modes,effective_from,reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,live_gate_evidence_reference,created_at,updated_at,data_classification)
         VALUES($1,$2,$3,1,'Published','StoreOverride',$4,'en-CA','CAD','America/Toronto',$5,$6,$7,$8,$9,ARRAY['DineIn','Pickup'],$10,'TEST_ONLY',$11,$12,$13,$14,$15,$10,$10,'ConfigurationMetadata')`,
        [
          id(400),
          brandReference,
          storeReference,
          id(401),
          id(402),
          id(403),
          id(404),
          id(405),
          id(406),
          at,
          owner,
          id(407),
          id(408),
          id(409),
          id(410),
        ],
      );
      for (const name of [role, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api: role, worker }));

      const run = async (work) => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
          await admin.query("SELECT set_config('bop.tenant_id',$1,true)", [tenantReference]);
          const value = await work(admin);
          await admin.query("COMMIT");
          return value;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      };
      const persistence = { now, transactions: { run } };
      const scope = syntheticMerchantBrandScope({
        tenantReference,
        brandReference,
        storeReference,
        policyReference: id(300),
        grants: {
          [owner]: [
            "catalog.product.read",
            "catalog.product.create",
            "catalog.product.update",
            "catalog.product.manage",
            "catalog.product.publish",
            "catalog.sku.create",
            "catalog.sku.activate",
          ],
        },
      });
      const products = createMerchantProducts({
        persistence,
        authentication: { authorize: async () => ({ sessionReference: id(7) }) },
        references: { next: op },
        locale: "en-CA",
        resolveScope: scope.resolveScope,
      });
      const session = { sessionCookie: "cookie", csrf: "csrf" };
      const beer = await products.command({
        ...session,
        body: {
          action: "Create",
          operationReference: op(),
          internalCode: "BEER",
          productType: "PreparedFood",
          name: "Beer (TEST)",
          taxClassificationReference: taxClass,
          sizes: [{ skuReference: null, skuCode: "BEER-1", name: "Bottle" }],
        },
      });
      const sku = beer.product.sizes[0].skuReference;
      // Live requests work with a Store selected, and products and sizes are hidden then: the rule
      // must still see them (a dish it can't see would be sold as an ordinary one).
      const runForStore = (work) =>
        run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [brandReference, storeReference],
          );
          const value = await work(tx);
          const after = await tx.query("SELECT current_setting('bop.store_id',true) store", []);
          assert.equal(after.rows[0].store, storeReference);
          return value;
        });
      const ids = { brandReference, storeReference };
      const dinner = "2026-10-07T23:00:00.000Z"; // 19:00 in Toronto
      const dawn = "2026-10-07T10:00:00.000Z"; // 06:00 in Toronto
      const may = (orderType, at) =>
        alcoholMaySell({ run: runForStore }, ids, { sellableReference: sku, orderType, at });

      // Not marked: an ordinary dish, whatever the switch, the service or the hour.
      assert.equal(await may("Pickup", dawn), true);

      const mark = (containsAlcohol, expectedVersion, operationReference = op()) =>
        runForStore((tx) =>
          changeProductAlcoholMark(
            tx,
            { tenantReference, brandReference },
            {
              productReference: beer.product.productReference,
              operationReference,
              expectedVersion,
              containsAlcohol,
              actorReference: owner,
              observedAt: "2026-10-07T12:00:00.000Z",
            },
          ),
        );
      const first = op();
      assert.deepEqual(await mark(true, 0, first), { containsAlcohol: true, version: 1 });
      // The same operation again returns what it recorded; a stale version is refused.
      assert.deepEqual(await mark(true, 0, first), { containsAlcohol: true, version: 1 });
      await assert.rejects(
        mark(false, 0),
        (error) => error.code === "PRODUCT_ALCOHOL_MARK_CHANGED",
      );

      // Marked, with the Store's switch off (the default): not sold anywhere.
      assert.equal(await may("DineIn", dinner), false);
      const setting = await run((tx) => loadStoreFeatureSetting(tx, ids));
      assert.equal(setting.alcohol, false);

      await run((tx) =>
        changeStoreFeatureSetting(
          tx,
          { tenantReference, ...ids },
          {
            operationReference: op(),
            expectedVersion: setting.version,
            template: null,
            modules: { ...setting, alcohol: true },
            actorReference: owner,
            observedAt: "2026-10-07T12:00:00.000Z",
          },
        ),
      );
      // Switched on: at tables within the hours only, in the Store's own time; never for pickup.
      assert.equal(await may("DineIn", dinner), true);
      assert.equal(await may("DineIn", dawn), false);
      assert.equal(await may("Pickup", dinner), false);
      const sale = await runForStore((tx) => readAlcoholSale(tx, ids, dinner, [sku, id(999)]));
      assert.deepEqual([...sale.skus], [sku]);
      assert.equal(sale.offered, true);
      assert.equal(sale.withinHours, true);
      assert.equal(sale.lastCall, undefined);
      // WP-2423 (M93, Owner decision 18): from 1:30 Store time it is last call; at 2:00 it ends.
      const lastCall = await runForStore((tx) =>
        readAlcoholSale(tx, ids, "2026-10-08T05:40:00.000Z", [sku]),
      ); // 01:40 in Toronto
      assert.equal(lastCall.withinHours, true);
      assert.equal(lastCall.lastCall, true);
      const closed = await runForStore((tx) =>
        readAlcoholSale(tx, ids, "2026-10-08T06:00:00.000Z", [sku]),
      ); // 02:00 in Toronto
      assert.equal(closed.withinHours, false);
      assert.equal(closed.lastCall, undefined);

      // Cleared: an ordinary dish again.
      await mark(false, 1);
      assert.equal(await may("Pickup", dawn), true);

      // The history stays: both versions kept, and it can't be changed.
      await assert.rejects(
        run((tx) =>
          tx.query("UPDATE rms_catalog.product_alcohol_mark SET contains_alcohol=true", []),
        ),
      );
      assert.equal(
        Number(
          (await admin.query("SELECT count(*) FROM rms_catalog.product_alcohol_mark")).rows[0]
            .count,
        ),
        2,
      );
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      for (const name of [role, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE IF EXISTS " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});

it("knows the hours: 9:00 up to but not including 2:00", () => {
  for (const open of ["09:00:00", "12:00:00", "23:59:59", "00:00:00", "01:59:59"])
    assert.equal(withinAlcoholHours(open), true, open);
  for (const closed of ["02:00:00", "05:00:00", "08:59:59"])
    assert.equal(withinAlcoholHours(closed), false, closed);
});
