import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresCartQueryStore,
  listStaffCartRemovals,
  readStaffDiningCart,
  removeStaffDiningCartLine,
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
