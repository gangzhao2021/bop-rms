import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { createMerchantAvailability } from "../../../apps/api/src/merchant-availability.ts";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedOrdinaryRefundStorePublication } from "../test-support/ordinary-refund-store-publication.mjs";
import { productApiGrants } from "../test-support/merchant-api-grants.mjs";
import { syntheticMerchantBrandScope } from "../test-support/merchant-brand-scope.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";
import { seedOrdinaryRefundSession } from "../test-support/ordinary-refund-session.mjs";

const { Client } = pg;
const id = (n) => "01909a1f-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** The pilot API role's grants for Store item availability (docs/spec/pilot-acl-additions.json). */
export const availabilityApiGrants = [
  "GRANT SELECT,INSERT,UPDATE ON rms_catalog.availability_rule TO ROLE_",
  "GRANT SELECT,INSERT ON rms_catalog.availability_rule_operation_record,rms_catalog.availability_rule_operation_snapshot TO ROLE_",
];

/** WP-2423 8.5: offer an item at a Store, sell out, back in stock, stop offering — under RLS. */
it("manages which items a Store sells with Brand and Store authority", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_availability" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_avail_" + context.runId,
      worker = "wp2423_avail_w_" + context.runId;
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      manager = id(5),
      cashier = id(6),
      cook = id(13),
      sku = id(12),
      at = "2026-09-20T00:00:00.000Z",
      names = JSON.stringify({ "en-CA": "Mocha" });
    // 2026-10-07 21:00 in Toronto. WP-2423 Q21: the Store's business day starts at 04:00 local, so
    // the Oct 7 business day ends at 2026-10-08T08:00Z (not at local midnight, 04:00Z).
    let clock = Date.parse("2026-10-08T01:00:00.000Z");
    const now = () => new Date((clock += 1000)).toISOString();
    let reference = 0x9000;
    const next = () => "019a0000-0000-7000-8000-" + (++reference).toString(16).padStart(12, "0");
    try {
      await admin.query(
        "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'MOCHA','PreparedFood','Active',1,$3,$4,$3)",
        [id(10), brandReference, at, owner],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$5)",
        [id(11), id(10), brandReference, names, at],
      );
      await admin.query(
        `INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,'MOCHA-REGULAR-12-OZ','Active','{"en-CA":"Regular (12 oz)"}'::jsonb,'[]'::jsonb,$5,'EACH',1,$6,$7)`,
        [sku, id(10), brandReference, id(11), "sha256:" + "a".repeat(64), at, owner],
      );
      // WP-2423 Q21: the Store's published configuration (America/Toronto, day starts 04:00).
      await seedOrdinaryRefundStorePublication({
        client: admin,
        scope: { tenantReference, brandReference, storeReference },
        firstCapturedAt: "2026-10-08T00:00:00.000Z",
      });
      for (const name of [role, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      // The rendered pilot API grants (matrix plus additions), as on the pilot host.
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api: role, worker }));
      for (const sql of [...productApiGrants, ...availabilityApiGrants])
        await admin.query(sql.replaceAll("ROLE_", role));
      const persistence = {
        now,
        publication: {
          configurationType: "STORE_CONFIGURATION",
          purposeCode: "STORE_CONFIGURATION",
          requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
        },
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
      const manage = ["catalog.sku.read", "catalog.sku.availability.manage"];
      const scope = syntheticMerchantBrandScope({
        tenantReference,
        brandReference,
        storeReference,
        policyReference: id(300),
        grants: { [owner]: manage, [manager]: [], [cashier]: [], [cook]: [] },
        // WP-2423 Q17: the Kitchen and Front of House templates hold only the today-only mark.
        storeGrants: { [manager]: manage, [cashier]: [], [cook]: ["catalog.sku.sold_out.mark"] },
      });
      const availability = createMerchantAvailability({
        persistence,
        authentication: { authorize: async () => ({ sessionReference: id(7) }) },
        references: { next },
        locale: "en-CA",
        resolveScope: scope.resolveScope,
      });
      const call = (body) => availability.command({ sessionCookie: "s", csrf: "c", body });
      const status = async () =>
        (await availability.query({ sessionCookie: "s", csrf: "c" })).items[0];

      assert.deepEqual(await status(), {
        skuReference: sku,
        skuCode: "MOCHA-REGULAR-12-OZ",
        productName: "Mocha",
        sizeName: "Regular (12 oz)",
        status: "NotOffered",
        soldOutUntil: null,
        stockSoldOut: null,
      });
      // Store authority never offers an item.
      scope.as(manager);
      await assert.rejects(
        call({ action: "Offer", operationReference: next(), skuReference: sku }),
        {
          code: "PermissionDenied",
        },
      );
      scope.as(owner);
      const offer = { action: "Offer", operationReference: next(), skuReference: sku };
      assert.equal((await call(offer)).item.status, "Available");
      assert.equal((await call(offer)).status, "Unchanged");
      // WP-2423 Q17: the cook marks it sold out for the rest of today and back, and nothing else.
      scope.as(cook);
      const cookView = await availability.query({ sessionCookie: "s", csrf: "c" });
      assert.deepEqual(cookView.permissions, {
        mayOffer: false,
        mayMarkSoldOut: true,
        mayMarkUntilBack: false,
      });
      for (const body of [
        { action: "StopOffering", operationReference: next(), skuReference: sku },
        { action: "Offer", operationReference: next(), skuReference: sku },
        { action: "SoldOut", operationReference: next(), skuReference: sku, until: "UntilBack" },
      ])
        await assert.rejects(call(body), { code: "PermissionDenied" });
      assert.deepEqual(
        (
          await call({
            action: "SoldOut",
            operationReference: next(),
            skuReference: sku,
            until: "EndOfDay",
          })
        ).item,
        { status: "SoldOut", soldOutUntil: "2026-10-08T08:00:00.000Z" },
      );
      assert.equal(
        (await call({ action: "BackInStock", operationReference: next(), skuReference: sku })).item
          .status,
        "Available",
      );
      const cookAudits = (
        await admin.query(
          "SELECT action_code,store_id::text store,after_summary_json summary FROM platform_audit.audit_record WHERE actor_reference=$1 ORDER BY occurred_at,audit_id",
          [cook],
        )
      ).rows;
      // Create and activate share one instant; compare as a set.
      assert.deepEqual(cookAudits.map((a) => a.action_code + "@" + a.store).sort(), [
        "CATALOG_AVAILABILITY_CHANGELIFECYCLE@" + storeReference,
        "CATALOG_AVAILABILITY_CHANGELIFECYCLE@" + storeReference,
        "CATALOG_AVAILABILITY_CREATE@" + storeReference,
      ]);
      // Each audit row says what changed, for which item and Store (no personal data).
      const summaries = cookAudits
        .map((a) => {
          const { commandReference, ...rest } = a.summary;
          assert.match(commandReference, /^[0-9a-f-]{36}$/u);
          return JSON.stringify(Object.fromEntries(Object.entries(rest).sort()));
        })
        .sort();
      const common = {
        item: "Mocha — Regular (12 oz)",
        itemReference: sku,
        storeReference,
        authority: "SoldOutToday",
      };
      assert.deepEqual(
        summaries,
        [
          { change: "BackInStock", ruleStep: "RuleEnded", ...common },
          {
            change: "SoldOutToday",
            ruleStep: "RuleActivated",
            ...common,
            soldOutUntil: "2026-10-08T08:00:00.000Z",
          },
          {
            change: "SoldOutToday",
            ruleStep: "RuleCreated",
            ...common,
            soldOutUntil: "2026-10-08T08:00:00.000Z",
          },
        ]
          .map((value) => JSON.stringify(Object.fromEntries(Object.entries(value).sort())))
          .sort(),
      );
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM platform_audit.audit_record WHERE action_code LIKE 'CATALOG_AVAILABILITY_%' AND after_summary_json='{}'::jsonb",
          )
        ).rows[0].n,
        0,
      );
      // The Store Manager marks it sold out for the rest of the business day, then back in stock.
      scope.as(manager);
      const soldOut = await call({
        action: "SoldOut",
        operationReference: next(),
        skuReference: sku,
        until: "EndOfDay",
      });
      assert.deepEqual(soldOut.item, {
        status: "SoldOut",
        soldOutUntil: "2026-10-08T08:00:00.000Z",
      });
      await assert.rejects(
        call({ action: "StopOffering", operationReference: next(), skuReference: sku }),
        { code: "PermissionDenied" },
      );
      assert.equal(
        (await call({ action: "BackInStock", operationReference: next(), skuReference: sku })).item
          .status,
        "Available",
      );
      // Sold out until further notice outlives the business day.
      await call({
        action: "SoldOut",
        operationReference: next(),
        skuReference: sku,
        until: "UntilBack",
      });
      clock = Date.parse("2026-10-08T12:00:00.000Z");
      assert.deepEqual(
        { status: (await status()).status, until: (await status()).soldOutUntil },
        { status: "SoldOut", until: null },
      );
      // The cook cannot bring back a manager's "until further notice" mark.
      scope.as(cook);
      await assert.rejects(
        call({ action: "BackInStock", operationReference: next(), skuReference: sku }),
        { code: "PermissionDenied" },
      );
      scope.as(manager);
      await call({ action: "BackInStock", operationReference: next(), skuReference: sku });
      // WP-2423 Q21: at 01:30 on Oct 9 (after midnight, before the 04:00 business-day start) it is
      // still the Oct 8 business day: sold out for today ends at 04:00 local, not next midnight.
      clock = Date.parse("2026-10-09T05:30:00.000Z");
      scope.as(cook);
      assert.deepEqual(
        (
          await call({
            action: "SoldOut",
            operationReference: next(),
            skuReference: sku,
            until: "EndOfDay",
          })
        ).item,
        { status: "SoldOut", soldOutUntil: "2026-10-09T08:00:00.000Z" },
      );
      // Once the business day has ended, the item is back on sale by itself.
      clock = Date.parse("2026-10-09T08:00:00.000Z");
      assert.equal((await status()).status, "Available");
      scope.as(owner);
      assert.equal(
        (await call({ action: "StopOffering", operationReference: next(), skuReference: sku })).item
          .status,
        "NotOffered",
      );
      scope.as(cashier);
      await assert.rejects(availability.query({ sessionCookie: "s", csrf: "c" }), {
        code: "PermissionDenied",
      });

      const rules = (
        await admin.query(
          "SELECT reason_code,decision,priority,lifecycle,store_id::text store,effective_until FROM rms_catalog.availability_rule ORDER BY created_at,availability_rule_id",
        )
      ).rows;
      assert.deepEqual(
        rules.map((r) => [r.reason_code, r.decision, r.priority, r.lifecycle, r.store]),
        [
          ["STORE_OFFERED", "Available", 100, "Inactive", storeReference],
          ["SOLD_OUT", "Unavailable", 900, "Inactive", storeReference],
          ["SOLD_OUT", "Unavailable", 900, "Inactive", storeReference],
          ["SOLD_OUT", "Unavailable", 900, "Inactive", storeReference],
          ["SOLD_OUT", "Unavailable", 900, "Active", storeReference],
        ],
      );
      const audits = (
        await admin.query(
          "SELECT action_code,store_id::text store FROM platform_audit.audit_record WHERE action_code LIKE 'CATALOG_AVAILABILITY_%' ORDER BY occurred_at,audit_id",
        )
      ).rows;
      assert.equal(audits.length, 14);
      assert.equal(audits.filter((a) => a.store === storeReference).length, 11);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM platform_eventing.outbox_event WHERE event_type LIKE 'AvailabilityRule%'",
          )
        ).rows[0].n,
        14,
      );
      const snapshots = await admin.query(
        "SELECT count(*)::int n FROM rms_catalog.availability_rule_operation_snapshot",
      );
      assert.equal(snapshots.rows[0].n, 14);
      await admin.query(
        "UPDATE rms_catalog.availability_rule_operation_snapshot SET record_json='{}'",
      );
      await admin.query("DELETE FROM rms_catalog.availability_rule_operation_snapshot");
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int n FROM rms_catalog.availability_rule_operation_snapshot WHERE record_json<>'{}'",
          )
        ).rows[0].n,
        14,
      );
    } finally {
      for (const name of [role, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE IF EXISTS " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});

/**
 * WP-2423 (Owner approval 2026-10-14, "批准收紧"): a kitchen display sign-in holds only the kitchen
 * profile at Brand level too. The Owner's own kitchen display Session may mark an item sold out for
 * today, but never offer, stop offering or mark it "until further notice" — while the same Owner's
 * ordinary Session keeps every Brand action. Real Session, Membership, roles and Permission policy,
 * real Store and Brand scopes, under the restricted pilot API role.
 */
it("limits an Owner's kitchen display sign-in to sold out today at Brand level", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_kds_brand" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const role = "wp2423_kdsb_" + context.runId,
      worker = "wp2423_kdsb_w_" + context.runId;
    const tenantReference = id(1),
      brandReference = id(2),
      storeReference = id(3),
      owner = id(4),
      sku = id(12),
      at = "2026-10-08T01:00:00.000Z",
      from = "2026-10-08T00:59:00.000Z",
      until = "2026-10-08T02:00:00.000Z",
      names = JSON.stringify({ "en-CA": "Mocha" });
    let clock = Date.parse(at);
    const now = () => new Date((clock += 1000)).toISOString();
    let reference = 0x9000;
    const next = () => "019a0000-0000-7000-8000-" + (++reference).toString(16).padStart(12, "0");
    const scope = { tenantReference, brandReference, storeReference };
    try {
      await seedOrdinaryRefundStorePublication({
        client: admin,
        scope,
        firstCapturedAt: "2026-10-08T00:00:00.000Z",
      });
      await admin.query(
        "INSERT INTO rms_catalog.product(product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,'MOCHA','PreparedFood','Active',1,$3,$4,$3)",
        [id(10), brandReference, from, owner],
      );
      await admin.query(
        "INSERT INTO rms_catalog.product_version(product_version_id,product_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$5)",
        [id(11), id(10), brandReference, names, from],
      );
      await admin.query(
        `INSERT INTO rms_catalog.sku(sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,localized_names_json,variant_selections_json,variant_digest,unit_of_sale,unit_quantity,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,'MOCHA-REGULAR-12-OZ','Active','{"en-CA":"Regular (12 oz)"}'::jsonb,'[]'::jsonb,$5,'EACH',1,$6,$7)`,
        [sku, id(10), brandReference, id(11), "sha256:" + "a".repeat(64), from, owner],
      );
      for (const name of [role, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api: role, worker }));
      for (const sql of [...productApiGrants, ...availabilityApiGrants])
        await admin.query(sql.replaceAll("ROLE_", role));
      const transactions = {
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
      };
      // The Store Owner role (all Store codes it needs here) and the Session started as a kitchen
      // display; then the Owner's Brand role with the Brand-level availability authority.
      const kitchen = await seedMerchantAcceptanceSession({
        admin,
        runner: transactions,
        scope,
        actor: owner,
        at,
        extraPermissions: [
          "catalog.sku.read",
          "catalog.sku.availability.manage",
          "catalog.sku.sold_out.mark",
        ],
        authenticationPolicyCode: "NamedKdsOperator",
        referencePrefix: "01909a40",
        sessionReferencePrefix: "01909a41",
      });
      const bid = (n) => "01909a42-0000-7000-8000-" + n.toString(16).padStart(12, "0");
      await admin.query(
        "INSERT INTO bop_permission.role VALUES($1,$2,NULL,'synthetic_brand_owner','Active',$3,$4,1,$3,$3)",
        [bid(1), brandReference, from, until],
      );
      await admin.query(
        "INSERT INTO bop_permission.role_assignment VALUES($1,$2,$3,NULL,$4,$5,NULL,'Active',$6,$7,1,$6,$6)",
        [
          bid(2),
          bid(1),
          "01909a40-0000-7000-8000-000000000001",
          owner,
          brandReference,
          from,
          until,
        ],
      );
      for (const [i, action] of ["catalog.sku.read", "catalog.sku.availability.manage"].entries()) {
        const permission = (
          await admin.query(
            "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
            [action],
          )
        ).rows[0].permission_id;
        await admin.query(
          "INSERT INTO bop_permission.permission_grant VALUES ($1,$2,$3,$4,NULL,'Active',$5,$6,1,$5,$5)",
          [bid(10 + i), bid(1), permission, brandReference, from, until],
        );
      }
      // The same Owner's ordinary sign-in.
      const ordinary = await seedOrdinaryRefundSession({
        client: admin,
        runner: () => transactions,
        scope,
        requester: owner,
        at,
        referencePrefix: "01909a43",
      });
      const availability = (session) => {
        const service = createMerchantAvailability({
          persistence: {
            ...session.persistence,
            now,
            publication: {
              configurationType: "STORE_CONFIGURATION",
              purposeCode: "STORE_CONFIGURATION",
              requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
            },
            transactions,
          },
          authentication: session.authentication,
          references: { next },
          locale: "en-CA",
        });
        const input = { sessionCookie: session.sessionCookie, csrf: session.csrf };
        return {
          query: () => service.query(input),
          call: (body) => service.command({ ...input, body }),
        };
      };
      const atKitchen = availability(kitchen),
        atDesk = availability(ordinary);

      assert.deepEqual((await atDesk.query()).permissions, {
        mayOffer: true,
        mayMarkSoldOut: true,
        mayMarkUntilBack: true,
      });
      assert.equal(
        (await atDesk.call({ action: "Offer", operationReference: next(), skuReference: sku })).item
          .status,
        "Available",
      );
      // At the kitchen display the same Owner holds only the today-only mark.
      assert.deepEqual((await atKitchen.query()).permissions, {
        mayOffer: false,
        mayMarkSoldOut: true,
        mayMarkUntilBack: false,
      });
      for (const body of [
        { action: "StopOffering", operationReference: next(), skuReference: sku },
        { action: "Offer", operationReference: next(), skuReference: sku },
        { action: "SoldOut", operationReference: next(), skuReference: sku, until: "UntilBack" },
      ])
        await assert.rejects(atKitchen.call(body), { code: "PermissionDenied" });
      assert.deepEqual(
        (
          await atKitchen.call({
            action: "SoldOut",
            operationReference: next(),
            skuReference: sku,
            until: "EndOfDay",
          })
        ).item,
        { status: "SoldOut", soldOutUntil: "2026-10-08T08:00:00.000Z" },
      );
      assert.equal(
        (
          await atKitchen.call({
            action: "BackInStock",
            operationReference: next(),
            skuReference: sku,
          })
        ).item.status,
        "Available",
      );
      // The kitchen display's refusals changed nothing: only the desk's offer and the kitchen's
      // today-only mark and its return are recorded.
      assert.deepEqual(
        (
          await admin.query(
            "SELECT reason_code,lifecycle FROM rms_catalog.availability_rule ORDER BY created_at,availability_rule_id",
          )
        ).rows.map((r) => [r.reason_code, r.lifecycle]),
        [
          ["STORE_OFFERED", "Active"],
          ["SOLD_OUT", "Inactive"],
        ],
      );
      // The ordinary sign-in still stops offering it.
      assert.equal(
        (
          await atDesk.call({
            action: "StopOffering",
            operationReference: next(),
            skuReference: sku,
          })
        ).item.status,
        "NotOffered",
      );
    } finally {
      for (const name of [role, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE IF EXISTS " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
