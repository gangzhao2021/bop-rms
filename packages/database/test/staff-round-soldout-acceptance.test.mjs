import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { stdout } from "node:process";
import pg from "pg";
import { it, vi } from "vitest";
import { createMerchantAvailability } from "../../../apps/api/src/merchant-availability.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;

/**
 * WP-2423 (staff-round-soldout, v15 8911a4c1 M06): guests at a table left a dish in their shared
 * Cart that then sold out (or went off the menu). Staff taking the table's next round were told
 * "the system couldn't send it" (503 staff_round_unavailable) and could not send anything. Now the
 * refusal marks that dish, staff remove it and send the rest, and the Ordering owner's own rule
 * decides at that instant whether another guest's line may be removed.
 *
 * Everything runs through the pilot's real staff round composition (`createInternalCounterOrder`)
 * under the restricted NOBYPASSRLS API role holding the rendered pilot ACL, with real staff
 * sessions; the guest phone is the same table guest path (QR entry, join with the table code,
 * binding, the table's Cart). Only an interrupted quote step (a dish selling out at that moment)
 * is a test hook. Synthetic TEST references only.
 */
async function soldOutTable(store, label) {
  const { soup, tea, tableReference, reference, now } = store;
  const server = await store.staff(label(0x700), [
    "ordering.order.create_staff",
    "dining.operate",
    "dining.session.close",
    "catalog.sku.sold_out.mark",
    "catalog.sku.availability.manage",
    "catalog.sku.read",
  ]);
  const as = { sessionCookie: server.sessionCookie, csrf: server.csrf };
  // The pilot's own round; its quote step can be interrupted (a dish sells out at that moment).
  let pipeline = null;
  const counter = await store.counterFor(server, {
    decorateStaffRoundPipeline: (real) => (pipeline = { ...real }),
  });
  const availability = createMerchantAvailability({
    persistence: store.persistenceOf(server),
    authentication: server.authentication,
    references: { next: reference },
    locale: "en-CA",
  });
  const mark = (action, skuReference) =>
    availability.command({
      ...as,
      body: {
        action,
        operationReference: reference(),
        skuReference,
        ...(action === "SoldOut" ? { until: "UntilBack" } : {}),
      },
    });

  // A guest at the table scans, joins with the table code and puts tea and soup in the Cart.
  const table = await pipeline.openTable(as, { tableReference });
  assert.equal(table.status, "Opened");
  const entered = await pipeline.enter({ tableReference, requestedAt: now() });
  assert.equal(entered.status, "Established");
  const joined = await pipeline.join(entered.credentials, {
    joinCredential: table.joinCredential,
    operationReference: reference(),
  });
  const phone = (
    await pipeline.bind(entered.credentials, {
      operationReference: reference(),
      admissionReference: joined.admissionReference,
    })
  ).credentials;
  const phoneCart = () =>
    pipeline.selectCart(phone, { operationReference: reference(), requestedAt: now() });
  let cart = await phoneCart();
  for (const sellableReference of [tea.skuReference, soup.skuReference]) {
    const added = await pipeline.addItem(phone, {
      operationReference: reference(),
      cartReference: cart.cartReference,
      expectedCartVersion: cart.cartVersion,
      sellableReference,
      quantity: 1,
      optionSelections: [],
      customerNote: null,
      requestedAt: now(),
    });
    assert.equal(added.status, "Applied");
    cart = await phoneCart();
  }
  const lineOf = (sku) =>
    store.asApi(async (tx) => {
      const found = await tx.query(
        "SELECT cart_line_id::text AS line FROM rms_ordering.cart_line WHERE cart_id=$1 AND sellable_id=$2",
        [cart.cartReference, sku],
      );
      return found.rows[0]?.line ?? null;
    });
  const teaLine = await lineOf(tea.skuReference),
    soupLine = await lineOf(soup.skuReference);
  assert.ok(teaLine !== null && soupLine !== null);

  /** The round staff take for the table: one dish of their own (the soup is the guests'). */
  const send = (command = {}) =>
    counter.staffDiningRound({
      ...as,
      command: {
        operationReference: reference(),
        tableReference,
        lines: [
          { sellableReference: tea.skuReference, quantity: 2, optionSelections: [], note: null },
        ],
        tip: { kind: "None" },
        recordedAfterOutage: false,
        ...command,
      },
    });
  const refusal = (promise) =>
    promise.then(
      (value) => assert.fail("expected a refusal, got " + value.status),
      (error) => error,
    );
  return {
    server,
    actor: label(0x700),
    pipeline: () => pipeline,
    mark,
    send,
    refusal,
    cartReference: cart.cartReference,
    teaLine,
    soupLine,
  };
}

const facts = async (admin, cartReference) => {
  const [cart] = (
    await admin.query(
      "SELECT aggregate_version AS version,(SELECT coalesce(json_agg(json_build_object('line',l.cart_line_id::text,'sku',l.sellable_id::text,'quantity',l.quantity) ORDER BY l.added_at),'[]') FROM rms_ordering.cart_line l WHERE l.cart_id=c.cart_id) AS lines FROM rms_ordering.cart c WHERE c.cart_id::text=$1",
      [cartReference],
    )
  ).rows;
  const [counts] = (
    await admin.query(
      "SELECT (SELECT count(*)::int FROM rms_ordering.order_batch) AS batches,(SELECT count(*)::int FROM rms_ordering.order_item) AS items",
    )
  ).rows;
  return { ...cart, ...counts };
};
const orderedItems = async (admin, orderBatchReference) =>
  (
    await admin.query(
      "SELECT transaction_snapshot_json->'catalog'->>'sellableReference' AS sku,quantity FROM rms_ordering.order_item WHERE order_batch_id::text=$1 ORDER BY quantity,sku",
      [orderBatchReference],
    )
  ).rows;
/**
 * WP-2423 M06/M35: the staff removal of a line: by whom (the staff member), why, at which cart
 * version, and its audit record. The guest Cart's own remove is never used for another's line.
 */
const removal = async (admin, cartReference, line) =>
  (
    await admin.query(
      "SELECT r.actor_id::text AS actor,r.reason_code AS reason,r.result_aggregate_version AS version,(SELECT count(*)::int FROM platform_audit.audit_record a WHERE a.audit_id=r.audit_id AND a.action_code='ORDERING_CART_ITEM_REMOVE_BY_STAFF') AS audits FROM rms_ordering.cart_staff_line_removal r WHERE r.cart_id::text=$1 AND r.cart_line_id::text=$2",
      [cartReference, line],
    )
  ).rows;
const guestRemoves = async (admin, cartReference, line) =>
  (
    await admin.query(
      "SELECT count(*)::int AS n FROM rms_ordering.cart_operation_record WHERE cart_id::text=$1 AND cart_line_id::text=$2 AND action_code='Remove'",
      [cartReference, line],
    )
  ).rows[0].n;
const entryCount = async (admin) =>
  (await admin.query("SELECT count(*)::int AS n FROM rms_ordering.staff_dining_round_entry"))
    .rows[0].n;
const restrictedRoleRan = async (store, api) =>
  assert.deepEqual(
    await store.asApi(async (tx) => {
      const seen = await tx.query(
        "SELECT current_user AS who,(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass",
        [],
      );
      return seen.rows[0];
    }),
    { who: api, bypass: false },
  );

it("a guest's sold-out dish is marked; staff remove it and send the rest, a dish still sold stays", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_srs_payfirst" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_srs");
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayFirst" });
      const label = (n) => "01a0fe00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
      const t = await soldOutTable(store, label);
      const { soup, tea } = store;
      await t.mark("SoldOut", soup.skuReference);
      const before = await facts(admin, t.cartReference);
      assert.deepEqual(
        before.lines.map((line) => line.line),
        [t.teaLine, t.soupLine],
      );

      // Sent as it was before: the guests' items are named at once, read only (WP-2423 M35):
      // no table guest joined and nothing about the round was recorded.
      const first = await t.refusal(t.send());
      assert.equal(first.code, "STAFF_ROUND_TABLE_CART_HAS_ITEMS");
      assert.deepEqual(
        first.pendingItems.map((item) => item.cartItemReference),
        [t.teaLine, t.soupLine],
      );
      assert.equal(first.tableCart.cartVersion, before.version);
      assert.equal(await entryCount(admin), 0, "a refusal before the table leaves no entry");
      // Taking the whole Cart in without deciding on the soup: refused, never "the system
      // couldn't send it" (v15 8911a4c1: 503 staff_round_unavailable); the soup is marked.
      const whole = await t.refusal(
        t.send({ includeTableCart: { expectedCartVersion: before.version } }),
      );
      assert.equal(whole.code, "STAFF_ROUND_TABLE_CART_HAS_ITEMS");
      assert.deepEqual(
        whole.pendingItems.map((item) => [item.cartItemReference, item.standing]),
        [
          [t.teaLine, "Available"],
          [t.soupLine, "Unavailable"],
        ],
      );
      assert.equal(whole.tableCart.cartVersion, before.version);
      assert.equal((await facts(admin, t.cartReference)).version, before.version);

      // Decisions for a cart version that moved on: refused read only, nothing removed.
      const entriesBefore = await entryCount(admin);
      const stale = await t.refusal(
        t.send({
          includeTableCart: {
            expectedCartVersion: before.version - 1,
            lines: [
              { cartItemReference: t.teaLine, decision: "Send" },
              { cartItemReference: t.soupLine, decision: "Remove", reason: "CantMake" },
            ],
          },
        }),
      );
      assert.equal(stale.code, "STAFF_ROUND_TABLE_CART_HAS_ITEMS");
      assert.equal(await entryCount(admin), entriesBefore);
      assert.deepEqual(await removal(admin, t.cartReference, t.soupLine), []);

      // As staff decide on each line: the soup out (the kitchen can't make it), the tea sent.
      // M35: one request, measured on this test database (the pilot's own composition).
      const started = performance.now();
      const placed = await t.send({
        includeTableCart: {
          expectedCartVersion: before.version,
          lines: [
            { cartItemReference: t.teaLine, decision: "Send" },
            { cartItemReference: t.soupLine, decision: "Remove", reason: "CantMake" },
          ],
        },
      });
      const elapsed = Math.round(performance.now() - started);
      assert.equal(placed.status, "Placed");
      // Recorded, not a gate here: the bundle's < 2 s budget is NOT met and is an Owner-visible
      // exception in WP-2423 (2026-11-10). Measured per step on this container database
      // (4.1 s in all): payment preparation 1.95 s, checkout 0.64 s, quote 0.48 s, the table
      // guest and cart steps 0.85 s; the staff decision adds one read-only check and one removal
      // transaction (about 0.2 s). v15 measured 2.34 s for a staff round before this bundle.
      stdout.write(`[M35] staff round with a guest line removed and one sent: ${elapsed} ms\n`);
      assert.deepEqual(await orderedItems(admin, placed.orderBatchReference), [
        { sku: tea.skuReference, quantity: 1 },
        { sku: tea.skuReference, quantity: 2 },
      ]);
      // The soup left the Cart as the staff member's own removal, with why, audited, at the next
      // Cart version; never by the guest Cart's remove, and it was never ordered.
      const removed = await removal(admin, t.cartReference, t.soupLine);
      assert.equal(removed.length, 1);
      assert.deepEqual(
        [removed[0].actor, removed[0].reason, removed[0].audits, removed[0].version],
        [t.actor, "CantMake", 1, before.version + 1],
      );
      assert.equal(await guestRemoves(admin, t.cartReference, t.soupLine), 0);
      assert.equal(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_ordering.order_item WHERE transaction_snapshot_json->'catalog'->>'sellableReference'=$1",
            [soup.skuReference],
          )
        ).rows[0].n,
        0,
      );
      await restrictedRoleRan(store, api);
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

it("pay later: a guest's dish sold out just before the quote is marked, the round's lines come out, then the rest is sent", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_srs_paylater" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_srl");
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayLater" });
      const label = (n) => "01a0fd00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
      const t = await soldOutTable(store, label);
      const { soup, tea } = store;
      const before = await facts(admin, t.cartReference);

      // Staff see the guests' tea and soup, both sellable, and add them to the round.
      const shown = await t.refusal(t.send());
      assert.deepEqual(
        shown.pendingItems.map((item) => item.standing),
        ["Available", "Available"],
      );
      // The soup sells out between that and the round's quote (the kitchen marks it).
      const pipeline = t.pipeline();
      const realQuote = pipeline.quote;
      let marked = false;
      pipeline.quote = async (...args) => {
        if (!marked) {
          marked = true;
          await t.mark("SoldOut", soup.skuReference);
        }
        return realQuote(...args);
      };
      const raced = await t.refusal(
        t.send({ includeTableCart: { expectedCartVersion: shown.tableCart.cartVersion } }),
      );
      pipeline.quote = realQuote;
      assert.equal(raced.code, "STAFF_ROUND_TABLE_CART_HAS_ITEMS");
      const soupShown = raced.pendingItems.find((item) => item.cartItemReference === t.soupLine);
      assert.equal(soupShown?.standing, "Unavailable");
      // The round's own lines came back out: the guests' Cart holds only their tea and soup,
      // nothing was ordered.
      const afterRace = await facts(admin, t.cartReference);
      assert.deepEqual(
        afterRace.lines.map((line) => line.line),
        [t.teaLine, t.soupLine],
      );
      assert.equal(afterRace.batches, before.batches);
      assert.equal(raced.tableCart.cartVersion, afterRace.version);

      // Read again (read only, before the table): both lines are listed to decide on.
      const markedNow = await t.refusal(t.send());
      assert.deepEqual(
        markedNow.pendingItems.map((item) => item.cartItemReference),
        [t.teaLine, t.soupLine],
      );
      // Staff remove it as they were shown it at the quote, and send the rest: to the kitchen,
      // to be paid at the end.
      const command = {
        operationReference: store.reference(),
        includeTableCart: {
          expectedCartVersion: raced.tableCart.cartVersion,
          removeUnavailable: [t.soupLine],
        },
      };
      const placed = await t.send(command);
      assert.deepEqual([placed.status, placed.payLater], ["Placed", true]);
      assert.deepEqual(await orderedItems(admin, placed.orderBatchReference), [
        { sku: tea.skuReference, quantity: 1 },
        { sku: tea.skuReference, quantity: 2 },
      ]);
      // The earlier screens' form: the listed line leaves as the staff member's removal too.
      assert.deepEqual(
        (await removal(admin, t.cartReference, t.soupLine)).map((row) => [row.actor, row.reason]),
        [[t.actor, "CantMake"]],
      );
      // A retry of the same command returns the same round and orders nothing twice.
      const counted = await facts(admin, t.cartReference);
      const again = await t.send(command);
      assert.equal(again.status, "AlreadyPlaced");
      assert.equal(again.orderBatchReference, placed.orderBatchReference);
      assert.deepEqual(
        [
          (await facts(admin, t.cartReference)).items,
          (await facts(admin, t.cartReference)).batches,
        ],
        [counted.items, counted.batches],
      );
      await restrictedRoleRan(store, api);
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
