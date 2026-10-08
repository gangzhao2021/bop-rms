import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { unpricedMenuOptions } from "../../../apps/api/src/menu-option-gates.ts";
import { createMerchantOptionPrices } from "../../../apps/api/src/merchant-option-prices.ts";
import { createMerchantOptionSets } from "../../../apps/api/src/merchant-option-sets.ts";
import { createMerchantProducts } from "../../../apps/api/src/merchant-products.ts";
import { createPostgresCurrentOptionPriceStore } from "../../rms/pricing/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { optionSetApiGrants, productApiGrants } from "../test-support/merchant-api-grants.mjs";
import { syntheticMerchantBrandScope } from "../test-support/merchant-brand-scope.mjs";

const { Client } = pg;
const id = (n) => "01909a22-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** The pilot API role's grants for option prices (docs/spec/pilot-acl-additions.json). */
export const optionPriceApiGrants = [
  "GRANT SELECT,INSERT,UPDATE ON rms_pricing.option_price_rule,rms_pricing.option_price_rule_version TO ROLE_",
  "GRANT SELECT,INSERT ON rms_pricing.option_price_authoring_operation TO ROLE_",
  // A retried operation replays its recorded event (the pilot API role reads the outbox).
  "GRANT SELECT ON platform_eventing.outbox_event TO ROLE_",
  "GRANT EXECUTE ON FUNCTION rms_pricing.option_price_authoring_operation_available(platform_helpers.uuid_v7,platform_helpers.uuid_v7) TO ROLE_",
];

/** WP-2423 slice 4.3: option prices drafted by one person, published by another, under RLS. */
it("prices options per product with four-eyes publication and gates unpriced menus", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_option_prices" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_optprice_" + context.runId;
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      approver = id(5),
      taxClass = id(100);
    // The option price writer bounds each request to a few seconds of real time.
    const now = () => new Date().toISOString();
    let operation = 0x7000;
    const op = () => "019a0000-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    try {
      // TEST-ONLY tax configuration: one Published version covering one tax class (13 %).
      const at = "2026-01-01T00:00:00.000Z";
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
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      for (const sql of [...productApiGrants, ...optionSetApiGrants, ...optionPriceApiGrants])
        await admin.query(sql.replaceAll("ROLE_", role));
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
      const priceRead = ["pricing.price_book.read", "catalog.option_set.read"];
      const scope = syntheticMerchantBrandScope({
        tenantReference,
        brandReference,
        storeReference,
        policyReference: id(300),
        grants: {
          [owner]: [
            ...priceRead,
            "catalog.option_set.manage",
            "catalog.product.read",
            "catalog.product.create",
            "catalog.product.update",
            "catalog.product.manage",
            "catalog.sku.create",
            "pricing.price-book.manage",
            "pricing.price-book.approve",
          ],
          [approver]: [...priceRead, "pricing.price-book.approve"],
        },
      });
      const authentication = { authorize: async () => ({ sessionReference: id(7) }) };
      const meta = {
        currencyCode: "CAD",
        minorUnitExponent: 2,
        metadataVersion: 1,
        metadataVersionReference: id(90),
      };
      const currencyMetadata = {
        ...meta,
        metadataDigest: "sha256:" + createHash("sha256").update(JSON.stringify(meta)).digest("hex"),
      };
      const common = {
        persistence,
        authentication,
        locale: "en-CA",
        resolveScope: scope.resolveScope,
      };
      const optionSets = createMerchantOptionSets(common);
      const products = createMerchantProducts({ ...common, references: { next: op } });
      const optionPrices = createMerchantOptionPrices({ ...common, currencyMetadata });
      const session = { sessionCookie: "cookie", csrf: "csrf" };
      const rejects = async (promise, code) =>
        assert.rejects(promise, (error) => error.code === code || assert.fail(String(error.code)));
      scope.as(owner);

      // Milk (choose one, required) on a latte.
      const milk = (
        await optionSets.command({
          ...session,
          body: {
            action: "Create",
            operationReference: op(),
            name: "Milk",
            kind: "One",
            minimum: 1,
            maximum: 1,
            perOptionMaximum: 1,
            options: [
              { optionReference: null, name: "Whole milk", offered: true, defaultChoice: true },
              { optionReference: null, name: "Oat milk", offered: true, defaultChoice: false },
            ],
          },
        })
      ).optionSet;
      const [whole, oat] = milk.options;
      const latte = (
        await products.command({
          ...session,
          body: {
            action: "Create",
            operationReference: op(),
            internalCode: "LATTE",
            productType: "NonAlcoholicBeverage",
            name: "Latte",
            taxClassificationReference: taxClass,
            sizes: [{ skuReference: null, skuCode: "LATTE-12", name: "12 oz" }],
          },
        })
      ).product;
      const bound = await products.command({
        ...session,
        body: {
          action: "SaveDraft",
          operationReference: op(),
          productReference: latte.productReference,
          expectedAggregateVersion: latte.aggregateVersion,
          name: "Latte",
          taxClassificationReference: taxClass,
          sizes: [
            { skuReference: latte.sizes[0].skuReference, skuCode: "LATTE-12", name: "12 oz" },
          ],
          optionSets: [
            {
              optionSetReference: milk.optionSetReference,
              enabledOptionReferences: [whole.optionReference, oat.optionReference],
            },
          ],
        },
      });
      const sku = latte.sizes[0].skuReference;
      const binding = (
        await admin.query("SELECT binding_id::text b FROM rms_catalog.product_option_binding")
      ).rows[0].b;
      assert.equal(bound.product.optionSets.length, 1);

      // A menu offering the latte is held back while its options have no price.
      const menu = {
        sections: [{ placements: [{ sellableReference: sku }] }],
        channelCodes: ["CUSTOMER_PWA"],
        orderTypeCodes: ["PICKUP", "DINE_IN"],
      };
      const gate = () =>
        persistence.transactions.run(async (tx) => {
          await tx.query("SELECT set_config('bop.brand_id',$1,true)", [brandReference]);
          return unpricedMenuOptions(tx, {
            owner: { brandReference, storeReference },
            currencyMetadata,
            observedAt: now(),
            menu,
          });
        });
      assert.deepEqual(
        (await gate()).map((item) => item.optionReference).sort(),
        [whole.optionReference, oat.optionReference].sort(),
      );

      const view = async () =>
        (await optionPrices.query(session)).products[0].optionSets[0].options;
      assert.deepEqual(
        (await view()).map((o) => [o.name, o.priceMinor, o.pending]),
        [
          ["Whole milk", null, null],
          ["Oat milk", null, null],
        ],
      );
      // The owner sets whole milk at 0 (no charge) and oat milk at 0.75.
      const setPrices = {
        action: "SetPrices",
        operationReference: op(),
        prices: [
          {
            bindingReference: binding,
            optionReference: whole.optionReference,
            amountMinor: "0",
            expectedAggregateVersion: null,
            replacesPending: false,
          },
          {
            bindingReference: binding,
            optionReference: oat.optionReference,
            amountMinor: "75",
            expectedAggregateVersion: null,
            replacesPending: false,
          },
        ],
      };
      assert.equal((await optionPrices.command({ ...session, body: setPrices })).results.length, 2);
      // A retried save changes nothing more.
      assert.equal((await optionPrices.command({ ...session, body: setPrices })).results.length, 0);
      let rows = await view();
      assert.deepEqual(
        rows.map((o) => [o.priceMinor, o.pending]),
        [
          [null, { priceMinor: "0", byViewer: true }],
          [null, { priceMinor: "75", byViewer: true }],
        ],
      );
      const publish = (list) => ({
        action: "Publish",
        operationReference: op(),
        rules: list.map((o) => ({
          ruleReference: o.ruleReference,
          expectedAggregateVersion: o.aggregateVersion,
        })),
      });
      // The author cannot publish their own prices, even holding approval.
      await rejects(optionPrices.command({ ...session, body: publish(rows) }), "ApprovalRequired");
      scope.as(approver);
      await rejects(optionPrices.command({ ...session, body: setPrices }), "PermissionDenied");
      const published = publish(rows);
      assert.equal((await optionPrices.command({ ...session, body: published })).results.length, 2);
      assert.equal((await optionPrices.command({ ...session, body: published })).results.length, 2);
      rows = await view();
      assert.deepEqual(
        rows.map((o) => [o.priceMinor, o.pending]),
        [
          ["0", null],
          ["75", null],
        ],
      );
      assert.deepEqual(await gate(), []);

      // The customer Quote reads the published price for the latte's size.
      const quoteRead = await persistence.transactions.run((tx) =>
        createPostgresCurrentOptionPriceStore(
          { run: (work) => work(tx) },
          { brandReference, storeReference },
          currencyMetadata,
        ).load({
          bindingReference: binding,
          optionReference: oat.optionReference,
          skuReference: sku,
          storeGroupReference: null,
          regionReference: null,
          channelCode: "CUSTOMER_WEB",
          orderType: "DineIn",
          observedAt: now(),
        }),
      );
      assert.deepEqual(
        quoteRead.map((rule) => rule.unitAmount.amountMinor),
        [75n],
      );

      // A price change waits for approval; customers keep paying the published price.
      scope.as(owner);
      await optionPrices.command({
        ...session,
        body: {
          action: "SetPrices",
          operationReference: op(),
          prices: [
            {
              bindingReference: binding,
              optionReference: oat.optionReference,
              amountMinor: "80",
              expectedAggregateVersion: rows[1].aggregateVersion,
              replacesPending: false,
            },
          ],
        },
      });
      rows = await view();
      assert.deepEqual(
        [rows[1].priceMinor, rows[1].pending],
        ["75", { priceMinor: "80", byViewer: true }],
      );
      // Someone else's change meanwhile is a conflict, not an overwrite.
      await rejects(
        optionPrices.command({
          ...session,
          body: {
            action: "SetPrices",
            operationReference: op(),
            prices: [
              {
                bindingReference: binding,
                optionReference: oat.optionReference,
                amountMinor: "90",
                expectedAggregateVersion: rows[1].aggregateVersion - 1,
                replacesPending: false,
              },
            ],
          },
        }),
        "Conflict",
      );
      const audits = (
        await admin.query(
          "SELECT action_code, count(*)::int n FROM platform_audit.audit_record WHERE action_code LIKE 'PRICING_OPTION_PRICE_%' GROUP BY 1 ORDER BY 1",
        )
      ).rows.map((r) => [r.action_code, r.n]);
      assert.deepEqual(audits, [
        ["PRICING_OPTION_PRICE_CREATEDRAFT", 3],
        ["PRICING_OPTION_PRICE_PUBLISH", 2],
      ]);
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end();
    }
  });
});
