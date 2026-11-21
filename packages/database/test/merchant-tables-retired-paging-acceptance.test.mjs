import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { createDiningTable, parseDiningSession } from "../../rms/dining/src/index.ts";
import { createMerchantDiningTables } from "../../../apps/api/src/merchant-dining-tables.ts";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { createTenantTransactionRunner } from "../src/transaction-runner.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";

const { Client, Pool } = pg;

/**
 * v15 b12 (tables-list-paging, blocker): Test Merchant 2 had 21 tables in use and 30 retired. The
 * Tables read cut the page at 50 rows, retired ones included, then left the retired ones out: 21
 * tables and a next reference. The merchant client refused that page and the whole Tables screen
 * (and Home) read "Tables unavailable" for every staff member. Retiring more tables made it worse.
 *
 * As the pilot API runs it — the application's transaction runner (snapshot reads), as a
 * restricted NOBYPASSRLS role holding the rendered pilot ACL, with a real merchant session — the
 * Tables read now pages over the tables in use only: every page with a next reference is full, and
 * following the pages lists each table in use exactly once, in order, at Test Merchant 2's shape
 * and at a Store with hundreds of tables, most of them retired, seated tables among them. Another
 * Store's tables are never listed. Test-only rows (labelled SYNTHETIC) are inserted by the owner.
 */
it("lists the tables in use in full pages, however many tables were retired", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_tblretired" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_tr_" + context.runId,
      worker = "wp2423_tr_w_" + context.runId;
    const pool = new Pool({
      ...context.clientConfig,
      max: 8,
      connectionTimeoutMillis: 5000,
      query_timeout: 10_000,
    });
    try {
      for (const name of [api, worker])
        await admin.query(
          "CREATE ROLE " + name + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
        );
      const root = new URL("../../../docs/spec/", import.meta.url);
      const matrices = await Promise.all(
        ["pilot-acl-matrix.json", "pilot-acl-additions.json"].map(async (file) =>
          JSON.parse(await readFile(new URL(file, root), "utf8")),
        ),
      );
      await admin.query(renderPilotAclSql(matrices, { api, worker }));

      const ref = (n) => "01a0f0c0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
      const brand = ref(1),
        store = ref(2),
        tenant = ref(3),
        otherStore = ref(4),
        scope = { brandReference: brand, storeReference: store };
      const now = () => new Date().toISOString();
      const tenantRunner = createTenantTransactionRunner(pool, { brandId: brand, storeId: store });
      const asApi = (work) => async (tx) => {
        await tx.query("SET LOCAL ROLE " + api, []);
        return work(tx);
      };
      const runner = {
        run: (work) => tenantRunner.run(asApi(work)),
        runSnapshot: (work) => tenantRunner.runSnapshot(asApi(work)),
      };
      const session = await seedMerchantAcceptanceSession({
        admin,
        runner,
        role: api,
        scope: { tenantReference: tenant, ...scope },
        actor: ref(0x900),
        at: now(),
        extraPermissions: ["dining.operate"],
        referencePrefix: "01a0f0c3",
        sessionReferencePrefix: "01a0f0c4",
      });
      await admin.query(
        "INSERT INTO bop_tenant.store VALUES ($1,$2,'SYNTHETIC_OTHER_STORE','Synthetic Other Store','America/Toronto','en-CA','CAD','Active',1,now(),now()) ON CONFLICT (store_id) DO NOTHING",
        [otherStore, brand],
      );

      const startedAt = new Date(
        Math.floor((Date.now() - 20 * 60_000) / 1000) * 1000,
      ).toISOString();
      let sessions = 0;
      /** One SYNTHETIC table row (owner), retired or in use; a seated one gets its session. */
      const addTable = async (n, lifecycle, seated = false, storeReference = store) => {
        const tableReference = ref(0x10000 + n),
          sessionReference = seated ? ref(0x20000 + ++sessions) : null;
        const table = createDiningTable({
          tenantReference: tenant,
          brandReference: brand,
          storeReference,
          tableReference,
          stableLabel: "SYNTHETIC-" + n,
          areaReference: ref(0x3000),
          areaCode: "ROOM",
          capacity: 4,
          accessibilityAttributes: [],
          lifecycle,
          qrStatus: lifecycle === "Retired" ? "Revoked" : "Active",
          qrVersion: 1,
          operationalState: "Available",
          blockReasonCode: null,
          activeDiningSessionReference: sessionReference,
          aggregateVersion: 1,
          createdAt: startedAt,
          observedAt: startedAt,
        });
        await admin.query(
          "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,1,$5::jsonb,$6,$6)",
          [tableReference, tenant, brand, storeReference, JSON.stringify(table), startedAt],
        );
        if (sessionReference !== null) {
          const dining = parseDiningSession({
            diningSessionReference: sessionReference,
            brandReference: brand,
            storeReference,
            tableReference,
            tableAssignmentVersion: 1,
            phase: "Active",
            version: 2,
            startedByActorReference: ref(0x900),
            startedAt,
            hostParticipantReference: null,
          });
          await admin.query(
            "INSERT INTO rms_dining.dining_session (session_id,tenant_id,brand_id,store_id,table_id,version,phase,session_snapshot,started_at) VALUES ($1,$2,$3,$4,$5,2,'Active',$6::jsonb,$7)",
            [
              sessionReference,
              tenant,
              brand,
              storeReference,
              tableReference,
              JSON.stringify(dining),
              startedAt,
            ],
          );
        }
        return String(tableReference);
      };

      const tables = createMerchantDiningTables({
        persistence: { ...session.persistence, transactions: runner, now },
        authentication: session.authentication,
        tableAvailabilityCommandEnabled: true,
      });
      const page = (afterTableReference, limit) =>
        tables({
          sessionCookie: session.sessionCookie,
          csrf: session.csrf,
          query: { afterTableReference, limit },
        });
      /** Follows every page as the merchant client does, checking each page is full. */
      const readAll = async (limit) => {
        const listed = [];
        let after = null;
        for (let pages = 0; pages < 100; pages++) {
          const view = await page(after, limit);
          if (view.nextAfterTableReference !== null) {
            assert.equal(view.items.length, limit, "a page with a next reference is full");
            assert.equal(
              String(view.nextAfterTableReference),
              String(view.items.at(-1).tableReference),
            );
          }
          listed.push(...view.items);
          after = view.nextAfterTableReference;
          if (after === null) return listed;
        }
        throw new Error("too many pages");
      };

      // 1. Test Merchant 2's shape: 30 retired tables first (the oldest), then 21 in use.
      const inUse = [];
      for (let n = 1; n <= 30; n++) await addTable(n, "Retired");
      for (let n = 31; n <= 51; n++) inUse.push(await addTable(n, "Published", n === 33));
      const first = await page(null, 50);
      assert.deepEqual(
        first.items.map((item) => String(item.tableReference)),
        inUse,
        "every table in use on the first page",
      );
      assert.equal(first.nextAfterTableReference, null, "nothing more to read");
      assert.ok(first.items.every((item) => item.lifecycle !== "Retired"));
      assert.equal(
        first.items.filter((item) => item.currentDiningSessionReference !== null).length,
        1,
      );

      // 2. A Store open for years: 400 tables, most of them retired, in use ones spread among
      //    them, some seated, and another Store's tables in between. Small and large pages.
      for (let n = 52; n <= 451; n++) {
        const used = n % 5 === 0 || n % 7 === 0;
        if (used) inUse.push(await addTable(n, "Published", n % 35 === 0));
        else await addTable(n, "Retired");
      }
      for (let n = 452; n <= 460; n++) await addTable(n, "Published", false, otherStore);
      assert.ok(inUse.length > 100, "more tables in use than one page");
      for (const limit of [7, 50, 100]) {
        const listed = await readAll(limit);
        assert.deepEqual(
          listed.map((item) => String(item.tableReference)),
          inUse,
          "each table in use once, in order, at pages of " + limit,
        );
      }
    } finally {
      await pool.end();
      await admin.end();
    }
  });
});
