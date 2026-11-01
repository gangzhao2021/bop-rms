import assert from "node:assert/strict";
import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  createMerchantStoreSupport,
  createMerchantStoreSupportAccess,
  maskGuestName,
  ownerOnlySupportActions,
} from "../../../apps/api/dist/merchant-store-support.js";
import { createMerchantStoreScope } from "../../../apps/api/dist/merchant-store-scope.js";
import { seedMerchantAcceptanceSession } from "./merchant-acceptance-session.mjs";
import { createPaidPickupOrderSeeder } from "./ordinary-refund-paid-pickup-order.mjs";

const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const LINES = [
  {
    unitAmountMinor: 2000,
    quantity: 4,
    localizedNames: { "en-CA": "Synthetic noodles", "fr-CA": "Nouilles synthétiques" },
  },
  {
    unitAmountMinor: 1000,
    quantity: 2,
    localizedNames: { "en-CA": "Synthetic tea", "fr-CA": "Thé synthétique" },
  },
];
export async function exercisePilotPlatformSupport(context) {
  const { admin, scope, store, owner, next, now, transactions, listen, id, session, manager } =
    context;
  const brand = scope.brandReference;
  const here = { ...scope, storeReference: store };
  const ownerRole = "01902431-0000-7000-8000-000000000004";
  const base = Date.now();
  const time = (offset) => new Date(base + offset).toISOString();
  const minutes = (n) => n * 60_000;
  const from = time(-minutes(60)),
    until = time(minutes(600));
  // Owner's template permission for the section (owner-seeded Permission facts, as the harness does).
  const grantToOwner = async (action, n) => {
    let permission = (
      await admin.query(
        "SELECT permission_id FROM bop_permission.permission_definition WHERE action_code=$1",
        [action],
      )
    ).rows[0]?.permission_id;
    if (permission === undefined) {
      permission = id(0x9c000 + n);
      await admin.query(
        "INSERT INTO bop_permission.permission_definition VALUES($1,$2,'Active',1,$3,$3)",
        [permission, action, from],
      );
    }
    await admin.query(
      "INSERT INTO bop_permission.permission_grant VALUES($1,$2,$3,$4,$5,'Active',$6,$7,1,$6,$6)",
      [id(0x9c100 + n), ownerRole, permission, brand, store, from, until],
    );
  };
  await grantToOwner("organization.support_access.manage", 1);

  // A support person who was also given a Store role (their membership and grants are real here):
  // the merchant scope must refuse them anyway, whatever the role says.
  const supportActor = id(0x9c200);
  const support = await seedMerchantAcceptanceSession({
    admin,
    runner: transactions,
    scope,
    actor: supportActor,
    at: now(),
    referencePrefix: "01a9c000",
    sessionReferencePrefix: "01a9c001",
    extraPermissions: ["payment.refund.create", "ordering.order.comp", "organization.staff.manage"],
  });
  support.actor = supportActor;
  const addPerson = (version, lifecycle, actions, effectiveUntil) =>
    admin.query(
      "INSERT INTO bop_permission.platform_support_person (actor_id,version,display_name,lifecycle,actions,effective_until,recorded_by_reason,recorded_at) VALUES ($1,$2,'TEST Support Sam',$3,$4,$5,'TEST persona',$6)",
      [supportActor, version, lifecycle, actions, effectiveUntil, from],
    );
  const moneyAllowedBefore = await transactions.run(async (tx) => {
    const current = await createMerchantStoreScope(support.persistence)(
      tx,
      support.sessionCookie,
      "payment.refund.create",
    );
    return current.allowed();
  });
  assert.equal(moneyAllowedBefore, true, "the seeded role does hold it before they are support");
  // Holding a role, they can't become support; the role ended, they can, and then can't get one.
  await assert.rejects(
    addPerson(1, "Active", ["platform.support.view", "platform.support.change"], until),
    /holding a Store role/u,
  );
  const held = (
    await admin.query(
      "SELECT assignment_id FROM bop_permission.role_assignment WHERE actor_id=$1",
      [supportActor],
    )
  ).rows;
  await admin.query(
    "UPDATE bop_permission.role_assignment SET lifecycle='Ended',version=version+1 WHERE actor_id=$1",
    [supportActor],
  );
  await addPerson(1, "Active", ["platform.support.view", "platform.support.change"], until);
  await assert.rejects(
    admin.query(
      "INSERT INTO bop_permission.role_assignment SELECT $1,role_id,membership_id,store_assignment_id,actor_id,brand_id,store_id,'Active',effective_from,effective_until,1,created_at,updated_at FROM bop_permission.role_assignment WHERE assignment_id=$2",
      [id(0x9c201), held[0].assignment_id],
    ),
    /cannot hold a Store role/u,
  );
  // No role, so every Store command is refused: money and access among them.
  for (const action of [
    "payment.refund.create",
    "ordering.order.comp",
    "organization.staff.manage",
  ]) {
    const allowed = await transactions
      .run(async (tx) =>
        (
          await createMerchantStoreScope(support.persistence)(tx, support.sessionCookie, action)
        ).allowed(),
      )
      .catch(() => false);
    assert.equal(allowed, false, action);
  }

  // A paid order with a real pickup contact (owner-seeded TEST-ONLY facts).
  const orderId = (n) => "01a9c100-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const ownerRunner = {
    async run(work) {
      const client = new (await import("pg")).default.Client(context.clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [scope.tenantReference, brand, store],
        );
        const result = await work({
          query: (sql, values) => client.query(sql, values === undefined ? [] : [...values]),
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await client.end();
      }
    },
  };
  await createPaidPickupOrderSeeder({
    admin,
    ownerRunner,
    scope: { ...scope, storeReference: store },
    id: orderId,
    hash,
    fresh: next,
    time,
    minutes,
    acceptorReference: owner,
    provider: next(),
    lines: LINES,
    tipMinor: 300n,
    capturedMinor: 11600n,
  })(1000);
  const orderReference = String(
    (
      await admin.query(
        "SELECT order_id FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 ORDER BY created_at DESC LIMIT 1",
        [brand, store],
      )
    ).rows[0].order_id,
  );
  const { submission_id: submission, source_cart_id: cart } = (
    await admin.query(
      "SELECT s.submission_id,b.source_cart_id FROM rms_ordering.order_submission_record s JOIN rms_ordering.order_batch b ON b.submission_id=s.submission_id WHERE s.order_id=$1 LIMIT 1",
      [orderReference],
    )
  ).rows[0];
  const details = next();
  const phone = "+14165550123";
  await admin.query("SET session_replication_role = replica");
  await admin.query(
    "INSERT INTO rms_ordering.checkout_details_record (brand_id,store_id,details_id,details_version,operation_id,guest_session_id,cart_id,snapshot_json,recorded_at) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8)",
    [
      brand,
      store,
      details,
      next(),
      id(0x9c300),
      cart,
      {
        schemaVersion: 1,
        detailsReference: details,
        detailsVersion: 1,
        guestSessionReference: id(0x9c300),
        brandReference: brand,
        storeReference: store,
        cartReference: cart,
        cartVersion: 1,
        quoteReference: id(0x9c301),
        quoteVersion: 2,
        orderType: "Pickup",
        pickupContact: { name: "Synthetic Guest", channel: "Phone", value: phone },
        receipt: { choice: "InSession", email: null },
        policies: [],
        recordedAt: time(0),
      },
      time(0),
    ],
  );
  await admin.query(
    "INSERT INTO rms_ordering.order_checkout_details_link (brand_id,store_id,submission_id,order_id,details_id,details_version) VALUES ($1,$2,$3,$4,$5,1)",
    [brand, store, submission, orderReference, details],
  );
  await admin.query("SET session_replication_role = origin");

  // The harness's sign-in double, with what the real service adds: the session without a workspace.
  const known = (cookie) => [session, manager, support].find((one) => one.sessionCookie === cookie);
  const routes = (persistence, authentication) => ({
    storeSupport: createMerchantStoreSupport({
      persistence,
      authentication: {
        ...authentication,
        sessionBootstrap: async (cookie) => {
          const csrf = known(cookie).csrf;
          return {
            session: await authentication.authorize({ sessionCookie: cookie, csrf }),
            csrf,
          };
        },
      },
      stores: () => [here],
      nextReference: next,
      locale: "en-CA",
    }),
    storeSupportAccess: createMerchantStoreSupportAccess({ persistence, authentication }),
  });
  const logRows = async (kind) =>
    Number(
      (
        await admin.query(
          "SELECT count(*) n FROM bop_permission.store_support_access_log WHERE brand_id=$1 AND store_id=$2 AND kind=$3",
          [brand, store, kind],
        )
      ).rows[0].n,
    );
  const features = async () =>
    (
      await admin.query(
        "SELECT version,pickup,actor_id FROM rms_store.store_feature_setting WHERE brand_id=$1 AND store_id=$2 ORDER BY version DESC LIMIT 1",
        [brand, store],
      )
    ).rows[0];

  // 1. A person who is not support is refused; so is the Owner on the support routes.
  await listen(
    session,
    async (send) => {
      assert.equal((await send("support/session")).status, 403);
      assert.equal((await send("support/store/view", { storeReference: store })).status, 403);
    },
    routes,
  );

  // 2-6: support at work; the Owner's permission read each time.
  let pickupVersion;
  const owner_ = {
    allow: null,
  };
  await listen(
    support,
    async (send) => {
      // Viewing needs no consent, is recorded, and the guest's contact stays hidden.
      const me = await send("support/session");
      assert.equal(me.status, 200, JSON.stringify(me.body));
      assert.equal(me.body.name, "TEST Support Sam");
      assert.deepEqual(
        me.body.stores.map((entry) => entry.storeReference),
        [store],
      );
      const viewed = await send("support/store/view", { storeReference: store });
      assert.equal(viewed.status, 200, JSON.stringify(viewed.body));
      assert.equal(await logRows("Viewed"), 1);
      assert.equal(viewed.body.ownerAllowsChanges, false);
      assert.equal(viewed.body.orders.length, 1);
      assert.equal(viewed.body.orders[0].guest, "S…");
      const text = JSON.stringify(viewed.body);
      assert.equal(text.includes("Synthetic Guest"), false);
      assert.equal(text.includes(phone), false);
      assert.equal(text.includes(orderReference), false);
      assert.equal(maskGuestName("  "), null);
      pickupVersion = viewed.body.features.version;
      // Another Store: refused, nothing read or recorded.
      assert.equal((await send("support/store/view", { storeReference: id(0x9e01) })).status, 403);
      assert.equal(await logRows("Viewed"), 1);

      // No live permission: refused, recorded, nothing changed.
      const before = await features();
      const refused = await send("support/store/command", {
        storeReference: store,
        command: {
          operationReference: next(),
          action: "SetPickup",
          expectedVersion: pickupVersion,
          value: false,
        },
      });
      assert.equal(refused.status, 403);
      assert.deepEqual(refused.body, { error: "not_allowed_by_owner" });
      assert.equal(await logRows("Refused"), 1);
      assert.deepEqual(await features(), before);
      // The Owner's own section is not theirs.
      assert.equal((await send("store/support-access")).status, 403);
    },
    routes,
  );

  // The Owner allows; another staff member can't.
  await listen(
    manager,
    async (send) => assert.equal((await send("store/support-access")).status, 403),
    routes,
  );
  let ownerVersion;
  await listen(
    session,
    async (send) => {
      const read = await send("store/support-access");
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.equal(read.body.mode, "Off");
      assert.equal(read.body.log[0].supportName, "TEST Support Sam");
      const allowed = await send("store/support-access", {
        operationReference: next(),
        expectedVersion: read.body.version,
        mode: "Standing",
        hours: null,
      });
      assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
      assert.equal(allowed.body.mode, "Standing");
      ownerVersion = allowed.body.version;
    },
    routes,
  );
  const allowedFeature = () => ({
    storeReference: store,
    command: {
      operationReference: next(),
      action: "SetPickup",
      expectedVersion: pickupVersion,
      value: false,
    },
  });
  await listen(
    support,
    async (send) => {
      // Allowed: attributed to the support person, never the Owner.
      const changed = await send("support/store/command", allowedFeature());
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      const row = await features();
      assert.equal(row.pickup, false);
      assert.equal(row.actor_id, supportActor);
      pickupVersion = row.version;
      assert.equal(await logRows("Changed"), 1);
      // The kitchen: the routing's audit names the support person.
      const kitchen = await send("support/store/command", {
        storeReference: store,
        command: { operationReference: next(), action: "SetUpKitchenLine", expectedVersion: 0 },
      });
      assert.equal(kitchen.status, 200, JSON.stringify(kitchen.body));
      const audit = (
        await admin.query(
          "SELECT actor_reference,reason_code FROM platform_audit.audit_record WHERE action_code='KITCHEN_ROUTING_CONFIGURATION_RECORDED' AND store_id=$1",
          [store],
        )
      ).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0].actor_reference, supportActor);
      assert.equal(audit[0].reason_code, "PLATFORM_SUPPORT_CHANGE");

      // Money and access: refused while changes are allowed, whatever it is, and recorded.
      const refunds = await logRows("Refused");
      for (const action of ownerOnlySupportActions) {
        const refused = await send("support/store/command", {
          storeReference: store,
          command: { operationReference: next(), action, expectedVersion: 0 },
        });
        assert.equal(refused.status, 403, action);
        assert.deepEqual(refused.body, { error: "owner_only" });
      }
      assert.equal(await logRows("Refused"), refunds + ownerOnlySupportActions.length);
    },
    routes,
  );

  // Off at once; then a limited time, and past it nothing is allowed, by itself.
  await listen(
    session,
    async (send) => {
      const off = await send("store/support-access", {
        operationReference: next(),
        expectedVersion: ownerVersion,
        mode: "Off",
        hours: null,
      });
      assert.equal(off.body.mode, "Off");
      ownerVersion = off.body.version;
    },
    routes,
  );
  await listen(
    support,
    async (send) => {
      assert.equal((await send("support/store/command", allowedFeature())).status, 403);
    },
    routes,
  );
  await listen(
    session,
    async (send) => {
      const limited = await send("store/support-access", {
        operationReference: next(),
        expectedVersion: ownerVersion,
        mode: "Limited",
        hours: 1,
      });
      assert.equal(limited.body.mode, "Limited");
      assert.ok(Date.parse(limited.body.allowedUntil) > Date.now());
      ownerVersion = limited.body.version;
    },
    routes,
  );
  await listen(
    support,
    async (send) => {
      const viewed = await send("support/store/view", { storeReference: store });
      assert.equal(viewed.body.ownerAllowsChanges, true);
    },
    routes,
  );
  // The hour has passed (an owner-written row: the time can't be moved otherwise).
  await admin.query(
    "INSERT INTO bop_permission.store_support_permission (brand_id,store_id,version,operation_id,mode,allowed_until,actor_id,occurred_at) VALUES ($1,$2,$3,$4,'Limited',$5,$6,$7)",
    [brand, store, ownerVersion + 1, next(), time(-minutes(1)), owner, time(-minutes(61))],
  );
  await listen(
    support,
    async (send) => {
      const viewed = await send("support/store/view", { storeReference: store });
      assert.equal(viewed.body.ownerAllowsChanges, false);
      assert.equal((await send("support/store/command", allowedFeature())).status, 403);
    },
    routes,
  );
  await listen(
    session,
    async (send) => {
      const read = await send("store/support-access");
      assert.equal(read.body.mode, "Off");
      const kinds = read.body.log.map((entry) => entry.kind);
      assert.ok(kinds.includes("Changed") && kinds.includes("Refused") && kinds.includes("Viewed"));
    },
    routes,
  );

  // The record can't be rewritten, and another Store's scope sees none of it (restricted role).
  await assert.rejects(
    admin.query("UPDATE bop_permission.store_support_access_log SET kind='Viewed'"),
    /append-only/u,
  );
  const seen = await transactions.run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      id(0x9e01),
    ]);
    return (await tx.query("SELECT count(*) n FROM bop_permission.store_support_access_log", []))
      .rows[0].n;
  });
  assert.equal(Number(seen), 0);

  // Support ended: at once, nothing.
  await addPerson(2, "Ended", [], until);
  await listen(
    support,
    async (send) => assert.equal((await send("support/session")).status, 403),
    routes,
  );
}
