import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import pg from "pg";
import { it, vi } from "vitest";
import { renderPilotAclSql } from "../../../tooling/environment/pilot-acl-render.mjs";
import { readProjectedExceptionReferences } from "../../../tooling/environment/pilot-exception-references.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { seedMerchantAcceptanceSession } from "../test-support/merchant-acceptance-session.mjs";
import { createPersistentMerchantOrderExceptions } from "../../../apps/api/src/persistent-merchant-order-exceptions.ts";
import { seedJourneyStorePublication } from "../test-support/dine-in-journey-seed.mjs";

const { Client } = pg;
const id = (n) => "01a1e200-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const minutes = (n) => n * 60_000;
const zone = "America/Toronto";

/** Test-only: the UTC instant of a Toronto wall-clock time (independent of the Store code). */
function torontoInstant(date, time) {
  const guess = Date.parse(`${date}T${time}Z`);
  for (const offset of [4, 5]) {
    const at = new Date(guess + offset * 3_600_000);
    const local = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(at);
    if (local.replace(", ", "T") === `${date}T${time}`) return at.toISOString();
  }
  throw new Error("no such Toronto time");
}
/** The end of the 04:00-to-04:00 Toronto business day an instant falls in. */
function businessDayEnd(instant) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.parse(instant) - 4 * 3_600_000));
  const next = new Date(Date.parse(date + "T12:00:00.000Z") + 86_400_000)
    .toISOString()
    .slice(0, 10);
  return torontoInstant(next, "04:00:00");
}

/**
 * WP-2423 (v15, 41 lifetime exceptions on 2026-10-17): the Exceptions page read stopped after
 * 5 x 100 projected cases and showed "unavailable" once a Store passed 500 in its lifetime. Under
 * the rendered pilot API grants (restricted NOBYPASSRLS role), the pilot runner's limits and the
 * exception snapshot's read-only statement rule, a Store with 520 resolved cases and 3 open ones
 * lists every open case on each read, pages its resolved history 25 at a time to the end, and
 * gives an open case whose refund the payment provider already confirmed the end of the business
 * day it opened in as its due time (DEC-EXCEPTION-CONFIRMED-REFUND-DUE).
 */
it("lists every open exception past 500 lifetime cases and pages resolved history", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_exc_history" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_eh_" + context.runId,
      worker = "wp2423_eh_w_" + context.runId;
    vi.stubEnv("NODE_ENV", "development");
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

      const now = () => new Date().toISOString();
      const scope = { brandReference: id(1), storeReference: id(2) };
      const ownerScope = { tenantReference: id(3), ...scope };
      const queryLog = [];
      let breakCauses = false;
      /** Test-only: the one reconciliation difference whose detail read PostgreSQL refuses. */
      let breakReconciliation = null;
      /**
       * Test-only: the business-day configuration read PostgreSQL cancels at the statement
       * timeout: the one for this instant, or "now" for today's.
       */
      let breakDayAt = null;
      const breaksDay = (sql, values) =>
        breakDayAt !== null &&
        sql.startsWith("WITH RECURSIVE published AS") &&
        sql.includes("rms_store.store_configuration_version") &&
        typeof values?.[2] === "string" &&
        (breakDayAt === "now"
          ? Math.abs(Date.parse(values[2]) - Date.now()) < 60_000
          : Date.parse(values[2]) === Date.parse(breakDayAt));
      /**
       * The pilot exception snapshot (tooling/environment/pilot-exception-snapshot.mjs): one
       * REPEATABLE READ transaction under the api role with the runner's limits, accepting only
       * read statements.
       */
      const transactions = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
            await client.query("SET LOCAL ROLE " + api);
            await client.query("SET LOCAL statement_timeout = '5s'");
            await client.query("SET LOCAL lock_timeout = '2s'");
            const result = await work({
              query: async (sql, values) => {
                assert.ok(
                  typeof sql === "string" &&
                    /^\s*(SELECT\b|WITH RECURSIVE\b|SET LOCAL\b|LOCK TABLE [a-z_][a-z0-9_.]*(?:,[a-z_][a-z0-9_.]*)* IN (?:ROW )?SHARE MODE$)/iu.test(
                      sql,
                    ) &&
                    !sql.includes(";"),
                  "the exception snapshot refuses: " + String(sql).slice(0, 60),
                );
                queryLog.push(sql);
                // Test-only: a real PostgreSQL failure of the order-cause read (an unknown table).
                const statement =
                  breakCauses && sql.includes("rms_ordering.order_termination_record")
                    ? sql.replace(
                        "rms_ordering.order_termination_record",
                        "rms_ordering.no_such_table",
                      )
                    : breakReconciliation !== null &&
                        sql.includes("FROM rms_payment.payment_reconciliation_exception e") &&
                        Array.isArray(values?.[2]) &&
                        values[2].includes(breakReconciliation)
                      ? sql.replace(
                          "FROM rms_payment.payment_reconciliation_exception e",
                          "FROM rms_payment.no_such_table e",
                        )
                      : sql;
                // Longer than the snapshot's 5 s statement timeout: PostgreSQL cancels it (57014).
                if (breaksDay(sql, values)) return client.query("SELECT pg_sleep(10)", []);
                return client.query(statement, values === undefined ? [] : [...values]);
              },
            });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      // The session seed writes through its own runner (not the read-only snapshot).
      const writer = {
        async run(work) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
            const result = await work({
              query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
            });
            await client.query("COMMIT");
            return result;
          } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const session = await seedMerchantAcceptanceSession({
        admin,
        runner: writer,
        scope: ownerScope,
        actor: id(10),
        at: now(),
        extraPermissions: ["operations.order-exception.manage"],
      });
      await seedJourneyStorePublication({
        client: admin,
        scope: ownerScope,
        // Its approval stays valid for two days after publication.
        publishedAt: new Date(Date.now() - 36 * 3_600_000).toISOString(),
        businessDayStart: "04:00:00",
        prefix: "01a1e300",
      });

      // Projected cases (setup on the owner client): 520 resolved, each with its open version
      // first, then three open: a refund already confirmed today, one confirmed on an earlier
      // business day, and one not yet confirmed.
      const record = (n, version, status, extra = {}) => ({
        sourceReference: id(n),
        ...ownerScope,
        orderReference: id(n + 100_000),
        paymentReference: id(n + 200_000),
        diningReference: null,
        kind: "PaidWithoutFulfillableOrder",
        severity: "Critical",
        sourceOwner: "Payment",
        sourceStatus: status,
        providerState: "Confirmed",
        compensationStatus: status === "Final" ? "Completed" : "Pending",
        sourceVersion: String(version),
        sourceDigest: "sha256:" + String(n % 10).repeat(64),
        createdAt: new Date(Date.now() - minutes(3000) + n * 1000).toISOString(),
        updatedAt: new Date(Date.now() - minutes(3000) + n * 1000 + version).toISOString(),
        resolutionEvidenceReference: status === "Final" ? id(n + 300_000) : null,
        ...extra,
      });
      const insert = async (value) =>
        admin.query(
          "INSERT INTO platform_projection.order_exception_source (tenant_id,brand_id,store_id,source_id,source_version,checkpoint_id,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
          [
            ownerScope.tenantReference,
            scope.brandReference,
            scope.storeReference,
            value.sourceReference,
            value.sourceVersion,
            id(900),
            JSON.stringify(value),
          ],
        );
      for (let n = 1000; n < 1520; n++) {
        await insert(record(n, 1, "Open"));
        await insert(record(n, 2, "Final"));
      }
      const todayOpened = new Date(Date.now() - minutes(10)).toISOString();
      const earlierOpened = new Date(Date.now() - 30 * 3_600_000).toISOString();
      const unconfirmedOpened = new Date(Date.now() - minutes(5)).toISOString();
      const open = [
        record(2000, 1, "Open", { createdAt: todayOpened, updatedAt: todayOpened }),
        record(2001, 1, "Open", { createdAt: earlierOpened, updatedAt: earlierOpened }),
        record(2002, 1, "Open", {
          providerState: "Pending",
          createdAt: unconfirmedOpened,
          updatedAt: unconfirmedOpened,
        }),
      ];
      // Interleaved with the resolved references (the open ones sort after all of them).
      for (const value of open) await insert(value);

      const unexpected = [];
      const read = createPersistentMerchantOrderExceptions({
        persistence: {
          ...session.persistence,
          transactions,
          now,
          // The Store's published business day (seeded above), as the pilot composes it.
          publication: {
            configurationType: "STORE_CONFIGURATION",
            purposeCode: "STORE_CONFIGURATION",
            requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
          },
        },
        onUnexpected: (error, read) => unexpected.push([read ?? "ReconciliationDetail", error]),
        // Test-only: the coverage the pilot reads from the owners is out of scope here.
        metadata: async (_tx, { storeLabel }) => ({
          storeLabel,
          businessDate: "2026-10-17",
          checkpointReference: id(400),
          projectedAt: now(),
          freshnessStatus: "Stale",
        }),
      });
      queryLog.length = 0;
      const first = await read(session.sessionCookie);
      const firstQueries = queryLog.length;
      const openItems = first.items.filter((item) => item.status !== "Resolved");
      assert.deepEqual(
        openItems.map((item) => item.exceptionReference).sort(),
        open.map((value) => value.sourceReference),
      );
      const due = new Map(openItems.map((item) => [item.exceptionReference, item.dueAt]));
      assert.equal(due.get(id(2000)), businessDayEnd(todayOpened));
      assert.equal(due.get(id(2001)), businessDayEnd(earlierOpened));
      assert.equal(
        due.get(id(2002)),
        new Date(Date.parse(unconfirmedOpened) + minutes(15)).toISOString(),
      );
      assert.deepEqual(unexpected, []);
      assert.equal(first.items.filter((item) => item.status === "Resolved").length, 25);

      // v15 batch 7 review: when the order-cause read fails in PostgreSQL, every case is still
      // listed (titled by its kind) and the failure is logged as a cause read, not as UNAVAILABLE.
      breakCauses = true;
      const withoutCauses = await read(session.sessionCookie);
      breakCauses = false;
      assert.deepEqual(
        withoutCauses.items.map((item) => item.exceptionReference),
        first.items.map((item) => item.exceptionReference),
      );
      assert.ok(withoutCauses.items.every((item) => item.cause === undefined));
      assert.deepEqual(
        unexpected.map(([what, error]) => [what, error?.code]),
        [["OrderCause", "42P01"]],
      );
      unexpected.length = 0;
      assert.notEqual(first.olderResolvedBefore, null);

      // Page the resolved history to its end: newest first, no repeats, every case once.
      const seen = new Set(
        first.items.filter((item) => item.status === "Resolved").map((i) => i.exceptionReference),
      );
      let cursor = first.olderResolvedBefore;
      let pages = 1;
      while (cursor !== null) {
        const page = await read(session.sessionCookie, { resolvedBefore: cursor });
        pages++;
        assert.equal(page.items.filter((item) => item.status !== "Resolved").length, 3);
        for (const item of page.items.filter((value) => value.status === "Resolved")) {
          assert.ok(item.exceptionReference < cursor);
          assert.equal(seen.has(item.exceptionReference), false);
          seen.add(item.exceptionReference);
        }
        cursor = page.olderResolvedBefore;
      }
      assert.equal(seen.size, 520);
      assert.equal(pages, 21);

      // The pilot coverage reads every projected reference (without records) in the snapshot.
      const references = await transactions.run((tx) =>
        readProjectedExceptionReferences({ tx, scope: ownerScope, authorize: async () => true }),
      );
      assert.equal(references.size, 523);
      assert.equal([...references.values()].filter((value) => value.final).length, 520);
      assert.deepEqual(references.get(id(2000)), {
        kind: "PaidWithoutFulfillableOrder",
        final: false,
      });

      // The open read is index-bounded: the planner uses the open index once tables are analysed.
      await admin.query("ANALYZE platform_projection.order_exception_source");
      const plan = await admin.query(
        "EXPLAIN (FORMAT JSON) SELECT DISTINCT ON (o.source_id) o.source_id,o.record_json::text AS record FROM platform_projection.order_exception_source o WHERE o.tenant_id=$1 AND o.brand_id=$2 AND o.store_id=$3 AND (o.record_json->>'sourceStatus')='Open' AND ($4::uuid IS NULL OR o.source_id>$4::uuid) AND NOT EXISTS (SELECT 1 FROM platform_projection.order_exception_source f WHERE f.tenant_id=o.tenant_id AND f.brand_id=o.brand_id AND f.store_id=o.store_id AND f.source_id=o.source_id AND (f.record_json->>'sourceStatus')='Final') ORDER BY o.source_id,o.source_version DESC LIMIT $5",
        [ownerScope.tenantReference, scope.brandReference, scope.storeReference, null, 101],
      );
      const text = JSON.stringify(plan.rows[0]);
      assert.ok(
        text.includes("order_exception_source_final_idx"),
        "the open read checks the final versions by index",
      );
      // Measured 2026-10-17: 102 statements (scope, 3 open, 25 resolved, two business days),
      // whatever the 520 resolved cases behind them.
      assert.ok(firstQueries <= 130, "the exception read took " + firstQueries + " statements");

      // WP-2423 (outage-reads-and-retry): two Payment reconciliation differences (charges that
      // match no order). When PostgreSQL refuses the detail read of one of them, the page still
      // lists every case and the other card keeps its detail; only the refused one says its
      // details could not be loaded. Before, the read of each one on its own ran in the cases'
      // transaction, already aborted (25P02), and the whole page answered "unavailable".
      const differences = [id(2100), id(2101)];
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
        [scope.brandReference, scope.storeReference],
      );
      for (const [index, reference] of differences.entries()) {
        await admin.query(
          "INSERT INTO rms_payment.payment_reconciliation_exception (reconciliation_exception_id,brand_id,store_id,candidate_id,reason,severity,status,opened_at) VALUES ($1,$2,$3,$4,'AmountMismatch','Error','Open',now())",
          [reference, scope.brandReference, scope.storeReference, id(2200 + index)],
        );
        const opened = new Date(Date.now() - minutes(20 + index)).toISOString();
        await insert(
          record(2100 + index, 1, "Open", {
            sourceReference: reference,
            kind: "PaymentReconciliationDifference",
            severity: "High",
            orderReference: null,
            paymentReference: null,
            providerState: "Unknown",
            compensationStatus: "NotRequested",
            createdAt: opened,
            updatedAt: opened,
          }),
        );
      }
      const detailOf = (page, reference) =>
        page.items.find((item) => item.exceptionReference === reference)?.reconciliation;
      const whole = await read(session.sessionCookie);
      for (const reference of differences)
        assert.deepEqual(detailOf(whole, reference), { type: "UnmatchedCharge" });
      assert.deepEqual(unexpected, []);
      breakReconciliation = differences[0];
      let partly;
      try {
        partly = await read(session.sessionCookie);
      } finally {
        breakReconciliation = null;
      }
      assert.deepEqual(
        partly.items.map((item) => item.exceptionReference),
        whole.items.map((item) => item.exceptionReference),
      );
      assert.deepEqual(detailOf(partly, differences[0]), { type: "Unavailable" });
      assert.deepEqual(detailOf(partly, differences[1]), { type: "UnmatchedCharge" });
      // The failed reads are logged as detail reads, with PostgreSQL's code (the batch, then the
      // refused one on its own).
      assert.deepEqual(
        unexpected.map(([what, error]) => [what, error?.code ?? error?.cause?.code ?? null]),
        [
          ["ReconciliationDetail", "42P01"],
          ["ReconciliationDetail", "42P01"],
        ],
      );
      unexpected.length = 0;

      // WP-2423 (outage-reads-and-retry): the business day a confirmed refund's check is due at
      // the end of is read after the cases, each day in a transaction of its own. When PostgreSQL
      // cancels an earlier day's read at the statement timeout, the page still lists every case:
      // that case is due at today's start (the latest its day could have ended), the others keep
      // theirs. Before, the read ran on in the cases' aborted transaction (25P02) and the whole
      // page answered "unavailable" whenever a refund was waiting for its check.
      const dueOf = (page) =>
        new Map(page.items.map((item) => [item.exceptionReference, item.dueAt]));
      const todayStart = businessDayEnd(
        new Date(Date.parse(businessDayEnd(now())) - 25 * 3_600_000).toISOString(),
      );
      breakDayAt = earlierOpened;
      let withoutEarlierDay;
      try {
        withoutEarlierDay = await read(session.sessionCookie);
      } finally {
        breakDayAt = null;
      }
      assert.deepEqual(
        withoutEarlierDay.items.map((item) => item.exceptionReference),
        whole.items.map((item) => item.exceptionReference),
      );
      const partDue = dueOf(withoutEarlierDay);
      assert.equal(partDue.get(id(2000)), businessDayEnd(todayOpened));
      assert.equal(partDue.get(id(2001)), todayStart);
      assert.equal(
        partDue.get(id(2002)),
        new Date(Date.parse(unconfirmedOpened) + minutes(15)).toISOString(),
      );
      for (const reference of differences)
        assert.deepEqual(detailOf(withoutEarlierDay, reference), { type: "UnmatchedCharge" });
      // When today's business day can't be read either, every case keeps its 15-minute due time.
      breakDayAt = "now";
      let withoutToday;
      try {
        withoutToday = await read(session.sessionCookie);
      } finally {
        breakDayAt = null;
      }
      assert.deepEqual(
        withoutToday.items.map((item) => item.exceptionReference),
        whole.items.map((item) => item.exceptionReference),
      );
      const noDayDue = dueOf(withoutToday);
      for (const [n, opened] of [
        [2000, todayOpened],
        [2001, earlierOpened],
        [2002, unconfirmedOpened],
      ])
        assert.equal(noDayDue.get(id(n)), new Date(Date.parse(opened) + minutes(15)).toISOString());
      // Each cancelled day read is logged as a refund-check day (Store answers its own code for a
      // business day it could not read; PostgreSQL's 57014 is not passed through).
      const postgresCode = (error) => {
        for (let at = error, depth = 0; at && depth < 6; at = at.cause, depth++)
          if (typeof at.code === "string" && /^[0-9A-Z]{5}$/u.test(at.code)) return at.code;
        return error instanceof Error ? error.message : null;
      };
      assert.deepEqual(
        unexpected.map(([what, error]) => [what, postgresCode(error)]),
        [
          ["RefundCheckDue", "STORE_BUSINESS_DATE_UNAVAILABLE"],
          ["RefundCheckDue", "STORE_BUSINESS_DATE_UNAVAILABLE"],
        ],
      );
    } finally {
      await admin.query("RESET ROLE").catch(() => undefined);
      for (const name of [api, worker])
        await admin
          .query("DROP OWNED BY " + name + " CASCADE")
          .then(() => admin.query("DROP ROLE " + name))
          .catch(() => undefined);
      await admin.end();
    }
  });
});
