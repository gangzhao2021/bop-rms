import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import process from "node:process";
import pg from "pg";
import { it, vi } from "vitest";
import { withPaidBatchAcceptance } from "../../../apps/api/src/merchant-card-machine-payment.ts";
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
 * in under 2 s, however many rounds the table already has. On v15 a round took 1.85–3.9 s on a
 * quiet table and grew with the rounds on the table (1.9 s to 9.4 s): about 4,150 statements a
 * round, and 3 more for every round already on the Order (each round's acceptance read on its own).
 *
 * Under the restricted NOBYPASSRLS pilot role, on the pilot's own transaction runner
 * (createTenantTransactionRunner) and the pilot's staff round composition: twelve rounds on one
 * pay-each-round table, each charged on the card machine and accepted, as a real Store does.
 * - Statement guard: each round is held to 2,500 statements (4,136 before), and from the third
 *   round on every round costs the same (before: 3 more a round).
 * - Time: the median round, Send to the card machine's amount, is under 2 s on this machine.
 * The 2 s on v15 itself is shown by the live check after the deploy.
 */
const roundBudget = 2500;
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
        counting.count = 0;
        counting.on = true;
        const started = performance.now();
        let result;
        try {
          result = await counter.staffDiningRound({
            ...as,
            command: {
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
            },
          });
        } finally {
          counting.on = false;
        }
        rounds.push({
          round,
          statements: counting.count,
          ms: Math.round(performance.now() - started),
        });
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
      const times = rounds.map((cost) => cost.ms).sort((a, b) => a - b);
      const median = (times[5] + times[6]) / 2;
      assert.ok(median < 2000, "median round " + median + " ms: " + JSON.stringify(rounds));
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
