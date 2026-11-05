import { it } from "vitest";
import { withAutoAcceptWorld } from "../test-support/auto-accept-world.mjs";

const acceptanceOf = (world, batch) =>
  world.query(
    "SELECT actor_type,actor_id,reason_code,permission_code,expected_order_version::int AS expected,accepted_order_version::int AS accepted FROM rms_ordering.order_acceptance_record WHERE order_batch_id=$1",
    [batch],
  );
const waitsOf = (world, batch) =>
  world.query("SELECT 1 FROM rms_ordering.order_payment_acceptance_wait WHERE order_batch_id=$1", [
    batch,
  ]);
const dispositionOf = async (world, batch) =>
  (
    await world.query(
      "SELECT disposition,reason FROM rms_ordering.order_payment_disposition_record WHERE order_batch_id=$1",
      [batch],
    )
  )[0];
const reasonsOf = async (world, batch) =>
  (
    await world.query(
      "SELECT coalesce(reason_code,outcome) AS reason,setting_version::int AS version FROM rms_ordering.order_auto_acceptance_decision WHERE order_batch_id=$1 ORDER BY decided_at,decision_id",
      [batch],
    )
  ).map((row) => row.reason);

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT. Under the restricted NOBYPASSRLS role with the rendered pilot
 * ACL, real Orders paid online, and the worker's paid outcome as the pilot composes it.
 */
it("a paid pickup at a Store with the switch on reaches the kitchen without anyone pressing Accept", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aa_pickup", orderType: "Pickup" }, async (world) => {
    const { assert, paid, query, setting, kitchenScreen, transactions, seedPaidPickup } = world;
    await setting.change({ pickup: true, dineIn: false, at: world.time(-world.minutes(60)) });
    await kitchenScreen.seenNow();
    const order = await seedPaidPickup();
    const consumed = await transactions().run((tx) => paid.consume(tx, order.event));
    assert.equal(consumed.consumerOutcome.status, "processed");
    assert.equal(consumed.result.status, "OrderConfirmed");
    assert.deepEqual(await acceptanceOf(world, order.orderBatchReference), [
      {
        actor_type: "System",
        actor_id: null,
        reason_code: "STORE_AUTO_ACCEPT_PAID",
        permission_code: "order.accept",
        expected: 1,
        accepted: 2,
      },
    ]);
    assert.deepEqual(await waitsOf(world, order.orderBatchReference), []);
    assert.equal((await dispositionOf(world, order.orderBatchReference)).disposition, "Confirmed");
    const confirmed = await query(
      "SELECT 1 FROM platform_eventing.outbox_event WHERE event_type='OrderConfirmed' AND aggregate_id=$1",
      [order.orderReference],
    );
    assert.equal(confirmed.length, 1);
    assert.deepEqual(
      (
        await query(
          "SELECT state,version::int AS version FROM rms_fulfillment.capacity_asap_commitment WHERE order_id=$1 ORDER BY version",
          [order.orderReference],
        )
      ).map((row) => [row.state, row.version]),
      [
        ["Prepared", 1],
        ["PaymentPending", 2],
        ["Consumed", 3],
      ],
    );
    assert.deepEqual(
      await query(
        "SELECT actor_type,reason_code,source_channel,after_summary_json AS after_summary,retention_policy_code FROM platform_audit.audit_record WHERE action_code='ORDER_ACCEPTED' AND target_id=$1",
        [order.orderReference],
      ),
      [
        {
          actor_type: "System",
          reason_code: "STORE_AUTO_ACCEPT_PAID",
          source_channel: "EVENT_CONSUMER",
          after_summary: { phase: "Accepted" },
          retention_policy_code: "FINANCIAL_COMPLIANCE",
        },
      ],
    );
    assert.deepEqual(
      await query(
        "SELECT actor_type,source_channel FROM platform_audit.audit_record WHERE action_code='FULFILLMENT_ASAP_CAPACITY_CONSUMED' AND target_id::text IN (SELECT allocation_id::text FROM rms_fulfillment.capacity_asap_commitment WHERE order_id=$1)",
        [order.orderReference],
      ),
      [{ actor_type: "System", source_channel: "EVENT_CONSUMER" }],
    );
    assert.deepEqual(await reasonsOf(world, order.orderBatchReference), ["Accepted"]);
  });
});

it("a paid first round and a paid later round at a pay-first table go straight through", async () => {
  await withAutoAcceptWorld({ caseId: "wp2423_aa_table", orderType: "DineIn" }, async (world) => {
    const { assert, paid, query, setting, kitchenScreen, transactions } = world;
    await setting.change({ pickup: false, dineIn: true, at: world.time(-world.minutes(60)) });
    await kitchenScreen.seenNow();
    const first = await world.seedPaidTableRound();
    const consumed = await transactions().run((tx) => paid.consume(tx, first.event));
    assert.equal(consumed.result.status, "OrderConfirmed");
    assert.deepEqual(await waitsOf(world, first.orderBatchReference), []);
    const accepted = await acceptanceOf(world, first.orderBatchReference);
    assert.equal(accepted[0].actor_type, "System");
    assert.equal(accepted[0].reason_code, "STORE_AUTO_ACCEPT_PAID");
    const later = await world.seedPaidLaterRound({
      ...first,
      currentVersion: accepted[0].accepted,
    });
    const second = await transactions().run((tx) => paid.consume(tx, later.event));
    assert.equal(second.result.status, "OrderConfirmed");
    assert.deepEqual(await waitsOf(world, later.orderBatchReference), []);
    const acceptedLater = await acceptanceOf(world, later.orderBatchReference);
    assert.equal(acceptedLater[0].actor_type, "System");
    assert.equal(acceptedLater[0].actor_id, null);
    assert.equal(
      (
        await query(
          "SELECT count(*)::int AS n FROM platform_eventing.outbox_event WHERE event_type='OrderConfirmed' AND aggregate_id=$1",
          [first.orderReference],
        )
      )[0].n,
      2,
    );
    assert.deepEqual(await reasonsOf(world, later.orderBatchReference), ["Accepted"]);
  });
});
