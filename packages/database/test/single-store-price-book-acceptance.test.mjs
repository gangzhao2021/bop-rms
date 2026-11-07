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
} from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01909a2d-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU (Owner 2026-10-28 decision 7; coordinator condition 4):
 * at a Brand with one store, the author of a price book publishes it alone ("List it", no review);
 * the publication is marked SingleStoreListing on its companion record and Audit. Through the real
 * price commands under the restricted NOBYPASSRLS role with the rendered pilot API grants:
 * 1. one store: the author who holds price approval publishes alone; marked;
 * 2. someone without price approval cannot, even their own draft; nothing is marked;
 * 3. a second store (a draft one) turns it off at once — refused by the command, and a mark written
 *    directly on another person's publication is refused by the database; archived, it is back;
 * 4. marks are append-only.
 */
it("price book: a single store's author publishes alone; no price approval or a second store refuses", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_ss_price" }, async (context) => {
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
      const role = await createPilotApiRole(admin, context, "wp2423_ssp");
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

      // Organization, Membership and Permission facts: one store; the owner holds price approval,
      // Kai (front of house) only edits drafts.
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
          // Kai edits price drafts but holds no price approval.
          [noah]: ["pricing.price_book.read", "pricing.price-book.manage"],
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
            "SELECT price_book_id::text book,actor_id::text actor,approval_mode,listing_store_id::text store,audit_id::text audit FROM rms_pricing.price_book_single_store_listing ORDER BY listed_at",
          )
        ).rows;

      // ── 1. One store: the author publishes alone; the mark and Audit say SingleStoreListing.
      scope.as(owner);
      const bookA = await draft("prices-a");
      const listing = publish(bookA, "SingleStoreListing");
      const published = await command(listing);
      assert.equal(published.lifecycle, "Published");
      const [mark] = await marks();
      assert.deepEqual(
        [mark.book, mark.actor, mark.approval_mode, mark.store],
        [bookA, owner, "SingleStoreListing", storeReference],
      );
      const audit = (
        await admin.query(
          "SELECT action_code,actor_reference::text actor,after_summary_json::text after FROM platform_audit.audit_record WHERE audit_id=$1",
          [mark.audit],
        )
      ).rows[0];
      assert.equal(audit.action_code, "PRICING_PRICE_BOOK_PUBLISH");
      assert.equal(audit.actor, owner);
      assert.deepEqual(JSON.parse(audit.after), { approvalMode: "SingleStoreListing" });
      assert.equal((await command(listing)).status, "AlreadyApplied");
      assert.equal((await marks()).length, 1);
      // Without asking for it, the author still cannot publish their own draft.
      const bookB = await draft("prices-b");
      await rejects(command(publish(bookB)), "ApprovalRequired");

      // ── 2. Kai has no price approval: cannot publish, even their own draft as a listing.
      scope.as(noah);
      const kais = await draft("prices-kai");
      await rejects(command(publish(kais, "SingleStoreListing")), "PermissionDenied");
      assert.equal((await marks()).length, 1);

      // ── 3. A second store (a draft one) turns the exception off at once.
      await store(id(6), "STORE_TWO", "Draft");
      scope.as(owner);
      await rejects(command(publish(bookB, "SingleStoreListing")), "NotSingleStore");
      assert.equal((await marks()).length, 1);
      // Kai's draft published by the owner (two people, no mark), then a single-store mark written
      // directly on that publication: the database refuses it while the Brand has two stores.
      assert.equal((await command(publish(kais))).lifecycle, "Published");
      const ownerPublished = (
        await admin.query(
          "SELECT operation_id::text operation FROM rms_pricing.price_book_operation_record WHERE price_book_id=$1 AND action_code='Publish'",
          [kais],
        )
      ).rows[0].operation;
      await assert.rejects(
        persistence.transactions.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
            [brandReference],
          );
          await tx.query(
            "INSERT INTO rms_pricing.price_book_single_store_listing (operation_id,brand_id,price_book_id,approval_mode,listing_store_id,actor_id,listed_at,audit_id) VALUES ($1,$2,$3,'SingleStoreListing',$4,$5,date_trunc('milliseconds',now()),$6)",
            [ownerPublished, brandReference, kais, storeReference, owner, id(0x9999)],
          );
        }),
        /pricing single store listing needs a brand with one store/u,
      );
      // Archived, the second store no longer counts: listing alone works again.
      await admin.query(
        "UPDATE bop_tenant.store SET lifecycle='Archived',version=2 WHERE store_id=$1",
        [id(6)],
      );
      assert.equal((await command(publish(bookB, "SingleStoreListing"))).lifecycle, "Published");
      assert.equal((await marks()).length, 2);

      // ── 4. Append-only.
      await assert.rejects(
        admin.query("UPDATE rms_pricing.price_book_single_store_listing SET actor_id=$1", [noah]),
        /append-only pricing single store listing/u,
      );
      await assert.rejects(
        admin.query("DELETE FROM rms_pricing.price_book_single_store_listing"),
        /append-only pricing single store listing/u,
      );
    } finally {
      await admin.end();
    }
  });
}, 180_000);
