import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import { createMerchantPrices } from "../../../apps/api/src/merchant-prices.ts";
import { createMerchantProducts } from "../../../apps/api/src/merchant-products.ts";
import { currentStorePriceBook } from "../../rms/pricing/src/index.ts";
import { listProductVersionTaxClassifications } from "../../rms/catalog/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { syntheticMerchantBrandScope } from "../test-support/merchant-brand-scope.mjs";
import { productApiGrants } from "../test-support/merchant-api-grants.mjs";

const { Client } = pg;
const id = (n) => "01909a1c-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** The pilot API role's grants for prices (docs/spec/pilot-acl-additions.json). */
const priceApiGrants = [
  "GRANT SELECT,INSERT,UPDATE ON rms_pricing.price_book TO ROLE_",
  "GRANT SELECT,INSERT ON rms_pricing.price_book_version,rms_pricing.price_entry,rms_pricing.price_book_operation_record TO ROLE_",
  "GRANT SELECT,INSERT ON rms_pricing.store_price_book_assignment,rms_pricing.store_price_book_assignment_end TO ROLE_",
  "GRANT SELECT ON platform_eventing.outbox_event TO ROLE_",
  "GRANT SELECT ON rms_catalog.published_menu_projection,rms_catalog.published_menu_projection_checkpoint,rms_catalog.published_menu_projection_generation,rms_catalog.published_menu_projection_section,rms_catalog.published_menu_projection_sellable TO ROLE_",
];

/** WP-2423 / DEC-PRICE-STORE-ASSIGNMENT: price books and the Store's price book, under the API's RLS. */
it("drafts, independently publishes and assigns price books that cover the Store's menu", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_prices" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_prices_" + context.runId;
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      manager = id(5),
      taxClass = id(100);
    let second = 0;
    const now = () => new Date(Date.UTC(2026, 9, 7, 12, 0, ++second)).toISOString();
    let operation = 0x7000;
    const op = () => "019a0000-0000-7000-8000-" + (++operation).toString(16).padStart(12, "0");
    try {
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
      await admin.query(
        "CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      for (const sql of [...productApiGrants, ...priceApiGrants])
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
      const productActions = [
        "catalog.product.read",
        "catalog.product.create",
        "catalog.product.update",
        "catalog.product.manage",
        "catalog.product.publish",
        "catalog.sku.create",
        "catalog.sku.activate",
      ];
      const priceRead = "pricing.price_book.read";
      const scope = syntheticMerchantBrandScope({
        tenantReference,
        brandReference,
        storeReference,
        policyReference: id(300),
        grants: {
          [owner]: [
            ...productActions,
            priceRead,
            "pricing.price-book.manage",
            "pricing.price-book.approve",
          ],
          [manager]: [priceRead, "pricing.price-book.manage", "pricing.price-book.approve"],
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
      const currencyMetadata = {
        ...meta,
        metadataDigest: "sha256:" + createHash("sha256").update(JSON.stringify(meta)).digest("hex"),
      };
      const prices = createMerchantPrices({
        persistence,
        authentication,
        references: { next: op },
        currencyMetadata,
        locale: "en-CA",
        resolveScope: scope.resolveScope,
      });
      const command = (body) => prices.command({ ...session, body });
      const rejects = async (promise, code) =>
        assert.rejects(promise, (error) => error.code === code || assert.fail(String(error.code)));

      // Two selling products: a latte in two sizes and a muffin.
      const make = async (code, name, sizes) => {
        const created = await products.command({
          ...session,
          body: {
            action: "Create",
            operationReference: op(),
            internalCode: code,
            productType: "PreparedFood",
            name,
            taxClassificationReference: taxClass,
            sizes: sizes.map(([skuCode, size]) => ({ skuReference: null, skuCode, name: size })),
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
        return Object.fromEntries(selling.product.sizes.map((size) => [size.skuCode, size]));
      };
      const latte = await make("LATTE", "Latte", [
        ["LATTE-S", "Small"],
        ["LATTE-L", "Large"],
      ]);
      const muffin = await make("MUFFIN", "Muffin", [["MUFFIN", "Regular"]]);
      const small = latte["LATTE-S"].skuReference,
        large = latte["LATTE-L"].skuReference,
        muffinSku = muffin.MUFFIN.skuReference;

      // The Store's menu (a published menu projection) sells the small latte and the muffin. TEST-ONLY
      // seed of the projection rows alone: its menu-authoring parents are outside this case, so the
      // seed skips their foreign keys (session_replication_role) and restores them afterwards.
      await admin.query("SET session_replication_role = replica");
      const generation = id(400),
        menu = id(401),
        section = id(402);
      await admin.query(
        "INSERT INTO rms_catalog.published_menu_projection_generation VALUES($1,$2,$3,'catalog_published_menu_v1',1,'Active',$4,1,$4,'2026-09-20T00:00:00Z','Fresh')",
        [generation, brandReference, menu, id(403)],
      );
      await admin.query(
        `INSERT INTO rms_catalog.published_menu_projection VALUES($1,$2,$3,$4,$5,$6,'en-CA','{"en-CA":"Menu"}',$7,'["CUSTOMER_PWA"]','["PICKUP"]','UTC','2026-09-20T00:00:00Z',NULL)`,
        [
          generation,
          brandReference,
          menu,
          id(404),
          id(405),
          "sha256:" + "b".repeat(64),
          JSON.stringify([storeReference]),
        ],
      );
      await admin.query(
        `INSERT INTO rms_catalog.published_menu_projection_section VALUES($1,$2,$3,$4,'DRINKS','{"en-CA":"Drinks"}',0)`,
        [generation, brandReference, menu, section],
      );
      for (const [n, sellable] of [
        [410, small],
        [411, muffinSku],
      ])
        await admin.query(
          `INSERT INTO rms_catalog.published_menu_projection_sellable VALUES($1,$2,$3,$4,$5,$6,$7,'{"en-CA":"Item"}','Standard',$9,false,'Available','[]',$8)`,
          [
            generation,
            brandReference,
            menu,
            section,
            id(n),
            sellable,
            (
              await admin.query("SELECT product_version_id FROM rms_catalog.sku WHERE sku_id=$1", [
                sellable,
              ])
            ).rows[0].product_version_id,
            JSON.stringify({
              items: [],
              assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
              allergenFreeClaim: false,
              registryVersionReference: id(412),
            }),
            n - 410,
          ],
        );
      await admin.query(
        "INSERT INTO rms_catalog.published_menu_projection_checkpoint VALUES('catalog.published-menu-projection',$1,$2,$3,$4,1,'2026-09-20T00:00:00Z')",
        [brandReference, menu, generation, id(403)],
      );
      await admin.query("SET session_replication_role = DEFAULT");

      // No price book yet: the list shows the menu items and no Store assignment.
      const empty = await prices.query({ ...session, priceBookReference: null });
      assert.equal(empty.storeAssignment, null);
      assert.deepEqual([...empty.menuSellables].sort(), [small, muffinSku].sort());
      assert.equal(empty.sellables.length, 3);

      // The owner drafts a book with prices for the small latte and the muffin.
      const createDraft = {
        action: "CreateDraft",
        operationReference: op(),
        stableCode: "prices-a",
        copyFrom: null,
      };
      const created = await command(createDraft);
      assert.equal(created.status, "Applied");
      const bookA = created.priceBookReference;
      assert.equal((await command(createDraft)).status, "AlreadyApplied");
      const draftA = await prices.query({ ...session, priceBookReference: bookA });
      assert.equal(draftA.book.lifecycle, "Draft");
      assert.equal(draftA.draftAuthor, owner);
      assert.deepEqual([...draftA.uncovered].sort(), [small, muffinSku].sort());
      const saved = await command({
        action: "SaveDraft",
        operationReference: op(),
        priceBookReference: bookA,
        expectedAggregateVersion: draftA.book.aggregateVersion,
        prices: [
          { sellableReference: small, amountMinor: "450" },
          { sellableReference: muffinSku, amountMinor: "325" },
        ],
      });
      assert.equal(saved.aggregateVersion, 2);

      // The author cannot publish their own draft; the manager can. Published books do not change.
      await rejects(
        command({
          action: "Publish",
          operationReference: op(),
          priceBookReference: bookA,
          expectedAggregateVersion: 2,
        }),
        "ApprovalRequired",
      );
      scope.as(manager);
      const published = await command({
        action: "Publish",
        operationReference: op(),
        priceBookReference: bookA,
        expectedAggregateVersion: 2,
      });
      assert.equal(published.lifecycle, "Published");
      await rejects(
        command({
          action: "SaveDraft",
          operationReference: op(),
          priceBookReference: bookA,
          expectedAggregateVersion: 3,
          prices: [],
        }),
        "Lifecycle",
      );

      // Use it at the Store; a retry replays the same assignment.
      const assign = {
        action: "AssignToStore",
        operationReference: op(),
        priceBookReference: bookA,
      };
      const assigned = await command(assign);
      assert.equal(assigned.status, "Applied");
      assert.equal((await command(assign)).status, "AlreadyApplied");
      await rejects(command({ ...assign, operationReference: op() }), "AlreadyAssigned");

      // A new book copied from it, with the muffin left out, cannot replace it until complete.
      scope.as(owner);
      const bookB = (
        await command({
          action: "CreateDraft",
          operationReference: op(),
          stableCode: "PRICES-B",
          copyFrom: bookA,
        })
      ).priceBookReference;
      const draftB = await prices.query({ ...session, priceBookReference: bookB });
      assert.deepEqual(draftB.book.prices.map((p) => p.amountMinor).sort(), ["325", "450"]);
      await command({
        action: "SaveDraft",
        operationReference: op(),
        priceBookReference: bookB,
        expectedAggregateVersion: draftB.book.aggregateVersion,
        prices: [
          { sellableReference: small, amountMinor: "475" },
          { sellableReference: large, amountMinor: "550" },
        ],
      });
      scope.as(manager);
      await command({
        action: "Publish",
        operationReference: op(),
        priceBookReference: bookB,
        expectedAggregateVersion: draftB.book.aggregateVersion + 1,
      });
      await assert.rejects(
        command({ action: "AssignToStore", operationReference: op(), priceBookReference: bookB }),
        (error) => error.code === "NotCovered" && error.sellableReferences.join() === muffinSku,
      );

      // A complete book (C) replaces A: A's assignment ends at the moment C's starts.
      scope.as(owner);
      const bookC = (
        await command({
          action: "CreateDraft",
          operationReference: op(),
          stableCode: "PRICES-C",
          copyFrom: bookB,
        })
      ).priceBookReference;
      const draftC = await prices.query({ ...session, priceBookReference: bookC });
      await command({
        action: "SaveDraft",
        operationReference: op(),
        priceBookReference: bookC,
        expectedAggregateVersion: draftC.book.aggregateVersion,
        prices: [
          { sellableReference: small, amountMinor: "475" },
          { sellableReference: large, amountMinor: "550" },
          { sellableReference: muffinSku, amountMinor: "350" },
        ],
      });
      scope.as(manager);
      await command({
        action: "Publish",
        operationReference: op(),
        priceBookReference: bookC,
        expectedAggregateVersion: draftC.book.aggregateVersion + 1,
      });
      await command({
        action: "AssignToStore",
        operationReference: op(),
        priceBookReference: bookC,
      });
      const list = await prices.query({ ...session, priceBookReference: null });
      assert.equal(list.storeAssignment.stableCode, "PRICES-C");
      assert.deepEqual(
        list.assignmentHistory.map((item) => [item.stableCode, item.endedAt === null]),
        [
          ["PRICES-C", true],
          ["PRICES-A", false],
        ],
      );
      assert.equal(list.assignmentHistory[1].endedAt, list.assignmentHistory[0].effectiveFrom);
      assert.deepEqual(list.books.map((book) => book.stableCode + ":" + book.lifecycle).sort(), [
        "PRICES-A:Published",
        "PRICES-B:Published",
        "PRICES-C:Published",
      ]);

      // A draft can be discarded; the database refuses a second open assignment or edits.
      scope.as(owner);
      const bookD = (
        await command({
          action: "CreateDraft",
          operationReference: op(),
          stableCode: "PRICES-D",
          copyFrom: null,
        })
      ).priceBookReference;
      const discarded = await command({
        action: "Discard",
        operationReference: op(),
        priceBookReference: bookD,
        expectedAggregateVersion: 1,
      });
      assert.equal(discarded.lifecycle, "Archived");
      await assert.rejects(
        admin.query("UPDATE rms_pricing.store_price_book_assignment SET effective_from=now()"),
        /append-only/u,
      );
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_pricing.store_price_book_assignment(assignment_id,tenant_id,brand_id,store_id,price_book_id,price_book_version_id,effective_from,operation_id,intent_hash,actor_id,audit_id) SELECT $1,tenant_id,brand_id,store_id,price_book_id,price_book_version_id,'2026-10-08T00:00:00Z',$2,intent_hash,actor_id,$3 FROM rms_pricing.store_price_book_assignment LIMIT 1",
          [id(500), id(501), id(502)],
        ),
        /more than one open/u,
      );

      // What the customer quote reads: the Store's book and each product version's tax class,
      // in the Store scope (the tax class read restores it).
      const smallVersion = (
        await admin.query("SELECT product_version_id FROM rms_catalog.sku WHERE sku_id=$1", [small])
      ).rows[0].product_version_id;
      const quoteFacts = await persistence.transactions.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brandReference, storeReference],
        );
        const book = await currentStorePriceBook(tx, { brandReference, storeReference });
        const classes = await listProductVersionTaxClassifications(tx, { brandReference }, [
          smallVersion,
        ]);
        const restored = (await tx.query("SELECT current_setting('bop.store_id',true) store", []))
          .rows[0].store;
        return { book, classes: [...classes.values()], restored };
      });
      assert.equal(quoteFacts.book.stableCode, "PRICES-C");
      assert.deepEqual(quoteFacts.classes, [taxClass]);
      assert.equal(quoteFacts.restored, storeReference);

      // Audits: every price book step by its actor; the assignments at Store level.
      const audits = (
        await admin.query(
          "SELECT action_code,actor_reference,store_id FROM platform_audit.audit_record WHERE action_code LIKE 'PRICING_%' ORDER BY occurred_at,action_code",
        )
      ).rows;
      assert.deepEqual(
        audits
          .filter((row) => row.action_code === "PRICING_STORE_PRICE_BOOK_ASSIGN")
          .map((row) => [row.actor_reference, row.store_id]),
        [
          [manager, storeReference],
          [manager, storeReference],
        ],
      );
      assert(
        audits
          .filter((row) => row.action_code === "PRICING_PRICE_BOOK_PUBLISH")
          .every((row) => row.actor_reference === manager),
      );
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role).catch(() => undefined);
      await admin.end();
    }
  });
});
