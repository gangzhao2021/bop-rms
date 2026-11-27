import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { withPaidBatchAcceptance } from "../../../apps/api/src/merchant-card-machine-payment.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01a0ff00-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * While armed: once a round's preparation has read the table's Order for its checkout (the parent
 * read), the next transaction any connection begins first waits for `move()`, a real change of that
 * Order committed by another staff member. So the Order moves on between the round's read and its
 * preparation's own check, as when the System took an expired unpaid round off at expiry + 5 s on
 * v15 (12:18:48Z, 12:20:13Z).
 */
const race = { armed: false, pending: false, moving: false, moved: 0, move: null };
const clientQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (config, ...rest) {
  const text = typeof config === "string" ? config : config?.text;
  if (
    race.armed &&
    race.pending &&
    !race.moving &&
    typeof text === "string" &&
    /^BEGIN\b/iu.test(text.trimStart())
  ) {
    race.pending = false;
    race.armed = false;
    race.moving = true;
    return race
      .move()
      .then(() => (race.moved += 1))
      .finally(() => (race.moving = false))
      .then(() => clientQuery.call(this, config, ...rest));
  }
  const sent = clientQuery.call(this, config, ...rest);
  if (
    race.armed &&
    !race.moving &&
    typeof text === "string" &&
    text.startsWith("SELECT h.created_at,r.occurred_at AS initial_at,") &&
    typeof sent?.then === "function"
  )
    return sent.then((value) => {
      race.pending = true;
      return value;
    });
  return sent;
};

/**
 * v15 b13 order-projection-and-round-race (DEC-ROUND-PREPARED-ON-CURRENT-ORDER). At a pay-first
 * Store a staff round sent while the table's Order moved on (the System took an expired unpaid
 * round off) answered 503 "Nothing was sent... Send it once more" in 2 of 9 timed sends: the
 * round's preparation refused because the Order was no longer at the version it had read.
 *
 * Everything runs through the pilot's real staff round composition under the restricted NOBYPASSRLS
 * API role with the rendered pilot ACL, with real staff sessions. The Order moves on by a real
 * Ordering revision committed between the round's parent read and its preparation's check: another
 * staff member records the table's first round as paid on the card machine and it is accepted
 * (the System's expiry cancellation needs its 30-minute payment window to pass, which an isolated
 * test cannot wait for; it changes the Order the same way, a new Order revision). The round goes
 * through on the Order as it is now: Placed, its exact amount, one dish, the table's cart empty
 * and the table's turn ended by the placed round. Synthetic TEST references only.
 */
it("a staff round sent while the table's Order moves on goes through on the fresh Order", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_round_moved" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_rmv");
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayFirst" });
      const { soup, tableReference, reference } = store;
      const permissions = ["ordering.order.create_staff", "dining.operate", "dining.session.close"];
      const server = await store.staff(id(0x710), permissions);
      const cashier = await store.staff(id(0x711), permissions);
      const counter = await store.counterFor(server);
      const till = await store.counterFor(cashier);
      const pay = withPaidBatchAcceptance(till.cardMachinePayment, {
        accept: await store.acceptanceFor(cashier),
        nextReference: reference,
      });
      const round = () =>
        counter.staffDiningRound({
          sessionCookie: server.sessionCookie,
          csrf: server.csrf,
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
      const first = await round();
      assert.deepEqual([first.status, first.totalMinor], ["Placed", "735"]);
      // The cashier records the first round as paid on the card machine while the second is sent.
      race.move = async () => {
        const paid = await pay({
          sessionCookie: cashier.sessionCookie,
          csrf: cashier.csrf,
          command: {
            operationReference: reference(),
            orderReference: first.orderReference,
            orderBatchReference: first.orderBatchReference,
            expectedTotalMinor: first.totalMinor,
            slipReference: "AUTH 771301",
            takenAt: null,
          },
        });
        assert.deepEqual([paid.status, paid.acceptance], ["Recorded", "Accepted"]);
      };
      race.armed = true;
      let second;
      try {
        second = await round().then(
          (value) => value,
          (error) => ({ status: "Refused", code: error?.code }),
        );
      } finally {
        race.armed = false;
      }
      assert.equal(race.moved, 1, "the Order moved on while the round was being sent");
      // The first round's acceptance went in between the round's read and its check, then the
      // round itself.
      const kinds = (
        await admin.query(
          "SELECT kind FROM rms_ordering.order_revision WHERE order_id=$1 ORDER BY version",
          [first.orderReference],
        )
      ).rows.map((row) => row.kind);
      assert.deepEqual(kinds.slice(-2), ["Acceptance", "AdditionalBatch"], JSON.stringify(kinds));
      // The round went through on the Order as it is now.
      assert.deepEqual(
        [second.status, second.totalMinor],
        ["Placed", "735"],
        JSON.stringify(second),
      );
      assert.equal(second.orderReference, first.orderReference);
      assert.notEqual(second.orderBatchReference, first.orderBatchReference);
      const rounds = (
        await admin.query(
          `SELECT b.order_batch_id::text AS batch,
             (SELECT coalesce(sum(i.quantity),0)::int FROM rms_ordering.order_item i
               WHERE i.order_batch_id=b.order_batch_id) AS dishes
           FROM rms_ordering.order_batch b WHERE b.order_id=$1 ORDER BY b.submitted_at`,
          [first.orderReference],
        )
      ).rows;
      assert.deepEqual(
        rounds.map((row) => [row.batch, row.dishes]),
        [
          [first.orderBatchReference, 1],
          [second.orderBatchReference, 1],
        ],
      );
      const [{ left }] = (
        await admin.query(
          `SELECT count(*)::int AS left FROM rms_ordering.cart_line l
           JOIN rms_ordering.cart c ON c.cart_id=l.cart_id
           JOIN rms_ordering.order_header h ON h.dining_session_id=c.dining_session_id
           WHERE h.order_id=$1`,
          [first.orderReference],
        )
      ).rows;
      assert.equal(left, 0);
      const turns = (
        await admin.query(
          `SELECT (SELECT string_agg(e.outcome,',') FROM rms_ordering.staff_dining_round_table_turn_end e
               WHERE e.turn_id=t.turn_id) AS ended
           FROM rms_ordering.staff_dining_round_table_turn t WHERE t.table_id=$1 ORDER BY t.begun_at`,
          [tableReference],
        )
      ).rows;
      assert.deepEqual(
        turns.map((turn) => turn.ended),
        ["Placed", "Placed"],
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
      race.armed = false;
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
