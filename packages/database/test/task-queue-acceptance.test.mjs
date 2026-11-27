import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { createMerchantBffRouter } from "../../../apps/api/src/merchant-bff.ts";
import { createMerchantTaskInboxRead } from "../../../apps/api/src/merchant-task-inbox-read.ts";
import { createTaskInboxClient } from "../../../apps/merchant-web/src/task-inbox-client.ts";
import { createTaskInboxController } from "../../../apps/merchant-web/src/task-inbox-state.ts";
const express = createRequire(new URL("../../../apps/api/package.json", import.meta.url))(
  "express",
);
import pg from "pg";
import { it } from "vitest";
import { createTaskRecord, createPostgresTaskQueueReader } from "../../bop/task/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const id = (n) => "01902403-0000-7000-8000-" + String(n).padStart(12, "0");
const at = (n) => `2026-09-27T00:0${n}:00.000Z`;
const scope = { kind: "Store", brandReference: id(2), storeReference: id(3) };

it("filters latest Task owner facts before keyset pages under restricted Store RLS", async () => {
  await withIsolatedDatabase({ caseId: "wp2403_queue" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    const role = `wp2403_${context.runId}`;
    assert.match(role, /^wp2403_[a-f0-9]+$/u);
    let sequence = 1000;
    const digest = "sha256:" + "a".repeat(64);
    try {
      await admin.query(
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      );
      await admin.query(`GRANT USAGE ON SCHEMA bop_task,platform_helpers TO ${role}`);
      await admin.query(`GRANT SELECT ON bop_task.task_version TO ${role}`);
      await admin.query(
        `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
      );
      async function insert(record, operation) {
        await admin.query(
          `INSERT INTO bop_task.task_version(task_id,brand_id,store_id,version,expected_version,
     operation_code,idempotency_key,request_digest,mutation_digest,audit_id,source_type,source_id,task_type,status,occurred_at,record_json)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
          [
            record.taskReference,
            record.scope.brandReference,
            record.scope.storeReference,
            record.version,
            Math.max(1, record.version - 1),
            operation,
            id(++sequence),
            digest,
            id(++sequence),
            record.source.sourceType,
            record.source.sourceReference,
            record.taskType,
            record.status,
            record.updatedAt,
            JSON.stringify(record),
          ],
        );
      }
      async function seed(
        n,
        {
          taskType = "EXCEPTION",
          severityCode = "CRITICAL",
          due = 0,
          actor = null,
          taskScope = scope,
          queue = id(7),
          moved = false,
        } = {},
      ) {
        const open = createTaskRecord({
          taskReference: id(n),
          scope: taskScope,
          source: {
            sourceType: "DINING_SESSION",
            sourceReference: id(500 + n),
            snapshotDigest: digest,
          },
          taskType,
          severityCode,
          priorityCode: "NORMAL",
          status: "Open",
          assignmentHistory: [],
          currentAssignment: null,
          claimHistory: [],
          currentClaim: null,
          dueAt: at(due),
          escalationPolicyReference: id(5),
          escalationHistory: [],
          terminalOutcome: null,
          version: 1,
          createdAt: at(0),
          updatedAt: at(0),
        });
        await insert(open, "Create");
        const assignment = {
          assignmentReference: id(++sequence),
          target: { kind: "Queue", reference: queue },
          assignedBy: id(80),
          assignedAt: at(0),
          reasonCode: "TEST_ASSIGNMENT",
        };
        let record = createTaskRecord({
          ...open,
          status: "Assigned",
          version: 2,
          assignmentHistory: [assignment],
          currentAssignment: assignment,
        });
        await insert(record, "Assign");
        if (actor !== null) {
          const claim = {
            claimReference: id(++sequence),
            actorReference: actor,
            eligibilityEvidenceReference: id(++sequence),
            membershipReference: id(++sequence),
            storeAssignmentReference: id(++sequence),
            claimedAt: at(0),
          };
          record = createTaskRecord({
            ...record,
            status: "Claimed",
            version: 3,
            claimHistory: [claim],
            currentClaim: claim,
          });
          await insert(record, "Claim");
        }
        if (moved) {
          const next = {
            ...assignment,
            assignmentReference: id(++sequence),
            target: { kind: "Queue", reference: id(8) },
          };
          record = createTaskRecord({
            ...record,
            version: 3,
            assignmentHistory: [assignment, next],
            currentAssignment: next,
          });
          await insert(record, "Assign");
        }
      }
      await seed(10, { taskType: "ROUTINE", due: 2 });
      await seed(11, { actor: id(80), severityCode: "HIGH" });
      await seed(12, { actor: id(81), due: 1 });
      await seed(13);
      await seed(14, { due: 2 });
      await seed(15, { moved: true });
      await seed(17, { taskScope: { ...scope, storeReference: id(4) } });
      await seed(18, { taskScope: { ...scope, brandReference: id(6) } });
      await seed(19, { queue: id(8) });
      let allowed = true,
        fenceCalls = 0;
      const reader = createPostgresTaskQueueReader({
        scope,
        authorizeAndFence: async () => {
          fenceCalls++;
          return allowed;
        },
      });
      async function page(filters, afterTaskReference = null, limit = 1) {
        await admin.query("BEGIN READ ONLY");
        try {
          await admin.query(`SET LOCAL ROLE ${role}`);
          await admin.query("SET LOCAL statement_timeout='5s'");
          const result = await reader.list(
            { query: (sql, values) => admin.query(sql, [...values]) },
            {
              queueReference: id(7),
              afterTaskReference,
              limit,
              observedAt: at(1),
              filters,
            },
          );
          // RLS itself hides foreign scopes even if a consumer omits explicit scope SQL.
          const visible = await admin.query(
            "SELECT DISTINCT brand_id::text,store_id::text FROM bop_task.task_version",
          );
          assert.deepEqual(visible.rows, [{ brand_id: id(2), store_id: id(3) }]);
          await admin.query("COMMIT");
          return result;
        } catch (error) {
          await admin.query("ROLLBACK");
          throw error;
        }
      }
      const references = (result) => result.items.map((t) => t.taskReference);
      const filters = {
        status: "Assigned",
        taskType: "EXCEPTION",
        severityCode: "CRITICAL",
        owner: { kind: "Unclaimed" },
      };
      const first = await page(filters);
      assert.deepEqual(references(first), [id(13)]);
      assert.equal(first.nextAfterTaskReference, id(13));
      const second = await page(filters, first.nextAfterTaskReference);
      assert.deepEqual(references(second), [id(14)]);
      assert.equal(second.nextAfterTaskReference, null);
      assert.deepEqual(references(await page({ ...filters, overdue: true })), [id(13)]);
      assert.deepEqual(references(await page({ ...filters, overdue: false })), [id(14)]);
      assert.deepEqual(
        references(await page({ owner: { kind: "ByActor", actorReference: id(80) } })),
        [id(11)],
      );
      assert.deepEqual(
        references(await page({ owner: { kind: "ByOtherActor", actorReference: id(80) } })),
        [id(12)],
      );
      assert.deepEqual(references(await page({ status: "Claimed", overdue: false })), [id(12)]);
      assert.deepEqual(references(await page({ exactReference: id(512) })), [id(12)]);
      assert.deepEqual(references(await page({ exactReference: id(11) })), [id(11)]);
      assert.deepEqual(references(await page({ exactReference: id(17) })), []);
      assert.deepEqual(references(await page(undefined, null, 100)), [10, 11, 12, 13, 14].map(id));
      const before = fenceCalls;
      allowed = false;
      await assert.rejects(page({}), /TASK_STORE_UNAVAILABLE/u);
      assert.equal(fenceCalls, before + 1);

      // Assembled real HTTP + database read, with explicit synthetic identity and
      // source permission ports. No OAuth/Secure-cookie/browser rendering claim.
      allowed = true;
      for (let n = 30; n < 85; n++)
        await seed(n, { taskType: "ROUTINE", severityCode: "HIGH", due: 2 });
      await seed(100, { severityCode: "LOW" });
      await seed(101, { severityCode: "LOW" });
      const cookie = "A".repeat(43);
      let trimRoutine = false;
      const taskInbox = createMerchantTaskInboxRead({
        now: () => at(1),
        transactions: {
          async run(work) {
            const client = new pg.Client(context.clientConfig);
            await client.connect();
            try {
              await client.query("BEGIN READ ONLY");
              await client.query(`SET LOCAL ROLE ${role}`);
              await client.query("SET LOCAL statement_timeout='5s'");
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
        },
        authorize: async (_tx, supplied) =>
          supplied === cookie && allowed
            ? {
                tenantReference: id(1),
                brandReference: id(2),
                storeReference: id(3),
                actorReference: id(80),
                queueReference: id(7),
                storeLabel: "Synthetic Store",
                canClaim: false,
              }
            : null,
        queue: () => reader,
        authorizeSource: async (_tx, _scope, task) => !trimRoutine || task.taskType !== "ROUTINE",
      });
      const unavailable = async () => {
        throw new Error("unconfigured synthetic command");
      };
      const app = express();
      const server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
        listener.once("error", reject);
      });
      const serverAddress = server.address();
      assert(serverAddress && typeof serverAddress !== "string");
      app.use(
        "/merchant",
        createMerchantBffRouter({
          taskInbox,
          service: {
            start: unavailable,
            callback: unavailable,
            bootstrap: unavailable,
            authorize: unavailable,
            logout: unavailable,
            switchStore: unavailable,
          },
          exactOrigin: "https://merchant.example.test",
          acceptedHost: `127.0.0.1:${serverAddress.port}`,
        }),
      );
      let transportReads = 0,
        lastResponseStatus = null;
      const browser = createTaskInboxController(
        createTaskInboxClient(async (pathname, options) => {
          assert.equal(pathname, "/merchant/tasks");
          assert.equal(options.method, "GET");
          assert.equal(options.cache, "no-store");
          const address = server.address();
          assert(address && typeof address !== "string");
          transportReads++;
          const response = await globalThis.fetch(`http://127.0.0.1:${address.port}${pathname}`, {
            ...options,
            headers: {
              ...options.headers,
              "Sec-Fetch-Site": "same-origin",
              Cookie: "__Host-bop-merchant=" + cookie,
            },
          });
          lastResponseStatus = response.status;
          return response;
        }),
        "synthetic-store-session",
      );
      try {
        await browser.refresh();
        assert.equal(lastResponseStatus, 200, "assembled initial HTTP read status");
        assert.equal(browser.getSnapshot().kind, "Ready");
        assert.equal(browser.getSnapshot().view.items.length, 50);
        assert(!browser.getSnapshot().view.items.some((task) => task.taskReference === id(100)));
        browser.setFilters({
          status: "Assigned",
          severityCode: "LOW",
          ownerStatus: "Unclaimed",
          overdue: true,
        });
        assert.equal(browser.getSnapshot().view, null);
        await browser.refresh();
        assert.deepEqual(
          browser.getSnapshot().view.items.map((t) => t.taskReference),
          [id(100), id(101)],
        );
        assert.equal(browser.getSnapshot().view.nextAfterTaskReference, null);
        browser.setFilters({ ownerStatus: "ClaimedByYou" });
        await browser.refresh();
        assert.deepEqual(
          browser.getSnapshot().view.items.map((t) => t.taskReference),
          [id(11)],
        );
        assert.equal(browser.getSnapshot().view.items[0].ownerStatus, "ClaimedByYou");
        assert(!JSON.stringify(browser.getSnapshot().view).includes(id(80)));
        browser.setFilters({ ownerStatus: "ClaimedByStaff", overdue: false });
        await browser.refresh();
        assert.deepEqual(
          browser.getSnapshot().view.items.map((t) => t.taskReference),
          [id(12)],
        );
        browser.setFilters({ exactReference: id(512) });
        await browser.refresh();
        assert.deepEqual(
          browser.getSnapshot().view.items.map((t) => t.taskReference),
          [id(12)],
        );
        assert(!JSON.stringify(browser.getSnapshot().view).includes(id(512)));
        assert(!browser.getSnapshot().view.items.some((t) => "sourceReference" in t));
        browser.setFilters({ taskType: "ROUTINE" });
        await browser.refresh();
        assert.equal(browser.getSnapshot().view.items.length, 50);
        assert.equal(browser.getSnapshot().view.nextAfterTaskReference, id(78));
        await browser.next();
        assert.deepEqual(
          browser.getSnapshot().view.items.map((t) => t.taskReference),
          [79, 80, 81, 82, 83, 84].map(id),
        );
        assert.equal(browser.getSnapshot().view.nextAfterTaskReference, null);
        trimRoutine = true;
        await browser.refresh();
        assert.deepEqual(browser.getSnapshot().view.items, []);
        assert.equal(browser.getSnapshot().view.nextAfterTaskReference, id(78));
        await browser.next();
        assert.deepEqual(browser.getSnapshot().view.items, []);
        assert.equal(browser.getSnapshot().view.nextAfterTaskReference, null);
        browser.setOnline(false);
        assert.equal(browser.getSnapshot().kind, "Offline");
        const reads = transportReads;
        browser.setFilters({ severityCode: "LOW" });
        assert.equal(browser.getSnapshot().view, null);
        await browser.refresh();
        assert.equal(transportReads, reads);
        browser.setOnline(true);
        assert.equal(transportReads, reads);
        await browser.refresh();
        assert.equal(browser.getSnapshot().kind, "Ready");
        allowed = false;
        await browser.refresh();
        assert.equal(browser.getSnapshot().kind, "PermissionDenied");
        assert.equal(browser.getSnapshot().view, null);
      } finally {
        browser.dispose();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      await admin.end();
    }
  });
});
