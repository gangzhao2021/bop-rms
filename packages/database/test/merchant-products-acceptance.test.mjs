import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createMerchantProducts } from "../../../apps/api/src/merchant-products.ts";
import { createBrand, createTenantContext } from "../../bop/tenant/src/index.ts";
import { listBrandSkuChoices } from "../../rms/catalog/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "01909a1b-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** The grants the pilot API role holds for Brand Products (docs/spec/pilot-acl-additions.json). */
export const productApiGrants = [
  "GRANT USAGE ON SCHEMA rms_catalog,rms_pricing,platform_audit,platform_helpers,platform_eventing TO ROLE_",
  "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO ROLE_",
  "GRANT SELECT,INSERT,UPDATE ON rms_catalog.product,rms_catalog.product_version TO ROLE_",
  "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.sku TO ROLE_",
  "GRANT SELECT,DELETE ON rms_catalog.product_version_category_assignment,rms_catalog.product_option_binding,rms_catalog.product_option_binding_option,rms_catalog.product_option_binding_sku_scope,rms_catalog.product_option_binding_channel TO ROLE_",
  "GRANT SELECT,INSERT ON rms_catalog.product_operation_record,rms_catalog.product_operation_snapshot,rms_catalog.product_source_commit TO ROLE_",
  "GRANT SELECT,INSERT,UPDATE ON rms_catalog.product_source_head TO ROLE_",
  "GRANT SELECT ON rms_catalog.product_publication_revision TO ROLE_",
  "GRANT SELECT ON rms_pricing.tax_configuration,rms_pricing.tax_configuration_version,rms_pricing.tax_configuration_rule TO ROLE_",
  "GRANT SELECT,INSERT ON platform_audit.audit_record TO ROLE_",
  "GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO ROLE_",
  "GRANT INSERT ON platform_eventing.outbox_event TO ROLE_",
];

/** WP-2423 / DEC-CAT-PRODUCT-ADMIN: Brand Products through the API composition, under the API's RLS. */
it("creates products with sizes, edits them, starts selling and refuses unsafe changes", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_products" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_products_" + context.runId;
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      reader = id(5),
      outsider = id(6),
      taxClass = id(100),
      otherTaxClass = id(101);
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
      const brand = createBrand({
        brandReference,
        code: "PRODUCT_TEST",
        displayName: "Synthetic Products",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      // Brand grants per Actor: the owner holds every Product action; the reader may only read.
      const granted = {
        [owner]: [
          "catalog.product.read",
          "catalog.product.create",
          "catalog.product.update",
          "catalog.product.manage",
          "catalog.product.publish",
          "catalog.sku.create",
          "catalog.sku.activate",
        ],
        [reader]: ["catalog.product.read"],
        [outsider]: [],
      };
      let actor = owner;
      const resolveScope = async (tx, cookie) => {
        assert.equal(cookie, "cookie");
        const current = actor;
        const tenantContext = createTenantContext(
          {
            actorType: "User",
            actorReference: current,
            accountKind: "Workforce",
            status: "Active",
            authenticationMethod: "Oidc",
            verificationLevel: "SingleFactor",
            authenticatedAt: at,
            recentMfaAt: null,
          },
          brand,
          null,
          at,
        );
        // As the real scope resolver: deciding a Store-scoped policy sets the Store, and each
        // Brand write must restore the Brand scope itself.
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brandReference, storeReference],
        );
        return {
          context: tenantContext,
          tenantReference,
          selectedStoreReference: storeReference,
          actorReference: current,
          authorizeAction: async (action) => {
            const allowed = granted[current].includes(action);
            return {
              action,
              scopeKind: "Brand",
              effect: allowed ? "Allow" : "Deny",
              reason: "ROLE_PERMISSION",
              source: "RolePermission",
              policySnapshotReference: id(300),
              policyVersion: 1,
              audit: {
                effect: allowed ? "Allow" : "Deny",
                reason: "ROLE_PERMISSION",
                source: "RolePermission",
              },
            };
          },
        };
      };
      const products = createMerchantProducts({
        persistence,
        authentication: { authorize: async () => ({ sessionReference: id(7) }) },
        references: { next: op },
        locale: "en-CA",
        resolveScope,
      });
      const session = { sessionCookie: "cookie", csrf: "csrf" };
      const command = (body) => products.command({ ...session, body });
      const rejects = async (promise, code) =>
        assert.rejects(promise, (error) => error.code === code || assert.fail(String(error.code)));

      // List: empty, with the Store's tax class and its order-type rates.
      const empty = await products.query({ ...session, productReference: null });
      assert.equal(empty.screenId, "CAT-PRODUCT-LIST");
      assert.deepEqual(empty.products, []);
      assert.deepEqual(
        empty.taxClasses.map((choice) => [
          choice.taxClassificationReference,
          choice.rules.map((rule) => rule.orderType + ":" + rule.rate),
        ]),
        [[taxClass, ["DineIn:0.13", "Pickup:0.13"]]],
      );
      assert.deepEqual(empty.permissions, {
        mayRead: true,
        mayCreate: true,
        mayEdit: true,
        mayAddSize: true,
        mayStartSelling: true,
      });

      // Create a latte with two sizes; a retry of the same operation returns the same product.
      const createLatte = {
        action: "Create",
        operationReference: op(),
        internalCode: "latte",
        productType: "NonAlcoholicBeverage",
        name: "Latte",
        taxClassificationReference: taxClass,
        sizes: [
          { skuReference: null, skuCode: "LATTE-S", name: "Small" },
          { skuReference: null, skuCode: "LATTE-L", name: "Large" },
        ],
      };
      const created = await command(createLatte);
      assert.equal(created.status, "Applied");
      const latte = created.product;
      assert.equal(latte.internalCode, "LATTE");
      assert.equal(latte.lifecycle, "Draft");
      assert.deepEqual(
        latte.sizes
          .map((size) => [size.skuCode, size.name, size.lifecycle, size.unitOfSale].join(":"))
          .sort(),
        ["LATTE-L:Large:Draft:EACH", "LATTE-S:Small:Draft:EACH"],
      );
      const variants = (
        await admin.query(
          "SELECT variant_selections_json v FROM rms_catalog.sku WHERE product_id=$1",
          [latte.productReference],
        )
      ).rows.map((row) => row.v);
      assert.equal(variants.length, 2);
      assert.equal(variants[0][0].dimensionReference, variants[1][0].dimensionReference);
      assert.notEqual(variants[0][0].valueReference, variants[1][0].valueReference);
      const replay = await command(createLatte);
      assert.equal(replay.status, "AlreadyApplied");
      assert.equal(replay.product.productReference, latte.productReference);

      // Refusals: an uncovered tax class, a taken code, duplicate size names.
      await rejects(
        command({
          ...createLatte,
          operationReference: op(),
          internalCode: "MOCHA",
          taxClassificationReference: otherTaxClass,
        }),
        "TaxClassUnavailable",
      );
      await rejects(command({ ...createLatte, operationReference: op() }), "CodeTaken");
      await rejects(
        command({
          ...createLatte,
          operationReference: op(),
          internalCode: "MOCHA",
          sizes: [
            { skuReference: null, skuCode: "MOCHA-A", name: "Small" },
            { skuReference: null, skuCode: "MOCHA-B", name: "small" },
          ],
        }),
        "Invalid",
      );

      // Edit: rename, rename a size, drop a size not yet selling, add a size; a retry replays.
      const small = latte.sizes.find((size) => size.skuCode === "LATTE-S");
      const edit = {
        action: "SaveDraft",
        operationReference: op(),
        productReference: latte.productReference,
        expectedAggregateVersion: latte.aggregateVersion,
        name: "Caffè Latte",
        taxClassificationReference: taxClass,
        sizes: [
          { skuReference: small.skuReference, skuCode: "LATTE-S", name: "Small (12 oz)" },
          { skuReference: null, skuCode: "LATTE-M", name: "Medium (16 oz)" },
        ],
      };
      const edited = await command(edit);
      assert.equal(edited.product.name, "Caffè Latte");
      assert.equal(edited.product.aggregateVersion, latte.aggregateVersion + 1);
      assert.deepEqual(edited.product.sizes.map((size) => size.skuCode).sort(), [
        "LATTE-M",
        "LATTE-S",
      ]);
      assert.equal((await command(edit)).status, "AlreadyApplied");
      await rejects(command({ ...edit, operationReference: op() }), "Conflict");

      // Start selling: the product and both sizes; a retry continues from the current state.
      const start = {
        action: "StartSelling",
        operationReference: op(),
        productReference: latte.productReference,
        expectedAggregateVersion: edited.product.aggregateVersion,
      };
      const selling = await command(start);
      assert.equal(selling.product.lifecycle, "Active");
      assert.deepEqual(
        selling.product.sizes.map((size) => size.lifecycle),
        ["Active", "Active"],
      );
      assert.equal(selling.product.aggregateVersion, edited.product.aggregateVersion + 3);
      const again = await command(start);
      assert.equal(again.product.aggregateVersion, selling.product.aggregateVersion);
      await rejects(command({ ...start, operationReference: op() }), "Conflict");

      // A selling size cannot be removed; a new size can be added and started later.
      const medium = selling.product.sizes.find((size) => size.skuCode === "LATTE-M");
      await rejects(
        command({
          ...edit,
          operationReference: op(),
          expectedAggregateVersion: selling.product.aggregateVersion,
          sizes: [{ skuReference: medium.skuReference, skuCode: "LATTE-M", name: "Medium" }],
        }),
        "SizeInUse",
      );
      const grown = await command({
        ...edit,
        operationReference: op(),
        expectedAggregateVersion: selling.product.aggregateVersion,
        sizes: [
          ...selling.product.sizes.map((size) => ({
            skuReference: size.skuReference,
            skuCode: size.skuCode,
            name: size.name,
          })),
          { skuReference: null, skuCode: "LATTE-XL", name: "Extra large" },
        ],
      });
      assert.deepEqual(
        grown.product.sizes.map((size) => size.skuCode + ":" + size.lifecycle).sort(),
        ["LATTE-M:Active", "LATTE-S:Active", "LATTE-XL:Draft"],
      );

      // Detail, list and the recipe SKU choices read the same facts.
      const detail = await products.query({ ...session, productReference: latte.productReference });
      assert.equal(detail.screenId, "CAT-PRODUCT-DETAIL");
      assert.equal(detail.product.sizes.length, 3);
      const list = await products.query({ ...session, productReference: null });
      assert.deepEqual(
        list.products.map((product) => [
          product.name,
          product.lifecycle,
          product.sizes,
          product.activeSizes,
        ]),
        [["Caffè Latte", "Active", 3, 2]],
      );
      const choices = await persistence.transactions.run((tx) =>
        listBrandSkuChoices(tx, { brandReference }),
      );
      assert.deepEqual(
        choices.map((choice) => choice.skuCode + ":" + choice.active),
        ["LATTE-M:true", "LATTE-S:true", "LATTE-XL:false"],
      );

      // Every change is audited with its author and emitted as a Product source event.
      const audits = (
        await admin.query(
          "SELECT action_code,actor_reference,target_id FROM platform_audit.audit_record WHERE target_type='CatalogProduct' ORDER BY occurred_at",
        )
      ).rows;
      assert.deepEqual(
        audits.map((row) => row.action_code),
        [
          "CATALOG_PRODUCT_CREATE",
          "CATALOG_PRODUCT_REPLACEDRAFT",
          "CATALOG_PRODUCT_CHANGELIFECYCLE",
          "CATALOG_PRODUCT_CHANGELIFECYCLE",
          "CATALOG_PRODUCT_CHANGELIFECYCLE",
          "CATALOG_PRODUCT_REPLACEDRAFT",
        ],
      );
      assert(audits.every((row) => row.actor_reference === owner));
      assert.equal(
        Number(
          (
            await admin.query(
              "SELECT count(*) FROM rms_catalog.product_source_commit WHERE product_id=$1",
              [latte.productReference],
            )
          ).rows[0].count,
        ),
        6,
      );

      // A reader sees products but cannot change them; without read permission nothing shows.
      actor = reader;
      const readOnly = await products.query({ ...session, productReference: null });
      assert.equal(readOnly.products.length, 1);
      assert.equal(readOnly.permissions.mayCreate, false);
      await rejects(
        command({ ...createLatte, operationReference: op(), internalCode: "MOCHA" }),
        "PermissionDenied",
      );
      await rejects(
        command({
          ...start,
          operationReference: op(),
          expectedAggregateVersion: grown.product.aggregateVersion,
        }),
        "PermissionDenied",
      );
      actor = outsider;
      await rejects(products.query({ ...session, productReference: null }), "PermissionDenied");
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end();
    }
  });
});
