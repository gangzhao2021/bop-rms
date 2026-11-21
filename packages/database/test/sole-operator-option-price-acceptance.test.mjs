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
  seedSoleOperatorHistory,
  seedSoleOperatorSetting,
  seedStepUp,
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a2e-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const markTable = "rms_pricing.option_price_sole_operator_approval";

/**
 * WP-2423 DEC-SOLE-OPERATOR-APPROVAL (v15 run 2026-10-16: option prices had no sole-operator
 * path): the author of option prices publishes them alone only while sole operator is in effect
 * for them (the only Brand-level holder of price approval), after a second-factor check at most 15
 * minutes old and an explicit request; each publication is marked SoleOperator on its companion
 * record (2000_074) and Audit. The database refuses an author's own publication without its mark,
 * and a mark while sole operator is off. Restricted NOBYPASSRLS role with the rendered pilot API
 * grants.
 */
it("option prices: the author publishes alone only as an in-effect, re-verified sole operator", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_so_optprice" }, async (context) => {
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
      const role = await createPilotApiRole(admin, context, "wp2423_soop");
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

      // Organization, Membership and Permission facts: the owner alone holds price approval.
      await seedBrand(admin, { brandReference, policyReference: id(300), from });
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

      // The command's transaction. `intercept` (tests only) sees each statement first.
      let intercept = null;
      const tx = {
        query: async (sql, values) =>
          intercept !== null && (await intercept(sql, values)) === "skip"
            ? { rows: [], rowCount: 1 }
            : admin.query(sql, values),
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
          [noah]: [...priceRead, "pricing.price-book.manage", "pricing.price-book.approve"],
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
            `SELECT option_price_rule_id::text rule,actor_id::text actor,approval_mode,audit_id::text audit FROM ${markTable} ORDER BY approved_at,operation_id`,
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

      // ── 1. Sole operator not set: the author can't publish their own prices, marked or not.
      assert.deepEqual((await view()).soleOperator, {
        status: "NotSet",
        otherApprovers: [],
        verifiedUntil: null,
      });
      await rejects(command(publish(await options())), "ApprovalRequired");
      await rejects(command(publish(await options(), "SoleOperator")), "SoleOperatorNotInEffect");
      await rejects(
        command({ ...publish(await options()), approvalMode: "Independent" }),
        "Invalid",
      );

      // ── 2. On, in effect: still refused without a recent second factor (enrolled 2 h ago).
      await seedSoleOperatorSetting(admin, {
        id,
        n: 500,
        tenantReference,
        brandReference,
        actorReference: owner,
        state: "On",
        version: 1,
      });
      assert.equal((await view()).soleOperator.status, "Effective");
      await rejects(command(publish(await options(), "SoleOperator")), "NeedsReverification");
      await seedStepUp(admin, {
        id,
        n: 510,
        brandReference,
        storeReference,
        actorReference: owner,
        ageMs: 16 * 60_000,
      });
      await rejects(command(publish(await options(), "SoleOperator")), "NeedsReverification");
      await seedStepUp(admin, {
        id,
        n: 520,
        brandReference,
        storeReference,
        actorReference: owner,
      });
      assert.notEqual((await view()).soleOperator.verifiedUntil, null);
      // The unmarked publication stays refused: the waiver needs the explicit request.
      await rejects(command(publish(await options())), "ApprovalRequired");
      assert.deepEqual(await marks(), []);

      // ── 3. Database guard (2000_074): an author's own publication without its mark is refused
      // when constraints are checked, and nothing is published.
      intercept = async (sql) => (sql.startsWith(`INSERT INTO ${markTable}`) ? "skip" : null);
      await assert.rejects(
        command(publish(await options(), "SoleOperator")),
        /option price published by its own author needs a sole operator approval/u,
      );
      intercept = null;
      // ── 4. Database guard: sole operator turned off before the mark is written (a setting
      // change racing the publication) refuses the mark; the whole publication rolls back.
      const next =
        (
          await admin.query(
            "SELECT max(version)::int v FROM bop_tenant.brand_sole_operator_setting WHERE brand_id=$1",
            [brandReference],
          )
        ).rows[0].v + 1;
      intercept = async (sql) => {
        if (!sql.startsWith(`INSERT INTO ${markTable}`) || intercept === null) return null;
        intercept = null;
        await admin.query("RESET ROLE");
        await seedSoleOperatorSetting(admin, {
          id,
          n: 530,
          tenantReference,
          brandReference,
          actorReference: owner,
          state: "Off",
          version: next,
        });
        await admin.query("SET LOCAL ROLE " + role);
        return null;
      };
      await assert.rejects(
        command(publish(await options(), "SoleOperator")),
        /option price sole operator approval needs sole operator on/u,
      );
      intercept = null;
      assert.deepEqual(
        (await options()).map((o) => [o.priceMinor, o.pending?.priceMinor ?? null]),
        [
          [null, "50"],
          [null, "75"],
        ],
      );
      assert.equal((await view()).soleOperator.status, "Effective");

      // ── 5. Re-verified, explicitly requested: the author publishes alone; marks and Audit say
      // SoleOperator; a retry changes nothing.
      const soleCommand = publish(await options(), "SoleOperator");
      assert.equal((await command(soleCommand)).results.length, 2);
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
        assert.deepEqual([mark.actor, mark.approval_mode], [owner, "SoleOperator"]);
        const audit = (
          await admin.query(
            "SELECT action_code,actor_reference::text actor,after_summary_json::text after FROM platform_audit.audit_record WHERE audit_id=$1",
            [mark.audit],
          )
        ).rows[0];
        assert.equal(audit.action_code, "PRICING_OPTION_PRICE_PUBLISH");
        assert.equal(audit.actor, owner);
        assert.deepEqual(JSON.parse(audit.after), { approvalMode: "SoleOperator" });
      }
      assert.equal((await command(soleCommand)).results.length, 2);
      assert.equal((await marks()).length, 2);

      // ── 6. A second person gains price approval: the waiver lapses at once and names them;
      // they publish the owner's next change independently (no mark).
      await seedBrandMember(admin, {
        id,
        base: 600,
        brandReference,
        storeReference,
        actorReference: noah,
        name: "Noah",
        roles: [approver],
        from,
        enrolledAt,
      });
      await setPrice(cream.optionReference, "60");
      const lapsed = (await view()).soleOperator;
      assert.deepEqual(
        [lapsed.status, lapsed.otherApprovers],
        ["OtherApprovers", [{ displayName: "Noah" }]],
      );
      await rejects(command(publish(await options(), "SoleOperator")), "SoleOperatorNotInEffect");
      scope.as(noah);
      // The waiver is only for one's own prices: Noah asking for it on the owner's draft is refused.
      await rejects(command(publish(await options(), "SoleOperator")), "SoleOperatorNotInEffect");
      assert.equal((await command(publish(await options()))).results.length, 1);
      assert.equal((await marks()).length, 2);

      // ── 7. Noah leaves; turned off (past version 10, by number), the author is refused again.
      await admin.query(
        "UPDATE bop_membership.membership SET lifecycle='Ended',effective_until=clock_timestamp(),version=version+1 WHERE actor_id=$1",
        [noah],
      );
      scope.as(owner);
      await setPrice(cream.optionReference, "65");
      assert.equal((await view()).soleOperator.status, "Effective");
      assert.equal(
        await seedSoleOperatorHistory(admin, {
          id,
          n: 800,
          tenantReference,
          brandReference,
          actorReference: owner,
          atLeast: 11,
          latest: "Off",
        }),
        12,
      );
      assert.equal((await view()).soleOperator.status, "NotSet");
      await rejects(command(publish(await options(), "SoleOperator")), "SoleOperatorNotInEffect");
      await rejects(command(publish(await options())), "ApprovalRequired");

      // ── 8. The mark is append-only and only marks the author's own publication.
      await assert.rejects(
        admin.query(`UPDATE ${markTable} SET actor_id=$1`, [noah]),
        /append-only option price sole operator approval/u,
      );
      await assert.rejects(
        admin.query(`DELETE FROM ${markTable}`),
        /append-only option price sole operator approval/u,
      );
      await assert.rejects(
        admin.query(`TRUNCATE ${markTable}`),
        /append-only option price sole operator approval/u,
      );
      const [draftOperation] = (
        await admin.query(
          "SELECT operation_id::text op,option_price_rule_id::text rule,occurred_at,audit_id::text audit FROM rms_pricing.option_price_authoring_operation WHERE action_code='CreateDraft' LIMIT 1",
        )
      ).rows;
      const [noahPublication] = (
        await admin.query(
          "SELECT operation_id::text op,option_price_rule_id::text rule,occurred_at,audit_id::text audit FROM rms_pricing.option_price_authoring_operation WHERE action_code='Publish' AND actor_id=$1",
          [noah],
        )
      ).rows;
      for (const [row, actor] of [
        [draftOperation, owner],
        [noahPublication, noah],
      ])
        await assert.rejects(
          admin.query(`INSERT INTO ${markTable} VALUES ($1,$2,$3,'SoleOperator',$4,$5,$5,$6)`, [
            row.op,
            brandReference,
            row.rule,
            actor,
            row.occurred_at,
            row.audit,
          ]),
          /must mark its author's own publication/u,
        );
      assert.equal((await marks()).length, 2);
    } finally {
      await admin.end();
    }
  });
});
