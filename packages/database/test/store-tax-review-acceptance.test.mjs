import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { menuItemsWithoutTax } from "../../../apps/api/src/menu-option-gates.ts";
import { createMerchantProducts } from "../../../apps/api/src/merchant-products.ts";
import { createMerchantStoreTax } from "../../../apps/api/src/merchant-store-tax.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { productApiGrants } from "../test-support/merchant-api-grants.mjs";
import { syntheticMerchantBrandScope } from "../test-support/merchant-brand-scope.mjs";

const { Client } = pg;
const id = (n) => "01909a24-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** WP-2423 8.7: the Store's tax review and the menu tax gate, under the API's RLS. */
it("reviews the Store's tax classes per product and refuses menus with untaxable items", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_tax_review" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_taxreview_" + context.runId;
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      reader = id(5),
      cashier = id(6),
      taxClass = id(100),
      pickupOnlyClass = id(101);
    let second = 0;
    const now = () => new Date(Date.UTC(2026, 9, 8, 12, 0, ++second)).toISOString();
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
      // A second TEST-ONLY class taxed for pickup only.
      await admin.query(
        "INSERT INTO rms_pricing.tax_configuration_rule(tax_configuration_rule_id,tax_configuration_version_id,tax_configuration_id,brand_id,store_id,tax_classification_id,order_type,charge_type,tax_component_code,treatment,tax_rate,price_inclusion,rounding_mode,calculation_order,compound_on_prior_tax,exception_evidence_id,receipt_presentation_code) VALUES($1,$2,$3,$4,$5,$6,'Pickup','Sellable','TEST_TAX','Taxable',0.05,'Exclusive','HalfUp',1,false,NULL,'TEST_TAX_LINE')",
        [id(212), id(201), id(200), brandReference, storeReference, pickupOnlyClass],
      );
      await admin.query(
        "UPDATE rms_pricing.tax_configuration SET current_version_id=$1 WHERE tax_configuration_id=$2",
        [id(201), id(200)],
      );

      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      for (const sql of productApiGrants) await admin.query(sql.replaceAll("ROLE_", role));
      const persistence = {
        now,
        transactions: {
          async run(work) {
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
          },
        },
      };
      const scope = syntheticMerchantBrandScope({
        tenantReference,
        brandReference,
        storeReference,
        policyReference: id(300),
        grants: {
          [owner]: [
            "pricing.tax_config.read",
            "catalog.product.read",
            "catalog.product.create",
            "catalog.product.update",
            "catalog.product.manage",
            "catalog.sku.create",
          ],
          [reader]: ["catalog.product.read"],
        },
        storeGrants: { [cashier]: ["pricing.tax_config.read"], [reader]: [] },
      });
      const common = {
        persistence,
        authentication: { authorize: async () => ({ sessionReference: id(7) }) },
        locale: "en-CA",
        resolveScope: scope.resolveScope,
      };
      const products = createMerchantProducts({ ...common, references: { next: op } });
      const tax = createMerchantStoreTax(common);
      const session = { sessionCookie: "cookie", csrf: "csrf" };
      scope.as(owner);
      const create = async (code, name, taxClassificationReference) =>
        (
          await products.command({
            ...session,
            body: {
              action: "Create",
              operationReference: op(),
              internalCode: code,
              productType: "NonAlcoholicBeverage",
              name,
              taxClassificationReference,
              sizes: [{ skuReference: null, skuCode: code + "-12", name: "12 oz" }],
            },
          })
        ).product;
      const latte = await create("LATTE", "Latte", taxClass);
      const tea = await create("TEA", "Tea", pickupOnlyClass);

      const review = await tax.query(session);
      assert.equal(review.screenId, "TAX-STORE-REVIEW");
      assert.equal(review.configuration.stableCode, "TEST_STORE_TAX");
      assert.equal(review.configuration.jurisdictionCode, "CA-ON");
      assert.equal(review.configuration.testOnly, true);
      assert.equal(review.configuration.endsAt, "2027-01-01T00:00:00.000Z");
      assert.equal(review.configuration.endingSoon, false);
      assert.deepEqual(
        review.classes.map((c) => [
          c.taxClassificationReference,
          c.rules.map((r) => r.orderType + ":" + r.rate),
          c.productNames,
        ]),
        [
          [taxClass, ["DineIn:0.13", "Pickup:0.13"], ["Latte"]],
          [pickupOnlyClass, ["Pickup:0.05"], ["Tea"]],
        ],
      );
      assert.deepEqual(
        review.products.map((p) => [p.name, p.status, p.missingOrderTypes]),
        [
          ["Latte", "Covered", []],
          ["Tea", "NotCovered", ["DineIn"]],
        ],
      );
      // Reading needs the tax permission.
      scope.as(reader);
      await assert.rejects(tax.query(session), { code: "PermissionDenied" });
      // A Store grant reads its own Store's tax.
      scope.as(cashier);
      assert.equal((await tax.query(session)).products.length, 2);

      // A menu offering tea for dine-in is held back; pickup only is fine.
      const gate = (orderTypeCodes) =>
        persistence.transactions.run((tx) =>
          menuItemsWithoutTax(tx, {
            owner: { brandReference, storeReference },
            observedAt: now(),
            menu: {
              sections: [
                {
                  placements: [
                    { sellableReference: latte.sizes[0].skuReference },
                    { sellableReference: tea.sizes[0].skuReference },
                  ],
                },
              ],
              orderTypeCodes,
            },
          }),
        );
      assert.deepEqual(await gate(["PICKUP", "DINE_IN"]), [tea.sizes[0].skuReference]);
      assert.deepEqual(await gate(["PICKUP"]), []);
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end();
    }
  });
});
