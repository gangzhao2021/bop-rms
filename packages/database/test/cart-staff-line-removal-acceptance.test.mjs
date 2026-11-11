import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresCartQueryStore,
  listStaffCartRemovals,
  readStaffDiningCart,
  removeStaffDiningCartLine,
  removeStaffDiningCartLines,
} from "../../rms/ordering/src/index.ts";
import { orderWriteFixture } from "../../rms/ordering/src/tests/order-creation-store.fixture.ts";
import { seedSubmissionCart } from "../test-support/dining-order-submission-seed.mjs";
import { grantPilotApiAcl } from "../test-support/pilot-api-acl.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { dbNow } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;
const id = (n) => "01902521-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hashIntent = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");

/**
 * WP-2423 shared-table-checkout (c), 2000_521: staff take a dish out of a table's unsent cart.
 * As the restricted pilot API role (rendered pilot ACL, NOBYPASSRLS): the cart moves to its next
 * version without the line, one append-only removal row records the staff member, the reason,
 * the dish, how many and whose phone added it, with its Audit record; the same operation replays
 * without writing again; a stale view, a line already gone and another table are refused with
 * nothing written; another Store sees no removal; the record can't be changed or deleted, and
 * can't claim a cart version or a line the cart doesn't show.
 */
it("WP-2423 (shared-table-checkout): staff remove a dish from a table cart, recorded and attributed", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_staff_cart" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_staffcart_" + context.runId;
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
      const now = await dbNow(admin);
      const f = orderWriteFixture({ namespace: "01902521", at: now, dineIn: true });
      await seedSubmissionCart(admin, f);
      const scope = f.scope;
      const cart = f.cart;
      const session = String(cart.diningSessionReference);
      const line = cart.items[0];
      const staff = id(501);
      const at = new Date(Math.max(Date.now(), Date.parse(cart.updatedAt) + 1000)).toISOString();
      let audits = 900;
      const removal = (operation, change = {}) => ({
        operationReference: id(operation),
        diningSessionReference: session,
        cartReference: String(cart.cartReference),
        cartItemReference: String(line.cartItemReference),
        expectedCartVersion: cart.aggregateVersion,
        reason: "CantMake",
        actorReference: staff,
        observedAt: at,
        hashIntent,
        checkoutHeld: async () => false,
        audit: {
          auditId: id(++audits),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "User", reference: staff },
          actionCode: "ORDERING_CART_ITEM_REMOVE_BY_STAFF",
          targetType: "OrderingCart",
          targetId: String(cart.cartReference),
          reasonCode: "STAFF_CART_CANT_MAKE",
          correlationId: id(operation),
          occurredAt: at,
          sourceChannel: "API",
          dataClassification: "Internal",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        },
        ...change,
      });
      const written = async () =>
        (
          await admin.query(
            `SELECT (SELECT count(*)::int FROM rms_ordering.cart_staff_line_removal WHERE cart_id=$1) AS removals,
               (SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) AS audits,
               (SELECT aggregate_version FROM rms_ordering.cart WHERE cart_id=$1) AS version`,
            [cart.cartReference],
          )
        ).rows[0];

      // Staff read the table's cart: the dish, how many, whose phone.
      const seen = await inTransaction((tx) => readStaffDiningCart(tx, scope, session, at));
      assert.equal(seen?.cartVersion, cart.aggregateVersion);
      assert.equal(seen?.lines.length, cart.items.length);
      assert.equal(
        seen?.lines[0]?.addedByParticipantReference,
        String(line.addedByParticipantReference),
      );
      const before = await written();

      // A stale view (another version) and another table's session: refused, nothing written.
      await assert.rejects(
        inTransaction((tx) =>
          removeStaffDiningCartLine(
            tx,
            scope,
            removal(10, { expectedCartVersion: cart.aggregateVersion + 1 }),
          ),
        ),
        { code: "CART_VERSION_CONFLICT" },
      );
      await assert.rejects(
        inTransaction((tx) =>
          removeStaffDiningCartLine(tx, scope, removal(11, { diningSessionReference: id(77) })),
        ),
        { code: "CART_PERMISSION_DENIED" },
      );
      assert.deepEqual(await written(), before);

      // A guest starts paying just as staff remove: the guest's checkout session holds the cart
      // row (its hold already recorded) while staff wait for it. Staff then see the hold and are
      // refused; nothing is written, so the guest pays for exactly the dishes they saw.
      {
        const guest = new Client(context.clientConfig);
        await guest.connect();
        let holdRecorded = false;
        const asked = [];
        try {
          await guest.query("BEGIN");
          await guest.query("SET LOCAL ROLE " + api);
          await guest.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          await guest.query(
            "SELECT aggregate_version FROM rms_ordering.cart WHERE brand_id=$1 AND store_id=$2 AND cart_id=$3 FOR UPDATE",
            [scope.brandReference, scope.storeReference, cart.cartReference],
          );
          const staffRemoval = inTransaction((tx) =>
            removeStaffDiningCartLine(
              tx,
              scope,
              removal(15, {
                checkoutHeld: async (version) => {
                  asked.push(version);
                  return holdRecorded;
                },
              }),
            ),
          ).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          // Wait until staff are blocked on the cart row lock.
          for (let attempt = 0; ; attempt += 1) {
            const waiting = await admin.query(
              "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM rms_ordering.cart WHERE%FOR UPDATE%'",
            );
            if (waiting.rows[0].n > 0) break;
            assert.ok(attempt < 200, "staff removal never waited for the cart lock");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          holdRecorded = true;
          await guest.query("COMMIT");
          const outcome = await staffRemoval;
          assert.equal(outcome.error?.code, "CART_CHECKOUT_IN_PROGRESS", String(outcome.value));
          assert.deepEqual(asked, [cart.aggregateVersion]);
        } finally {
          await guest.end();
        }
        assert.deepEqual(await written(), before);
        // A hold that can't be read is an outage, not a refusal of the staff member.
        await assert.rejects(
          inTransaction((tx) =>
            removeStaffDiningCartLine(
              tx,
              scope,
              removal(16, {
                checkoutHeld: async () => {
                  throw new Error("dining unavailable");
                },
              }),
            ),
          ),
          { code: "CART_DEPENDENCY_UNAVAILABLE" },
        );
        assert.deepEqual(await written(), before);
      }

      // The removal: next version, the line gone, one record and one Audit record.
      const removed = await inTransaction((tx) =>
        removeStaffDiningCartLine(tx, scope, removal(20)),
      );
      assert.deepEqual(removed, { status: "Removed", cartVersion: cart.aggregateVersion + 1 });
      const after = await createPostgresCartQueryStore({ run: inTransaction }, scope).load(
        cart.cartReference,
      );
      assert.equal(after.aggregateVersion, cart.aggregateVersion + 1);
      assert.ok(!after.items.some((item) => item.cartItemReference === line.cartItemReference));
      assert.deepEqual(await written(), {
        removals: before.removals + 1,
        audits: before.audits + 1,
        version: cart.aggregateVersion + 1,
      });
      const record = (
        await admin.query(
          "SELECT actor_id::text actor, reason_code, quantity, sellable_id::text sellable, added_by_participant_id::text adder, result_aggregate_version v FROM rms_ordering.cart_staff_line_removal WHERE operation_id=$1",
          [id(20)],
        )
      ).rows[0];
      assert.deepEqual(record, {
        actor: staff,
        reason_code: "CantMake",
        quantity: line.quantity,
        sellable: String(line.sellableReference),
        adder: String(line.addedByParticipantReference),
        v: cart.aggregateVersion + 1,
      });
      const audit = (
        await admin.query(
          "SELECT actor_type, actor_reference::text actor, action_code, reason_code FROM platform_audit.audit_record WHERE audit_id=$1",
          [id(audits)],
        )
      ).rows[0];
      assert.equal(audit.action_code, "ORDERING_CART_ITEM_REMOVE_BY_STAFF");
      assert.equal(audit.reason_code, "STAFF_CART_CANT_MAKE");
      assert.equal(audit.actor, staff);

      // The same operation again (a retry after a lost answer) writes nothing more.
      const again = await inTransaction((tx) => removeStaffDiningCartLine(tx, scope, removal(20)));
      assert.deepEqual(again, { status: "AlreadyRemoved", cartVersion: cart.aggregateVersion + 1 });
      assert.equal((await written()).removals, before.removals + 1);
      // The same reference for a different ask is refused.
      await assert.rejects(
        inTransaction((tx) =>
          removeStaffDiningCartLine(
            tx,
            scope,
            removal(20, {
              reason: "GuestAsked",
              audit: { ...removal(20).audit, reasonCode: "STAFF_CART_GUEST_ASKED" },
            }),
          ),
        ),
        { code: "CART_IDEMPOTENCY_CONFLICT" },
      );
      // The line is gone: a second removal of it (from an old screen) is refused.
      await assert.rejects(
        inTransaction((tx) =>
          removeStaffDiningCartLine(
            tx,
            scope,
            removal(21, { expectedCartVersion: cart.aggregateVersion + 1 }),
          ),
        ),
        { code: "CART_ITEM_NOT_FOUND" },
      );

      // Every phone is told: the table's recent removals (this Store only).
      const since = new Date(Date.parse(at) - 60_000).toISOString();
      const recent = await inTransaction((tx) => listStaffCartRemovals(tx, scope, session, since));
      assert.deepEqual(recent, [
        {
          sellableReference: String(line.sellableReference),
          quantity: line.quantity,
          occurredAt: at,
        },
      ]);
      const otherStore = { ...scope, storeReference: id(88) };
      assert.deepEqual(
        await inTransaction((tx) => listStaffCartRemovals(tx, otherStore, session, since)),
        [],
      );

      // Append-only, and a record must match the cart: as the API role, every rewrite is refused.
      for (const sql of [
        "UPDATE rms_ordering.cart_staff_line_removal SET reason_code='GuestAsked' WHERE operation_id=$1",
        "DELETE FROM rms_ordering.cart_staff_line_removal WHERE operation_id=$1",
      ])
        await assert.rejects(
          inTransaction(async (tx) => {
            await tx.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
              [scope.brandReference, scope.storeReference],
            );
            await tx.query(sql, [id(20)]);
          }),
        );
      await assert.rejects(
        inTransaction(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [scope.brandReference, scope.storeReference],
          );
          // A removal claiming a line still in the cart, at a version the cart isn't at.
          await tx.query(
            `INSERT INTO rms_ordering.cart_staff_line_removal (operation_id,brand_id,store_id,cart_id,dining_session_id,cart_line_id,sellable_id,quantity,added_by_participant_id,reason_code,result_aggregate_version,intent_digest,actor_id,occurred_at,audit_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,1,NULL,'GuestAsked',99,$8,$9,$10,$11)`,
            [
              id(30),
              scope.brandReference,
              scope.storeReference,
              cart.cartReference,
              session,
              String(cart.items[1]?.cartItemReference ?? id(31)),
              String(line.sellableReference),
              hashIntent("x"),
              staff,
              at,
              id(32),
            ],
          );
        }),
        { code: "23514" },
      );
      assert.equal((await written()).removals, before.removals + 1);
    } finally {
      await admin.end();
    }
  });
}, 600_000);

/**
 * WP-2423 M06/M35 (shared-table-cart-staff-round): staff decide on every guest line at once with
 * their round. As the restricted pilot API role: all the lines staff take out leave in one
 * transaction, each its own recorded and audited removal at consecutive cart versions, or none
 * does: a decision on a cart that moved on (another version, or not exactly its lines) and a
 * failure part-way (the second line's checkout hold can't be read) leave the cart as it was with
 * nothing recorded. The same operations replay without writing again.
 */
it("WP-2423 M06/M35: staff take several guest lines out at once, or none", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_cart_lines" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    const api = "wp2423_staffcartl_" + context.runId;
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
      const now = await dbNow(admin);
      const f = orderWriteFixture({ namespace: "01902522", at: now, dineIn: true });
      await seedSubmissionCart(admin, f);
      const scope = f.scope;
      const cart = f.cart;
      const session = String(cart.diningSessionReference);
      // Three lines at the table: the seeded ones, and copies from other phones up to three.
      const columns = (
        await admin.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='rms_ordering' AND table_name='cart_line' ORDER BY ordinal_position",
        )
      ).rows.map((row) => row.column_name);
      const seeded = (
        await admin.query(
          "SELECT cart_line_id::text AS line FROM rms_ordering.cart_line WHERE cart_id=$1 ORDER BY added_at, cart_line_id",
          [cart.cartReference],
        )
      ).rows.map((row) => row.line);
      const lines = [...seeded];
      for (let n = 0; lines.length < 3; n += 1) {
        const copy = id(600 + n);
        await admin.query(
          `INSERT INTO rms_ordering.cart_line (${columns.join(",")}) SELECT ${columns
            .map((column) => (column === "cart_line_id" ? "$2::uuid" : column))
            .join(",")} FROM rms_ordering.cart_line WHERE cart_line_id=$1`,
          [seeded[0], copy],
        );
        lines.push(copy);
      }
      const staff = id(501);
      const at = new Date(Math.max(Date.now(), Date.parse(cart.updatedAt) + 1000)).toISOString();
      let audits = 900;
      const decision = (keep, out, change = {}) => ({
        diningSessionReference: session,
        cartReference: String(cart.cartReference),
        expectedCartVersion: cart.aggregateVersion,
        keep,
        lines: out.map(([line, reason, operation]) => ({
          cartItemReference: line,
          reason,
          operationReference: id(operation),
          audit: {
            auditId: id(++audits),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "User", reference: staff },
            actionCode: "ORDERING_CART_ITEM_REMOVE_BY_STAFF",
            targetType: "OrderingCart",
            targetId: String(cart.cartReference),
            reasonCode: reason === "CantMake" ? "STAFF_CART_CANT_MAKE" : "STAFF_CART_GUEST_ASKED",
            correlationId: id(700),
            occurredAt: at,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          },
        })),
        actorReference: staff,
        observedAt: at,
        hashIntent,
        checkoutHeld: async () => false,
        ...change,
      });
      const written = async () =>
        (
          await admin.query(
            `SELECT (SELECT count(*)::int FROM rms_ordering.cart_staff_line_removal WHERE cart_id=$1) AS removals,
               (SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1) AS audits,
               (SELECT aggregate_version FROM rms_ordering.cart WHERE cart_id=$1) AS version,
               (SELECT count(*)::int FROM rms_ordering.cart_line WHERE cart_id=$1) AS lines`,
            [cart.cartReference],
          )
        ).rows[0];
      const before = await written();
      assert.equal(before.lines, 3);
      const [a, b, c] = lines;

      // Decided on a cart that isn't the one now: another version, a line not decided on, or a
      // line the cart doesn't hold. Refused with nothing written.
      for (const [keep, out, change] of [
        [
          [c],
          [
            [a, "GuestAsked", 10],
            [b, "CantMake", 11],
          ],
          { expectedCartVersion: cart.aggregateVersion + 1 },
        ],
        [
          [],
          [
            [a, "GuestAsked", 12],
            [b, "CantMake", 13],
          ],
          {},
        ],
        [
          [c, id(99)],
          [
            [a, "GuestAsked", 14],
            [b, "CantMake", 15],
          ],
          {},
        ],
      ])
        await assert.rejects(
          inTransaction((tx) => removeStaffDiningCartLines(tx, scope, decision(keep, out, change))),
          { code: "CART_VERSION_CONFLICT" },
        );
      assert.deepEqual(await written(), before);

      // A failure part-way (the second line's hold can't be read): the first line is not gone.
      await assert.rejects(
        inTransaction((tx) =>
          removeStaffDiningCartLines(
            tx,
            scope,
            decision(
              [c],
              [
                [a, "GuestAsked", 16],
                [b, "CantMake", 17],
              ],
              {
                checkoutHeld: async (version) => {
                  if (version > cart.aggregateVersion) throw new Error("dining unavailable");
                  return false;
                },
              },
            ),
          ),
        ),
        { code: "CART_DEPENDENCY_UNAVAILABLE" },
      );
      assert.deepEqual(await written(), before);

      // Both lines out, one transaction: two records, two Audit records, the next two versions.
      const removed = await inTransaction((tx) =>
        removeStaffDiningCartLines(
          tx,
          scope,
          decision(
            [c],
            [
              [a, "GuestAsked", 20],
              [b, "CantMake", 21],
            ],
          ),
        ),
      );
      assert.deepEqual(removed, { status: "Removed", cartVersion: cart.aggregateVersion + 2 });
      assert.deepEqual(await written(), {
        removals: before.removals + 2,
        audits: before.audits + 2,
        version: cart.aggregateVersion + 2,
        lines: 1,
      });
      assert.deepEqual(
        (
          await admin.query(
            "SELECT cart_line_id::text AS line, reason_code AS reason, result_aggregate_version AS v, actor_id::text AS actor FROM rms_ordering.cart_staff_line_removal WHERE cart_id=$1 ORDER BY result_aggregate_version",
            [cart.cartReference],
          )
        ).rows,
        [
          { line: a, reason: "GuestAsked", v: cart.aggregateVersion + 1, actor: staff },
          { line: b, reason: "CantMake", v: cart.aggregateVersion + 2, actor: staff },
        ],
      );
      // The same decision again (a retry after a lost answer): nothing more is written.
      const again = await inTransaction((tx) =>
        removeStaffDiningCartLines(
          tx,
          scope,
          decision(
            [c],
            [
              [a, "GuestAsked", 20],
              [b, "CantMake", 21],
            ],
          ),
        ),
      );
      assert.deepEqual(again, { status: "AlreadyRemoved", cartVersion: cart.aggregateVersion + 2 });
      assert.equal((await written()).removals, before.removals + 2);
      // Another Store sees nothing to remove there.
      await assert.rejects(
        inTransaction((tx) =>
          removeStaffDiningCartLines(
            tx,
            { ...scope, storeReference: id(88) },
            decision([], [[c, "GuestAsked", 30]], {
              expectedCartVersion: cart.aggregateVersion + 2,
            }),
          ),
        ),
      );
      assert.equal((await written()).lines, 1);
    } finally {
      await admin.end();
    }
  });
}, 600_000);
