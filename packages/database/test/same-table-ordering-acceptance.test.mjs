import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createGuestSessionCredentialProvider,
  createPostgresGuestParticipantSessionSource,
} from "../../bop/identity/src/index.ts";
import { createCustomerCartAdderStanding } from "../../../apps/api/src/customer-cart-adder-standing.ts";
import {
  createDiningCartItemService,
  createPostgresBoundCartItemOperationStore,
  createPostgresCartItemCommandStore,
  createPostgresCartOrderLookup,
  createPostgresCartQueryStore,
  createPostgresDiningCartCommandQueryStore,
  createPostgresOrderCreationStore,
  listDiningSessionRoundSenders,
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
          // M38: a pay-first round nobody has paid yet is never called paid.
          paymentState: "AwaitingPayment",
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
      // M139: the round is labelled by the phone that sent it (the payer), not by the phone that
      // added its first dish.
      const diningSession = (
        await admin.query(
          "SELECT dining_session_id::text s FROM rms_ordering.cart WHERE cart_id=$1",
          [f.cart.cartReference],
        )
      ).rows[0].s;
      // The order items name the phone that added each dish (the fixture's adder), another phone.
      assert.ok(f.cart.items.every((item) => item.addedByParticipantReference !== payer));
      const senders = await runner.run((tx) =>
        listDiningSessionRoundSenders(tx, f.scope, diningSession),
      );
      assert.equal(senders.length, 1);
      assert.equal(senders[0].participantReference, payer);
      assert.equal(senders[0].staffEntered, false);
      // Another Store sees no rounds.
      assert.deepEqual(
        await runner.run((tx) =>
          listDiningSessionRoundSenders(
            tx,
            { brandReference: f.scope.brandReference, storeReference: id(2) },
            diningSession,
          ),
        ),
        [],
      );
      // A round staff entered for the table is marked as theirs.
      await admin.query(
        `INSERT INTO rms_ordering.staff_dining_round_entry (brand_id,store_id,operation_id,
           intent_hash,actor_id,table_id,dining_session_id,guest_session_id,tip_selection_id,
           recorded_after_outage,created_at,audit_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,date_trunc('milliseconds',now()),$10)`,
        [
          f.scope.brandReference,
          f.scope.storeReference,
          id(91),
          "sha256:" + "b".repeat(64),
          id(92),
          id(93),
          diningSession,
          f.request.record.guestSessionReference,
          id(94),
          id(95),
        ],
      );
      assert.equal(
        (await runner.run((tx) => listDiningSessionRoundSenders(tx, f.scope, diningSession)))[0]
          .staffEntered,
        true,
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
      // M38: a round still awaiting payment stays in view whatever its age, so the payer and the
      // companions never lose it while the payment is open.
      const later = new Date(Date.parse(at) + 40 * 60_000).toISOString();
      assert.deepEqual(
        (await lookup.recentRounds({ cartReference: f.cart.cartReference, observedAt: later })).map(
          (round) => round.paymentState,
        ),
        ["AwaitingPayment"],
      );
      const batch = (
        await admin.query(
          `SELECT b.order_batch_id,b.order_id,b.submission_id,
             to_char(b.submitted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') submitted
           FROM rms_ordering.order_batch b WHERE b.source_cart_id=$1`,
          [f.cart.cartReference],
        )
      ).rows[0];
      // M38: a guest round held for staff (never released by itself) is not being paid by
      // anyone: it reads WaitingForStaff, and stays in view while it waits.
      await admin.query(
        `INSERT INTO rms_ordering.order_round_staff_hold (hold_id,brand_id,store_id,order_id,
           order_batch_id,submission_id,guest_session_id,reason,held_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'FirstOrder',$8::timestamptz)`,
        [
          id(88),
          f.scope.brandReference,
          f.scope.storeReference,
          batch.order_id,
          batch.order_batch_id,
          batch.submission_id,
          f.request.record.guestSessionReference,
          batch.submitted,
        ],
      );
      for (const observedAt of [now, later])
        assert.deepEqual(
          (await lookup.recentRounds({ cartReference: f.cart.cartReference, observedAt })).map(
            (round) => round.paymentState,
          ),
          ["WaitingForStaff"],
        );
      // Once the payment arrived it reads Paid, and 15 minutes later it is no longer news.
      await admin.query(
        `INSERT INTO rms_ordering.order_payment_acceptance_wait (wait_id,brand_id,store_id,order_id,
           order_batch_id,submission_id,payment_event_id,source_digest,evaluated_at,record_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,date_trunc('milliseconds',now()),'{}'::jsonb)`,
        [
          id(89),
          f.scope.brandReference,
          f.scope.storeReference,
          batch.order_id,
          batch.order_batch_id,
          batch.submission_id,
          id(90),
          "sha256:" + "a".repeat(64),
        ],
      );
      assert.deepEqual(
        (await lookup.recentRounds({ cartReference: f.cart.cartReference, observedAt: now })).map(
          (round) => round.paymentState,
        ),
        ["Paid"],
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

/**
 * WP-2423 (same-table-ordering): the remove of another phone's line, end to end against the real
 * stores as the restricted pilot API role (rendered pilot ACL, NOBYPASSRLS): Identity's live
 * Guest Sessions decide whether the adder is still at the table, and Ordering writes the next Cart
 * version, the operation record and the Audit record in one transaction. While the adder's phone
 * is still at the table the remove is refused as a stale view (nothing written); when the check
 * cannot run it is refused as "try again" (nothing written, never "session expired"); once staff
 * removed that phone (its session revoked) another guest's remove applies, attributed to the
 * remover. The binding check and Dining's departures are stand-ins here (each is covered by its
 * own restricted-role test); the Identity, Cart and Audit reads and writes are real.
 */
it("WP-2423 (same-table-ordering): another guest removes a removed phone's dish, attributed, and only then", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_sto_remove" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_remove_" + context.runId;
    try {
      await admin.query(
        "CREATE ROLE " + api + " NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
      );
      await grantPilotApiAcl(admin, api);
      const runner = (readOnly = false) => ({
        async run(action) {
          const client = new Client(context.clientConfig);
          await client.connect();
          try {
            await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
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
      });
      const now = await dbNow(admin);
      const f = orderWriteFixture({ namespace: "01902423", at: now, dineIn: true });
      await seedSubmissionCart(admin, f);
      const scope = f.scope;
      const cart = f.cart;
      const diningSession = String(cart.diningSessionReference);
      const adder = String(cart.items[0].addedByParticipantReference);
      const line = String(cart.items[0].cartItemReference);
      const remover = id(602),
        removerSession = id(603);
      // The adder's phone: one live Guest Session bound to it at this table.
      const credentials = createGuestSessionCredentialProvider(randomBytes(32));
      const adderSession = id(604);
      await admin.query(
        `INSERT INTO bop_identity.guest_session (guest_session_id,session_selector_hash,
          csrf_selector_hash,operation_id,operation_intent_hash,brand_id,store_id,public_store_id,
          public_table_id,channel,locale,qr_id,qr_revocation_version,dining_state,status,
          created_at,last_seen_at,idle_expires_at,absolute_expires_at,version,dining_session_id,
          dining_participant_id)
         VALUES ($1,decode($2,'hex'),decode($3,'hex'),$4,decode($5,'hex'),$6,$7,$8,$9,'DineIn',
          'zh-Hans',$10,2,'DiningBound','Active',$11::timestamptz - interval '10 minutes',$11,
          $11::timestamptz + interval '4 hours',
          $11::timestamptz - interval '10 minutes' + interval '24 hours',1,$12,$13)`,
        [
          adderSession,
          credentials.hashCredential("Session", credentials.generateCredential("Session")),
          credentials.hashCredential("Csrf", credentials.generateCredential("Csrf")),
          id(605),
          credentials.hashOperationIntent("adder"),
          scope.brandReference,
          scope.storeReference,
          id(606),
          id(607),
          id(608),
          now,
          diningSession,
          adder,
        ],
      );
      let bindingCheck = "Current";
      let departuresUp = true;
      const adders = createCustomerCartAdderStanding({
        scope,
        sessions: createPostgresGuestParticipantSessionSource(runner(true), scope),
        binding: {
          validate: async () => {
            if (bindingCheck === "Throws") throw new Error("synthetic Identity outage");
            return bindingCheck;
          },
        },
        departures: {
          readDepartures: async () => {
            if (!departuresUp) throw new Error("synthetic Dining outage");
            return [];
          },
        },
      });
      const references = {
        hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
        equals: (a, b) => a === b,
        generate: () => id(700 + ++generated),
      };
      let generated = 0;
      const writer = createPostgresCartItemCommandStore(runner(), scope, references);
      const service = createDiningCartItemService({
        scope,
        now: () => new Date().toISOString(),
        sessions: {
          authorize: async () => ({
            sessionReference: removerSession,
            status: "Active",
            version: 1,
            ...scope,
            publicStoreReference: id(606),
            publicTableReference: id(607),
            channel: "DineIn",
            locale: "zh-Hans",
            qrReference: id(608),
            qrRevocationVersion: 2,
            diningState: "DiningBound",
            diningSessionReference: diningSession,
            diningParticipantReference: remover,
            createdAt: now,
            lastSeenAt: now,
            idleExpiresAt: new Date(Date.parse(now) + 4 * 3600_000).toISOString(),
            absoluteExpiresAt: new Date(Date.parse(now) + 24 * 3600_000).toISOString(),
            orderClosedAt: null,
            closureExpiresAt: null,
            rotatedFromGuestSessionReference: null,
            revocationReason: null,
            revokedAt: null,
          }),
        },
        participation: {
          resolve: async () => ({
            schemaVersion: 1,
            ...scope,
            diningSessionReference: diningSession,
            participantReference: remover,
            tableReference: id(609),
            tableAssignmentVersion: 1,
            diningSessionVersion: 1,
            participantVersion: 1,
            observedAt: new Date().toISOString(),
          }),
        },
        catalog: { validateSelection: async () => assert.fail("no Catalog read on remove") },
        adders,
        references,
        audit: (input) => ({
          auditId: id(800 + ++generated),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "System" },
          actionCode: "ORDERING_CART_ITEM_" + input.action.toUpperCase(),
          targetType: "OrderingCart",
          targetId: input.cartReference,
          reasonCode: "AUTHORIZED_CART_MUTATION",
          correlationId: input.operationReference,
          occurredAt: input.observedAt,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        }),
        repository: (bound) => ({
          load: createPostgresDiningCartCommandQueryStore(runner(true), bound).load,
          resolveOperation: createPostgresBoundCartItemOperationStore(runner(true), bound)
            .resolveOperation,
          commit: writer.commit,
        }),
      });
      const reader = createPostgresCartQueryStore(runner(true), scope);
      const written = async () =>
        (
          await admin.query(
            `SELECT (SELECT count(*)::int FROM rms_ordering.cart_operation_record WHERE cart_id=$1)
               AS operations,
             (SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) AS audits`,
            [cart.cartReference],
          )
        ).rows[0];
      const remove = (operation) =>
        service.remove({
          sessionCredential: "a".repeat(43),
          csrfCredential: "b".repeat(43),
          cartReference: cart.cartReference,
          expectedAggregateVersion: cart.aggregateVersion,
          cartItemReference: line,
          operationReference: id(operation),
        });
      const before = await written();

      // The adder's phone is still at the table: a stale view, read the cart again.
      await assert.rejects(remove(901), { code: "CART_VERSION_CONFLICT" });
      // The check could not run (Identity's binding check and Dining both down): try again.
      bindingCheck = "Throws";
      departuresUp = false;
      await assert.rejects(remove(902), { code: "CART_DEPENDENCY_UNAVAILABLE" });
      // Its check failed but nothing records it left: still not removable, still "try again".
      bindingCheck = "Unavailable";
      departuresUp = true;
      await assert.rejects(remove(903), { code: "CART_DEPENDENCY_UNAVAILABLE" });
      assert.deepEqual(await written(), before);
      assert.equal((await reader.load(cart.cartReference)).aggregateVersion, cart.aggregateVersion);

      // Staff removed that phone: its session is revoked, so Identity lists none live.
      await admin.query(
        `UPDATE bop_identity.guest_session SET status='Revoked',revocation_reason='Rotated',
           revoked_at=$2,version=2 WHERE guest_session_id=$1`,
        [adderSession, now],
      );
      const applied = await remove(904);
      assert.equal(applied.status, "Applied");
      const after = await reader.load(cart.cartReference);
      assert.equal(after.aggregateVersion, cart.aggregateVersion + 1);
      assert.ok(!after.items.some((item) => String(item.cartItemReference) === line));
      assert.deepEqual(await written(), {
        operations: before.operations + 1,
        audits: before.audits + 1,
      });
      // Attributed to the remover's own Guest Session, never the adder's.
      const record = await admin.query(
        `SELECT guest_session_id,action_code FROM rms_ordering.cart_operation_record
         WHERE operation_id=$1`,
        [id(904)],
      );
      assert.equal(record.rows[0].guest_session_id, removerSession);
    } finally {
      await admin.end();
    }
  });
}, 120_000);
