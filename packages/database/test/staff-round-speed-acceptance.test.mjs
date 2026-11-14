import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import process from "node:process";
import pg from "pg";
import { it, vi } from "vitest";
import { withPaidBatchAcceptance } from "../../../apps/api/src/merchant-card-machine-payment.ts";
import { currentRequestChecks, withVerifiedChecks } from "../src/request-check-memo.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01a0ff00-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * Every statement this process sends to PostgreSQL while one staff round is sent (the
 * per-connection SET ROLE this test's pool adds is not counted: the pilot logs in as its role).
 */
const counting = { on: false, count: 0 };
const clientQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (config, ...rest) {
  const text = typeof config === "string" ? config : config?.text;
  if (counting.on && !(typeof text === "string" && text.startsWith("SET ROLE ")))
    counting.count += 1;
  return clientQuery.call(this, config, ...rest);
};

/**
 * WP-2423 M35 (DEC-STAFF-ROUND-SPEED, third step): a staff round reaches the card machine's amount
 * in under 2 s, the opening round and every later one, however many rounds the table already has.
 * On v15 a round took 1.85–3.9 s on a quiet table and grew with the rounds on the table (1.9 s to
 * 9.4 s): about 4,150 statements a round, and 3 more for every round already on the Order (each
 * round's acceptance read on its own). After the first cut (2,281 statements) the opening round
 * still took 2.1–2.4 s here at load 7–9; the review cut single-read transactions (each BEGIN,
 * read, COMMIT) of the guest's cart now answered from the request's own check, and scope settings
 * sent as round trips of their own (now with BEGIN): about 2,180 statements a later round. What
 * is left grows with the dishes in a round (about 500 statements a dish: the menu, availability,
 * recipe and stock snapshot reads, each switching the Store scope off and on again).
 *
 * Under the restricted NOBYPASSRLS pilot role, on the pilot's own transaction runner
 * (createTenantTransactionRunner) and the pilot's staff round composition: twelve rounds on one
 * pay-each-round table, each charged on the card machine and accepted, as a real Store does; and
 * the opening round on another Store's free table once the process is warm.
 * - Statement guard: each round is held to 2,250 statements (4,136 before), and from the third
 *   round on every round costs the same (before: 3 more a round).
 * - Time: every round, Send to the card machine's amount, is under 2 s on this machine (the
 *   slowest round, not the median). This times the pilot's command, not the HTTP route and the
 *   browser up to the Charge heading; v15's live check times that whole path.
 * - The checks a read-only transaction answered from earlier in the round that a later write of the
 *   round followed without reading them again (request-check-memo `unverifiedChecks`) are exactly
 *   the reviewed guest checks below (docs/spec/design/table-round-states-batch5.md, "Checks a
 *   round reuses"): a new one fails here until it is reviewed.
 */
const reviewedGuestChecks = [
  // The table guest's Guest Session (two reads, the same first line).
  "SELECT jsonb_build_object(",
  // The Brand and the Store, active.
  "SELECT * FROM bop_tenant.brand WHERE brand_id=$1 FOR SHARE",
  "SELECT * FROM bop_tenant.store WHERE brand_id=$1 AND store_id=$2 FOR SHARE",
  // The table, the guest's place at it, and whether the guest was readmitted.
  'SELECT table_snapshot AS "table" FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND tab',
  "SELECT s.session_snapshot AS session,p.participant_snapshot AS participant,t.table_snapshot AS table,a.admission_snapsho",
  "SELECT 1 FROM rms_dining.dining_participant_readmission WHERE brand_id=$1 AND store_id=$2 AND from_guest_session_id=$3",
  "SELECT s.session_snapshot AS session,p.participant_snapshot AS participant,t.table_snapshot AS table FROM rms_dining.din",
].sort();
const roundBudget = 2250;
/** The opening round seats the party and sends two dishes: about 500 statements a dish. */
const openingBudget = 2750;
const roundMs = 2000;
/** One staff round as one request (the pilot's own wrapper joins this one), timed and counted. */
async function timedRound(counter, as, command) {
  counting.count = 0;
  counting.on = true;
  const started = performance.now();
  let unverified = null;
  let result;
  try {
    result = await withVerifiedChecks(async () => {
      const value = await counter.staffDiningRound({ ...as, command });
      unverified = currentRequestChecks()?.unverifiedChecks() ?? null;
      return value;
    });
  } finally {
    counting.on = false;
  }
  return {
    result,
    cost: {
      statements: counting.count,
      ms: Math.round(performance.now() - started),
      unverified,
    },
  };
}
it("twelve staff rounds on one table each reach the card machine's amount under the budget, at the same cost", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_round_speed" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_rsp");
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayFirst" });
      const { soup, tableReference, reference } = store;
      const server = await store.staff(id(0x710), [
        "ordering.order.create_staff",
        "dining.operate",
        "dining.session.close",
      ]);
      const counter = await store.counterFor(server);
      const pay = withPaidBatchAcceptance(counter.cardMachinePayment, {
        accept: await store.acceptanceFor(server),
        nextReference: reference,
      });
      const as = { sessionCookie: server.sessionCookie, csrf: server.csrf };
      const rounds = [];
      let orderReference = null;
      for (let round = 1; round <= 12; round += 1) {
        const { result, cost } = await timedRound(counter, as, {
          operationReference: reference(),
          tableReference,
          tip: { kind: "None" },
          recordedAfterOutage: false,
          lines: [
            {
              sellableReference: soup.skuReference,
              quantity: 1,
              optionSelections: [],
              note: null,
            },
          ],
        });
        rounds.push({ round, ...cost });
        // The same table Order, a new round, its exact amount to charge.
        assert.equal(result.status, "Placed");
        assert.equal(result.payLater, false);
        assert.equal(result.totalMinor, "735");
        orderReference ??= result.orderReference;
        assert.equal(result.orderReference, orderReference);
        // Charged on the card machine and accepted, so the next round finds it on the table.
        const paid = await pay({
          ...as,
          command: {
            operationReference: reference(),
            orderReference: result.orderReference,
            orderBatchReference: result.orderBatchReference,
            expectedTotalMinor: result.totalMinor,
            slipReference: "AUTH 771204",
            takenAt: null,
          },
        });
        assert.deepEqual([paid.status, paid.acceptance], ["Recorded", "Accepted"]);
      }
      if (process.env.WP2423_COST_LOG)
        await appendFile(
          process.env.WP2423_COST_LOG,
          "staff rounds on one table " + JSON.stringify(rounds) + "\n",
        );
      const [{ batches }] = (
        await admin.query(
          "SELECT count(*)::int AS batches FROM rms_ordering.order_batch WHERE order_id=$1",
          [orderReference],
        )
      ).rows;
      assert.equal(batches, 12);
      for (const cost of rounds)
        assert.ok(
          cost.statements <= roundBudget,
          "round " +
            cost.round +
            " ran " +
            cost.statements +
            " statements (budget " +
            roundBudget +
            ")",
        );
      // O(1) in the rounds already on the table.
      const later = rounds.slice(2).map((cost) => cost.statements);
      assert.ok(
        Math.max(...later) - later[0] <= 3,
        "a later round costs more as rounds pile up: " + JSON.stringify(later),
      );
      // Every round, the opening one included: the slowest, not the median.
      const slowest = Math.max(...rounds.map((cost) => cost.ms));
      assert.ok(slowest < roundMs, "slowest round " + slowest + " ms: " + JSON.stringify(rounds));
      for (const cost of rounds)
        assert.deepEqual(
          [...cost.unverified].sort(),
          reviewedGuestChecks,
          "round " + cost.round + " reuses a check nobody reviewed",
        );
      // The restricted role is what ran all this.
      assert.deepEqual(
        await store.asApi(
          async (tx) =>
            (
              await tx.query(
                "SELECT current_user AS who,(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass",
                [],
              )
            ).rows[0],
        ),
        { who: api, bypass: false },
      );
    } finally {
      vi.unstubAllEnvs();
      if (store !== null) await store.close();
      for (const name of [api, api + "_w"]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});

it("the opening round on a free table reaches the card machine's amount under the budget", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_round_open" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_rso");
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayFirst" });
      const { soup, tableReference, reference } = store;
      const server = await store.staff(id(0x720), [
        "ordering.order.create_staff",
        "dining.operate",
        "dining.session.close",
      ]);
      const counter = await store.counterFor(server);
      const as = { sessionCookie: server.sessionCookie, csrf: server.csrf };
      // The opening round: the table is free, the round seats the party (opens the table, its
      // session and its code) and sends two dishes, as v15's opening rounds did.
      const { result, cost } = await timedRound(counter, as, {
        operationReference: reference(),
        tableReference,
        tip: { kind: "None" },
        recordedAfterOutage: false,
        lines: [
          { sellableReference: soup.skuReference, quantity: 1, optionSelections: [], note: null },
          { sellableReference: soup.skuReference, quantity: 1, optionSelections: [], note: null },
        ],
      });
      if (process.env.WP2423_COST_LOG)
        await appendFile(
          process.env.WP2423_COST_LOG,
          "opening round on a free table " + JSON.stringify(cost) + "\n",
        );
      assert.deepEqual(
        [result.status, result.payLater, result.totalMinor],
        ["Placed", false, "1469"],
      );
      assert.ok(cost.statements <= openingBudget, "opening round " + JSON.stringify(cost));
      assert.ok(cost.ms < roundMs, "opening round " + JSON.stringify(cost));
      assert.deepEqual(
        [...cost.unverified].sort(),
        reviewedGuestChecks,
        "the opening round reuses a check nobody reviewed",
      );
    } finally {
      vi.unstubAllEnvs();
      if (store !== null) await store.close();
      for (const name of [api, api + "_w"]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});

/**
 * WP-2423 (rush-connection-hold, integration of batch 16): no step of a table's opening staff round
 * holds one of the API pool's connections while it takes a second. Since batch 16 such a second acquire is
 * answered busy at once when no connection is free, so in a rush any nested one fails the round
 * ("couldn't send, try again") however long the pool would have taken. The checkout's stock check
 * used to open the guest's access transaction from inside the stock read's snapshot. On a pool of
 * one connection, every second acquire made while holding one is refused, so the round only
 * completes when each step gives its connection back before the next takes one. (A later round's
 * current checks still read the menu in their own snapshots inside the round's write transaction:
 * open in WP-2423, rush-connection-hold integration.)
 */
it("an opening staff round is sent on a pool of one connection: no step takes a second while it holds one", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_round_one" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_rs1");
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({
        admin,
        context,
        api,
        paymentTiming: "PayFirst",
        apiPool: { max: 1, acquireBudgetMs: 5000 },
      });
      const { soup, tableReference, reference } = store;
      const server = await store.staff(id(0x730), [
        "ordering.order.create_staff",
        "dining.operate",
        "dining.session.close",
      ]);
      const counter = await store.counterFor(server);
      const as = { sessionCookie: server.sessionCookie, csrf: server.csrf };
      // The opening round: it seats the party and checks two dishes' stock, one at a time.
      const { result } = await timedRound(counter, as, {
        operationReference: reference(),
        tableReference,
        tip: { kind: "None" },
        recordedAfterOutage: false,
        lines: [
          { sellableReference: soup.skuReference, quantity: 1, optionSelections: [], note: null },
          { sellableReference: soup.skuReference, quantity: 1, optionSelections: [], note: null },
        ],
      });
      assert.deepEqual([result.status, result.totalMinor], ["Placed", "1469"]);
    } finally {
      vi.unstubAllEnvs();
      if (store !== null) await store.close();
      for (const name of [api, api + "_w"]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
