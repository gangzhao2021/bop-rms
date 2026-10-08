import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createMerchantOptionSets } from "../../../apps/api/src/merchant-option-sets.ts";
import { createMerchantProducts } from "../../../apps/api/src/merchant-products.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { productApiGrants } from "../test-support/merchant-api-grants.mjs";
import { syntheticMerchantBrandScope } from "../test-support/merchant-brand-scope.mjs";

const { Client } = pg;
const id = (n) => "01909a20-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** The pilot API role's grants for Brand option sets and product bindings (pilot-acl-additions.json). */
export const optionSetApiGrants = [
  "GRANT SELECT,INSERT,UPDATE ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option TO ROLE_",
  "GRANT SELECT,INSERT,DELETE ON rms_catalog.option_conflict TO ROLE_",
  "GRANT SELECT,INSERT ON rms_catalog.option_set_operation_record,rms_catalog.option_set_operation_snapshot TO ROLE_",
  "GRANT INSERT ON rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel TO ROLE_",
];

/** WP-2423 slice 4: Brand option sets authored and bound to a product, under the API's RLS. */
it("creates and edits option sets, keeps saved options and binds them to a product", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_option_sets" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_options_" + context.runId;
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      reader = id(5),
      taxClass = id(100);
    let second = 0;
    const now = () => {
      second += 1;
      return new Date(Date.UTC(2026, 9, 8, 12, 0, second)).toISOString();
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
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      for (const sql of [...productApiGrants, ...optionSetApiGrants])
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
      const scope = syntheticMerchantBrandScope({
        tenantReference,
        brandReference,
        storeReference,
        policyReference: id(300),
        grants: {
          [owner]: [
            "catalog.option_set.read",
            "catalog.option_set.manage",
            "catalog.product.read",
            "catalog.product.create",
            "catalog.product.update",
            "catalog.product.manage",
            "catalog.sku.create",
          ],
          [reader]: ["catalog.option_set.read", "catalog.product.read"],
        },
      });
      const authentication = { authorize: async () => ({ sessionReference: id(7) }) };
      const optionSets = createMerchantOptionSets({
        persistence,
        authentication,
        locale: "en-CA",
        resolveScope: scope.resolveScope,
      });
      const products = createMerchantProducts({
        persistence,
        authentication,
        references: { next: op },
        locale: "en-CA",
        resolveScope: scope.resolveScope,
      });
      const session = { sessionCookie: "cookie", csrf: "csrf" };
      const call = (body) => optionSets.command({ ...session, body });
      const rejects = async (promise, code) =>
        assert.rejects(promise, (error) => error.code === code || assert.fail(String(error.code)));
      scope.as(owner);

      // Milk: choose one, required; whole milk is the default.
      const createMilk = {
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
          { optionReference: null, name: "Almond milk", offered: true, defaultChoice: false },
        ],
      };
      const milk = await call(createMilk);
      assert.equal(milk.status, "Applied");
      assert.equal(milk.optionSet.internalCode, "MILK");
      assert.deepEqual(
        milk.optionSet.options.map((o) => [o.code, o.name, o.offered, o.defaultChoice]),
        [
          ["WHOLE_MILK", "Whole milk", true, true],
          ["OAT_MILK", "Oat milk", true, false],
          ["ALMOND_MILK", "Almond milk", true, false],
        ],
      );
      // A retried request returns what it did; a second set with the same name is refused.
      const replay = await call(createMilk);
      assert.equal(replay.status, "AlreadyApplied");
      assert.equal(replay.optionSet.optionSetReference, milk.optionSet.optionSetReference);
      await rejects(call({ ...createMilk, operationReference: op() }), "Invalid");
      // Limits customers could not meet are refused before anything is written.
      await rejects(
        call({
          ...createMilk,
          operationReference: op(),
          name: "Syrup",
          kind: "Any",
          minimum: 4,
          maximum: null,
        }),
        "Invalid",
      );

      // Extra shot: a quantity choice, up to 3 of it.
      const shots = await call({
        action: "Create",
        operationReference: op(),
        name: "Extra shot",
        kind: "Quantity",
        minimum: 0,
        maximum: 3,
        perOptionMaximum: 3,
        options: [
          { optionReference: null, name: "Espresso shot", offered: true, defaultChoice: false },
        ],
      });
      assert.deepEqual(
        [shots.optionSet.kind, shots.optionSet.maximum, shots.optionSet.perOptionMaximum],
        ["Quantity", 3, 3],
      );

      // Edit Milk: rename an option, add soy, stop offering almond; leaving an option out keeps it
      // on record, not offered.
      const [whole, oat, almond] = milk.optionSet.options;
      const save = {
        action: "Save",
        operationReference: op(),
        optionSetReference: milk.optionSet.optionSetReference,
        expectedAggregateVersion: milk.optionSet.aggregateVersion,
        name: "Milk",
        kind: "One",
        minimum: 1,
        maximum: 1,
        perOptionMaximum: 1,
        options: [
          {
            optionReference: whole.optionReference,
            name: "Whole milk (2%)",
            offered: true,
            defaultChoice: true,
          },
          { optionReference: null, name: "Soy milk", offered: true, defaultChoice: false },
          {
            optionReference: oat.optionReference,
            name: "Oat milk",
            offered: true,
            defaultChoice: false,
          },
        ],
      };
      const saved = await call(save);
      assert.deepEqual(
        saved.optionSet.options.map((o) => [o.name, o.offered]),
        [
          ["Whole milk (2%)", true],
          ["Soy milk", true],
          ["Oat milk", true],
          ["Almond milk", false],
        ],
      );
      assert.equal(saved.optionSet.options[3].optionReference, almond.optionReference);
      assert.equal((await call(save)).status, "AlreadyApplied");
      await rejects(call({ ...save, operationReference: op() }), "Conflict");
      // A reader sees option sets but cannot change them.
      scope.as(reader);
      assert.equal(
        (await optionSets.query({ ...session, optionSetReference: null })).optionSets.length,
        2,
      );
      await rejects(
        call({
          ...save,
          operationReference: op(),
          expectedAggregateVersion: saved.optionSet.aggregateVersion,
        }),
        "PermissionDenied",
      );
      scope.as(owner);

      // A latte offers Milk (all but soy) and Extra shot.
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
      const soy = saved.optionSet.options[1];
      const bind = {
        action: "SaveDraft",
        operationReference: op(),
        productReference: latte.productReference,
        expectedAggregateVersion: latte.aggregateVersion,
        name: "Latte",
        taxClassificationReference: taxClass,
        sizes: [{ skuReference: latte.sizes[0].skuReference, skuCode: "LATTE-12", name: "12 oz" }],
        optionSets: [
          {
            optionSetReference: milk.optionSet.optionSetReference,
            enabledOptionReferences: [
              whole.optionReference,
              oat.optionReference,
              almond.optionReference,
            ],
          },
          {
            optionSetReference: shots.optionSet.optionSetReference,
            enabledOptionReferences: [shots.optionSet.options[0].optionReference],
          },
        ],
      };
      const bound = await products.command({ ...session, body: bind });
      assert.deepEqual(
        bound.product.optionSets.map((set) => [
          set.optionSetReference,
          [...set.enabledOptionReferences].sort(),
        ]),
        bind.optionSets.map((set) => [
          set.optionSetReference,
          [...set.enabledOptionReferences].sort(),
        ]),
      );
      const detail = await products.query({ ...session, productReference: latte.productReference });
      assert.deepEqual(detail.optionSetChoices.map((choice) => choice.name).sort(), [
        "Extra shot",
        "Milk",
      ]);
      const rows = (
        await admin.query(
          "SELECT b.sort_order, b.purpose, o.option_id::text option, o.default_quantity FROM rms_catalog.product_option_binding b JOIN rms_catalog.product_option_binding_option o USING (binding_id) WHERE b.product_id=$1 ORDER BY b.sort_order, o.option_id",
          [latte.productReference],
        )
      ).rows;
      assert.deepEqual(
        rows.map((r) => [r.sort_order, r.purpose, r.option, r.default_quantity]),
        [
          ...[whole, oat, almond]
            .map((o) => o.optionReference)
            .sort()
            .map((option) => [
              0,
              "CUSTOMER_CHOICE",
              option,
              option === whole.optionReference ? 1 : null,
            ]),
          [1, "CUSTOMER_CHOICE", shots.optionSet.options[0].optionReference, null],
        ],
      );
      // An option from another set, or a product edit that leaves options out, keeps bindings safe.
      await rejects(
        products.command({
          ...session,
          body: {
            ...bind,
            operationReference: op(),
            expectedAggregateVersion: bound.product.aggregateVersion,
            optionSets: [
              {
                optionSetReference: milk.optionSet.optionSetReference,
                enabledOptionReferences: [shots.optionSet.options[0].optionReference],
              },
            ],
          },
        }),
        "Invalid",
      );
      const withoutOptions = Object.fromEntries(
        Object.entries(bind).filter(([key]) => key !== "optionSets"),
      );
      const renamed = await products.command({
        ...session,
        body: {
          ...withoutOptions,
          operationReference: op(),
          expectedAggregateVersion: bound.product.aggregateVersion,
          name: "Caffè Latte",
        },
      });
      assert.equal(renamed.product.optionSets.length, 2);
      assert.ok(soy.optionReference);

      // Archive Extra shot: still on the latte until removed; it cannot be added anew.
      const archived = await call({
        action: "Archive",
        operationReference: op(),
        optionSetReference: shots.optionSet.optionSetReference,
        expectedAggregateVersion: shots.optionSet.aggregateVersion,
      });
      assert.equal(archived.optionSet.archived, true);

      const audits = (
        await admin.query(
          "SELECT action_code FROM platform_audit.audit_record WHERE action_code LIKE 'CATALOG_OPTION_SET_%' ORDER BY occurred_at,audit_id",
        )
      ).rows.map((r) => r.action_code);
      assert.deepEqual(audits, [
        "CATALOG_OPTION_SET_CREATE",
        "CATALOG_OPTION_SET_CREATE",
        "CATALOG_OPTION_SET_REPLACEDRAFT",
        "CATALOG_OPTION_SET_ARCHIVE",
      ]);
      const snapshots = await admin.query(
        "SELECT count(*)::int n FROM rms_catalog.option_set_operation_snapshot",
      );
      assert.equal(snapshots.rows[0].n, 4);
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end();
    }
  });
});
