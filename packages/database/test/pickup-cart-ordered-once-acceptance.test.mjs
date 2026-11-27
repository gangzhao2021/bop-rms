import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresCartOrderLookup,
  createPostgresCartQueryStore,
  createPostgresOrderCreationStore,
} from "../../rms/ordering/src/index.ts";
import { orderWriteFixture } from "../../rms/ordering/src/tests/order-creation-store.fixture.ts";
import { seedSubmissionCart } from "../test-support/dining-order-submission-seed.mjs";
import { grantPilotApiAcl } from "../test-support/pilot-api-acl.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const id = (n) => "01902423-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 M03 (simulation blocker; v15 orders 13 and 14 from one Cart version, both paid): a pickup
 * Cart is ordered once. The Order's own transaction empties the Cart and moves it to its next
 * version; a repeat of the same submission returns the original Order; a lookup names the Order the
 * dishes went to (also for a Cart filled before this change, through its lines); and the database
 * refuses a second submission of the same Cart version from any writer. Everything under test runs
 * as a restricted NOBYPASSRLS role holding exactly the rendered pilot API grants; the Cart, its
 * lines and the legacy repeat are seeded by the owner client (labelled test data).
 */
it("WP-2423 M03: a pickup Cart version produces one Order, its Cart is emptied, a second is refused", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_ordered_once" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_once_" + context.runId;
    try {
      await admin.query(
        "CREATE ROLE " + api + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await grantPilotApiAcl(admin, api);
      const runner = {
        async run(action) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query("BEGIN");
            await client.query("SET LOCAL ROLE " + api);
            await client.query("SET LOCAL statement_timeout='20s'");
            const value = await action({ query: (sql, values) => client.query(sql, [...values]) });
            await client.query("COMMIT");
            return value;
          } catch (error) {
            await client.query("ROLLBACK");
            throw error;
          } finally {
            await client.end();
          }
        },
      };
      const at = new Date(Date.now() - 1000).toISOString();
      const f = orderWriteFixture({ namespace: "01902423", at });
      // Review: another, different submission of the same Cart version (a second tab, a stale page).
      const second = orderWriteFixture({ namespace: "01902423", at, submission: 1 });
      assert.notEqual(
        second.request.record.submissionReference,
        f.request.record.submissionReference,
      );
      assert.equal(second.cart.aggregateVersion, f.cart.aggregateVersion);
      assert.equal(f.cart.orderType, "Pickup");
      await seedSubmissionCart(admin, f);
      const version = f.cart.aggregateVersion;
      const line = f.cart.items[0].cartItemReference;
      const guest = f.request.record.guestSessionReference;
      const counts = async () =>
        (
          await admin.query(
            `SELECT (SELECT count(*)::int FROM rms_ordering.order_header) AS orders,
              (SELECT count(*)::int FROM rms_ordering.order_submission_record) AS submissions,
              (SELECT count(*)::int FROM rms_ordering.order_item) AS items,
              (SELECT count(*)::int FROM rms_ordering.cart_line WHERE cart_id=$1) AS lines,
              (SELECT aggregate_version FROM rms_ordering.cart WHERE cart_id=$1) AS version,
              (SELECT lifecycle_status FROM rms_ordering.cart WHERE cart_id=$1) AS status`,
            [f.cart.cartReference],
          )
        ).rows[0];

      // 1. The Order is created and its pickup Cart is empty at the next version, still usable.
      const store = createPostgresOrderCreationStore(runner, f.scope);
      const created = await store.append(f.request);
      assert.equal(created.status, "Created");
      assert.deepEqual(await counts(), {
        orders: 1,
        submissions: 1,
        items: f.cart.items.length,
        lines: 0,
        version: version + 1,
        status: "Active",
      });
      assert.deepEqual(
        (
          await admin.query("SELECT source_cart_line_id FROM rms_ordering.order_item ORDER BY 1")
        ).rows.map((row) => row.source_cart_line_id),
        f.cart.items.map((item) => item.cartItemReference).sort(),
      );
      const current = await createPostgresCartQueryStore(runner, f.scope).load(
        f.cart.cartReference,
      );
      assert.equal(current.aggregateVersion, version + 1);
      assert.deepEqual(current.items, []);

      // 2. A repeat of the same submission (lost answer, double tap) returns the same Order.
      const replay = await store.append(f.request);
      assert.equal(replay.status, "Existing");
      assert.deepEqual(replay.record, created.record);
      assert.equal((await counts()).orders, 1);

      // 3. The lookup names the Order these dishes went to; the emptied Cart says so to its guest.
      const lookup = createPostgresCartOrderLookup(runner, f.scope);
      const orderNumber = created.record.orderNumberAllocation.orderNumber;
      assert.deepEqual(
        await lookup.findVersion({ cartReference: f.cart.cartReference, cartVersion: version }),
        {
          submissionReference: f.request.record.submissionReference,
          orderReference: created.record.order.orderReference,
          orderNumber,
          guestSessionReference: guest,
          sourceCartVersion: version,
          notMade: false,
        },
      );
      assert.equal(
        await lookup.findVersion({ cartReference: f.cart.cartReference, cartVersion: version + 1 }),
        null,
      );
      assert.equal(
        (
          await lookup.findLatest({
            cartReference: f.cart.cartReference,
            guestSessionReference: guest,
          })
        )?.orderNumber,
        orderNumber,
      );
      assert.equal(
        await lookup.findLatest({
          cartReference: f.cart.cartReference,
          guestSessionReference: id(1),
        }),
        null,
      );
      // Another Store sees nothing of it.
      const otherStore = createPostgresCartOrderLookup(runner, {
        brandReference: f.scope.brandReference,
        storeReference: id(2),
      });
      assert.equal(
        await otherStore.findVersion({ cartReference: f.cart.cartReference, cartVersion: version }),
        null,
      );

      // 3b. Review: the Order store itself refuses a second, different submission of this Cart
      // version (the second of two tabs that lost the race finds the Cart already moved on) with
      // "already ordered" naming the guest's Order: never an outage, nothing written.
      const before = await counts();
      await assert.rejects(store.append(second.request), (error) => {
        assert.equal(error.code, "ORDER_CREATE_ALREADY_ORDERED");
        assert.deepEqual(error.placedOrder, {
          orderReference: created.record.order.orderReference,
          orderNumber,
        });
        return true;
      });
      assert.deepEqual(await counts(), before);

      // 4. The database refuses a second submission of the same Cart version from any writer.
      const insertSubmission = (submission, cartVersion) =>
        runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [f.scope.brandReference, f.scope.storeReference],
          );
          await tx.query(
            `INSERT INTO rms_ordering.order_submission_record
             (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at)
             SELECT $1,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,$2,quote_id,created_at
             FROM rms_ordering.order_submission_record WHERE submission_id=$3`,
            [submission, cartVersion, f.request.record.submissionReference],
          );
        });
      await assert.rejects(insertSubmission(id(10), version), {
        code: "23505",
        message: "CART_VERSION_ALREADY_ORDERED",
      });
      // Another version passes this guard (and is stopped only by the one-row-per-Order rule).
      await assert.rejects(insertSubmission(id(11), version + 1), (error) => {
        assert.equal(error.code, "23505");
        assert.equal(error.constraint, "order_submission_initial_order_unique");
        return true;
      });
      assert.equal((await counts()).submissions, 1);

      // 5. A Cart filled before this change kept its ordered line: the lookup still finds the
      // Order through the line, at the Cart's current version, so checkout refuses it too.
      await admin.query(
        `INSERT INTO rms_ordering.cart_line
         (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,customer_note,
          catalog_selection_evidence_json,added_by_actor_id,added_by_participant_id,added_at)
         SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12`,
        [
          line,
          f.cart.cartReference,
          f.cart.brandReference,
          f.cart.storeReference,
          f.cart.items[0].sellableReference,
          f.cart.items[0].quantity,
          JSON.stringify(f.cart.items[0].optionSelections),
          f.cart.items[0].customerNote,
          JSON.stringify(f.cart.items[0].catalogSelectionEvidence),
          f.cart.items[0].addedByActorReference,
          f.cart.items[0].addedByParticipantReference,
          f.cart.items[0].addedAt,
        ],
      );
      assert.equal(
        (
          await lookup.findVersion({
            cartReference: f.cart.cartReference,
            cartVersion: version + 1,
          })
        )?.orderReference,
        created.record.order.orderReference,
      );

      // 5b. Review: the same legacy Cart still at the ordered version (it was never moved on). A
      // second, different submission locks the Cart and is refused by the store, naming the Order.
      await admin.query("UPDATE rms_ordering.cart SET aggregate_version=$2 WHERE cart_id=$1", [
        f.cart.cartReference,
        version,
      ]);
      const legacy = await counts();
      assert.equal(legacy.version, version);
      await assert.rejects(store.append(second.request), (error) => {
        assert.equal(error.code, "ORDER_CREATE_ALREADY_ORDERED");
        assert.equal(error.placedOrder?.orderNumber, orderNumber);
        return true;
      });
      assert.deepEqual(await counts(), legacy);
      await admin.query("UPDATE rms_ordering.cart SET aggregate_version=$2 WHERE cart_id=$1", [
        f.cart.cartReference,
        version + 1,
      ]);

      // 5c. Review: once that Order will not be made (its payment closed unpaid), its dishes still
      // in the Cart may be ordered again from the moved-on Cart, and the emptied Cart says the
      // Order closed (so the page offers its dishes back), while the exact version stays ordered.
      await admin.query(
        `INSERT INTO rms_ordering.order_payment_failure_record
         (failure_record_id,brand_id,store_id,order_id,payment_transaction_id,payment_intent_id,
          payment_attempt_id,payment_event_id,reason,retry_disposition,terminal_occurred_at,event_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Cancelled','Never',date_trunc('milliseconds',now()),$9)`,
        [
          id(30),
          f.cart.brandReference,
          f.cart.storeReference,
          created.record.order.orderReference,
          id(31),
          id(32),
          id(33),
          id(34),
          "sha256:" + "b".repeat(64),
        ],
      );
      assert.equal(
        await lookup.findVersion({ cartReference: f.cart.cartReference, cartVersion: version + 1 }),
        null,
      );
      assert.equal(
        (await lookup.findVersion({ cartReference: f.cart.cartReference, cartVersion: version }))
          ?.notMade,
        true,
      );
      await admin.query("DELETE FROM rms_ordering.cart_line WHERE cart_line_id=$1", [line]);
      assert.deepEqual(
        await lookup.findLatest({
          cartReference: f.cart.cartReference,
          guestSessionReference: guest,
        }),
        {
          submissionReference: f.request.record.submissionReference,
          orderReference: created.record.order.orderReference,
          orderNumber,
          guestSessionReference: guest,
          sourceCartVersion: version,
          notMade: true,
        },
      );
      assert.equal(
        (
          await lookup.findRestorable({
            cartReference: f.cart.cartReference,
            orderReference: created.record.order.orderReference,
          })
        )?.orderNumber,
        orderNumber,
      );

      // 6. Once the guest puts something in the Cart again, it no longer claims the Order.
      await admin.query(
        `INSERT INTO rms_ordering.cart_operation_record
         (operation_id,brand_id,store_id,cart_id,cart_line_id,guest_session_id,action_code,intent_digest,
          result_aggregate_version,result_cart_snapshot_json,occurred_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'Add',$7,$8,'{}'::jsonb,now(),now()+interval '24 hours')`,
        [
          id(20),
          f.cart.brandReference,
          f.cart.storeReference,
          f.cart.cartReference,
          id(21),
          guest,
          "sha256:" + "a".repeat(64),
          version + 2,
        ],
      );
      assert.equal(
        await lookup.findLatest({
          cartReference: f.cart.cartReference,
          guestSessionReference: guest,
        }),
        null,
      );
    } finally {
      await admin.query("DROP OWNED BY " + api).catch(() => undefined);
      await admin.query("DROP ROLE IF EXISTS " + api).catch(() => undefined);
      await admin.end();
    }
  });
});
