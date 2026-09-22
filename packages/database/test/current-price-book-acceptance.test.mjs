import { createPriceBookDraftAuthorSource } from "../../../apps/api/src/price-book-draft-author-source.ts";
import { appendEventInTransaction } from "../../bop/eventing/src/index.ts";
import { createPostgresPriceBookRepository } from "../../rms/pricing/src/index.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createPostgresCurrentPriceBookStore, resolvePrice } from "../../rms/pricing/src/index.ts";
import { input } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "01902402-0000-7000-8000-" + n.toString(16).padStart(12, "0");

it("reads current owner PriceBook with exact money, scoped precedence and DST boundaries", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_price_book" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_price_book_" + context.runId;
    assert.match(role, /^wp2402_price_book_[a-f0-9]+$/u);
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query("GRANT USAGE ON SCHEMA rms_pricing,platform_helpers TO " + role);
      await admin.query("GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id() TO " + role);
      await admin.query(
        "GRANT SELECT ON rms_pricing.price_book,rms_pricing.price_book_version,rms_pricing.price_entry TO " +
          role,
      );
      const fixture = input();
      const book = fixture.priceBook;
      const currency = book.currencyMetadata;
      const at = "2026-11-01T06:00:00.000Z";
      const runner = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN READ ONLY");
            await client.query("SET LOCAL ROLE " + role);
            const value = await work({ query: (sql, values) => client.query(sql, [...values]) });
            await client.query("COMMIT");
            return value;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      await admin.query(
        "INSERT INTO rms_pricing.price_book (price_book_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,$3,1,$4,$5,$4)",
        [book.priceBookReference, book.brandReference, book.stableCode, book.createdAt, id(100)],
      );
      async function version(reference, number, lifecycle, createdAt = book.createdAt) {
        await admin.query(
          "INSERT INTO rms_pricing.price_book_version (price_book_version_id,price_book_id,brand_id,version_number,snapshot_digest,lifecycle,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            reference,
            book.priceBookReference,
            book.brandReference,
            number,
            book.snapshotDigest,
            lifecycle,
            currency.currencyCode,
            currency.metadataVersion,
            currency.metadataVersionReference,
            currency.metadataDigest,
            createdAt,
          ],
        );
        await admin.query(
          "UPDATE rms_pricing.price_book SET current_version_id=$1,aggregate_version=$2 WHERE price_book_id=$3",
          [reference, number, book.priceBookReference],
        );
      }
      async function entry(reference, versionRef, scopeKind, scopeRef, amount, from, until = null) {
        await admin.query(
          "INSERT INTO rms_pricing.price_entry (price_entry_id,price_book_version_id,price_book_id,brand_id,sellable_id,scope_kind,scope_id,channel_code,order_type,amount_minor,currency_code,effective_from,effective_until,effective_time_zone,reason_code) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,$8,$9,$10,$11,'America/Toronto','SYNTHETIC_PRICE')",
          [
            reference,
            versionRef,
            book.priceBookReference,
            book.brandReference,
            book.entries[0].sellableReference,
            scopeKind,
            scopeRef,
            amount,
            currency.currencyCode,
            from,
            until,
          ],
        );
      }
      const reader = createPostgresCurrentPriceBookStore(
        runner,
        { brandReference: book.brandReference },
        currency,
      );
      const request = { priceBookReference: book.priceBookReference, observedAt: at };
      assert.equal(await reader.load(request), null);
      await version(book.versionReference, 1, "Published");
      await entry(
        id(101),
        book.versionReference,
        "Brand",
        null,
        "9007199254740993",
        "2026-08-01T04:00:00.000Z",
      );
      await entry(
        id(102),
        book.versionReference,
        "Store",
        fixture.storeReference,
        "1250",
        "2026-11-01T05:30:00.000Z",
        "2026-11-01T06:30:00.000Z",
      );
      const loaded = await reader.load(request);
      assert.ok(loaded);
      assert.equal(loaded.entries[0].amount.amountMinor, 9007199254740993n);
      assert.deepEqual(loaded.currencyMetadata, currency);
      const period = loaded.entries[1].effectivePeriod;
      assert.equal(period.effectiveFrom.localDateTime, "2026-11-01T01:30:00.000");
      assert.equal(period.effectiveUntil.localDateTime, "2026-11-01T01:30:00.000");
      assert.equal(period.effectiveFrom.utcOffsetMinutes, -240);
      assert.equal(period.effectiveUntil.utcOffsetMinutes, -300);
      const resolution = {
        brandReference: book.brandReference,
        storeReference: fixture.storeReference,
        storeGroupReference: null,
        regionReference: null,
        sellableReference: book.entries[0].sellableReference,
        channelCode: "CUSTOMER_PWA",
        orderType: "Pickup",
        currencyCode: "CAD",
        evaluatedAt: at,
      };
      assert.equal(resolvePrice(loaded, resolution).amount.amountMinor, 1250n);
      assert.equal(
        resolvePrice(loaded, { ...resolution, storeReference: id(103) }).amount.amountMinor,
        9007199254740993n,
      );
      assert.equal(
        resolvePrice(loaded, { ...resolution, evaluatedAt: period.effectiveUntil.instant }).amount
          .amountMinor,
        9007199254740993n,
      );
      assert.equal(
        await createPostgresCurrentPriceBookStore(
          runner,
          { brandReference: id(104) },
          currency,
        ).load(request),
        null,
      );
      await assert.rejects(
        createPostgresCurrentPriceBookStore(
          runner,
          { brandReference: book.brandReference },
          { ...currency, metadataDigest: "sha256:" + "f".repeat(64) },
        ).load(request),
        { code: "CURRENT_PRICE_BOOK_UNAVAILABLE" },
      );
      await version(id(105), 2, "Draft");
      assert.equal(await reader.load(request), null);
      await version(id(106), 3, "Archived");
      assert.equal(await reader.load(request), null);
      await version(id(107), 4, "Published", "2026-11-02T00:00:00.000Z");
      assert.equal(await reader.load(request), null);
      await version(id(108), 5, "Published");
      await entry(id(109), id(108), "Brand", null, "100", "2026-08-01T04:00:00.000001Z");
      await assert.rejects(reader.load(request), { code: "CURRENT_PRICE_BOOK_UNAVAILABLE" });
      assert.equal(
        (await admin.query("SELECT count(*)::int AS n FROM rms_pricing.price_book_version")).rows[0]
          .n,
        5,
      );
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
}, 120_000);

it("persists authored price versions with exact replay and atomic Audit/Outbox", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_price_auth" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_price_author_" + context.runId;
    assert.match(role, /^wp2402_price_author_[a-f0-9]+$/);
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_pricing,platform_audit,platform_eventing,platform_helpers TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_pricing.price_book,rms_pricing.price_book_version,rms_pricing.price_entry,rms_pricing.price_book_operation_record,platform_audit.audit_record,platform_eventing.outbox_event TO " +
          role,
      );
      await admin.query(
        "GRANT UPDATE(aggregate_version,current_version_id,updated_at) ON rms_pricing.price_book TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      const runner = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + role);
            const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const original = input().priceBook;
      const base = {
        ...original,
        entries: [
          ...original.entries,
          { ...original.entries[0], entryReference: id(599), channelCode: "QR" },
        ],
      };
      let authorized = true,
        failEvent = false,
        deniedBook = null;
      const repositoryOptions = {
        transactions: runner,
        brandReference: base.brandReference,
        currencyMetadata: base.currencyMetadata,
        authorize: async (_tx, request) =>
          authorized && (deniedBook === null || request.priceBookReference !== deniedBook),
        appendEvent: async (tx, record) => {
          await appendEventInTransaction(tx, {
            eventId: record.operationReference,
            eventType: record.event.eventType,
            schemaVersion: 1,
            occurredAt: record.event.occurredAt,
            producerModule: "@rms/pricing",
            tenantId: base.brandReference,
            aggregateType: "PriceBook",
            aggregateId: base.priceBookReference,
            aggregateVersion: BigInt(record.aggregate.aggregateVersion),
            correlationId: record.operationReference,
            actor: { type: "Actor", actorId: id(500) },
            payload: record.event,
            redactionClassification: "indirect_identifier",
            replayMetadata: {},
          });
          if (failEvent) throw new Error("synthetic event continuation failure");
        },
      };
      const repository = createPostgresPriceBookRepository(repositoryOptions);
      const author = createPriceBookDraftAuthorSource({
        brandReference: base.brandReference,
        repository: (tx) =>
          createPostgresPriceBookRepository({
            ...repositoryOptions,
            transactions: { run: (work) => work(tx) },
          }),
      });

      const make = (number, action) => {
        const lifecycle =
          action === "Publish" ? "Published" : action === "Archive" ? "Archived" : "Draft";
        const aggregate = {
          ...base,
          versionReference: id(510 + number),
          aggregateVersion: number,
          versionNumber: number,
          lifecycle,
          createdAt: "2026-08-01T16:0" + number + ":00.000Z",
          entries: base.entries.map((entry, index) => ({
            ...entry,
            entryReference: id(550 + number * 10 + index),
          })),
        };
        const event = {
          eventType:
            action === "CreateDraft"
              ? "PriceBookDraftCreated"
              : action === "Publish"
                ? "PriceBookVersionPublished"
                : "PriceBookArchived",
          priceBookReference: aggregate.priceBookReference,
          versionReference: aggregate.versionReference,
          brandReference: aggregate.brandReference,
          aggregateVersion: number,
          lifecycle,
          currencyCode: "CAD",
          snapshotDigest: aggregate.snapshotDigest,
          occurredAt: aggregate.createdAt,
        };
        return {
          action,
          operationReference: id(520 + number),
          operationIntentHash: "sha256:" + String(number).repeat(64),
          aggregate,
          event,
        };
      };
      const audit = (record) => ({
        auditId: id(530 + record.aggregate.aggregateVersion),
        brandId: base.brandReference,
        actor: { type: "User", reference: id(500) },
        actionCode: "PRICING_PRICE_BOOK_" + record.action.toUpperCase(),
        targetType: "PricingPriceBook",
        targetId: base.priceBookReference,
        correlationId: record.operationReference,
        occurredAt: record.aggregate.createdAt,
        reasonCode: "SYNTHETIC_TEST",
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Internal",
        retentionPolicyCode: "CONFIGURATION_AUDIT",
        retentionPolicyVersion: 1,
      });
      const first = make(1, "CreateDraft"),
        published = make(2, "Publish");
      const reversed = {
        ...first,
        aggregate: { ...first.aggregate, entries: [...first.aggregate.entries].reverse() },
      };
      assert.deepEqual(await repository.create({ record: reversed, audit: audit(first) }), first);
      assert.deepEqual(await repository.load(base.priceBookReference), first.aggregate);
      assert.deepEqual(await repository.loadCurrentOperation(base.priceBookReference), first);
      assert.deepEqual(await runner.run((tx) => author.load(tx, base.priceBookReference)), {
        actorReference: id(500),
        operationReference: first.operationReference,
        versionReference: first.aggregate.versionReference,
        aggregateVersion: 1,
      });
      const count = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_pricing.price_book_version) AS versions,(SELECT count(*)::int FROM platform_audit.audit_record) AS audits,(SELECT count(*)::int FROM platform_eventing.outbox_event) AS events",
          )
        ).rows[0];
      assert.deepEqual(await count(), { versions: 1, audits: 1, events: 1 });
      failEvent = true;
      await assert.rejects(
        repository.commit({
          record: published,
          audit: audit(published),
          expectedAggregateVersion: 1,
        }),
      );
      assert.deepEqual(await count(), { versions: 1, audits: 1, events: 1 });
      assert.equal((await repository.load(base.priceBookReference)).aggregateVersion, 1);
      failEvent = false;
      assert.deepEqual(
        await repository.commit({
          record: published,
          audit: audit(published),
          expectedAggregateVersion: 1,
        }),
        published,
      );
      assert.deepEqual(await repository.resolveOperation(first.operationReference), first);
      assert.deepEqual(await repository.loadCurrentOperation(base.priceBookReference), published);
      assert.equal(await runner.run((tx) => author.load(tx, base.priceBookReference)), null);
      assert.deepEqual(await repository.create({ record: first, audit: audit(first) }), first);
      assert.deepEqual(await count(), { versions: 2, audits: 2, events: 2 });
      // Existing published reader relies on a caller-provided Tenant Context.
      const scopedRunner = {
        run: (work) =>
          runner.run(async (tx) => {
            await tx.query("SELECT set_config('bop.brand_id',$1,true)", [base.brandReference]);
            return work(tx);
          }),
      };
      const live = await createPostgresCurrentPriceBookStore(
        scopedRunner,
        { brandReference: base.brandReference },
        base.currencyMetadata,
      ).load({
        priceBookReference: base.priceBookReference,
        observedAt: published.aggregate.createdAt,
      });
      assert.equal(live.versionReference, published.aggregate.versionReference);
      deniedBook = base.priceBookReference;
      await assert.rejects(repository.resolveOperation(first.operationReference), {
        code: "PRICE_BOOK_PERMISSION_DENIED",
      });
      deniedBook = null;
      authorized = false;
      await assert.rejects(repository.resolveOperation(first.operationReference), {
        code: "PRICE_BOOK_PERMISSION_DENIED",
      });
      await assert.rejects(repository.load(base.priceBookReference), {
        code: "PRICE_BOOK_PERMISSION_DENIED",
      });
      authorized = true;
      await assert.rejects(
        repository.commit({
          record: { ...published, operationReference: id(590) },
          audit: audit(published),
          expectedAggregateVersion: 1,
        }),
        { code: "PRICE_BOOK_VERSION_CONFLICT" },
      );
      const archived = make(3, "Archive");
      await repository.commit({
        record: archived,
        audit: audit(archived),
        expectedAggregateVersion: 2,
      });
      assert.deepEqual(await repository.resolveOperation(published.operationReference), published);
      assert.equal(
        await createPostgresCurrentPriceBookStore(
          scopedRunner,
          { brandReference: base.brandReference },
          base.currencyMetadata,
        ).load({
          priceBookReference: base.priceBookReference,
          observedAt: archived.aggregate.createdAt,
        }),
        null,
      );
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
}, 120_000);
