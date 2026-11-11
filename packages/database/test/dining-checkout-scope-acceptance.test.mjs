import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { setTimeout as sleep } from "node:timers/promises";
import { it } from "vitest";
import {
  chooseDiningCheckoutScope,
  createPostgresCartQueryStore,
  createPostgresOrderCreationStore,
  extendDiningCheckoutScope,
  readDiningCheckoutScopeState,
  readForeignDiningCheckoutScope,
  returnDiningWaitingLines,
} from "../../rms/ordering/src/index.ts";
import { orderWriteFixture } from "../../rms/ordering/src/tests/order-creation-store.fixture.ts";
import { seedSubmissionCart } from "../test-support/dining-order-submission-seed.mjs";
import { grantPilotApiAcl } from "../test-support/pilot-api-acl.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const hashIntent = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const later = (at, ms) => new Date(Date.parse(at) + ms).toISOString();

/**
 * One pay-first table with two phones, A (the fixture's phone) and B. The fixture's own round (A's
 * dish, cart version 5) is the round A pays; the table cart is seeded one version earlier holding
 * A's dish and B's dishes, so A's choice produces exactly that round's version.
 */
function table(namespace, { bQuantity = 1, aQuantity, agoMs = 1000 } = {}) {
  const at = new Date(Date.now() - agoMs).toISOString();
  const f = orderWriteFixture({
    namespace,
    at,
    dineIn: true,
    ...(aQuantity === undefined ? {} : { quantity: aQuantity }),
  });
  const id = (n) => namespace + "-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const lineA = f.cart.items[0];
  const phoneA = {
    diningSessionReference: String(f.cart.diningSessionReference),
    guestSessionReference: String(lineA.addedByActorReference),
    participantReference: String(lineA.addedByParticipantReference),
  };
  const phoneB = {
    diningSessionReference: phoneA.diningSessionReference,
    guestSessionReference: id(0x7b1),
    participantReference: id(0x7b2),
  };
  const lineB = {
    ...lineA,
    cartItemReference: id(0x7b3),
    quantity: bQuantity,
    customerNote: "Less spicy",
    addedByActorReference: phoneB.guestSessionReference,
    addedByParticipantReference: phoneB.participantReference,
    addedAt: later(lineA.addedAt, 60_000),
  };
  const seeded = {
    ...f,
    cart: {
      ...f.cart,
      aggregateVersion: f.cart.aggregateVersion - 1,
      updatedAt: later(f.cart.updatedAt, -60_000),
      items: [lineA, lineB],
    },
  };
  return { f, at, id, lineA, lineB, phoneA, phoneB, seeded };
}

/**
 * WP-2423 shared-table-checkout (a), 2000_520 (DEC-OWNER-DEFAULTS-2026-11-06 同桌结账: 默认付全桌,
 * 只付我加的, 选几道菜帮别人付), as the restricted pilot API role (rendered pilot ACL, NOBYPASSRLS):
 * at a pay-first table phone A pays only what A added. B's dish waits while A pays: B can't quote,
 * record details or start a checkout of that cart (checkout_scope_held, also refused by the
 * database), nor take the dish back. When B chooses at the same instant one choice wins. A's round
 * is the fixture's real order submission: it orders A's dish only and empties the cart; B's dish
 * then comes back once, as a new line with B as adder, note and quantity unchanged. A dish is never
 * both ordered and waiting; nothing is updated or deleted; another Store sees nothing.
 */
it("WP-2423 (shared-table-checkout): at a pay-first table A pays only what A added and B's dish comes back once after A's round", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_scope_mine" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_scope_" + context.runId;
    try {
      await admin.query(
        "CREATE ROLE " + api + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await grantPilotApiAcl(admin, api);
      const connect = async () => {
        const client = new Client(context.clientConfig);
        await client.connect();
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + api);
        return client;
      };
      const inTransaction = async (action) => {
        const client = await connect();
        try {
          const value = await action({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      };
      const { f, at, id, lineA, lineB, phoneA, phoneB, seeded } = table("01902520");
      await seedSubmissionCart(admin, seeded);
      const scope = f.scope;
      const cartReference = String(f.cart.cartReference);
      let n = 0x900;
      const next = () => id(++n);
      const audit = (actionCode, when) => ({
        auditId: next(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode,
        targetType: "OrderingCart",
        targetId: cartReference,
        reasonCode: "AUTHORIZED_CART_MUTATION",
        correlationId: next(),
        occurredAt: when,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      });
      const choose = (phone, operation, when, change = {}) => ({
        operationReference: id(operation),
        cartReference,
        expectedCartVersion: seeded.cart.aggregateVersion,
        choice: "Mine",
        lines: [],
        actor: phone,
        observedAt: when,
        hashIntent,
        newReference: next,
        audit: audit("ORDERING_CART_CHECKOUT_SCOPE", when),
        heldByOther: async () => null,
        ...change,
      });
      const giveBack = (phone, operation, when, action = "Return") => ({
        operationReference: id(operation),
        action,
        actor: phone,
        observedAt: when,
        newReference: next,
        audit: audit("ORDERING_CART_WAITING_RETURN", when),
        heldByOther: async () => null,
      });
      // A chooses at the instant the fixture's round was priced (its quote and checkout validation
      // were captured for the cart at that instant).
      const chosenAt = String(f.cart.updatedAt);
      // A details record written straight to the table (the database's own fence, whatever the
      // API answered first); rolled back so nothing of it stays.
      const tryDetails = async (phone) => {
        const client = await connect();
        try {
          await client.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          const details = next();
          await client.query(
            `INSERT INTO rms_ordering.checkout_details_record (brand_id,store_id,details_id,details_version,
               operation_id,guest_session_id,cart_id,snapshot_json,recorded_at)
             VALUES ($1,$2,$3,1,$4,$5,$6,$7::jsonb,$8)`,
            [
              scope.brandReference,
              scope.storeReference,
              details,
              next(),
              phone.guestSessionReference,
              cartReference,
              JSON.stringify({
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                detailsReference: details,
                detailsVersion: 1,
                guestSessionReference: phone.guestSessionReference,
                cartReference,
                recordedAt: chosenAt,
              }),
              chosenAt,
            ],
          );
          return "written";
        } catch (error) {
          return error.message;
        } finally {
          await client.query("ROLLBACK");
          await client.end();
        }
      };

      // A and B choose "only what I added" at the same instant: A's choice holds the cart row
      // while B's waits on it; B then finds the cart changed (B's phone reads it again) and,
      // choosing on what it now shows, that A is paying: refused, nothing written.
      const holder = await connect();
      let bOutcome;
      try {
        const chosen = await chooseDiningCheckoutScope(
          { query: (sql, values) => holder.query(sql, [...values]) },
          scope,
          choose(phoneA, 1, chosenAt),
        );
        assert.equal(chosen.status, "Chosen");
        assert.equal(chosen.cartVersion, f.cart.aggregateVersion);
        assert.equal(chosen.setAsideUnits, lineB.quantity);
        assert.equal(chosen.expiresAt, later(chosenAt, 5 * 60_000));
        bOutcome = inTransaction((tx) =>
          chooseDiningCheckoutScope(tx, scope, choose(phoneB, 2, later(chosenAt, 1))),
        ).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        for (let attempt = 0; ; attempt += 1) {
          const waiting = await admin.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM rms_ordering.cart WHERE%FOR UPDATE%'",
          );
          if (waiting.rows[0].n > 0) break;
          assert.ok(attempt < 200, "B's choice never waited for the cart lock");
          await sleep(50);
        }
        await holder.query("COMMIT");
      } finally {
        await holder.end();
      }
      const b = await bOutcome;
      assert.equal(b.error?.code, "CART_VERSION_CONFLICT", JSON.stringify(b.value));
      const bAgain = await inTransaction((tx) =>
        chooseDiningCheckoutScope(
          tx,
          scope,
          choose(phoneB, 2, later(chosenAt, 2), { expectedCartVersion: f.cart.aggregateVersion }),
        ),
      ).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      assert.equal(bAgain.error?.code, "CART_CHECKOUT_IN_PROGRESS", JSON.stringify(bAgain.value));
      assert.equal(bAgain.error?.heldUntil, later(chosenAt, 5 * 60_000));
      const counts = async () =>
        (
          await admin.query(
            `SELECT (SELECT count(*)::int FROM rms_ordering.dining_checkout_scope WHERE cart_id=$1) AS scopes,
               (SELECT count(*)::int FROM rms_ordering.dining_cart_waiting_line WHERE cart_id=$1) AS waiting,
               (SELECT count(*)::int FROM rms_ordering.dining_cart_waiting_line_resolution WHERE cart_id=$1) AS returned,
               (SELECT aggregate_version FROM rms_ordering.cart WHERE cart_id=$1) AS version`,
            [cartReference],
          )
        ).rows[0];
      assert.deepEqual(await counts(), {
        scopes: 1,
        waiting: 1,
        returned: 0,
        version: f.cart.aggregateVersion,
      });
      // The cart is exactly A's round; B's dish waits, copied exactly.
      const carts = createPostgresCartQueryStore({ run: inTransaction }, scope);
      const round = await carts.load(cartReference);
      assert.deepEqual(
        round.items.map((item) => [item.cartItemReference, item.quantity]),
        [[lineA.cartItemReference, lineA.quantity]],
      );
      const state = await inTransaction((tx) =>
        readDiningCheckoutScopeState(tx, scope, {
          diningSessionReference: phoneA.diningSessionReference,
          observedAt: later(chosenAt, 1000),
        }),
      );
      assert.equal(state.live?.chooserParticipantReference, phoneA.participantReference);
      assert.equal(state.live?.choice, "Mine");
      assert.deepEqual(
        state.waiting.map((line) => [
          line.sellableReference,
          line.quantity,
          line.addedByParticipantReference,
        ]),
        [[String(lineB.sellableReference), lineB.quantity, phoneB.participantReference]],
      );

      // checkout_scope_held: B is kept from paying this version; A isn't. The database refuses
      // B's details too.
      const foreign = (phone, when) =>
        inTransaction((tx) =>
          readForeignDiningCheckoutScope(tx, scope, {
            cartReference,
            cartVersion: f.cart.aggregateVersion,
            participantReference: phone.participantReference,
            observedAt: when,
          }),
        );
      assert.deepEqual(await foreign(phoneB, later(chosenAt, 1000)), {
        heldUntil: later(chosenAt, 5 * 60_000),
        reserved: true,
      });
      assert.equal(await foreign(phoneA, later(chosenAt, 1000)), null);
      assert.match(await tryDetails(phoneB), /CHECKOUT_SCOPE_HELD/u);
      assert.equal(await tryDetails(phoneA), "written");
      // B can't take the dish back while A pays, nor can a checkout hold be ignored.
      await assert.rejects(
        inTransaction((tx) =>
          returnDiningWaitingLines(tx, scope, giveBack(phoneB, 3, later(chosenAt, 2000))),
        ),
        { code: "CART_CHECKOUT_IN_PROGRESS" },
      );
      // Only A keeps the dishes longer.
      assert.deepEqual(
        await inTransaction((tx) =>
          extendDiningCheckoutScope(tx, scope, {
            operationReference: id(4),
            actor: phoneB,
            observedAt: later(chosenAt, 3000),
          }),
        ),
        { status: "NotLive" },
      );
      assert.deepEqual(await counts(), {
        scopes: 1,
        waiting: 1,
        returned: 0,
        version: f.cart.aggregateVersion,
      });

      // A's round is ordered (the real submission): A's dish only, the cart empties.
      const runner = { run: inTransaction };
      // TEST-ONLY: the synthetic round's snapshot carries the cart's idle deadline as the fixture
      // fixed it; the choice moved it on by the Store's idle timeout. Align that one clock field
      // so the fixture's own snapshot matches (the dishes and version are the choice's).
      await admin.query("UPDATE rms_ordering.cart SET idle_expires_at=$2 WHERE cart_id=$1", [
        cartReference,
        f.cart.lifecycle.idleExpiresAt,
      ]);
      const created = await createPostgresOrderCreationStore(runner, scope).append(f.request);
      assert.equal(created.status, "Created");
      const ordered = (
        await admin.query(
          "SELECT source_cart_line_id::text AS line FROM rms_ordering.order_item i JOIN rms_ordering.order_batch b ON b.order_batch_id=i.order_batch_id WHERE b.source_cart_id=$1",
          [cartReference],
        )
      ).rows.map((row) => row.line);
      assert.deepEqual(ordered, [String(lineA.cartItemReference)]);
      const after = await carts.load(cartReference);
      assert.equal(after.aggregateVersion, f.cart.aggregateVersion + 1);
      assert.equal(after.items.length, 0);
      // The scope ended with the round; B may now pay, and B's phone gives its dish back.
      assert.equal(await foreign(phoneB, later(at, 1000)), null);
      assert.equal(await tryDetails(phoneB), "written");
      const returnedAt = later(at, 2000);
      const back = await inTransaction((tx) =>
        returnDiningWaitingLines(tx, scope, giveBack(phoneB, 5, returnedAt)),
      );
      assert.deepEqual(back, {
        status: "Returned",
        cartVersion: f.cart.aggregateVersion + 2,
        returnedUnits: lineB.quantity,
      });
      const restored = await carts.load(cartReference);
      assert.equal(restored.items.length, 1);
      const dish = restored.items[0];
      assert.notEqual(dish.cartItemReference, lineB.cartItemReference);
      assert.equal(dish.addedByParticipantReference, phoneB.participantReference);
      assert.equal(dish.addedByActorReference, phoneB.guestSessionReference);
      assert.equal(dish.addedAt, lineB.addedAt);
      assert.equal(dish.quantity, lineB.quantity);
      assert.equal(dish.customerNote, lineB.customerNote);
      assert.deepEqual(dish.optionSelections, lineB.optionSelections);
      assert.equal(
        (
          await admin.query(
            "SELECT reason_code FROM rms_ordering.dining_cart_waiting_line_resolution WHERE cart_id=$1",
            [cartReference],
          )
        ).rows[0].reason_code,
        "RoundSent",
      );
      // A retry with the same operation answers the same; a second phone finds nothing to return.
      assert.deepEqual(
        await inTransaction((tx) =>
          returnDiningWaitingLines(tx, scope, giveBack(phoneB, 5, later(returnedAt, 1))),
        ),
        back,
      );
      assert.deepEqual(
        await inTransaction((tx) =>
          returnDiningWaitingLines(tx, scope, giveBack(phoneA, 6, later(returnedAt, 2))),
        ),
        { status: "NothingToReturn", cartVersion: f.cart.aggregateVersion + 2 },
      );
      assert.deepEqual(await counts(), {
        scopes: 1,
        waiting: 1,
        returned: 1,
        version: f.cart.aggregateVersion + 2,
      });

      // The database keeps each dish in one life: a second return, a waiting copy of an ordered
      // dish, and any change or deletion of the history are refused.
      const asApi = (sql, values) =>
        inTransaction(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          return tx.query(sql, values);
        });
      const waitingRow = (
        await admin.query(
          "SELECT waiting_line_id::text AS line, scope_id::text AS scope, recorded_at FROM rms_ordering.dining_cart_waiting_line WHERE cart_id=$1",
          [cartReference],
        )
      ).rows[0];
      await assert.rejects(
        asApi(
          `INSERT INTO rms_ordering.dining_cart_waiting_line_resolution (waiting_line_id,brand_id,store_id,cart_id,
             cart_version,resolution,returned_cart_line_id,reason_code,operation_id,guest_session_id,occurred_at,audit_id)
           VALUES ($1,$2,$3,$4,$5,'Returned',$6,'CartChanged',$7,$8,$9,$10)`,
          [
            waitingRow.line,
            scope.brandReference,
            scope.storeReference,
            cartReference,
            f.cart.aggregateVersion + 2,
            next(),
            next(),
            phoneB.guestSessionReference,
            later(returnedAt, 5),
            next(),
          ],
        ),
      );
      await assert.rejects(
        asApi(
          `INSERT INTO rms_ordering.dining_cart_waiting_line (waiting_line_id,brand_id,store_id,dining_session_id,
             cart_id,scope_id,origin_cart_line_id,origin_quantity,sellable_id,quantity,option_selections_json,
             customer_note,catalog_selection_evidence_json,added_by_actor_id,added_by_participant_id,added_at,recorded_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$10::jsonb,NULL,NULL,$11,$12,$13,$14)`,
          [
            next(),
            scope.brandReference,
            scope.storeReference,
            phoneA.diningSessionReference,
            cartReference,
            waitingRow.scope,
            lineA.cartItemReference,
            lineA.quantity,
            lineA.sellableReference,
            JSON.stringify(lineA.optionSelections),
            lineA.addedByActorReference,
            lineA.addedByParticipantReference,
            lineA.addedAt,
            waitingRow.recorded_at,
          ],
        ),
        /an ordered dish cannot wait for another round/u,
      );
      for (const table of [
        "dining_checkout_scope",
        "dining_cart_waiting_line",
        "dining_cart_waiting_line_resolution",
      ]) {
        // The pilot role holds no UPDATE or DELETE at all; even the owner is refused.
        await assert.rejects(
          asApi(`DELETE FROM rms_ordering.${table} WHERE brand_id=$1`, [scope.brandReference]),
          /permission denied/u,
        );
        await assert.rejects(
          asApi(`UPDATE rms_ordering.${table} SET brand_id=brand_id WHERE brand_id=$1`, [
            scope.brandReference,
          ]),
          /permission denied/u,
        );
        await assert.rejects(
          admin.query(`DELETE FROM rms_ordering.${table} WHERE brand_id=$1`, [
            scope.brandReference,
          ]),
          /append-only/u,
        );
        await assert.rejects(
          admin.query(`UPDATE rms_ordering.${table} SET brand_id=brand_id WHERE brand_id=$1`, [
            scope.brandReference,
          ]),
          /append-only/u,
        );
      }
      // Another Store of the Brand sees none of it.
      const otherStore = await inTransaction(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, id(0xabc)],
        );
        return (
          await tx.query(
            `SELECT (SELECT count(*)::int FROM rms_ordering.dining_checkout_scope) +
               (SELECT count(*)::int FROM rms_ordering.dining_checkout_scope_extension) +
               (SELECT count(*)::int FROM rms_ordering.dining_cart_waiting_line) +
               (SELECT count(*)::int FROM rms_ordering.dining_cart_waiting_line_resolution) AS n`,
            [],
          )
        ).rows[0].n;
      });
      assert.equal(otherStore, 0);
    } finally {
      await admin.end();
    }
  });
});

/**
 * WP-2423 shared-table-checkout (a), 2000_520: A picks dishes for this round, one of A's two and
 * one of B's three; the other units wait. B is kept out for 5 minutes, and for 5 more after A taps
 * "Keep them"; once that runs out with nobody paying, B's phone gives every waiting unit back (the
 * database still refuses B's checkout of A's version until then), each once and as a new line. A's
 * next choice ends when A goes back ("Back to cart"): nothing was charged, every dish is back.
 * Units are never lost or doubled.
 */
it("WP-2423 (shared-table-checkout): A picks dishes, keeps them longer, and every dish comes back when the reservation runs out or A goes back", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_scope_chosen" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_scopec_" + context.runId;
    try {
      await admin.query(
        "CREATE ROLE " + api + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await grantPilotApiAcl(admin, api);
      const inTransaction = async (action) => {
        const client = new Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + api);
          const value = await action({ query: (sql, values) => client.query(sql, [...values]) });
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          await client.end();
        }
      };
      // Set 20 minutes back, so the reservation can run out by the clock without waiting.
      const { f, id, lineA, lineB, phoneA, phoneB, seeded } = table("01902530", {
        aQuantity: 2,
        bQuantity: 3,
        agoMs: 20 * 60_000,
      });
      await seedSubmissionCart(admin, seeded);
      const scope = f.scope;
      const cartReference = String(f.cart.cartReference);
      let n = 0x900;
      const next = () => id(++n);
      const audit = (actionCode, when) => ({
        auditId: next(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode,
        targetType: "OrderingCart",
        targetId: cartReference,
        reasonCode: "AUTHORIZED_CART_MUTATION",
        correlationId: next(),
        occurredAt: when,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      });
      const giveBack = (phone, operation, when, action = "Return") => ({
        operationReference: id(operation),
        action,
        actor: phone,
        observedAt: when,
        newReference: next,
        audit: audit("ORDERING_CART_WAITING_RETURN", when),
        heldByOther: async () => null,
      });
      const carts = createPostgresCartQueryStore({ run: inTransaction }, scope);
      const units = (cart) => cart.items.reduce((total, item) => total + item.quantity, 0);
      const t0 = new Date(Date.now() - 15 * 60_000).toISOString();
      assert.ok(t0 > seeded.cart.updatedAt);
      const pick = (
        operation,
        when,
        lines,
        version = seeded.cart.aggregateVersion,
        change = {},
      ) => ({
        operationReference: id(operation),
        cartReference,
        expectedCartVersion: version,
        choice: "Chosen",
        lines,
        actor: phoneA,
        observedAt: when,
        hashIntent,
        newReference: next,
        audit: audit("ORDERING_CART_CHECKOUT_SCOPE", when),
        heldByOther: async () => null,
        ...change,
      });
      // More units than the dish has, or a dish not in the cart: refused, nothing written.
      await assert.rejects(
        inTransaction((tx) =>
          chooseDiningCheckoutScope(
            tx,
            scope,
            pick(1, t0, [{ cartItemReference: lineB.cartItemReference, quantity: 4 }]),
          ),
        ),
        { code: "CART_INPUT_INVALID" },
      );
      // Everything chosen is simply the whole cart: nothing set aside, nothing written.
      assert.deepEqual(
        await inTransaction((tx) =>
          chooseDiningCheckoutScope(
            tx,
            scope,
            pick(2, t0, [
              { cartItemReference: lineA.cartItemReference, quantity: 2 },
              { cartItemReference: lineB.cartItemReference, quantity: 3 },
            ]),
          ),
        ),
        { status: "WholeCart", cartVersion: seeded.cart.aggregateVersion },
      );
      // Another participant's checkout already holds the cart: refused.
      await assert.rejects(
        inTransaction((tx) =>
          chooseDiningCheckoutScope(
            tx,
            scope,
            pick(3, t0, [{ cartItemReference: lineA.cartItemReference, quantity: 1 }], undefined, {
              heldByOther: async () => later(t0, 60_000),
            }),
          ),
        ),
        { code: "CART_CHECKOUT_IN_PROGRESS" },
      );
      // A dining hold that can't be read is an outage, never a refusal.
      await assert.rejects(
        inTransaction((tx) =>
          chooseDiningCheckoutScope(
            tx,
            scope,
            pick(4, t0, [{ cartItemReference: lineA.cartItemReference, quantity: 1 }], undefined, {
              heldByOther: async () => {
                throw new Error("dining down");
              },
            }),
          ),
        ),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      const before = await carts.load(cartReference);
      assert.equal(before.aggregateVersion, seeded.cart.aggregateVersion);
      assert.equal(units(before), 5);

      // One of A's two and one of B's three for this round (A pays for B's too).
      const chosen = await inTransaction((tx) =>
        chooseDiningCheckoutScope(
          tx,
          scope,
          pick(5, t0, [
            { cartItemReference: lineA.cartItemReference, quantity: 1 },
            { cartItemReference: lineB.cartItemReference, quantity: 1 },
          ]),
        ),
      );
      assert.equal(chosen.status, "Chosen");
      assert.equal(chosen.setAsideUnits, 3);
      const round = await carts.load(cartReference);
      assert.deepEqual(
        round.items.map((item) => [item.cartItemReference, item.quantity]).sort(),
        [
          [lineA.cartItemReference, 1],
          [lineB.cartItemReference, 1],
        ].sort(),
      );
      // The same tap again (a lost answer) answers the same, writing nothing.
      assert.deepEqual(
        await inTransaction((tx) =>
          chooseDiningCheckoutScope(
            tx,
            scope,
            pick(5, later(t0, 10), [
              { cartItemReference: lineA.cartItemReference, quantity: 1 },
              { cartItemReference: lineB.cartItemReference, quantity: 1 },
            ]),
          ),
        ),
        chosen,
      );
      // B is kept out at 1 minute; A keeps them at 4 minutes, so B is still kept out at 6.
      await assert.rejects(
        inTransaction((tx) =>
          returnDiningWaitingLines(tx, scope, giveBack(phoneB, 10, later(t0, 60_000))),
        ),
        { code: "CART_CHECKOUT_IN_PROGRESS" },
      );
      const kept = await inTransaction((tx) =>
        extendDiningCheckoutScope(tx, scope, {
          operationReference: id(11),
          actor: phoneA,
          observedAt: later(t0, 4 * 60_000),
        }),
      );
      assert.deepEqual(kept, { status: "Extended", expiresAt: later(t0, 9 * 60_000) });
      await assert.rejects(
        inTransaction((tx) =>
          returnDiningWaitingLines(tx, scope, giveBack(phoneB, 12, later(t0, 6 * 60_000))),
        ),
        (error) => error.code === "CART_CHECKOUT_IN_PROGRESS" && error.heldUntil === kept.expiresAt,
      );
      // Run out (nobody paid): B is no longer "reserved" against, but still can't pay A's version
      // until the dishes are back; B's phone gives them back, each once, as new lines.
      const expired = later(t0, 10 * 60_000);
      const foreign = await inTransaction((tx) =>
        readForeignDiningCheckoutScope(tx, scope, {
          cartReference,
          cartVersion: chosen.cartVersion,
          participantReference: phoneB.participantReference,
          observedAt: expired,
        }),
      );
      assert.equal(foreign?.reserved, false);
      const back = await inTransaction((tx) =>
        returnDiningWaitingLines(tx, scope, giveBack(phoneB, 13, expired)),
      );
      assert.deepEqual(back, {
        status: "Returned",
        cartVersion: chosen.cartVersion + 1,
        returnedUnits: 3,
      });
      const restored = await carts.load(cartReference);
      assert.equal(units(restored), 5);
      assert.equal(restored.items.length, 4);
      assert.equal(
        restored.items
          .filter((item) => item.addedByParticipantReference === phoneB.participantReference)
          .reduce((total, item) => total + item.quantity, 0),
        3,
      );
      assert.deepEqual(
        (
          await admin.query(
            "SELECT DISTINCT reason_code FROM rms_ordering.dining_cart_waiting_line_resolution WHERE cart_id=$1",
            [cartReference],
          )
        ).rows,
        [{ reason_code: "ScopeExpired" }],
      );
      // Keeping a choice that is no longer live does nothing.
      assert.deepEqual(
        await inTransaction((tx) =>
          extendDiningCheckoutScope(tx, scope, {
            operationReference: id(14),
            actor: phoneA,
            observedAt: later(expired, 1000),
          }),
        ),
        { status: "NotLive" },
      );

      // A chooses again, then goes back: A's own choice ends at once; nothing was charged.
      const again = await inTransaction((tx) =>
        chooseDiningCheckoutScope(
          tx,
          scope,
          pick(
            15,
            later(expired, 2000),
            [{ cartItemReference: lineA.cartItemReference, quantity: 1 }],
            restored.aggregateVersion,
          ),
        ),
      );
      assert.equal(again.status, "Chosen");
      // B can't end A's choice by asking to "cancel" it.
      await assert.rejects(
        inTransaction((tx) =>
          returnDiningWaitingLines(tx, scope, giveBack(phoneB, 16, later(expired, 3000), "Cancel")),
        ),
        { code: "CART_CHECKOUT_IN_PROGRESS" },
      );
      const cancelled = await inTransaction((tx) =>
        returnDiningWaitingLines(tx, scope, giveBack(phoneA, 17, later(expired, 4000), "Cancel")),
      );
      assert.equal(cancelled.status, "Returned");
      const final = await carts.load(cartReference);
      assert.equal(units(final), 5);
      assert.ok(
        (
          await admin.query(
            "SELECT reason_code FROM rms_ordering.dining_cart_waiting_line_resolution WHERE operation_id=$1",
            [id(17)],
          )
        ).rows.every((row) => row.reason_code === "PayerCancelled"),
      );
      // Each waiting unit resolved exactly once.
      const totals = (
        await admin.query(
          `SELECT count(*)::int AS waiting,
             (SELECT count(*)::int FROM rms_ordering.dining_cart_waiting_line_resolution r WHERE r.cart_id=$1) AS returned
           FROM rms_ordering.dining_cart_waiting_line w WHERE w.cart_id=$1`,
          [cartReference],
        )
      ).rows[0];
      assert.equal(totals.waiting, totals.returned);
    } finally {
      await admin.end();
    }
  });
});
