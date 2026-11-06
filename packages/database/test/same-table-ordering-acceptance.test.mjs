import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createGuestSessionCredentialProvider,
  createPostgresGuestParticipantSessionSource,
} from "../../bop/identity/src/index.ts";
import { createCustomerCartAdderStanding } from "../../../apps/api/src/customer-cart-adder-standing.ts";
import {
  createPostgresCartOrderLookup,
  createPostgresOrderCreationStore,
} from "../../rms/ordering/src/index.ts";
import { orderWriteFixture } from "../../rms/ordering/src/tests/order-creation-store.fixture.ts";
import { seedSubmissionCart } from "../test-support/dining-order-submission-seed.mjs";
import { grantPilotApiAcl } from "../test-support/pilot-api-acl.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { createPilotApiRole, dbNow } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01902423-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/**
 * WP-2423 (same-table-ordering): "has the phone that added this line left the table" reads only
 * Identity's own live Guest Sessions bound to that Dining participant, as the restricted pilot API
 * role (rendered pilot ACL, NOBYPASSRLS) with the Store selected: a revoked, timed-out or closed
 * session never counts, another table session's or another Store's or Brand's sessions are never
 * returned, and nothing is visible with another Store selected. Each live session then goes
 * through the cart's own binding check (stubbed here by the QR revocation version the table has
 * now; the check itself is covered by the binding tests).
 */
it("WP-2423 (same-table-ordering): a stranded line's phone is found Gone from its own live sessions only", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_same_table" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    try {
      const api = await createPilotApiRole(admin, context, "wp2423_sto");
      const brand = id(2),
        otherBrand = id(5),
        store = id(3),
        otherStore = id(4),
        table = id(30),
        otherTable = id(31),
        phoneA = id(41),
        phoneB = id(42),
        phoneC = id(43);
      const credentials = createGuestSessionCredentialProvider(randomBytes(32));
      const now = await dbNow(admin);
      const at = (minutes) => new Date(Date.parse(now) + minutes * 60_000).toISOString();
      let n = 0;
      const seed = async ({
        brandId = brand,
        storeId = store,
        diningSession = table,
        participant,
        qrVersion = 2,
        status = "Active",
        lastSeenMinutes = -30,
        closedMinutes = null,
      }) => {
        n += 1;
        await admin.query(
          `INSERT INTO bop_identity.guest_session (guest_session_id,session_selector_hash,
            csrf_selector_hash,operation_id,operation_intent_hash,brand_id,store_id,public_store_id,
            public_table_id,channel,locale,qr_id,qr_revocation_version,dining_state,status,
            created_at,last_seen_at,idle_expires_at,absolute_expires_at,version,dining_session_id,
            dining_participant_id,revocation_reason,revoked_at,order_closed_at,closure_expires_at)
           VALUES ($1,decode($2,'hex'),decode($3,'hex'),$4,decode($5,'hex'),$6,$7,$8,$9,'DineIn',
            'zh-Hans',$10,$11,'DiningBound',$12,$13,$14,$14::timestamptz + interval '4 hours',
            $13::timestamptz + interval '24 hours',1,$15,$16,$17,$18,$19,
            $19::timestamptz + interval '2 hours')`,
          [
            id(100 + n),
            credentials.hashCredential("Session", credentials.generateCredential("Session")),
            credentials.hashCredential("Csrf", credentials.generateCredential("Csrf")),
            id(200 + n),
            credentials.hashOperationIntent("seed" + n),
            brandId,
            storeId,
            id(13),
            id(14),
            id(15),
            qrVersion,
            status,
            at(-300),
            at(lastSeenMinutes),
            diningSession,
            participant,
            status === "Revoked" ? "Rotated" : null,
            status === "Revoked" ? at(-5) : null,
            closedMinutes === null ? null : at(closedMinutes),
          ],
        );
        return id(100 + n);
      };
      // Phone A: a session from before the table QR was replaced (version 1) and its current one.
      const aOld = await seed({ participant: phoneA, qrVersion: 1 });
      const aNow = await seed({ participant: phoneA });
      // Phone B: its session was revoked (removed), and an older one timed out.
      await seed({ participant: phoneB, status: "Revoked" });
      await seed({ participant: phoneB, lastSeenMinutes: -250 });
      // Phone C: only its closed-order session, already past its closure time.
      await seed({ participant: phoneC, closedMinutes: -130 });
      // Never returned: the same participant id at another table session, Store or Brand.
      await seed({ participant: phoneB, diningSession: otherTable });
      await seed({ participant: phoneB, storeId: otherStore });
      await seed({ participant: phoneB, brandId: otherBrand });

      const transactions = (scope) => ({
        async run(work) {
          await admin.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
          try {
            await admin.query("SET LOCAL ROLE " + api);
            const value = await work({
              query: (sql, values) => admin.query(sql, values === undefined ? [] : [...values]),
            });
            await admin.query("COMMIT");
            return value;
          } catch (error) {
            await admin.query("ROLLBACK");
            throw error;
          } finally {
            assert.ok(scope);
          }
        },
      });
      const scope = { brandReference: brand, storeReference: store };
      const source = createPostgresGuestParticipantSessionSource(transactions(scope), scope);
      const listed = await source.listBound({
        diningSessionReference: table,
        participantReferences: [phoneA, phoneB, phoneC],
        observedAt: now,
      });
      assert.deepEqual(listed.map((session) => String(session.sessionReference)).sort(), [
        aOld,
        aNow,
      ]);
      // No credential or selector leaves the source.
      for (const session of listed)
        assert.ok(!JSON.stringify(session).includes("Selector") && !("credential" in session));

      // The binding check stand-in: the table's QR is at version 2 now.
      const standing = createCustomerCartAdderStanding({
        scope,
        sessions: source,
        binding: {
          validate: async (session) =>
            session.qrRevocationVersion === 2 ? "Current" : "Unavailable",
        },
      });
      assert.deepEqual(
        await standing.standing({
          diningSessionReference: table,
          participantReferences: [phoneA, phoneB, phoneC],
          observedAt: now,
        }),
        [
          { participantReference: phoneA, standing: "AtTable" },
          { participantReference: phoneB, standing: "Gone" },
          { participantReference: phoneC, standing: "Gone" },
        ],
      );

      // RLS: with another Store (or Brand) selected, the table's sessions are invisible.
      for (const other of [
        { brandReference: brand, storeReference: otherStore },
        { brandReference: otherBrand, storeReference: store },
      ]) {
        const foreign = createPostgresGuestParticipantSessionSource(transactions(other), other);
        assert.deepEqual(
          await foreign.listBound({
            diningSessionReference: table,
            participantReferences: [phoneA],
            observedAt: now,
          }),
          [],
        );
      }
      // Even a direct read under the role with a Store selected sees only that Store's rows.
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + api);
        await admin.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, otherStore],
        );
        const rows = await admin.query(
          "SELECT store_id FROM bop_identity.guest_session WHERE dining_participant_id=$1",
          [phoneA],
        );
        assert.equal(rows.rowCount, 0);
      } finally {
        await admin.query("ROLLBACK");
      }
    } finally {
      await admin.end();
    }
  });
});

/**
 * WP-2423 (same-table-ordering): every phone at the table learns that a round took the cart's
 * dishes, from Ordering's own round record (the batch, its submission's Guest Session and the cart
 * lines it took), not from "the cart's version just before this one": it is still found after
 * other dishes were added to the cart. Read as the restricted pilot API role; another Store sees
 * nothing; after 15 minutes it is no longer reported.
 */
it("WP-2423 (same-table-ordering): a round sent from the cart is reported with its lines, even after more dishes were added", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_sto_rounds" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_rounds_" + context.runId;
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
      const f = orderWriteFixture({ namespace: "01902423", at, dineIn: true });
      await seedSubmissionCart(admin, f);
      // Ordering's own record of the paying session opening this table's Cart, as participant P.
      const payer = id(88);
      await admin.query(
        `INSERT INTO rms_ordering.dining_cart_operation (brand_id,store_id,operation_id,
           dining_session_id,guest_session_id,participant_id,action_code,cart_id,cart_version,
           occurred_at,expires_at)
         SELECT c.brand_id,c.store_id,$1,c.dining_session_id,$2,$3,'Select',c.cart_id,
           c.aggregate_version,c.updated_at,c.updated_at + interval '24 hours'
         FROM rms_ordering.cart c WHERE c.cart_id=$4`,
        [id(87), f.request.record.guestSessionReference, payer, f.cart.cartReference],
      );
      const created = await createPostgresOrderCreationStore(runner, f.scope).append(f.request);
      assert.equal(created.status, "Created");
      const lookup = createPostgresCartOrderLookup(runner, f.scope);
      const now = new Date().toISOString();
      const expected = [
        {
          roundNumber: 1,
          sentAt: at,
          guestSessionReference: f.request.record.guestSessionReference,
          participantReference: payer,
          cartItemReferences: f.cart.items.map((item) => item.cartItemReference).sort(),
        },
      ];
      const rounds = await lookup.recentRounds({
        cartReference: f.cart.cartReference,
        observedAt: now,
      });
      assert.deepEqual(
        rounds.map((round) => ({ ...round, cartItemReferences: [...round.cartItemReferences] })),
        expected,
      );
      // Someone adds a dish after the round (the cart moves on twice): the round is still found.
      await admin.query(
        "UPDATE rms_ordering.cart SET aggregate_version=aggregate_version+2 WHERE cart_id=$1",
        [f.cart.cartReference],
      );
      assert.equal(
        (await lookup.recentRounds({ cartReference: f.cart.cartReference, observedAt: now }))
          .length,
        1,
      );
      // Another Store sees nothing; 15 minutes later it is no longer news.
      const otherStore = createPostgresCartOrderLookup(runner, {
        brandReference: f.scope.brandReference,
        storeReference: id(2),
      });
      assert.deepEqual(
        await otherStore.recentRounds({ cartReference: f.cart.cartReference, observedAt: now }),
        [],
      );
      assert.deepEqual(
        await lookup.recentRounds({
          cartReference: f.cart.cartReference,
          observedAt: new Date(Date.parse(at) + 16 * 60_000).toISOString(),
        }),
        [],
      );
    } finally {
      await admin.end();
    }
  });
});
