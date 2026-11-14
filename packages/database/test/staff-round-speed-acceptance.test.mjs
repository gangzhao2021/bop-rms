import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import process from "node:process";
import pg from "pg";
import { it, vi } from "vitest";
import { withPaidBatchAcceptance } from "../../../apps/api/src/merchant-card-machine-payment.ts";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
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
/**
 * A test's step run once inside a later round's write transaction, before that transaction's own
 * current checks: it is the transaction that takes the Order's disposition fence and then reads the
 * round's saved tip choice (createCustomerAdditionalDiningSubmissionRuntime), and the step runs right
 * before that read, so after the round's pre-check and before the write's re-check reads the clock.
 * The write is READ COMMITTED: what the step commits is what a staff member or another table did
 * in that moment. `snapshots` counts the read-only snapshot checks Catalog makes from then until
 * that write transaction ends (the step's own statements are not counted).
 */
const beforeWrite = { step: null, fired: false, writer: null, snapshots: 0 };
const fenced = new WeakMap();
const clientQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function (config, ...rest) {
  const text = typeof config === "string" ? config : config?.text;
  if (counting.on && !(typeof text === "string" && text.startsWith("SET ROLE ")))
    counting.count += 1;
  const values = Array.isArray(rest[0]) ? rest[0] : config?.values;
  if (typeof text === "string") {
    if (/^\s*BEGIN\b/u.test(text)) fenced.set(this, false);
    else if (
      text.startsWith("SELECT pg_advisory_xact_lock") &&
      String(values?.[0] ?? "").startsWith("OrderingOrderDisposition:")
    )
      fenced.set(this, true);
  }
  if (beforeWrite.writer !== null && typeof text === "string") {
    if (text.includes("transaction_isolation")) beforeWrite.snapshots += 1;
    if (this === beforeWrite.writer && /^\s*(COMMIT|ROLLBACK)\b/u.test(text))
      beforeWrite.writer = null;
  }
  if (
    beforeWrite.step !== null &&
    !beforeWrite.fired &&
    fenced.get(this) === true &&
    typeof text === "string" &&
    text.includes("rms_payment.payment_tip_selection")
  ) {
    beforeWrite.fired = true;
    const step = beforeWrite.step;
    beforeWrite.step = null;
    return step().then(() => {
      beforeWrite.writer = this;
      return clientQuery.call(this, config, ...rest);
    });
  }
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
 * WP-2423 (rush-connection-hold, integration of batch 16): no step of a staff round, the opening
 * one or a later one, holds one of the API pool's connections while it takes a second. Since batch
 * 16 such a second acquire is answered busy at once when no connection is free, so in a rush any
 * nested one fails the round ("couldn't send, try again") however long the pool would have taken.
 * The checkout's stock check used to open the guest's access transaction from inside the stock
 * read's snapshot (fixed for the opening round); a later round ran its whole current check (menu,
 * availability, stock: about 11 snapshots a dish) inside its write transaction, so on v15 in a rush
 * rounds 2 and on failed (ADDITIONAL_DINING_BATCH_STORE_UNAVAILABLE). Now that check runs before
 * the write transaction, and the write only confirms on its own connection that what it read is
 * still in effect (docs/spec/design/later-round-current-checks.md). On a pool of one connection,
 * every second acquire made while holding one is refused, so the rounds only complete when each
 * step gives its connection back before the next takes one. Before the change round 2 failed here.
 */
it("three staff rounds on one table are sent on a pool of one connection: no step takes a second while it holds one", async () => {
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
      const pay = withPaidBatchAcceptance(counter.cardMachinePayment, {
        accept: await store.acceptanceFor(server),
        nextReference: reference,
      });
      // Three rounds on one table, each charged on the card machine: the first opens the table's
      // Order (it seats the party), the later ones go through the round's own write transaction.
      for (let round = 1; round <= 3; round += 1) {
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
        assert.deepEqual([result.status, result.totalMinor], ["Placed", "1469"], "round " + round);
        const paid = await pay({
          ...as,
          command: {
            operationReference: reference(),
            orderReference: result.orderReference,
            orderBatchReference: result.orderBatchReference,
            expectedTotalMinor: result.totalMinor,
            slipReference: "AUTH 771205",
            takenAt: null,
          },
        });
        assert.deepEqual(
          [paid.status, paid.acceptance],
          ["Recorded", "Accepted"],
          "round " + round,
        );
      }
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

/** Another table's rounds hold all the soup's stock left (a Reserve movement on its ledger). */
async function holdAllStock(admin, store) {
  const { tenantReference, brandReference, storeReference } = store.ownerScope;
  const account = store.stock.accountReference;
  const row = (
    await admin.query(
      "SELECT a.location_id::text AS location,b.ledger_version::int AS version,b.on_hand::numeric::text AS on_hand,b.reserved::numeric::text AS reserved FROM rms_inventory.stock_account a JOIN rms_inventory.stock_balance b USING (tenant_id,brand_id,store_id,account_id) WHERE a.account_id=$1",
      [account],
    )
  ).rows[0];
  const onHand = Number(row.on_hand),
    held = Number(row.reserved),
    quantity = String(onHand - held);
  const balance = (r, v) => ({
    onHand: String(onHand),
    reserved: String(r),
    available: String(onHand - r),
    inTransit: "0",
    unitCode: "KG",
    ledgerVersion: v,
  });
  const movement = id(0x7a0),
    audit = id(0x7a1),
    at = new Date().toISOString();
  const record = {
    movementReference: movement,
    tenantReference,
    brandReference,
    itemReference: store.stock.itemReference,
    movementType: "Reserve",
    quantityDelta: quantity,
    unitCode: "KG",
    baseQuantityDelta: quantity,
    baseUnitCode: "KG",
    conversionMultiplier: "1",
    sourceScope: null,
    destinationScope: { scopeType: "Location", scopeReference: row.location },
    lotReference: null,
    expiryDate: null,
    businessSourceType: "SYNTHETIC_RESERVE",
    businessSourceReference: id(0x7a2),
    reasonCode: "SYNTHETIC_TEST",
    performedBy: id(9),
    occurredAt: at,
    before: balance(held, row.version),
    after: balance(onHand, row.version + 1),
    auditReference: audit,
    correctsMovementReference: null,
  };
  await admin.query("BEGIN");
  try {
    await admin.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [tenantReference, brandReference, storeReference],
    );
    await admin.query(
      "INSERT INTO rms_inventory.stock_movement (tenant_id,brand_id,store_id,account_id,movement_id,ledger_version,movement_type,base_quantity_delta,record_json,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,'Reserve',$7,$8,$9,$10)",
      [
        tenantReference,
        brandReference,
        storeReference,
        account,
        movement,
        row.version + 1,
        quantity,
        record,
        audit,
        at,
      ],
    );
    await appendAuditRecordInTransaction(
      { query: (sql, values) => admin.query(sql, [...values]) },
      {
        auditId: audit,
        brandId: brandReference,
        storeId: storeReference,
        actor: { type: "User", reference: id(9) },
        actionCode: "INVENTORY_RESERVE",
        targetType: "StockMovement",
        targetId: movement,
        reasonCode: "SYNTHETIC_TEST",
        correlationId: id(0x7a3),
        occurredAt: at,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Internal",
        retentionPolicyCode: "SYNTHETIC_AUDIT",
        retentionPolicyVersion: 1,
      },
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
}

/**
 * WP-2423 (rush-connection-hold, later rounds): a later round's menu, availability and stock are
 * checked before its write transaction, so a dish can sell out in between. It is still never
 * ordered: the write re-checks on its own connection that the dish is still on sale (a staff
 * sold-out mark made since), and the round's stock reservation in the same transaction refuses
 * stock that ran out since. Each time the round is refused as "can't be sold now", nothing is
 * ordered or charged, the round's dishes leave the table's Cart, and the table can order again.
 * The race is made deterministic: the sold-out mark, or another table's hold on the last stock,
 * lands after the round's pre-check, inside its write transaction before that transaction's own
 * checks; and once it did, no read-only snapshot is opened for that round's write.
 */
it("a dish sold out or run out between a later round's pre-check and its write is refused, never ordered", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_round_race" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_rsr");
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayFirst" });
      const { soup, tableReference, reference } = store;
      const server = await store.staff(id(0x740), [
        "ordering.order.create_staff",
        "dining.operate",
        "dining.session.close",
      ]);
      const counter = await store.counterFor(server);
      const as = { sessionCookie: server.sessionCookie, csrf: server.csrf };
      const pay = withPaidBatchAcceptance(counter.cardMachinePayment, {
        accept: await store.acceptanceFor(server),
        nextReference: reference,
      });
      const round = () =>
        counter.staffDiningRound({
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
      const charge = async (result) => {
        const paid = await pay({
          ...as,
          command: {
            operationReference: reference(),
            orderReference: result.orderReference,
            orderBatchReference: result.orderBatchReference,
            expectedTotalMinor: result.totalMinor,
            slipReference: "AUTH 771206",
            takenAt: null,
          },
        });
        assert.deepEqual([paid.status, paid.acceptance], ["Recorded", "Accepted"]);
      };
      const batches = async (orderReference) =>
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_ordering.order_batch WHERE order_id=$1",
            [orderReference],
          )
        ).rows[0].n;
      const reserved = async () =>
        (
          await admin.query(
            "SELECT reserved::numeric::text AS reserved FROM rms_inventory.stock_balance WHERE account_id=$1",
            [store.stock.accountReference],
          )
        ).rows[0].reserved;
      const refusedWhen = async (step) => {
        beforeWrite.fired = false;
        beforeWrite.snapshots = 0;
        beforeWrite.step = step;
        try {
          await assert.rejects(round(), { code: "STAFF_ROUND_ITEM_UNAVAILABLE" });
          assert.equal(beforeWrite.fired, true, "the step ran before the round's write");
          assert.equal(beforeWrite.snapshots, 0, "the round's write opened a snapshot");
        } finally {
          beforeWrite.step = null;
          beforeWrite.fired = false;
          beforeWrite.writer = null;
        }
      };

      // Round 1 opens the table's Order and is charged.
      const first = await round();
      assert.equal(first.status, "Placed");
      await charge(first);
      const orderReference = first.orderReference;

      // Round 2: the kitchen marks the soup sold out after the round's pre-check found it on sale.
      const heldBefore = await reserved();
      await refusedWhen(() => store.owner.markSoldOut(soup.skuReference));
      assert.equal(await batches(orderReference), 1, "a sold-out dish was ordered");
      assert.equal(await reserved(), heldBefore, "the refused round held stock");

      // Back in stock: the next round is placed as usual.
      await store.owner.markBackInStock(soup.skuReference);
      const third = await round();
      assert.equal(third.status, "Placed");
      await charge(third);
      assert.equal(await batches(orderReference), 2);

      // Round 4: another table's rounds take the last of the soup's stock after the pre-check.
      await refusedWhen(() => holdAllStock(admin, store));
      assert.equal(await batches(orderReference), 2, "a dish with no stock left was ordered");
    } finally {
      vi.unstubAllEnvs();
      beforeWrite.step = null;
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
 * WP-2423 review of the later-round pre-check (docs/spec/design/later-round-current-checks.md): a
 * guest's later round already written is sent again (the reply was lost, or the payment start after
 * it failed). The retry is answered from the record: the same round, no second batch, no second
 * stock hold. The round's current check must not run again for it: the written round already
 * emptied the Cart and moved its version on, so a fresh check refuses what is only a replay (it did
 * before this fix: the retry failed, and a pay-first round could never get its payment started).
 * Through the pilot's own guest composition (the guest's "Continue to payment" at a pay-first table,
 * not the staff retry lookup), on a pool of one connection.
 */
it("a guest's later round sent again is answered from its record: the same round, nothing written twice", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_round_replay" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_rrp");
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({
        admin,
        context,
        api,
        paymentTiming: "PayFirst",
        apiPool: { max: 1, acquireBudgetMs: 5000 },
      });
      const { soup, tableReference, reference, now } = store;
      const server = await store.staff(id(0x750), [
        "ordering.order.create_staff",
        "dining.operate",
        "dining.session.close",
      ]);
      const as = { sessionCookie: server.sessionCookie, csrf: server.csrf };
      let pipeline = null;
      await store.counterFor(server, { decorateStaffRoundPipeline: (real) => (pipeline = real) });
      const table = await pipeline.openTable(as, { tableReference });
      assert.equal(table.status, "Opened");
      // A phone joins the table (this test's guest pipeline saves checkout details once a phone).
      const phone = async () => {
        const entered = await pipeline.enter({ tableReference, requestedAt: now() });
        assert.equal(entered.status, "Established");
        const issued = await pipeline.openTable(as, { tableReference });
        const joined = await pipeline.join(entered.credentials, {
          joinCredential: issued.joinCredential,
          operationReference: reference(),
        });
        return (
          await pipeline.bind(entered.credentials, {
            operationReference: reference(),
            admissionReference: joined.admissionReference,
          })
        ).credentials;
      };
      // One round from a guest's phone, up to its checkout.
      const checkoutOfOneSoup = async (guest) => {
        const cart = await pipeline.selectCart(guest, {
          operationReference: reference(),
          requestedAt: now(),
        });
        const added = await pipeline.addItem(guest, {
          operationReference: reference(),
          cartReference: cart.cartReference,
          expectedCartVersion: cart.cartVersion,
          sellableReference: soup.skuReference,
          quantity: 1,
          optionSelections: [],
          customerNote: null,
          requestedAt: now(),
        });
        assert.equal(added.status, "Applied");
        const current = await pipeline.selectCart(guest, {
          operationReference: reference(),
          requestedAt: now(),
        });
        const quoted = await pipeline.quote(guest, {
          operationReference: reference(),
          cartReference: current.cartReference,
          cartVersion: current.cartVersion,
          requestedAt: now(),
        });
        assert.equal(quoted.status, "Quoted");
        await pipeline.saveDetails(guest, {
          operationReference: reference(),
          detailsReference: reference(),
          cartReference: current.cartReference,
          cartVersion: current.cartVersion,
          quoteReference: quoted.quoteReference,
        });
        const checkout = await pipeline.startCheckout(guest, {
          createOperationReference: reference(),
          cartReference: current.cartReference,
          cartVersion: current.cartVersion,
          quoteReference: quoted.quoteReference,
        });
        assert.equal(checkout.status, "Started");
        return {
          checkoutSessionReference: checkout.checkoutSessionReference,
          selectionReference: reference(),
          tip: { amountMinor: 0n, currencyCode: "CAD" },
          recordedAfterOutage: false,
        };
      };
      // "Continue to payment" (a pay-first table): each round is written unpaid and its payment
      // prepared; the first phone's opens the table's Order, the second phone's is a later round.
      const opener = await phone();
      await pipeline.preparePayment(opener, await checkoutOfOneSoup(opener));
      const guest = await phone();
      const later = await checkoutOfOneSoup(guest);
      const sent = await pipeline.preparePayment(guest, later);
      const written = async () =>
        (
          await admin.query(
            `SELECT (SELECT count(*)::int FROM rms_ordering.additional_dining_batch_record) AS rounds,
               (SELECT count(*)::int FROM rms_ordering.order_batch) AS batches,
               (SELECT count(*)::int FROM platform_audit.audit_record
                  WHERE action_code='ORDERING_ADDITIONAL_BATCH_SUBMIT') AS audits,
               (SELECT count(*)::int FROM platform_eventing.outbox_event) AS events`,
          )
        ).rows[0];
      const after = await written();
      assert.equal(after.rounds, 1);
      assert.equal(after.batches, 2);
      // Sent again, with the same checkout and choice: the same round, answered from its record.
      // (The preparation's own reference names this answer, not a record: each answer has its own.)
      const again = await pipeline.preparePayment(guest, later);
      const facts = (value) => ({ ...value, preparationReference: null });
      assert.deepEqual(facts(again), facts(sent));
      assert.deepEqual(await written(), after, "a replayed round wrote again");
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
