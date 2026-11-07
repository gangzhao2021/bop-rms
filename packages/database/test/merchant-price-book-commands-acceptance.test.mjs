import { withPriceBookHttp } from "../../../apps/api/test-support/price-book-http.mjs";
import { createSingleStorePriceBookFacts } from "../../../apps/api/src/single-store-price-book-facts.ts";
import { analyzePriceCoverage } from "../../rms/pricing/src/index.ts";
import { createPostgresMenuPricingFactsSource } from "../../rms/catalog/src/index.ts";
import { seedPriceMenuOwnerFacts } from "../test-support/price-menu-owner-facts.mjs";
import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { createBrand, createTenantContext } from "../../bop/tenant/src/index.ts";
import { createMerchantPriceBookCommands } from "../../../apps/api/src/merchant-price-book-commands.ts";
import { input } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

// Session/permission authority is synthetic. Domain service, current Tenant/Catalog\n// facts, repository, draft provenance, Audit and Outbox use restricted PostgreSQL.
const authority = vi.hoisted(() => ({ resolve: null }));
vi.mock("../../../apps/api/src/merchant-brand-scope.ts", () => ({
  createMerchantBrandScope:
    () =>
    (...args) =>
      authority.resolve(...args),
}));
const { Client } = pg;
const id = (n) => "01902402-0000-7000-8000-" + n.toString(16).padStart(12, "0");
it("composes price management with durable independent approval and atomic revalidation", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_price_cmd" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_price_cmd_" + context.runId;
    assert.match(role, /^wp2402_price_cmd_[a-f0-9]+$/);
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
      const transactions = {
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
      const base = input().priceBook;
      const at = "2026-09-14T08:00:00.000Z";
      let actor = id(701),
        allowed = true,
        approved = true,
        coverage = true;
      let factsCalls = 0,
        revokeFactsAt = Infinity;
      const brand = createBrand({
        brandReference: base.brandReference,
        code: "PRICE_TEST",
        displayName: "Synthetic Pricing",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      authority.resolve = async (_tx, cookie, expectedSession) => {
        assert.equal(cookie, "synthetic-cookie");
        assert.equal(expectedSession, id(700));
        const actorReference = actor;
        return {
          actorReference,
          context: createTenantContext(
            {
              actorType: "User",
              actorReference,
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
          ),
          authorizeAction: async (action) => ({
            action,
            scopeKind: "Brand",
            effect:
              allowed && (action !== "pricing.price-book.approve" || approved) ? "Allow" : "Deny",
            reason: "ROLE_PERMISSION",
            source: "RolePermission",
            policySnapshotReference: id(703),
            policyVersion: 1,
            audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
          }),
        };
      };
      const factOptions = await seedPriceMenuOwnerFacts(admin, role, base, id, at);
      const ownerFacts = createSingleStorePriceBookFacts(factOptions);
      let transportTime = "2026-09-14T08:10:00.000Z";
      const commands = createMerchantPriceBookCommands({
        merchant: { transactions, now: () => transportTime },
        authentication: {
          async authorize(request) {
            if (request.sessionCookie !== "synthetic-cookie" || request.csrf !== "synthetic-csrf")
              throw new Error("SYNTHETIC_CSRF_DENIED");
            return { sessionReference: id(700) };
          },
        },
        currencyMetadata: base.currencyMetadata,
        auditReference: (op) => id(1000 + Number.parseInt(op.slice(-12), 16)),
        validateFacts: async (tx, snapshot) =>
          ++factsCalls < revokeFactsAt && (await ownerFacts.validateFacts(tx, snapshot)),
        coverageContexts: async (tx, snapshot) =>
          coverage ? ownerFacts.coverageContexts(tx, snapshot) : [],
      });
      const candidate = (n, lifecycle = "Draft") => ({
        ...base,
        lifecycle,
        versionReference: id(720 + n),
        aggregateVersion: n,
        versionNumber: n,
        snapshotDigest: "sha256:" + String(n).repeat(64),
        createdAt: "2026-09-14T08:0" + n + ":00.000Z",
        entries: base.entries.map((entry) => ({ ...entry, entryReference: id(730 + n) })),
      });
      const request = (action, snapshot) => ({
        sessionCookie: "synthetic-cookie",
        csrf: "synthetic-csrf",
        action,
        input: {
          candidate: snapshot,
          operationReference: id(740 + snapshot.versionNumber),
          requestedAt: snapshot.createdAt,
          ...(action === "CreateDraft"
            ? {}
            : {
                priceBookReference: snapshot.priceBookReference,
                expectedAggregateVersion: snapshot.aggregateVersion - 1,
              }),
        },
      });
      const count = async () =>
        (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_pricing.price_book_version) versions,(SELECT count(*)::int FROM platform_audit.audit_record) audits,(SELECT count(*)::int FROM platform_eventing.outbox_event) events",
          )
        ).rows[0];
      const publicationSnapshot = candidate(3, "Published");
      const matrix = await transactions.run((tx) =>
        ownerFacts.coverageContexts(tx, publicationSnapshot),
      );
      assert.equal(matrix.length, 4);
      assert.deepEqual(
        new Set(matrix.map((item) => item.orderType)),
        new Set(["DineIn", "Pickup"]),
      );
      assert.deepEqual(new Set(matrix.map((item) => item.channelCode)), new Set(["WEB", "QR"]));
      assert.ok(
        analyzePriceCoverage(
          {
            ...publicationSnapshot,
            entries: publicationSnapshot.entries.map((entry) => ({ ...entry, channelCode: "WEB" })),
          },
          matrix,
        ).some((item) => item.status !== "Covered"),
      );
      const expiring = {
        ...publicationSnapshot,
        entries: publicationSnapshot.entries.map((entry) => ({
          ...entry,
          effectivePeriod: {
            ...entry.effectivePeriod,
            effectiveUntil: {
              instant: "2026-09-15T04:00:00.000Z",
              localDateTime: "2026-09-15T00:00:00.000",
              utcOffsetMinutes: -240,
            },
          },
        })),
      };
      const future = await transactions.run((tx) => ownerFacts.coverageContexts(tx, expiring));
      assert.equal(future.length, 8);
      assert.ok(analyzePriceCoverage(expiring, future).some((item) => item.status !== "Covered"));
      for (const entry of [
        { ...base.entries[0], sellableReference: id(999) },
        { ...base.entries[0], scopeKind: "Store", scopeReference: id(999) },
        { ...base.entries[0], channelCode: "UNKNOWN" },
      ])
        assert.equal(
          await transactions.run((tx) =>
            ownerFacts.validateFacts(tx, {
              ...publicationSnapshot,
              entries: [entry],
            }),
          ),
          false,
        );
      await admin.query("UPDATE rms_catalog.sku SET lifecycle='Draft' WHERE sku_id=$1", [
        base.entries[0].sellableReference,
      ]);
      assert.equal(
        await transactions.run((tx) => ownerFacts.validateFacts(tx, candidate(1))),
        true,
      );
      assert.equal(
        await transactions.run((tx) => ownerFacts.validateFacts(tx, publicationSnapshot)),
        false,
      );
      assert.deepEqual(
        await transactions.run((tx) => ownerFacts.coverageContexts(tx, publicationSnapshot)),
        [],
      );
      await admin.query("UPDATE rms_catalog.sku SET lifecycle='Active' WHERE sku_id=$1", [
        base.entries[0].sellableReference,
      ]);
      await admin.query("INSERT INTO rms_catalog.menu_version_store VALUES($1,$2,$3,$4)", [
        id(801),
        id(800),
        base.brandReference,
        id(999),
      ]);
      assert.equal(
        await transactions.run((tx) => ownerFacts.validateFacts(tx, publicationSnapshot)),
        false,
      );
      await admin.query("DELETE FROM rms_catalog.menu_version_store WHERE store_id=$1", [id(999)]);
      assert.equal(
        await transactions.run((tx) =>
          createPostgresMenuPricingFactsSource({
            brandReference: id(999),
            menuReference: id(800),
          }).load(tx, at),
        ),
        null,
      );
      // Row locks hold actual referenced SKU state through the price transaction.
      await transactions.run(async (tx) => {
        assert.equal(await ownerFacts.validateFacts(tx, publicationSnapshot), true);
        await admin.query("SET lock_timeout='100ms'");
        try {
          await assert.rejects(
            admin.query("UPDATE rms_catalog.sku SET lifecycle='Draft' WHERE sku_id=$1", [
              base.entries[0].sellableReference,
            ]),
            { code: "55P03" },
          );
        } finally {
          await admin.query("SET lock_timeout='0'");
        }
      });
      const draft = request("CreateDraft", candidate(1));
      await assert.rejects(commands.execute({ ...draft, csrf: "wrong" }), /SYNTHETIC_CSRF_DENIED/);
      assert.deepEqual(await count(), { versions: 0, audits: 0, events: 0 });
      assert.equal((await commands.execute(draft)).status, "Applied");
      actor = id(702);
      assert.equal(
        (await commands.execute(request("ReplaceDraft", candidate(2)))).status,
        "Applied",
      );
      const publication = request("Publish", candidate(3, "Published"));
      await assert.rejects(commands.execute(publication), { code: "PRICE_BOOK_APPROVAL_REQUIRED" });
      assert.deepEqual(await count(), { versions: 2, audits: 2, events: 2 });

      // Original root creator may approve the replacement written by a different
      // author. Concurrent identical commands serialize on operation before book.
      actor = id(701);
      coverage = false;
      await assert.rejects(commands.execute(publication), { code: "PRICE_BOOK_COVERAGE_INVALID" });
      coverage = true;
      await assert.rejects(
        commands.execute({
          ...publication,
          input: {
            ...publication.input,
            candidate: {
              ...publication.input.candidate,
              entries: publication.input.candidate.entries.map((entry) => ({
                ...entry,
                amount: { ...entry.amount, amountMinor: 2000n },
              })),
            },
          },
        }),
        { code: "PRICE_BOOK_INPUT_INVALID" },
      );
      assert.deepEqual(await count(), { versions: 2, audits: 2, events: 2 });
      const concurrent = await Promise.all([
        commands.execute(publication),
        commands.execute(publication),
      ]);
      assert.deepEqual(concurrent.map((result) => result.status).sort(), [
        "AlreadyApplied",
        "Applied",
      ]);
      assert.deepEqual(await count(), { versions: 3, audits: 3, events: 3 });
      const persisted = (
        await admin.query(
          "SELECT payload_json->>'versionReference' version,actor_id FROM platform_eventing.outbox_event WHERE event_id=$1",
          [publication.input.operationReference],
        )
      ).rows[0];
      assert.equal(persisted.version, publication.input.candidate.versionReference);
      assert.equal(persisted.actor_id, id(701));

      coverage = false;
      assert.equal((await commands.execute(publication)).status, "AlreadyApplied");
      approved = false;
      await assert.rejects(commands.execute(publication), { code: "PRICE_BOOK_PERMISSION_DENIED" });
      approved = true;
      allowed = false;
      await assert.rejects(commands.execute(draft), { code: "PRICE_BOOK_PERMISSION_DENIED" });
      allowed = true;
      for (const field of ["draftAuthorActorReference", "approvalPermission", "coverageContexts"]) {
        await assert.rejects(
          async () =>
            commands.execute({
              ...publication,
              input: { ...publication.input, [field]: field === "coverageContexts" ? [] : id(799) },
            }),
          { code: "PRICE_BOOK_INPUT_INVALID" },
        );
      }

      // Revocation after the actual Audit/Outbox append rolls back the entire command.
      factsCalls = 0;
      revokeFactsAt = 3;
      const second = {
        ...candidate(1),
        priceBookReference: id(760),
        versionReference: id(761),
        stableCode: "SECOND_TEST",
        entries: base.entries.map((entry) => ({ ...entry, entryReference: id(762) })),
      };
      const secondRequest = request("CreateDraft", second);
      secondRequest.input.operationReference = id(763);
      await assert.rejects(commands.execute(secondRequest), {
        code: "PRICE_BOOK_DEPENDENCY_UNAVAILABLE",
      });
      assert.equal(factsCalls, 3);
      assert.deepEqual(await count(), { versions: 3, audits: 3, events: 3 });
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM rms_pricing.price_book WHERE price_book_id=$1",
            [id(760)],
          )
        ).rows[0].n,
        0,
      );
      factsCalls = 0;
      revokeFactsAt = Infinity;
      coverage = true;
      await withPriceBookHttp(commands, async (post) => {
        const body = {
          action: "CreateDraft",
          operationReference: id(880),
          priceBookReference: id(881),
          expectedAggregateVersion: 0,
          stableCode: "HTTP_PRICE",
          entries: base.entries.map((entry) => ({
            sellableReference: entry.sellableReference,
            scopeKind: entry.scopeKind,
            scopeReference: entry.scopeReference,
            channelCode: entry.channelCode,
            orderType: entry.orderType,
            amountMinor: "9007199254740993",
            effectivePeriod: entry.effectivePeriod,
            reasonCode: entry.reasonCode,
          })),
        };
        for (const invalid of [
          { ...body, brandReference: id(999) },
          { ...body, requestedAt: "2020-01-01T00:00:00.000Z" },
          {
            ...body,
            entries: body.entries.map((entry) => ({
              ...entry,
              amountMinor: "9223372036854775808",
            })),
          },
          { ...body, entries: body.entries.map((entry) => ({ ...entry, amountMinor: 10.25 })) },
          { ...body, entries: body.entries.map((entry) => ({ ...entry, scopeKind: "Invalid" })) },
        ])
          assert.equal((await post(invalid)).status, 400);
        const created = await post(body);
        assert.equal(created.status, 200);
        assert.equal(created.body.status, "Applied");
        assert.equal(created.body.lifecycle, "Draft");
        assert.match(created.body.snapshotDigest, /^sha256:[0-9a-f]{64}$/);
        transportTime = "2026-09-15T08:10:00.000Z";
        const replayed = await post(body);
        assert.deepEqual(replayed, {
          status: 200,
          body: { ...created.body, status: "AlreadyApplied" },
        });
        const saved = (
          await admin.query(
            "SELECT amount_minor::text amount FROM rms_pricing.price_entry WHERE price_book_id=$1",
            [id(881)],
          )
        ).rows;
        assert.deepEqual(saved, [{ amount: "9007199254740993" }]);
        assert.equal(
          (
            await post({
              ...body,
              entries: body.entries.map((entry) => ({ ...entry, amountMinor: "9007199254740994" })),
            })
          ).status,
          409,
        );
        // Future clock is used only to prove replay does not create a new event.
        // Fresh writes return to a real, non-future server time for Audit.
        transportTime = "2026-09-14T08:20:00.000Z";
        const publish = {
          ...body,
          action: "Publish",
          expectedAggregateVersion: 1,
          operationReference: id(882),
        };
        assert.equal((await post(publish)).status, 403);
        actor = id(702);
        const published = await post(publish);
        assert.equal(published.status, 200);
        assert.equal(published.body.lifecycle, "Published");
        assert.equal(published.body.aggregateVersion, 2);
        assert.deepEqual(await count(), { versions: 5, audits: 5, events: 5 });
      });
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
}, 120_000);
