import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { createMerchantOptionPrices } from "../../../apps/api/src/merchant-option-prices.ts";
import { createMerchantOptionSets } from "../../../apps/api/src/merchant-option-sets.ts";
import { createMerchantProducts } from "../../../apps/api/src/merchant-products.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { syntheticMerchantBrandScope } from "../test-support/merchant-brand-scope.mjs";
import {
  createPilotApiRole,
  dbNow,
  seedBrand,
  seedBrandMember,
  seedBrandRole,
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a3f-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const markTable = "rms_pricing.option_price_single_store_listing";

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (Owner 2026-10-28 decision 7; coordinator condition 4):
 * at a Brand with one store, the author of option prices publishes them alone ("List it", no
 * review); each publication is marked SingleStoreListing on its companion record and Audit.
 * Through the real option price commands under the restricted NOBYPASSRLS role with the rendered
 * pilot API grants:
 * 1. one store: the author who holds price approval publishes alone; marked;
 * 2. someone without price approval cannot, even their own prices;
 * 3. a second store (a draft one) turns it off at once — refused by the command, and, with the
 *    command's own store check made to answer yes, by the database at commit; archived, it is back;
 * 4. marks are append-only.
 */
it("option prices: a single store's author publishes alone; no price approval or a second store refuses", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_ss_optprice" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      noah = id(5),
      taxClass = id(100);
    let operation = 0x7000;
    const op = () => "019a0002-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_ssop");
      const start = Date.parse(await dbNow(admin));
      const from = new Date(start - 3 * 3600_000).toISOString();
      // TEST-ONLY Store tax configuration covering the tax class the product uses (13 %).
      await admin.query(
        "INSERT INTO rms_pricing.tax_configuration(tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'TEST_STORE_TAX',1,'2026-01-01T00:00:00Z',$4,'2026-01-01T00:00:00Z')",
        [id(200), brandReference, storeReference, owner],
      );
      await admin.query(
        `INSERT INTO rms_pricing.tax_configuration_version(tax_configuration_version_id,tax_configuration_id,brand_id,store_id,version_number,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_until,effective_time_zone,registration_applicability_id,operating_entity_tax_reference_id,jurisdiction_profile_id,registration_evidence_valid_until,professional_evidence_id,professional_review_reference_id,fixture_suite_reference_id,fixture_suite_digest,professional_evidence_valid_until,created_at)
         VALUES($1,$2,$3,$4,1,$5,'Published','CA-ON','CAD',1,$6,$5,'2026-01-01T00:00:00Z',NULL,'America/Toronto',$7,$8,$9,'2027-01-01T00:00:00Z',$10,$11,$12,$5,'2027-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
        [
          id(201),
          id(200),
          brandReference,
          storeReference,
          "sha256:" + "a".repeat(64),
          id(202),
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

      // Organization, Membership and Permission facts: one store; the owner holds price approval,
      // Kai (front of house) only edits prices.
      await seedBrand(admin, { brandReference, policyReference: id(300), from });
      const store = (reference, code, lifecycle) =>
        admin.query(
          "INSERT INTO bop_tenant.store (store_id,brand_id,code,display_name,time_zone,locale,currency_code,lifecycle,version,created_at,updated_at) VALUES ($1,$2,$3,$4,'America/Toronto','en-CA','CAD',$5,1,$6,$6)",
          [reference, brandReference, code, "Synthetic " + code, lifecycle, from],
        );
      await store(storeReference, "STORE_ONE", "Active");
      const approver = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(310),
        code: "brand_owner",
        actions: ["pricing.price-book.approve", "pricing.price-book.manage"],
        from,
      });
      const enrolledAt = new Date(start - 2 * 3600_000).toISOString();
      await seedBrandMember(admin, {
        id,
        base: 400,
        brandReference,
        storeReference,
        actorReference: owner,
        name: "Sam",
        roles: [approver],
        from,
        enrolledAt,
      });
      const editor = await seedBrandRole(admin, {
        id,
        brandReference,
        roleId: id(320),
        code: "front_of_house",
        actions: ["pricing.price-book.manage"],
        from,
      });
      await seedBrandMember(admin, {
        id,
        base: 600,
        brandReference,
        storeReference,
        actorReference: noah,
        name: "Kai",
        roles: [editor],
        from,
        enrolledAt,
      });

      // The command's transaction. `intercept` (tests only) sees each statement first.
      let intercept = null;
      const tx = {
        query: async (sql, values) => {
          const seen = intercept === null ? undefined : await intercept(sql, values);
          if (seen === "skip") return { rows: [], rowCount: 1 };
          if (seen !== undefined && typeof seen === "object") return seen;
          return admin.query(sql, values);
        },
      };
      const persistence = {
        now: () => new Date().toISOString(),
        transactions: {
          async run(work) {
            await admin.query("BEGIN");
            try {
              await admin.query("SET LOCAL ROLE " + role);
              await admin.query("SELECT set_config('bop.tenant_id',$1,true)", [tenantReference]);
              const value = await work(tx);
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
          [noah]: [...priceRead, "pricing.price-book.manage"],
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
      const command = (body) => optionPrices.command({ ...session, body });
      const rejects = (promise, code) =>
        assert.rejects(promise, (error) => error.code === code || assert.fail(String(error.code)));
      const marks = async () =>
        (
          await admin.query(
            `SELECT option_price_rule_id::text rule,actor_id::text actor,approval_mode,listing_store_id::text store,audit_id::text audit FROM ${markTable} ORDER BY listed_at,operation_id`,
          )
        ).rows;
      scope.as(owner);

      // Whipped cream on a hot chocolate (choose any).
      const toppings = (
        await optionSets.command({
          ...session,
          body: {
            action: "Create",
            operationReference: op(),
            name: "Toppings",
            kind: "Any",
            minimum: 0,
            maximum: 2,
            perOptionMaximum: 1,
            options: [
              { optionReference: null, name: "Whipped cream", offered: true, defaultChoice: false },
              { optionReference: null, name: "Marshmallows", offered: true, defaultChoice: false },
            ],
          },
        })
      ).optionSet;
      const [cream, marshmallows] = toppings.options;
      const drink = (
        await products.command({
          ...session,
          body: {
            action: "Create",
            operationReference: op(),
            internalCode: "HOTCHOC",
            productType: "NonAlcoholicBeverage",
            name: "Hot Chocolate",
            taxClassificationReference: taxClass,
            sizes: [{ skuReference: null, skuCode: "HOTCHOC-8", name: "Small (8 oz)" }],
          },
        })
      ).product;
      await products.command({
        ...session,
        body: {
          action: "SaveDraft",
          operationReference: op(),
          productReference: drink.productReference,
          expectedAggregateVersion: drink.aggregateVersion,
          name: "Hot Chocolate",
          taxClassificationReference: taxClass,
          sizes: [
            {
              skuReference: drink.sizes[0].skuReference,
              skuCode: "HOTCHOC-8",
              name: "Small (8 oz)",
            },
          ],
          optionSets: [
            {
              optionSetReference: toppings.optionSetReference,
              enabledOptionReferences: [cream.optionReference, marshmallows.optionReference],
            },
          ],
        },
      });
      const binding = (
        await admin.query("SELECT binding_id::text b FROM rms_catalog.product_option_binding")
      ).rows[0].b;
      const view = async () => await optionPrices.query(session);
      const options = async () => (await view()).products[0].optionSets[0].options;
      const setPrice = async (option, amountMinor) => {
        const row = (await options()).find((o) => o.optionReference === option);
        await command({
          action: "SetPrices",
          operationReference: op(),
          prices: [
            {
              bindingReference: binding,
              optionReference: option,
              amountMinor,
              expectedAggregateVersion: row.aggregateVersion,
              replacesPending: row.pending !== null,
            },
          ],
        });
      };
      await setPrice(cream.optionReference, "50");
      await setPrice(marshmallows.optionReference, "75");
      const publish = (rows, mode) => ({
        action: "Publish",
        operationReference: op(),
        rules: rows
          .filter((o) => o.pending !== null)
          .map((o) => ({
            ruleReference: o.ruleReference,
            expectedAggregateVersion: o.aggregateVersion,
          })),
        ...(mode ? { approvalMode: mode } : {}),
      });

      // ── 1. One store: the author publishes alone; marks and Audit say SingleStoreListing.
      const listing = publish(await options(), "SingleStoreListing");
      assert.equal((await command(listing)).results.length, 2);
      assert.deepEqual(
        (await options()).map((o) => [o.priceMinor, o.pending]),
        [
          ["50", null],
          ["75", null],
        ],
      );
      const recorded = await marks();
      assert.equal(recorded.length, 2);
      for (const mark of recorded) {
        assert.deepEqual(
          [mark.actor, mark.approval_mode, mark.store],
          [owner, "SingleStoreListing", storeReference],
        );
        const audit = (
          await admin.query(
            "SELECT action_code,actor_reference::text actor,after_summary_json::text after FROM platform_audit.audit_record WHERE audit_id=$1",
            [mark.audit],
          )
        ).rows[0];
        assert.equal(audit.action_code, "PRICING_OPTION_PRICE_PUBLISH");
        assert.equal(audit.actor, owner);
        assert.deepEqual(JSON.parse(audit.after), { approvalMode: "SingleStoreListing" });
      }

      // ── 2. Kai has no price approval: cannot publish, even their own prices.
      scope.as(noah);
      await setPrice(cream.optionReference, "60");
      await rejects(command(publish(await options(), "SingleStoreListing")), "PermissionDenied");
      assert.equal((await marks()).length, 2);

      // ── 3. A second store (a draft one) turns the exception off at once.
      scope.as(owner);
      await store(id(6), "STORE_TWO", "Draft");
      await setPrice(marshmallows.optionReference, "80");
      // Only the owner's own pending price (Kai's still waits for review).
      const ownPublish = async () => ({
        action: "Publish",
        operationReference: op(),
        rules: (await options())
          .filter((o) => o.pending !== null && o.optionReference === marshmallows.optionReference)
          .map((o) => ({
            ruleReference: o.ruleReference,
            expectedAggregateVersion: o.aggregateVersion,
          })),
        approvalMode: "SingleStoreListing",
      });
      await rejects(command(await ownPublish()), "NotSingleStore");
      assert.equal((await marks()).length, 2);
      // Even if the command's own store check answered yes, the database refuses the mark (and so
      // the author's own publication) at commit.
      intercept = async (sql) =>
        sql.includes("bop_tenant.brand_has_single_store")
          ? { rows: [{ single: true }], rowCount: 1 }
          : undefined;
      await assert.rejects(
        command(await ownPublish()),
        (error) =>
          /pricing single store listing needs a brand with one store/u.test(
            String(error?.message) + String(error?.cause?.message),
          ) || assert.fail(String(error?.message)),
      );
      intercept = null;
      assert.equal((await marks()).length, 2);
      // Archived, the second store no longer counts: the owner's price lists alone again.
      await admin.query(
        "UPDATE bop_tenant.store SET lifecycle='Archived',version=2 WHERE store_id=$1",
        [id(6)],
      );
      assert.equal((await command(await ownPublish())).results.length, 1);
      assert.equal((await marks()).length, 3);

      // ── 4. Append-only.
      await assert.rejects(
        admin.query(`UPDATE ${markTable} SET actor_id=$1`, [noah]),
        /append-only pricing single store listing/u,
      );
      await assert.rejects(
        admin.query(`DELETE FROM ${markTable}`),
        /append-only pricing single store listing/u,
      );
    } finally {
      await admin.end();
    }
  });
}, 180_000);
