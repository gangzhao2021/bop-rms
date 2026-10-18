import { createMerchantMenuDraftQuery } from "../../../apps/api/src/merchant-menu-draft-query.ts";
import { withMenuDraftHttp } from "../../../apps/api/test-support/menu-draft-http.mjs";
import { createBrand, createTenantContext } from "../../bop/tenant/src/index.ts";
import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedPriceMenuOwnerFacts } from "../test-support/price-menu-owner-facts.mjs";
import { createPostgresMenuDraftSource } from "../../rms/catalog/src/index.ts";
const authority = vi.hoisted(() => ({ resolve: null }));
vi.mock("../../../apps/api/src/merchant-brand-scope.ts", () => ({
  createMerchantBrandScope:
    () =>
    (...args) =>
      authority.resolve(...args),
}));
const { Client } = pg;
const id = (n) => "01902404-0000-7000-8000-" + n.toString(16).padStart(12, "0");
it("reads the complete persisted Menu Draft with a stable content digest and owning transaction locks", async () => {
  await withIsolatedDatabase({ caseId: "wp2402_menu_draft" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2402_menu_draft_" + context.runId;
    assert.match(role, /^wp2402_menu_draft_[a-f0-9]+$/);
    const at = "2026-09-14T08:00:00.000Z",
      observed = "2026-09-14T08:10:00.000Z";
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      await admin.query("GRANT USAGE ON SCHEMA platform_helpers TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id(),platform_helpers.is_uuid_v7(uuid) TO " +
          role,
      );
      const scope = await seedPriceMenuOwnerFacts(
        admin,
        role,
        { brandReference: id(1), entries: [{ sellableReference: id(20) }] },
        id,
        at,
      );
      await admin.query("GRANT SELECT ON rms_catalog.menu_section_category TO " + role);
      await admin.query(
        "INSERT INTO rms_catalog.category VALUES($1,$2,'DRAFT_CATEGORY','Draft',1,'en-CA',$3,'{}',NULL,1,0,'[]',$4,$5,$4)",
        [id(850), id(1), JSON.stringify({ "en-CA": "Synthetic category" }), at, id(701)],
      );
      await admin.query("INSERT INTO rms_catalog.menu_section_category VALUES($1,$2,$3,$4)", [
        id(804),
        id(800),
        id(1),
        id(850),
      ]);
      await admin.query(
        "INSERT INTO rms_catalog.menu_section VALUES($1,$2,$3,$4,'EMPTY_SECTION',$5,7)",
        [id(851), id(801), id(800), id(1), JSON.stringify({ "en-CA": "Empty section" })],
      );
      await admin.query(
        "UPDATE rms_catalog.sellable_placement SET presentation_role='Hidden',pinned=true,localized_name_overrides_json=$2 WHERE placement_id=$1",
        [id(805), JSON.stringify({ "en-CA": "Hidden override" })],
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
      let allowed = true,
        calls = 0,
        denyAt = Infinity;
      const authorize = async (_tx, menu) => {
        assert.equal(menu, scope.menuReference);
        calls++;
        return allowed && calls !== denyAt;
      };
      const source = createPostgresMenuDraftSource({
        brandReference: id(1),
        transactions: runner,
        authorize,
      });
      const first = await source.load(scope.menuReference, observed);
      const brand = createBrand({
        brandReference: id(1),
        code: "DRAFT_TEST",
        displayName: "Synthetic menu",
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: at,
        updatedAt: at,
      });
      const tenant = createTenantContext(
        {
          actorType: "User",
          actorReference: id(701),
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
      let httpAllowed = true,
        httpScope = "Brand";
      authority.resolve = async (_tx, cookie, session) => {
        assert.equal(cookie, "synthetic-cookie");
        assert.equal(session, id(900));
        return {
          context: tenant,
          actorReference: id(701),
          authorizeAction: async (action) => ({
            effect: httpAllowed ? "Allow" : "Deny",
            scopeKind: httpScope,
            action,
          }),
        };
      };
      const query = createMerchantMenuDraftQuery({
        merchant: { transactions: runner, now: () => observed },
        authentication: {
          authorize: async (input) => {
            assert.equal(input.sessionCookie, "synthetic-cookie");
            assert.equal(input.csrf, "synthetic-csrf");
            return { sessionReference: id(900) };
          },
        },
      });
      await withMenuDraftHttp(query, async (post) => {
        const result = await post({ menuReference: scope.menuReference });
        assert.equal(result.status, 200);
        assert.deepEqual(result.body, { status: "Found", ...first });
        for (const extra of [
          { brandReference: id(99) },
          { actorReference: id(99) },
          { observedAt: at },
          { snapshotDigest: "sha256:" + "a".repeat(64) },
        ])
          assert.equal((await post({ menuReference: scope.menuReference, ...extra })).status, 400);
        httpAllowed = false;
        assert.equal((await post({ menuReference: scope.menuReference })).status, 403);
        httpAllowed = true;
        httpScope = "Store";
        assert.equal((await post({ menuReference: scope.menuReference })).status, 403);
        httpScope = "Brand";
        assert.equal((await post({ menuReference: id(999) })).status, 403);
      });

      assert.match(first.configurationDigest, /^sha256:[a-f0-9]{64}$/);
      assert.equal(first.aggregate.menuReference, scope.menuReference);
      assert.deepEqual(first.aggregate.draft.storeReferences, [scope.storeReference]);
      assert.deepEqual(first.aggregate.draft.channelCodes, ["QR", "WEB"]);
      assert.deepEqual(first.aggregate.draft.orderTypeCodes, ["DINE_IN", "PICKUP"]);
      assert.deepEqual(
        first.aggregate.draft.sections.map((s) => s.internalCode),
        ["PRICE_SECTION", "EMPTY_SECTION"],
      );
      assert.deepEqual(first.aggregate.draft.sections[0].categoryReferences, [id(850)]);
      assert.deepEqual(first.aggregate.draft.sections[1].placements, []);
      assert.deepEqual(first.aggregate.draft.sections[0].placements[0], {
        placementReference: id(805),
        menuReference: id(800),
        sectionReference: id(804),
        brandReference: id(1),
        sellableReference: id(20),
        sellableType: "Sku",
        presentationRole: "Hidden",
        sortOrder: 0,
        pinned: true,
        localizedNameOverrides: { "en-CA": "Hidden override" },
        createdAt: at,
        createdByActorReference: id(701),
      });
      assert.deepEqual(await source.load(scope.menuReference, "2026-09-14T08:11:00.000Z"), first);
      await admin.query(
        "UPDATE rms_catalog.sellable_placement SET localized_name_overrides_json=$2 WHERE placement_id=$1",
        [id(805), JSON.stringify({ "en-CA": "Changed override" })],
      );
      const changed = await source.load(scope.menuReference, observed);
      assert.notEqual(changed.configurationDigest, first.configurationDigest);
      assert.equal(
        first.aggregate.draft.sections[0].placements[0].localizedNameOverrides["en-CA"],
        "Hidden override",
      );
      allowed = false;
      await assert.rejects(source.load(scope.menuReference, observed), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      allowed = true;
      calls = 0;
      denyAt = 2;
      await assert.rejects(source.load(scope.menuReference, observed), {
        code: "CATALOG_PERMISSION_DENIED",
      });
      denyAt = Infinity;
      assert.equal(
        await createPostgresMenuDraftSource({
          brandReference: id(99),
          transactions: runner,
          authorize: async () => true,
        }).load(scope.menuReference, observed),
        null,
      );
      await admin.query(
        "UPDATE rms_catalog.menu_version SET updated_at=$2 WHERE menu_version_id=$1",
        [id(801), "2026-09-14T08:01:00.000001Z"],
      );
      await assert.rejects(source.load(scope.menuReference, observed), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      await admin.query(
        "UPDATE rms_catalog.menu_version SET updated_at=$2 WHERE menu_version_id=$1",
        [id(801), "2026-09-14T08:12:00.000Z"],
      );
      await assert.rejects(source.load(scope.menuReference, observed), {
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      await admin.query(
        "UPDATE rms_catalog.menu_version SET updated_at=$2 WHERE menu_version_id=$1",
        [id(801), at],
      );
      // The caller retains owner locks until its transaction completes.
      await runner.run(async (tx) => {
        const bound = createPostgresMenuDraftSource({
          brandReference: id(1),
          transactions: { run: (work) => work(tx) },
          authorize: async () => true,
        });
        assert.ok(await bound.load(scope.menuReference, observed));
        await admin.query("SET lock_timeout='150ms'");
        try {
          await assert.rejects(
            admin.query(
              "UPDATE rms_catalog.menu SET aggregate_version=aggregate_version+1 WHERE menu_id=$1",
              [scope.menuReference],
            ),
            { code: "55P03" },
          );
        } finally {
          await admin.query("RESET lock_timeout");
        }
      });
      assert.equal(
        (
          await admin.query(
            "UPDATE rms_catalog.menu SET aggregate_version=aggregate_version+1 WHERE menu_id=$1",
            [scope.menuReference],
          )
        ).rowCount,
        1,
      );
    } finally {
      await admin.query("DROP OWNED BY " + role).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + role);
      await admin.end();
    }
  });
}, 120_000);
