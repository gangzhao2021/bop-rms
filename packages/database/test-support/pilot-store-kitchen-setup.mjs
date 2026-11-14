import assert from "node:assert/strict";
import { createMerchantKitchenSetup } from "../../../apps/api/dist/merchant-kitchen-setup.js";
import { menuListingGaps } from "../../../apps/api/dist/menu-option-gates.js";
import { storeTakesOrder } from "../../../apps/api/dist/customer-store-open-gate.js";
import { counterTakesOrder } from "../../../apps/api/dist/merchant-counter-order.js";
import { createKitchenGatedOperatingStatusReader } from "../../../apps/api/dist/store-kitchen-open-gate.js";
import { seedMerchantAcceptanceSession } from "./merchant-acceptance-session.mjs";

/**
 * Runs on a published Store with no kitchen routing. A staff member without the permission and a
 * Store other than the session's are refused or untouched; the routing is written and read by the
 * same restricted role the Store's other commands use.
 */
export async function exercisePilotStoreKitchenSetup(context) {
  const { admin, scope, store, next, now, transactions, listen, id, resources, session } = context;
  const brand = scope.brandReference;
  // The Owner's permissions for this section (owner-seeded Permission facts, as the harness does).
  const ownerRole = "01902431-0000-7000-8000-000000000004";
  const grant = async (action, n) => {
    const from = new Date(Date.parse(now()) - 3_600_000).toISOString();
    let permission = (
      await admin.query(
        "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
        [action],
      )
    ).rows[0]?.permission_id;
    if (!permission) {
      permission = id(0x9d000 + n);
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
        [permission, action, from],
      );
    }
    const until = new Date(Date.parse(now()) + 3_600_000).toISOString();
    // Store setup publication may have granted it already (it publishes the Store's phone).
    await admin.query(
      "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6) ON CONFLICT DO NOTHING",
      [id(0x9d100 + n), ownerRole, permission, brand, store, from, until],
    );
  };
  const routes = (persistence, authentication) => ({
    kitchenSetup: createMerchantKitchenSetup({
      persistence,
      authentication,
      nextReference: next,
      locale: "en",
    }),
  });
  const rows = async (storeReference) =>
    (
      await admin.query(
        "SELECT version_number,effective_from,recorded_at FROM rms_kitchen.kitchen_routing_configuration WHERE brand_id=$1 AND store_id=$2 ORDER BY version_number",
        [brand, storeReference],
      )
    ).rows;
  const statusNow = () =>
    transactions.run((tx) =>
      createKitchenGatedOperatingStatusReader(resources.operating)(tx, now()),
    );
  const gaps = () =>
    transactions.run((tx) =>
      menuListingGaps(tx, {
        owner: { brandReference: brand, storeReference: store },
        observedAt: now(),
        menu: { sections: [], orderTypeCodes: [], storeReferences: [] },
      }),
    );
  const audits = async () =>
    Number(
      (
        await admin.query(
          "SELECT count(*) n FROM platform_audit.audit_record WHERE action_code='KITCHEN_ROUTING_CONFIGURATION_RECORDED' AND brand_id=$1 AND store_id=$2",
          [brand, store],
        )
      ).rows[0].n,
    );
  // Store 1 stands for a running Store: routing recorded before this feature, by its own record.
  const otherStore = id(0x9e01);
  const otherBefore = await rows(otherStore);

  // 1. No routing: a menu here can't be listed and no path takes an order, with no way round.
  assert.deepEqual(await rows(store), []);
  assert.deepEqual(await gaps(), [
    { storeReference: store, skuReference: null, missing: "Kitchen", optionReference: null },
  ]);
  const closed = await statusNow();
  assert.equal(closed.state, "Closed");
  assert.deepEqual([...closed.availableServiceModes], []);
  assert.equal(storeTakesOrder(closed, "Pickup"), false);
  assert.equal(storeTakesOrder(closed, "SeatedDineIn"), false);
  assert.equal(storeTakesOrder(closed, "SeatedDineIn", "Staff"), false);
  assert.equal(counterTakesOrder(closed, { recordedAfterOutage: false }), false);
  assert.equal(counterTakesOrder(closed, { recordedAfterOutage: true }), false);

  // 2. Without the permission: refused, nothing written.
  const staff = await seedMerchantAcceptanceSession({
    admin,
    runner: context.seedRunner,
    scope,
    actor: id(0x9f10),
    at: now(),
    referencePrefix: "01a9f010",
    sessionReferencePrefix: "01a9f011",
  });
  staff.actor = id(0x9f10);
  await listen(
    staff,
    async (send) => {
      assert.equal((await send("store/kitchen-setup")).status, 403);
      const refused = await send("store/kitchen-setup", {
        operationReference: next(),
        expectedVersion: 0,
      });
      assert.equal(refused.status, 403);
    },
    routes,
  );
  assert.deepEqual(await rows(store), []);

  // 3. The Owner: what is missing, then one step, in effect from now, read back after a reload.
  await grant("organization.store.read", 1);
  await grant("organization.store.update", 2);
  await listen(
    session,
    async (send) => {
      const opened = await send("store/kitchen-setup");
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      assert.deepEqual(opened.body, {
        canChange: true,
        version: 0,
        inEffectFrom: null,
        uncoveredDishes: [],
      });
      // The Store is the session's: a command can't name another.
      const named = await send("store/kitchen-setup", {
        operationReference: next(),
        expectedVersion: 0,
        storeReference: otherStore,
      });
      assert.equal(named.status, 422);
      const operationReference = next();
      const before = now();
      const set = await send("store/kitchen-setup", { operationReference, expectedVersion: 0 });
      assert.equal(set.status, 200, JSON.stringify(set.body));
      assert.deepEqual(set.body, { status: "Recorded", version: 1 });
      const read = await send("store/kitchen-setup");
      assert.equal(read.body.version, 1);
      assert.ok(read.body.inEffectFrom >= before, "never back-dated");
      assert.deepEqual(read.body.uncoveredDishes, []);
      assert.equal(await audits(), 1);
      // The same operation again: what it recorded, nothing new.
      const again = await send("store/kitchen-setup", { operationReference, expectedVersion: 0 });
      assert.equal(again.status, 200);
      assert.deepEqual(again.body, { status: "AlreadyRecorded", version: 1 });
      // Nothing to change: nothing recorded.
      const unchanged = await send("store/kitchen-setup", {
        operationReference: next(),
        expectedVersion: 1,
      });
      assert.equal(unchanged.status, 409);
      assert.deepEqual(unchanged.body, { error: "no_change" });
      assert.equal((await rows(store)).length, 1);
      assert.equal(await audits(), 1);
    },
    routes,
  );

  // 4. In effect: the Store's own status and nothing gating listing; the other Store untouched.
  const open = await statusNow();
  assert.notEqual(open.kitchenNotSetUp, true);
  assert.deepEqual(await gaps(), []);
  assert.deepEqual(await rows(otherStore), otherBefore);
}
