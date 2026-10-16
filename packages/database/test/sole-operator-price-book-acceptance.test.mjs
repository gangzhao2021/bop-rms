import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { createMerchantPrices } from "../../../apps/api/src/merchant-prices.ts";
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
const id = (n) => "01909a1d-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 Q19 step 2 (DEC-SOLE-OPERATOR-APPROVAL): the author of a price book publishes it alone
 * only while sole operator is in effect for them (the only Brand-level holder of price approval)
 * and after a second-factor check at most 15 minutes old; the publication is marked SoleOperator
 * on its companion record and Audit. A second approver ends it at once; turning it off restores
 * the two-person rule. Restricted NOBYPASSRLS role with the rendered pilot API grants.
 */
it("price book: the author publishes alone only as an in-effect, re-verified sole operator", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_so_price" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      noah = id(5),
      taxClass = id(100);
    let operation = 0x7000;
    const op = () => "019a0001-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    try {
      const role = await createPilotApiRole(admin, context, "wp2423_sop");
      const start = Date.parse(await dbNow(admin));
      const from = new Date(start - 3 * 3600_000).toISOString();
      // TEST-ONLY Store tax configuration covering the tax class the products use.
      await admin.query(
        "INSERT INTO rms_pricing.tax_configuration(tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'TEST_STORE_TAX',1,'2026-09-20T00:00:00Z',$4,'2026-09-20T00:00:00Z')",
        [id(200), brandReference, storeReference, owner],
      );
      await admin.query(
        `INSERT INTO rms_pricing.tax_configuration_version(tax_configuration_version_id,tax_configuration_id,brand_id,store_id,version_number,snapshot_digest,lifecycle,jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,effective_from,effective_until,effective_time_zone,registration_applicability_id,operating_entity_tax_reference_id,jurisdiction_profile_id,registration_evidence_valid_until,professional_evidence_id,professional_review_reference_id,fixture_suite_reference_id,fixture_suite_digest,professional_evidence_valid_until,created_at)
         VALUES($1,$2,$3,$4,1,$5,'Published','CA-ON','CAD',1,$6,$5,'2026-09-20T00:00:00Z',NULL,'America/Toronto',$7,$8,$9,'2027-01-01T00:00:00Z',$10,$11,$12,$5,'2027-01-01T00:00:00Z','2026-09-20T00:00:00Z')`,
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
      await admin.query(
        "INSERT INTO rms_pricing.tax_configuration_rule(tax_configuration_rule_id,tax_configuration_version_id,tax_configuration_id,brand_id,store_id,tax_classification_id,order_type,charge_type,tax_component_code,treatment,tax_rate,price_inclusion,rounding_mode,calculation_order,compound_on_prior_tax,exception_evidence_id,receipt_presentation_code) VALUES($1,$2,$3,$4,$5,$6,'Pickup','Sellable','TEST_TAX','Taxable',0.13,'Exclusive','HalfUp',1,false,NULL,'TEST_TAX_LINE')",
        [id(210), id(201), id(200), brandReference, storeReference, taxClass],
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

      const persistence = {
        now: () => new Date().toISOString(),
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
      const priceActions = [
        "pricing.price_book.read",
        "pricing.price-book.manage",
        "pricing.price-book.approve",
      ];
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
            ...priceActions,
          ],
          [noah]: priceActions,
        },
      });
      const session = { sessionCookie: "cookie", csrf: "csrf" };
      const authentication = { authorize: async () => ({ sessionReference: id(7) }) };
      const products = createMerchantProducts({
        persistence,
        authentication,
        references: { next: op },
        locale: "en-CA",
        resolveScope: scope.resolveScope,
      });
      const meta = {
        currencyCode: "CAD",
        minorUnitExponent: 2,
        metadataVersion: 1,
        metadataVersionReference: id(90),
      };
      const prices = createMerchantPrices({
        persistence,
        authentication,
        references: { next: op },
        currencyMetadata: {
          ...meta,
          metadataDigest:
            "sha256:" + createHash("sha256").update(JSON.stringify(meta)).digest("hex"),
        },
        locale: "en-CA",
        resolveScope: scope.resolveScope,
      });
      const command = (body) => prices.command({ ...session, body });
      const rejects = (promise, code) =>
        assert.rejects(promise, (error) => error.code === code || assert.fail(String(error.code)));

      const created = await products.command({
        ...session,
        body: {
          action: "Create",
          operationReference: op(),
          internalCode: "LATTE",
          productType: "PreparedFood",
          name: "Latte",
          taxClassificationReference: taxClass,
          sizes: [{ skuReference: null, skuCode: "LATTE-S", name: "Small" }],
        },
      });
      const selling = await products.command({
        ...session,
        body: {
          action: "StartSelling",
          operationReference: op(),
          productReference: created.product.productReference,
          expectedAggregateVersion: created.product.aggregateVersion,
        },
      });
      const small = selling.product.sizes[0].skuReference;
      const draft = async (code) => {
        const book = (
          await command({
            action: "CreateDraft",
            operationReference: op(),
            stableCode: code,
            copyFrom: null,
          })
        ).priceBookReference;
        await command({
          action: "SaveDraft",
          operationReference: op(),
          priceBookReference: book,
          expectedAggregateVersion: 1,
          prices: [{ sellableReference: small, amountMinor: "450" }],
        });
        return book;
      };
      const publish = (book, mode) => ({
        action: "Publish",
        operationReference: op(),
        priceBookReference: book,
        expectedAggregateVersion: 2,
        ...(mode ? { approvalMode: mode } : {}),
      });
      const marks = async () =>
        (
          await admin.query(
            "SELECT price_book_id::text book,actor_id::text actor,approval_mode,audit_id::text audit FROM rms_pricing.price_book_sole_operator_approval ORDER BY approved_at",
          )
        ).rows;

      // ── 1. Sole operator not set: the author can't publish their own draft, marked or not.
      scope.as(owner);
      const bookA = await draft("prices-a");
      const viewA = await prices.query({ ...session, priceBookReference: bookA });
      assert.deepEqual(viewA.soleOperator, {
        status: "NotSet",
        otherApprovers: [],
        verifiedUntil: null,
      });
      await rejects(command(publish(bookA)), "ApprovalRequired");
      await rejects(command(publish(bookA, "SoleOperator")), "SoleOperatorNotInEffect");
      await rejects(command({ ...publish(bookA), approvalMode: "Independent" }), "Invalid");

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
      assert.equal(
        (await prices.query({ ...session, priceBookReference: bookA })).soleOperator.status,
        "Effective",
      );
      await rejects(command(publish(bookA, "SoleOperator")), "NeedsReverification");
      // A step-up 16 minutes old does not count either.
      await seedStepUp(admin, {
        id,
        n: 510,
        brandReference,
        storeReference,
        actorReference: owner,
        ageMs: 16 * 60_000,
      });
      await rejects(command(publish(bookA, "SoleOperator")), "NeedsReverification");
      // The unmarked publication stays refused: the waiver needs the explicit confirmation.
      await seedStepUp(admin, {
        id,
        n: 520,
        brandReference,
        storeReference,
        actorReference: owner,
      });
      await rejects(command(publish(bookA)), "ApprovalRequired");
      assert.deepEqual(await marks(), []);

      // ── 3. Re-verified: the author publishes alone; mark and Audit say SoleOperator.
      const soleCommand = publish(bookA, "SoleOperator");
      const published = await command(soleCommand);
      assert.equal(published.lifecycle, "Published");
      const [mark] = await marks();
      assert.deepEqual([mark.book, mark.actor, mark.approval_mode], [bookA, owner, "SoleOperator"]);
      const audit = (
        await admin.query(
          "SELECT action_code,actor_reference::text actor,after_summary_json::text after FROM platform_audit.audit_record WHERE audit_id=$1",
          [mark.audit],
        )
      ).rows[0];
      assert.equal(audit.action_code, "PRICING_PRICE_BOOK_PUBLISH");
      assert.equal(audit.actor, owner);
      assert.deepEqual(JSON.parse(audit.after), { approvalMode: "SoleOperator" });
      assert.equal((await command(soleCommand)).status, "AlreadyApplied");
      assert.equal((await marks()).length, 1);

      // ── 4. A second person gains price approval: the waiver lapses at once and names them.
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
      const bookB = await draft("prices-b");
      const lapsed = (await prices.query({ ...session, priceBookReference: bookB })).soleOperator;
      assert.deepEqual(
        [lapsed.status, lapsed.otherApprovers],
        ["OtherApprovers", [{ displayName: "Noah" }]],
      );
      await rejects(command(publish(bookB, "SoleOperator")), "SoleOperatorNotInEffect");
      // Noah publishes independently (no mark); the mark is refused for someone else's draft.
      scope.as(noah);
      await rejects(command(publish(bookB, "SoleOperator")), "ApprovalRequired");
      assert.equal((await command(publish(bookB))).lifecycle, "Published");
      assert.equal((await marks()).length, 1);

      // ── 5. Noah leaves the Brand (membership ended): it is in effect again; turned off, it is not.
      await admin.query(
        "UPDATE bop_membership.membership SET lifecycle='Ended',effective_until=clock_timestamp(),version=version+1 WHERE actor_id=$1",
        [noah],
      );
      scope.as(owner);
      const bookC = await draft("prices-c");
      assert.equal(
        (await prices.query({ ...session, priceBookReference: bookC })).soleOperator.status,
        "Effective",
      );
      await seedSoleOperatorSetting(admin, {
        id,
        n: 700,
        tenantReference,
        brandReference,
        actorReference: owner,
        state: "Off",
        version: 2,
      });
      await rejects(command(publish(bookC, "SoleOperator")), "SoleOperatorNotInEffect");
      // WP-2423 v15 defect (2026-10-16): past version 10 the latest version still decides (a text
      // sort read version 9 "On" as the latest and let the author publish alone).
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
      assert.equal(
        (await prices.query({ ...session, priceBookReference: bookC })).soleOperator.status,
        "NotSet",
      );
      await rejects(command(publish(bookC, "SoleOperator")), "SoleOperatorNotInEffect");

      // ── 6. The mark is append-only and only marks a publication.
      await assert.rejects(
        admin.query("UPDATE rms_pricing.price_book_sole_operator_approval SET actor_id=$1", [noah]),
        /append-only price book sole operator approval/u,
      );
      await assert.rejects(
        admin.query("DELETE FROM rms_pricing.price_book_sole_operator_approval"),
        /append-only price book sole operator approval/u,
      );
      const createOperation = (
        await admin.query(
          "SELECT operation_id::text op FROM rms_pricing.price_book_operation_record WHERE price_book_id=$1 AND action_code='CreateDraft'",
          [bookC],
        )
      ).rows[0].op;
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_pricing.price_book_sole_operator_approval VALUES ($1,$2,$3,'SoleOperator',$4,now(),date_trunc('milliseconds',now()),$5)",
          [createOperation, brandReference, bookC, owner, id(900)],
        ),
        /must mark a publication/u,
      );
    } finally {
      await admin.end();
    }
  });
});
