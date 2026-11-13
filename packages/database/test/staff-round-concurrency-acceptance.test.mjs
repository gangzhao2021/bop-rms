import assert from "node:assert/strict";
import { setTimeout } from "node:timers";
import pg from "pg";
import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";
import { createPostgresStaffDiningRoundTableTurnStore } from "../../rms/ordering/src/index.ts";

const { Client } = pg;
const id = (n) => "01a0fd00-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * Every statement this process sends, per connection, while recording is on: to read the order a
 * round's own transaction takes its locks in.
 */
const recording = { on: false, statements: [] };
const clientQuery = pg.Client.prototype.query;
const connections = new WeakMap();
let connectionCount = 0;
pg.Client.prototype.query = function (config, ...rest) {
  const text = typeof config === "string" ? config : config?.text;
  if (recording.on && typeof text === "string") {
    if (!connections.has(this)) connections.set(this, (connectionCount += 1));
    const values = (typeof config === "string" ? rest[0] : config?.values) ?? [];
    recording.statements.push({ connection: connections.get(this), text, values });
  }
  return clientQuery.call(this, config, ...rest);
};
/** Each transaction's statements, in the order its connection sent them. */
function transactionsOf(statements) {
  const open = new Map();
  const done = [];
  for (const statement of statements) {
    const { connection, text } = statement;
    const head = text.trimStart();
    if (/^BEGIN\b/iu.test(head)) {
      open.set(connection, [statement]);
      continue;
    }
    const current = open.get(connection);
    if (current === undefined) continue;
    current.push(statement);
    if (/^(COMMIT|ROLLBACK)\b/iu.test(head)) {
      done.push(current);
      open.delete(connection);
    }
  }
  return done;
}

/**
 * v15 b12 staff-round-concurrency (DEC-STAFF-ROUND-ONE-AT-A-TIME). Two staff, each on their own
 * tablet, send a round for the same table at the same moment, one dish each. On v15 one tablet
 * was told "Nothing was sent to the kitchen or charged" (503) while its dish stayed in the table's
 * shared cart; the other tablet then showed that dish as the guests' and sent it, and the first
 * tablet's retry added its dish again: three dishes charged for two ordered.
 *
 * Everything runs through the pilot's real staff round composition (`createInternalCounterOrder`)
 * on its transaction runner (createTenantTransactionRunner) under the restricted NOBYPASSRLS API
 * role holding the rendered pilot ACL, with two real staff sessions. The only test hook holds each
 * round just before it puts its dish in the table's cart until the other round got there too (or
 * a moment passed), so both are inside the send at once, as two tablets pressed together are.
 * Synthetic TEST references only.
 */
it("two staff send a round for one table at once: each dish goes out once, every answer is true", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_round_twice" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_rtg");
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayFirst" });
      const { soup, tableReference, reference } = store;
      const permissions = ["ordering.order.create_staff", "dining.operate", "dining.session.close"];
      const first = await store.staff(id(0x710), permissions);
      const second = await store.staff(id(0x711), permissions);
      // Both rounds reach the table's cart together: each waits there for the other (or 1.5 s).
      let arrived = 0;
      const waiting = [];
      const together = async () => {
        arrived += 1;
        if (arrived >= 2) for (const release of waiting.splice(0)) release();
        else
          await new Promise((resolve) => {
            waiting.push(resolve);
            setTimeout(resolve, 1500);
          });
      };
      const tablet = async (who) =>
        store.counterFor(who, {
          decorateStaffRoundPipeline: (real) => ({
            ...real,
            addItem: async (...values) => {
              await together();
              return real.addItem(...values);
            },
          }),
        });
      const a = await tablet(first);
      const b = await tablet(second);
      // The party is seated on the Tables page (Dining's own start command).
      const seated = await store.seatTable(first);
      assert.equal(seated.status, "Issued");
      const diningSessionReference = String(seated.session.diningSessionReference);
      const round = (counter, who) =>
        counter.staffDiningRound({
          sessionCookie: who.sessionCookie,
          csrf: who.csrf,
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
      recording.statements = [];
      recording.on = true;
      let answers;
      try {
        answers = await Promise.allSettled([round(a, first), round(b, second)]);
      } finally {
        recording.on = false;
      }
      // Each tablet's answer is the truth: its round was placed (one waited for the other),
      // never "nothing was sent" while its dish stays in the table's cart.
      assert.deepEqual(
        answers.map((answer) =>
          answer.status === "fulfilled"
            ? [answer.value.status, answer.value.totalMinor]
            : ["Refused", answer.reason?.code],
        ),
        [
          ["Placed", "735"],
          ["Placed", "735"],
        ],
      );
      const [one, two] = answers.map((answer) => answer.value);
      assert.equal(one.orderReference, two.orderReference);
      assert.notEqual(one.orderBatchReference, two.orderBatchReference);
      // Two rounds of one dish each: two dishes ordered, two on the table's order, none left in
      // its cart to go out again.
      const rounds = (
        await admin.query(
          `SELECT b.order_batch_id::text AS batch,
             (SELECT coalesce(sum(i.quantity),0)::int FROM rms_ordering.order_item i
               WHERE i.order_batch_id=b.order_batch_id) AS dishes
           FROM rms_ordering.order_batch b WHERE b.order_id=$1 ORDER BY b.submitted_at`,
          [one.orderReference],
        )
      ).rows;
      assert.deepEqual(
        rounds.map((row) => row.dishes),
        [1, 1],
      );
      assert.deepEqual(
        new Set(rounds.map((row) => row.batch)),
        new Set([one.orderBatchReference, two.orderBatchReference]),
      );
      const [{ left }] = (
        await admin.query(
          `SELECT count(*)::int AS left FROM rms_ordering.cart_line l
           JOIN rms_ordering.cart c ON c.cart_id=l.cart_id WHERE c.dining_session_id=$1`,
          [diningSessionReference],
        )
      ).rows;
      assert.equal(left, 0);
      // The rounds took turns at the table: two turns, each ended with a row by its own placed
      // round (v15 b12 review: the next round's check never looks for it among sent rounds).
      const turns = (
        await admin.query(
          `SELECT t.actor_id::text AS actor,
             (SELECT string_agg(e.outcome,',') FROM rms_ordering.staff_dining_round_table_turn_end e
               WHERE e.turn_id=t.turn_id) AS ended
           FROM rms_ordering.staff_dining_round_table_turn t WHERE t.table_id=$1 ORDER BY t.begun_at`,
          [tableReference],
        )
      ).rows;
      assert.equal(turns.length, 2);
      assert.deepEqual(new Set(turns.map((turn) => turn.actor)), new Set([id(0x710), id(0x711)]));
      assert.deepEqual(
        turns.map((turn) => turn.ended),
        ["Placed", "Placed"],
      );
      // A turn whose end could not be written is over once its round exists: the round is found
      // by its table guest through an index, never by reading the Store's sent rounds.
      const [{ indexed }] = (
        await admin.query(
          `SELECT count(*)::int AS indexed FROM pg_indexes WHERE schemaname='rms_ordering'
            AND indexname IN ('order_batch_submitted_by_actor_idx','staff_dining_round_table_turn_operation_idx')`,
        )
      ).rows;
      assert.equal(indexed, 2);

      // The later round (a further round of the table's order) locks the stock it uses before
      // the Store's audit chain, as the opening round does: a round taking them in the other order
      // deadlocked against stock commands under load on v15 (05:47:41Z).
      // Within one transaction: the stock items it locks only after it appended to the audit
      // chain (an item it locked before is held already and never waited for).
      const lockOrders = transactionsOf(recording.statements)
        .map((statements) => {
          const audit = statements.findIndex(({ text }) =>
            /platform_audit\.audit_chain_head/u.test(text),
          );
          const items = (from, to) =>
            statements
              .slice(from, to)
              .filter(({ text }) =>
                /FROM rms_inventory\.inventory_item\b[\s\S]*FOR UPDATE/u.test(text),
              )
              .map(({ values }) => String(values[2]));
          const before = new Set(items(0, audit < 0 ? statements.length : audit));
          return {
            audit,
            additional: statements.some(({ text }) =>
              /INSERT INTO rms_ordering\.additional_dining_batch_record/u.test(text),
            ),
            lockedBefore: before.size,
            lockedAfter: audit < 0 ? [] : items(audit).filter((item) => !before.has(item)),
          };
        })
        .filter(
          (found) => found.audit >= 0 && (found.lockedBefore > 0 || found.lockedAfter.length > 0),
        );
      assert.ok(
        lockOrders.some((found) => found.additional),
        "the later round's own transaction locks stock and appends to the audit chain",
      );
      for (const found of lockOrders)
        assert.deepEqual(
          found.lockedAfter,
          [],
          "a transaction appended to the audit chain before it locked stock: " +
            JSON.stringify(found),
        );

      // A third tablet's round while the table's turn is held by a round that never finished
      // (its tablet lost the connection): refused as busy at once, nothing put in the cart.
      const held = reference();
      const heldOperation = reference();
      await store.asApi((tx) =>
        tx.query(
          `INSERT INTO rms_ordering.staff_dining_round_table_turn
           (turn_id,brand_id,store_id,table_id,operation_id,actor_id,begun_at,held_until)
           SELECT $1,$2,$3,$4,$5,$6,date_trunc('milliseconds',clock_timestamp()),
            date_trunc('milliseconds',clock_timestamp())+interval '2 minutes'`,
          [
            held,
            store.ownerScope.brandReference,
            store.ownerScope.storeReference,
            tableReference,
            heldOperation,
            id(0x710),
          ],
        ),
      );
      const third = await store.staff(id(0x712), permissions);
      const c = await store.counterFor(third);
      const busy = await round(c, third).then(
        (value) => assert.fail("expected the table to be busy, got " + value.status),
        (error) => error,
      );
      assert.equal(busy.code, "STAFF_ROUND_TABLE_BUSY");
      const [{ lines, entries }] = (
        await admin.query(
          `SELECT (SELECT count(*)::int FROM rms_ordering.cart_line l JOIN rms_ordering.cart c
             ON c.cart_id=l.cart_id WHERE c.dining_session_id=$1) AS lines,
           (SELECT count(*)::int FROM rms_ordering.staff_dining_round_entry) AS entries`,
          [diningSessionReference],
        )
      ).rows;
      assert.deepEqual({ lines, entries }, { lines: 0, entries: 2 });
      // Once that turn is ended, the table takes the next round.
      await store.asApi((tx) =>
        tx.query(
          `INSERT INTO rms_ordering.staff_dining_round_table_turn_end (turn_id,brand_id,store_id,ended_at,outcome)
           VALUES ($1,$2,$3,date_trunc('milliseconds',clock_timestamp()),'Unknown')`,
          [held, store.ownerScope.brandReference, store.ownerScope.storeReference],
        ),
      );
      const next = await round(c, third);
      assert.deepEqual([next.status, next.totalMinor], ["Placed", "735"]);
      // v15 b12 review: the same command sent again reads how its turns ended, as the pilot API
      // role: one that ended without knowing is never answered "send it again".
      const turnStore = createPostgresStaffDiningRoundTableTurnStore({
        brandReference: store.ownerScope.brandReference,
        storeReference: store.ownerScope.storeReference,
        authorize: async () => true,
      });
      assert.deepEqual(
        await store.asApi(async (tx) => [
          await turnStore.outcomeOf(tx, heldOperation),
          await turnStore.outcomeOf(tx, reference()),
        ]),
        ["Undecided", "None"],
      );
      // The turn records are append-only, also for the pilot API role.
      await assert.rejects(
        store.asApi((tx) =>
          tx.query("DELETE FROM rms_ordering.staff_dining_round_table_turn WHERE turn_id=$1", [
            held,
          ]),
        ),
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
      recording.on = false;
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
