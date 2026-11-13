import { randomUUID } from "node:crypto";
import { it } from "vitest";
import { TenantContextDatabaseError } from "../src/tenant-context.ts";
import { withAutoAcceptWorld } from "../test-support/auto-accept-world.mjs";
import { createPersistentMerchantOrderChanges } from "../../../apps/api/src/merchant-order-changes.ts";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";
import { merchantFailureKind } from "../../../apps/api/src/merchant-failure.ts";
import {
  orderChangeKinds,
  orderChangeMarkSql,
  orderChangeWindowStart,
} from "../../rms/ordering/src/index.ts";

/**
 * WP-2423 (reads-under-burst, v15 2026-11-13): a freshly paid pickup reached the Orders screen
 * 30-70 s late, because the screen read its whole (heavy) list only every 10 s. Orders now asks
 * every few seconds whether anything changed among the Store's Orders, and reads the list at once
 * when it did. Under the restricted NOBYPASSRLS api role with the rendered pilot ACL, on real
 * Orders paid online and the worker's paid outcome as the pilot composes it:
 *  - the mark changes when a pickup is placed and paid, and again when its payment reaches the
 *    Store (the paid order now waits for staff), and stays the same while nothing changes;
 *  - the list read at the moment the mark changed already holds the new order;
 *  - a record committed after a later one (an earlier time than the newest) still changes it;
 *  - another Store's new Order leaves it unchanged;
 *  - a signed-in staff member without the Orders permission is refused (a refusal, 403), a
 *    database that cannot be reached is not (busy, 503), and it names no Order;
 *  - b12 review: every part reads the Store's own time index, never sorting the Store's history.
 */
it("the Orders change mark moves with the Store's own new records only, and reads its index", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_ocm", orderType: "Pickup" }, async (world) => {
    const { assert, scope } = world;
    const staff = await world.session([], "01a6ab31");
    const persistence = { ...staff.persistence, now: world.now };
    const changes = createPersistentMerchantOrderChanges({ persistence });
    const list = createPersistentMerchantOrderQueue({
      persistence,
      quoteVersion: 1,
      acceptanceConfigured: true,
    });
    const mark = async () => (await changes({ sessionCookie: staff.sessionCookie })).mark;

    const empty = await mark();
    assert.match(empty, /^[0-9a-f]{32}$/u);
    assert.equal(await mark(), empty, "nothing changed: the same mark");

    // A guest places and pays a pickup (the Order, its round, the payment taken).
    const order = await world.seedPaidPickup({ paidMinutesAgo: 0 });
    const placed = await mark();
    assert.notEqual(placed, empty, "a new paid pickup changes the mark");
    // The list read when the mark changed already holds it.
    const listed = await list({ sessionCookie: staff.sessionCookie, afterOrderReference: null });
    assert.ok(
      listed.items.some((item) => item.orderReference === order.orderReference),
      "the Orders list holds the new pickup",
    );
    // Its payment reaches the Store's Orders (the worker's paid outcome): it waits for staff.
    await world.transactions().run((tx) => world.paid.consume(tx, order.event));
    const waiting = await mark();
    assert.notEqual(waiting, placed, "the payment reaching the Store changes the mark");
    assert.equal(await mark(), waiting);
    // Nothing about any Order is in it.
    assert.ok(!waiting.includes(order.orderReference.slice(0, 8)));

    // An Order recorded alongside the first one (the copy of its rows: number, header) but given
    // to `storeId` with `createdAt`; owner-side admin writes, as the API's own would land.
    let number = 900;
    const earlyId = () => {
      const hex = randomUUID().replaceAll("-", "");
      return `00000000-${hex.slice(0, 4)}-7${hex.slice(5, 8)}-8${hex.slice(9, 12)}-${hex.slice(12, 24)}`;
    };
    const copyOrder = async (storeId, createdAt) => {
      // A uuid v7 whose time part is long ago: it sorts before every id the Store has.
      const orderId = earlyId();
      number += 1;
      const override = JSON.stringify({
        order_id: orderId,
        store_id: storeId,
        order_number: String(number),
        sequence: number,
        created_at: createdAt,
      });
      for (const table of ["order_number_allocation", "order_header"])
        await world.query(
          `INSERT INTO rms_ordering.${table} SELECT (jsonb_populate_record(NULL::rms_ordering.${table},` +
            ` to_jsonb(source) || $2::jsonb)).*` +
            ` FROM rms_ordering.${table} source WHERE source.order_id=$1`,
          [order.orderReference, override],
        );
    };
    const [{ created }] = await world.query(
      "SELECT created_at AS created FROM rms_ordering.order_header WHERE order_id=$1",
      [order.orderReference],
    );
    // b12 review: a record whose time (and id) was taken before the newest one's, committed
    // after it, still changes the mark: the newest record is not the only witness.
    await copyOrder(scope.storeReference, new Date(created.getTime() - 2_000).toISOString());
    const late = await mark();
    assert.notEqual(late, waiting, "a record committed late, with an earlier time, changes it");
    // Another Store of the same Brand records a new Order: this Store's mark does not move.
    await copyOrder(earlyId(), new Date().toISOString());
    assert.equal(await mark(), late, "another Store's activity leaves the mark as it was");

    // A signed-in staff member of the Store without the Orders permission is refused: a refusal
    // (403), never "busy". Their session is real; only the ordering.operate grant is revoked.
    const other = await world.session([], "01a6ab32");
    const otherChanges = createPersistentMerchantOrderChanges({
      persistence: { ...other.persistence, now: world.now },
    });
    const grant = "01a6ab32-0000-7000-8000-" + (22).toString(16).padStart(12, "0");
    const [{ action }] = await world.query(
      "SELECT d.action_code AS action FROM bop_permission.permission_grant g JOIN bop_permission.permission_definition d ON d.permission_id=g.permission_id WHERE g.grant_id=$1",
      [grant],
    );
    assert.equal(action, "ordering.operate");
    assert.ok(
      (await otherChanges({ sessionCookie: other.sessionCookie })).mark,
      "with the permission it answers",
    );
    await world.query(
      "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE grant_id=$1",
      [grant],
    );
    const refused = await otherChanges({ sessionCookie: other.sessionCookie }).then(
      () => null,
      (error) => error,
    );
    assert.ok(refused instanceof Error, "without ordering.operate there is no answer");
    assert.equal(merchantFailureKind(refused), "Refused", "answered as a refusal (403)");

    // Without a staff sign-in there is no answer, as for the list.
    await assert.rejects(changes({ sessionCookie: "not-a-session" }));

    // A database that cannot be reached is busy (503), never a refusal: at the connection, and
    // with the connection lost after the sign-in was read (the permission read fails).
    const unreachable = createPersistentMerchantOrderChanges({
      persistence: {
        ...persistence,
        transactions: {
          run: async () => {
            throw new TenantContextDatabaseError(
              "TENANT_DATABASE_ACQUIRE_FAILED",
              Object.freeze({ sqlState: "08006", constraint: null, table: null, closed: false }),
            );
          },
        },
      },
    });
    const outage = await unreachable({ sessionCookie: staff.sessionCookie }).then(
      () => null,
      (error) => error,
    );
    assert.ok(outage instanceof Error);
    assert.notEqual(merchantFailureKind(outage), "Refused", "an outage is not a refusal");
    let statements = 0;
    const lost = createPersistentMerchantOrderChanges({
      persistence: {
        ...persistence,
        transactions: {
          run: (work) =>
            persistence.transactions.run((tx) =>
              work(
                new Proxy(tx, {
                  get: (target, key) => {
                    if (key !== "query") {
                      const value = Reflect.get(target, key);
                      return typeof value === "function" ? value.bind(target) : value;
                    }
                    return (sql, values) => {
                      statements += 1;
                      if (/permission_grant|role_assignment|policy_state/u.test(sql))
                        return Promise.reject(
                          new TenantContextDatabaseError(
                            "TENANT_DATABASE_TRANSACTION_FAILED",
                            Object.freeze({
                              sqlState: "57P01",
                              constraint: null,
                              table: null,
                              closed: true,
                            }),
                          ),
                        );
                      return tx.query(sql, values);
                    };
                  },
                }),
              ),
            ),
        },
      },
    });
    const midway = await lost({ sessionCookie: staff.sessionCookie }).then(
      () => null,
      (error) => error,
    );
    assert.ok(statements > 0);
    assert.ok(midway instanceof Error, "a lost connection gives no mark");
    assert.notEqual(merchantFailureKind(midway), "Refused", "a lost connection is not a refusal");

    // b12 review: the plan reads each kind from the Store's own time index, one row from its end
    // for the latest time and only the window's rows for the count; no sort, no table scan. Seq
    // and bitmap scans are priced out so the small test tables show the index plan Postgres
    // takes on a Store with a year of history; a sort or a scan stays in the plan when no index
    // fits, as it did for the first mark (Sort Key: order_id::text over every row of the Store).
    const plan = await world.transactions().run(async (tx) => {
      await tx.query("SET LOCAL enable_seqscan=off");
      await tx.query("SET LOCAL enable_bitmapscan=off");
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      const explained = await tx.query("EXPLAIN (FORMAT JSON) " + orderChangeMarkSql, [
        scope.brandReference,
        scope.storeReference,
        orderChangeWindowStart(world.now()),
      ]);
      return explained.rows[0]["QUERY PLAN"][0].Plan;
    });
    const nodes = [];
    const parents = new Map();
    const walk = (node) => {
      nodes.push(node);
      for (const child of node.Plans ?? []) {
        parents.set(child, node);
        walk(child);
      }
    };
    walk(plan);
    assert.ok(!nodes.some((node) => node["Node Type"] === "Sort"), "no sort");
    assert.ok(!nodes.some((node) => /Seq Scan|Bitmap/u.test(node["Node Type"])), "no table scan");
    const scans = nodes.filter((node) => /Index/u.test(node["Node Type"]));
    for (const [table, at] of orderChangeKinds) {
      const own = scans.filter((node) => node["Relation Name"] === table);
      assert.equal(own.length, 2, table + ": the latest time and the window count");
      for (const node of own) {
        assert.match(String(node["Index Cond"]), /brand_id/u, table + ": by its Store");
        assert.match(String(node["Index Cond"]), /store_id/u, table + ": by its Store");
        assert.match(String(node["Index Name"]), /store/u, table + ": a Store-leading index");
      }
      assert.ok(
        own.some((node) => String(node["Index Cond"]).includes(at)),
        table + ": the count reads only the window",
      );
      assert.ok(
        own.some(
          (node) =>
            // Limit 1 over the scan, with only the row-security filter of the Store between them.
            [parents.get(node), parents.get(parents.get(node))].some(
              (above) => above?.["Node Type"] === "Limit",
            ) && !String(node["Index Cond"]).includes(at),
        ),
        table + ": the latest time is one row read from the end of the index",
      );
    }
  });
});
