import { createCurrentOptionSetDraftPriceReferenceSource } from "../../../apps/api/src/current-option-set-draft-price-references.ts";
import {
  createPostgresFullOptionSetDraftStore,
  parseCatalogOptionSetEditorContent,
  CatalogError,
} from "../../rms/catalog/src/index.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresConfigurationReferenceSourceStore,
  parseConfigurationReferenceSourceSnapshot,
} from "../../rms/pricing/src/index.ts";
import { input } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { fixture } from "../../rms/ordering/src/tests/configured-cart-quote.fixture.ts";
import { seedPriceBook } from "../test-support/price-book-seed.mjs";
import { seedOptionPriceRule } from "../test-support/option-price-seed.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `01902412-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const past = "2026-08-02T16:00:00.000Z";
const request = {
  purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ",
  brandReference: id(1),
  actorReference: id(9),
  operationReference: id(8),
  catalogIntentDigest: "sha256:" + "a".repeat(64),
};
const tables = [
  "price_book",
  "price_book_version",
  "price_entry",
  "option_price_rule",
  "option_price_rule_version",
  "promotion",
  "promotion_version",
  "promotion_eligibility_reference",
];
const unavailable = { code: "CONFIGURATION_REFERENCE_SOURCE_UNAVAILABLE" };
it("holds all actual Pricing reference writers through COMMIT, preserving RLS, backfill, current fields and rollback", async () => {
  await withIsolatedDatabase({ root, caseId: "configuration_refs" }, async (context) => {
    const admin = new Client(context.clientConfig),
      reader = new Client(context.clientConfig),
      writer = new Client(context.clientConfig),
      role = `bop_wp2412_read_${context.runId}`,
      writerRole = `bop_wp2412_write_${context.runId}`;
    await admin.connect();
    await reader.connect();
    await writer.connect();
    let tx,
      headerCalls = 0,
      familyCalls = 0,
      denyHeader = 0,
      denyFamily = 0,
      offset = 0,
      slowFamily = false,
      beforeCommit;
    const runner = {
      async run(work) {
        await reader.query("BEGIN");
        await reader.query("SET LOCAL ROLE " + role);
        try {
          tx = { query: (sql, values) => reader.query(sql, [...values]) };
          const value = await work(tx);
          if (beforeCommit) await beforeCommit();
          await reader.query("COMMIT");
          return value;
        } catch (error) {
          await reader.query("ROLLBACK");
          throw error;
        } finally {
          tx = undefined;
        }
      },
    };
    const family = {
      async holdUntilTransactionCompletes(actual, input) {
        assert.equal(actual, tx);
        assert.deepEqual(input.request, request);
        assert(input.requiredFields.length > 0);
        if (++familyCalls === denyFamily) throw new Error("synthetic field revoked");
        if (slowFamily && familyCalls % 9 === 0) offset = 6000;
      },
    };
    const options = {
      tenantReference: id(7),
      brandReference: id(1),
      actorReference: id(9),
      transactions: runner,
      clock: { now: () => new Date(Date.now() + offset).toISOString() },
      priceBookAuthority: family,
      optionPriceAuthority: family,
      promotionAuthority: family,
      authority: {
        async holdUntilTransactionCompletes(actual, input) {
          assert.equal(actual, tx);
          assert.deepEqual(input.request, request);
          assert.equal(input.requiredScope, "Brand");
          assert.deepEqual(input.requiredPermissions, [
            "pricing.price-book.manage",
            "pricing.promotion.manage",
          ]);
          assert.deepEqual(input.requiredFields, ["generation", "sourceDigests"]);
          if (++headerCalls === denyHeader) throw new Error("synthetic current source revoked");
        },
      },
    };
    const store = createPostgresConfigurationReferenceSourceStore(options);
    const generation = async () =>
      (
        await admin.query(
          "SELECT generation::text FROM rms_pricing.configuration_reference_generation WHERE brand_id=$1",
          [id(1)],
        )
      ).rows[0]?.generation;
    const peer = async (sql) => {
      await writer.query("BEGIN");
      try {
        await writer.query("SET LOCAL ROLE " + writerRole);
        await writer.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [id(1), id(44)],
        );
        await writer.query("SET LOCAL lock_timeout='100ms'");
        return await writer.query(sql);
      } finally {
        await writer.query("ROLLBACK");
      }
    };
    const fence = async () =>
      (
        await writer.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) available", [
          "PricingConfigurationReferenceV1:" + id(1),
        ])
      ).rows[0].available;
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query("CREATE ROLE " + writerRole + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      for (const name of [role, writerRole]) {
        await admin.query("GRANT USAGE ON SCHEMA rms_pricing,platform_helpers TO " + name);
        await admin.query(
          "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
            name,
        );
        await admin.query(
          "GRANT SELECT ON " + tables.map((t) => "rms_pricing." + t).join(",") + " TO " + name,
        );
      }
      await admin.query(
        "GRANT SELECT ON rms_pricing.configuration_reference_generation TO " + role,
      );
      await admin.query(
        "GRANT INSERT,UPDATE,DELETE ON " +
          tables.map((t) => "rms_pricing." + t).join(",") +
          " TO " +
          writerRole,
      );
      // Legitimate empty Brand still requires every source field permission.
      const empty = await store.withCurrentSnapshot(request, async (s) => s);
      assert.equal(empty.generation, "0");
      assert.equal(empty.priceBooks.references.length, 0);
      assert.equal(empty.taxCoverage, "Unavailable");
      assert.equal(familyCalls, 9);
      denyFamily = familyCalls + 1;
      await assert.rejects(
        store.withCurrentSnapshot(request, async () => assert.fail("denied empty consumer")),
        unavailable,
      );
      denyFamily = 0;
      const book = {
        ...input().priceBook,
        priceBookReference: id(11),
        versionReference: id(12),
        brandReference: id(1),
        stableCode: "SYNTHETIC_REFERENCE",
        entries: [
          { ...input().priceBook.entries[0], entryReference: id(13), sellableReference: id(14) },
        ],
      };
      await seedPriceBook(admin, book, id(9));
      const option = {
        ...fixture().quote.lines[0].optionPrices[0].rule,
        ruleReference: id(21),
        versionReference: id(22),
        brandReference: id(1),
        bindingReference: id(23),
        optionReference: id(24),
      };
      await seedOptionPriceRule(admin, option, id(9));
      await admin.query(
        "INSERT INTO rms_pricing.promotion(promotion_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_REFERENCE',1,$3,$4,$3)",
        [id(31), id(1), past, id(9)],
      );
      await admin.query(
        "INSERT INTO rms_pricing.promotion_version(promotion_version_id,promotion_id,brand_id,version_number,snapshot_digest,lifecycle,promotion_type,currency_code,benefit_scope,benefit_calculation,benefit_rate,stacking,priority,budget_minor,usage_minor,usage_count,redemption_limit,effective_from,effective_time_zone,customer_copy_code,created_at) VALUES($1,$2,$3,1,$4,'Draft','ItemPercentage','CAD','Item','Percentage',0.1,'Exclusive',0,1000,0,0,10,$5,'America/Toronto','SYNTHETIC_REFERENCE_COPY',$5)",
        [id(32), id(31), id(1), "sha256:" + "b".repeat(64), past],
      );
      await admin.query(
        "INSERT INTO rms_pricing.promotion_eligibility_reference VALUES($1,$2,$3,$4,'Sellable',$5)",
        [id(33), id(32), id(31), id(1), id(14)],
      );
      await admin.query(
        "UPDATE rms_pricing.promotion SET current_version_id=$1 WHERE promotion_id=$2",
        [id(32), id(31)],
      );
      await admin.query(
        "INSERT INTO rms_pricing.option_price_rule(option_price_rule_id,brand_id,binding_id,option_id,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,$4,1,$5,$6,$5)",
        [id(25), id(1), id(23), id(26), past, id(9)],
      );
      await seedPriceBook(
        admin,
        {
          ...book,
          priceBookReference: id(51),
          versionReference: id(52),
          brandReference: id(2),
          entries: [{ ...book.entries[0], entryReference: id(53) }],
        },
        id(9),
      );
      // Exact new migration backfill, entirely rolled back; no applied history edit.
      await admin.query("BEGIN");
      for (const table of tables) {
        await admin.query(
          "DROP TRIGGER " + table + "_configuration_reference_fence ON rms_pricing." + table,
        );
        await admin.query(
          "DROP TRIGGER " + table + "_configuration_reference_no_truncate ON rms_pricing." + table,
        );
      }
      await admin.query(
        "DROP FUNCTION rms_pricing.maintain_configuration_reference_generation();DROP FUNCTION rms_pricing.reject_configuration_reference_truncate();DROP TABLE rms_pricing.configuration_reference_generation",
      );
      await admin.query(
        await readFile(
          path.join(
            root,
            "migrations/1200-rms-pricing/1200_013_create_configuration_reference_generation.sql",
          ),
          "utf8",
        ),
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT generation::text FROM rms_pricing.configuration_reference_generation ORDER BY brand_id",
          )
        ).rows,
        [{ generation: "0" }, { generation: "0" }],
      );
      await admin.query("ROLLBACK");
      const first = await store.withCurrentSnapshot(request, async (s) => s);
      assert.equal(
        parseConfigurationReferenceSourceSnapshot(first, request, new Date().toISOString()).digest,
        first.digest,
      );
      assert.equal(first.priceBooks.references.length, 1);
      assert.equal(first.optionPrices.roots.length, 2);
      assert.equal(first.optionPrices.versions.length, 1);
      assert.equal(first.promotions.versions[0].eligibility.length, 1);
      assert.equal(JSON.stringify(first).includes(id(51)), false);
      assert.equal(/amountMinor|benefitRate|createdByActor/.test(JSON.stringify(first)), false);
      const fresh = await store.withCurrentSnapshot(request, async (s) => s);
      assert.equal(fresh.digest, first.digest); // Observing the same data again is not source mutation.
      const peerReader = new Client(context.clientConfig);
      await peerReader.connect();
      try {
        const compatible = createPostgresConfigurationReferenceSourceStore({
          ...options,
          authority: {
            async holdUntilTransactionCompletes(_tx, input) {
              assert.deepEqual(input.request, request);
              assert.equal(input.requiredScope, "Brand");
            },
          },
          priceBookAuthority: {
            async holdUntilTransactionCompletes(_actual, input) {
              assert.deepEqual(input.request, request);
              assert(input.requiredFields.length > 0);
            },
          },
          optionPriceAuthority: {
            async holdUntilTransactionCompletes(_actual, input) {
              assert.deepEqual(input.request, request);
              assert(input.requiredFields.length > 0);
            },
          },
          promotionAuthority: {
            async holdUntilTransactionCompletes(_actual, input) {
              assert.deepEqual(input.request, request);
              assert(input.requiredFields.length > 0);
            },
          },
          transactions: {
            async run(work) {
              await peerReader.query("BEGIN");
              await peerReader.query("SET LOCAL ROLE " + role);
              try {
                const value = await work({
                  query: (sql, values) => peerReader.query(sql, [...values]),
                });
                await peerReader.query("COMMIT");
                return value;
              } catch (error) {
                await peerReader.query("ROLLBACK");
                throw error;
              }
            },
          },
        });
        await store.withCurrentSnapshot(request, async (s) =>
          assert.equal(
            await compatible.withCurrentSnapshot(request, async (other) => other.digest),
            s.digest,
          ),
        );
      } finally {
        await peerReader.end();
      }
      const mutations = [
        "UPDATE rms_pricing.price_book SET updated_at=updated_at WHERE price_book_id='" +
          id(11) +
          "'",
        "INSERT INTO rms_pricing.price_book_version SELECT (jsonb_populate_record(NULL::rms_pricing.price_book_version,to_jsonb(v)||jsonb_build_object('price_book_version_id','" +
          id(112) +
          "','version_number',2))).* FROM rms_pricing.price_book_version v WHERE price_book_version_id='" +
          id(12) +
          "'",
        "INSERT INTO rms_pricing.price_entry SELECT (jsonb_populate_record(NULL::rms_pricing.price_entry,to_jsonb(e)||jsonb_build_object('price_entry_id','" +
          id(113) +
          "','sellable_id','" +
          id(114) +
          "'))).* FROM rms_pricing.price_entry e WHERE price_entry_id='" +
          id(13) +
          "'",
        "UPDATE rms_pricing.option_price_rule SET updated_at=updated_at WHERE option_price_rule_id='" +
          id(21) +
          "'",
        "INSERT INTO rms_pricing.option_price_rule_version SELECT (jsonb_populate_record(NULL::rms_pricing.option_price_rule_version,to_jsonb(v)||jsonb_build_object('option_price_rule_version_id','" +
          id(122) +
          "','version_number',2))).* FROM rms_pricing.option_price_rule_version v WHERE option_price_rule_version_id='" +
          id(22) +
          "'",
        "UPDATE rms_pricing.promotion SET updated_at=updated_at WHERE promotion_id='" +
          id(31) +
          "'",
        "INSERT INTO rms_pricing.promotion_version SELECT (jsonb_populate_record(NULL::rms_pricing.promotion_version,to_jsonb(v)||jsonb_build_object('promotion_version_id','" +
          id(132) +
          "','version_number',2))).* FROM rms_pricing.promotion_version v WHERE promotion_version_id='" +
          id(32) +
          "'",
        "INSERT INTO rms_pricing.promotion_eligibility_reference SELECT (jsonb_populate_record(NULL::rms_pricing.promotion_eligibility_reference,to_jsonb(e)||jsonb_build_object('promotion_eligibility_reference_id','" +
          id(133) +
          "','public_reference_id','" +
          id(134) +
          "'))).* FROM rms_pricing.promotion_eligibility_reference e WHERE promotion_eligibility_reference_id='" +
          id(33) +
          "'",
      ];
      beforeCommit = async () => assert.equal(await fence(), false);
      const marker = { held: true };
      assert.equal(
        await store.withCurrentSnapshot(request, async (s) => {
          assert.equal(s.generation, first.generation);
          for (const sql of mutations) await assert.rejects(peer(sql), { code: "55P03" });
          return marker;
        }),
        marker,
      );
      beforeCommit = undefined;
      assert.equal(await fence(), true);
      for (const sql of mutations) await peer(sql); // Same valid mutations proceed once holder releases, then roll back.
      // Limited owner writer updates only source tables; metadata function restores caller Store context.
      await writer.query("BEGIN");
      await writer.query("SET LOCAL ROLE " + writerRole);
      await writer.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [id(1), id(44)],
      );
      await writer.query(
        "UPDATE rms_pricing.price_book SET updated_at=updated_at WHERE price_book_id=$1",
        [id(11)],
      );
      assert.deepEqual(
        (
          await writer.query(
            "SELECT current_setting('bop.brand_id') brand,current_setting('bop.store_id') store",
          )
        ).rows[0],
        { brand: id(1), store: id(44) },
      );
      await assert.rejects(
        writer.query(
          "UPDATE rms_pricing.configuration_reference_generation SET generation=generation+1",
        ),
        { code: "42501" },
      );
      await writer.query("ROLLBACK");
      // A permitted callback source mutation must be rejected and rolled back by the owning runner.
      await admin.query("GRANT UPDATE(updated_at) ON rms_pricing.price_book TO " + role);
      const originalGeneration = await generation();
      await assert.rejects(
        store.withCurrentSnapshot(request, async () => {
          await tx.query(
            "UPDATE rms_pricing.price_book SET updated_at=updated_at WHERE price_book_id=$1",
            [id(11)],
          );
          return marker;
        }),
        unavailable,
      );
      assert.equal(await generation(), originalGeneration);
      await admin.query("REVOKE UPDATE(updated_at) ON rms_pricing.price_book FROM " + role);
      denyHeader = headerCalls + 3;
      await assert.rejects(
        store.withCurrentSnapshot(request, async () => marker),
        unavailable,
      );
      denyHeader = 0;
      denyFamily = familyCalls + 9;
      await assert.rejects(
        store.withCurrentSnapshot(request, async () => marker),
        unavailable,
      );
      denyFamily = 0;
      slowFamily = true;
      familyCalls = 0;
      await assert.rejects(
        store.withCurrentSnapshot(request, async () => marker),
        unavailable,
      );
      slowFamily = false;
      offset = 0;
      const repeatable = {
        ...options,
        transactions: {
          run: (work) =>
            runner.run(async (bound) => {
              await bound.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", []);
              return work(bound);
            }),
        },
      };
      await assert.rejects(
        createPostgresConfigurationReferenceSourceStore(repeatable).withCurrentSnapshot(
          request,
          async () => marker,
        ),
        unavailable,
      );
      // Missing source metadata never becomes an empty result for existing roots.
      await admin.query("BEGIN");
      await admin.query(
        "DELETE FROM rms_pricing.configuration_reference_generation WHERE brand_id=$1",
        [id(1)],
      );
      const boundOptions = {
        ...options,
        transactions: {
          run: async (work) => {
            tx = { query: (sql, values) => admin.query(sql, [...values]) };
            try {
              return await work(tx);
            } finally {
              tx = undefined;
            }
          },
        },
      };
      await assert.rejects(
        createPostgresConfigurationReferenceSourceStore(boundOptions).withCurrentSnapshot(
          request,
          async () => marker,
        ),
        unavailable,
      );
      await admin.query("ROLLBACK");
      await reader.query("BEGIN");
      await reader.query("SET LOCAL ROLE " + role);
      await reader.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [id(1), id(44)],
      );
      assert.equal(
        (await reader.query("SELECT count(*) FROM rms_pricing.configuration_reference_generation"))
          .rows[0].count,
        "0",
      );
      await reader.query("ROLLBACK");
      await reader.query("BEGIN");
      await reader.query("SET LOCAL ROLE " + role);
      await assert.rejects(
        reader.query("SELECT rms_pricing.maintain_configuration_reference_generation()"),
        { code: "42501" },
      );
      await reader.query("ROLLBACK");
      // Generation includes empty roots, removal and legacy cross-Brand moves, not only matching entries.
      const beforeEmptyRoot = await generation();
      await admin.query(
        "INSERT INTO rms_pricing.price_book(price_book_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'SYNTHETIC_EMPTY_MOVABLE',1,$3,$4,$3)",
        [id(61), id(1), past, id(9)],
      );
      assert(BigInt(await generation()) > BigInt(beforeEmptyRoot));
      const beforeMove = await generation();
      await admin.query("UPDATE rms_pricing.price_book SET brand_id=$1 WHERE price_book_id=$2", [
        id(3),
        id(61),
      ]);
      assert(BigInt(await generation()) > BigInt(beforeMove));
      assert.equal(
        (
          await admin.query(
            "SELECT generation::text FROM rms_pricing.configuration_reference_generation WHERE brand_id=$1",
            [id(3)],
          )
        ).rows[0].generation,
        "1",
      );
      await admin.query("DELETE FROM rms_pricing.price_book WHERE price_book_id=$1", [id(61)]);
      assert.equal(
        (
          await admin.query(
            "SELECT generation::text FROM rms_pricing.configuration_reference_generation WHERE brand_id=$1",
            [id(3)],
          )
        ).rows[0].generation,
        "2",
      );
      await reader.query("BEGIN");
      await reader.query("SET LOCAL ROLE " + role);
      await reader.query("SET LOCAL row_security=off");
      await assert.rejects(reader.query("SELECT brand_id FROM rms_pricing.price_book"), {
        code: "42501",
      });
      await reader.query("ROLLBACK");
      const functionAcl = (
        await admin.query(
          "SELECT prosecdef,proconfig,has_function_privilege('public','rms_pricing.maintain_configuration_reference_generation()','EXECUTE') public_execute FROM pg_proc WHERE oid='rms_pricing.maintain_configuration_reference_generation()'::regprocedure",
        )
      ).rows[0];
      assert.deepEqual(functionAcl, {
        prosecdef: true,
        proconfig: ["search_path=pg_catalog", "row_security=on"],
        public_execute: false,
      });
      const acl = (
        await admin.query(
          "SELECT relrowsecurity,relforcerowsecurity,has_table_privilege('public','rms_pricing.configuration_reference_generation','SELECT') public_select FROM pg_class WHERE oid='rms_pricing.configuration_reference_generation'::regclass",
        )
      ).rows[0];
      assert.deepEqual(acl, {
        relrowsecurity: true,
        relforcerowsecurity: true,
        public_select: false,
      });
      await admin.query("BEGIN");
      await assert.rejects(admin.query("TRUNCATE rms_pricing.price_entry"), { code: "55000" });
      await admin.query("ROLLBACK");

      // Milestone55: actual Catalog full Draft plus existing complete held Pricing source.
      offset = 0;
      denyHeader = 0;
      denyFamily = 0;
      slowFamily = false;
      beforeCommit = undefined;
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_catalog,platform_audit,platform_eventing TO " + role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_catalog.option_set,rms_catalog.option_set_version,rms_catalog.option,rms_catalog.option_conflict TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_catalog.option_set_operation_record,rms_catalog.option_set_draft_content_snapshot,platform_audit.audit_record,platform_eventing.outbox_event TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query("GRANT UPDATE ON rms_pricing.option_price_rule TO " + role);
      let next55 = 7000,
        readAllowed55 = true;
      const lease55 = (input) => ({
        observedAt: input.observedAt,
        validUntil: new Date(Date.parse(input.observedAt) + 30000).toISOString(),
      });
      const write55 = createPostgresFullOptionSetDraftStore({
        tenantReference: id(7),
        brandReference: id(1),
        actorReference: id(9),
        clock: options.clock,
        transactions: runner,
        authority: { holdUntilTransactionCompletes: async (_tx, input) => lease55(input) },
        creation: {
          authority: { holdUntilTransactionCompletes: async (_tx, input) => lease55(input) },
          references: { generate: () => id(++next55) },
        },
        audit: {
          create(input) {
            return {
              auditId: id(7501),
              brandId: id(1),
              actor: { type: "User", reference: id(9) },
              actionCode: "CATALOG_OPTION_SET_CREATE",
              targetType: "CatalogOptionSet",
              targetId: input.result.sourceAggregate.optionSetReference,
              reasonCode: input.reasonCode,
              correlationId: input.operationReference,
              occurredAt: input.occurredAt,
              sourceChannel: "API",
              dataClassification: "Internal",
              retentionPolicyCode: "OPERATIONAL",
              retentionPolicyVersion: 1,
            };
          },
        },
        events: { generateReference: () => id(7502) },
      });
      const created55 = await write55.create({
        internalCode: "CURRENT_PRICE_PINS55",
        draft: {
          defaultLocale: "en-CA",
          localizedNames: { "en-CA": "Synthetic choices" },
          localizedDescriptions: {},
          displayStyle: "MultiChoice",
          minimumSelection: 0,
          maximumSelection: 1,
          allowRepeatedOption: false,
          perOptionMaximumQuantity: 1,
          maximumTotalQuantity: 1,
          options: [
            {
              stableCode: "ONLY",
              sortOrder: 0,
              lifecycle: "Draft",
              localizedNames: { "en-CA": "Synthetic option" },
              localizedDescriptions: {},
              defaultEligible: true,
              triggeredOptionSetReference: null,
              conflictOptionCodes: [],
            },
          ],
        },
        additionalContent: {
          profile: "CatalogOptionSetEditorContentV1",
          optionDetails: [
            {
              stableCode: "ONLY",
              quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
              media: null,
              pricingRule: { reference: id(7600), versionReference: id(7601) },
              consumption: null,
              triggeredOptionSetVersionReference: null,
            },
          ],
          conditionalRules: [],
          conflictRules: [],
          scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
          effectivePeriod: {
            timeZone: "UTC",
            effectiveFrom: { instant: past, localDateTime: past.slice(0, 23), utcOffsetMinutes: 0 },
            effectiveUntil: null,
          },
        },
        operationReference: id(7500),
        occurredAt: options.clock.now(),
        reasonCode: "INITIAL_CONFIGURATION",
      });
      const { sourceAggregate: aggregate55, ...additional55 } = created55.content;
      const prepared55 = parseCatalogOptionSetEditorContent(aggregate55, additional55);
      // This controlled synthetic owning-table seed supplies current metadata, not real price qualification.
      await seedOptionPriceRule(
        admin,
        {
          ...option,
          ruleReference: id(7600),
          versionReference: id(7601),
          optionReference: aggregate55.draft.options[0].optionReference,
        },
        id(9),
      );
      const input55 = () => {
        const observedAt = options.clock.now();
        return {
          graphRequest: {
            optionSetReference: aggregate55.optionSetReference,
            versionReference: aggregate55.draft.versionReference,
            expectedAggregateVersion: 1,
            sourceDigest: prepared55.sourceDigest,
            contentDigest: prepared55.contentDigest,
            configurationDigest: prepared55.configurationDigest,
            observedAt,
            validUntil: new Date(Date.parse(observedAt) + 4000).toISOString(),
          },
          pricingRequest: request,
          activationAt: new Date(Date.parse(observedAt) + 2000).toISOString(),
        };
      };
      const source55 = () =>
        createCurrentOptionSetDraftPriceReferenceSource({
          tenantReference: id(7),
          brandReference: id(1),
          actorReference: id(9),
          clock: options.clock,
          readAuthority: {
            async holdUntilTransactionCompletes(actual, input) {
              assert.equal(actual, tx);
              assert.equal(input.action, "catalog.option_set.read");
              assert.equal(input.purposeCode, "CATALOG_OPTION_SET_DRAFT");
              assert.ok(input.requiredFields.includes("optionDetails"));
              if (!readAllowed55) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              return lease55(input);
            },
          },
          pricingAuthority: options.authority,
          priceBookAuthority: family,
          optionPriceAuthority: family,
          promotionAuthority: family,
        });
      const take55 = async () => {
        const result = {};
        for (const table of [
          "rms_catalog.option_set",
          "rms_catalog.option_set_version",
          "rms_catalog.option",
          "rms_catalog.option_conflict",
          "rms_catalog.option_set_operation_record",
          "rms_catalog.option_set_draft_content_snapshot",
          "rms_pricing.option_price_rule",
          "rms_pricing.option_price_rule_version",
          "rms_pricing.configuration_reference_generation",
          "platform_audit.audit_record",
          "platform_audit.audit_chain_head",
          "platform_eventing.outbox_event",
        ])
          result[table] = (
            await admin.query(
              "SELECT to_jsonb(t) row FROM " + table + " t ORDER BY to_jsonb(t)::text",
            )
          ).rows;
        return result;
      };
      const baseline55 = await take55();
      await runner.run(async (actual) => {
        await source55().withCurrentAssessment(actual, input55(), async (value) => {
          assert.equal(value.assessment.references[0].status, "CurrentPublishedMetadata");
          assert.equal(value.assessment.decision, "PassForMetadata");
          assert.equal(value.assessment.bindingMembership, "NotEvaluated");
          assert.equal(value.assessment.priceAmounts, "NotEvaluated");
          assert.equal(value.eligibility, "NotEvaluated");
          assert.equal(value.assessment.request.catalogIntentDigest, request.catalogIntentDigest);
          assert.ok(Object.isFrozen(value));
          return value;
        });
      });
      assert.deepEqual(await take55(), baseline55);
      for (const mode55 of [
        "read-denial",
        "price-denial",
        "expiry",
        "backward",
        "root-head",
        "pricing-head",
      ]) {
        offset = 0;
        readAllowed55 = true;
        denyHeader = 0;
        denyFamily = 0;
        let reached55 = false;
        await assert.rejects(
          runner.run(async (actual) => {
            await source55().withCurrentAssessment(actual, input55(), async () => {
              reached55 = true;
              await actual.query(
                "UPDATE rms_catalog.option_set SET aggregate_version=2 WHERE option_set_id=$1",
                [aggregate55.optionSetReference],
              );
              assert.equal(
                (
                  await actual.query(
                    "SELECT aggregate_version FROM rms_catalog.option_set WHERE option_set_id=$1",
                    [aggregate55.optionSetReference],
                  )
                ).rows[0].aggregate_version,
                2,
              );
              if (mode55 !== "read-denial" && mode55 !== "root-head") {
                const before55 = (
                  await actual.query(
                    "SELECT generation::text FROM rms_pricing.configuration_reference_generation WHERE brand_id=$1",
                    [id(1)],
                  )
                ).rows[0].generation;
                await actual.query(
                  "UPDATE rms_pricing.option_price_rule SET updated_at=updated_at WHERE option_price_rule_id=$1",
                  [id(7600)],
                );
                assert.ok(
                  BigInt(
                    (
                      await actual.query(
                        "SELECT generation::text FROM rms_pricing.configuration_reference_generation WHERE brand_id=$1",
                        [id(1)],
                      )
                    ).rows[0].generation,
                  ) > BigInt(before55),
                );
              }
              if (mode55 === "read-denial") readAllowed55 = false;
              if (mode55 === "price-denial") denyFamily = familyCalls + 2;
              if (mode55 === "expiry") offset = 6000;
              if (mode55 === "backward") offset = -10000;
              return "tentative";
            });
          }),
          (e) => e.code === "CATALOG_DEPENDENCY_UNAVAILABLE",
        );
        assert.equal(reached55, true);
        assert.deepEqual(await take55(), baseline55);
      }
      offset = 0;
      readAllowed55 = true;
      denyHeader = 0;
      denyFamily = 0;
    } finally {
      await admin.query("ROLLBACK");
      await reader.query("ROLLBACK");
      await writer.query("ROLLBACK");
      await admin.end();
      await reader.end();
      await writer.end();
    }
  });
});
