import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { withPaidBatchAcceptance } from "../../../apps/api/src/merchant-card-machine-payment.ts";
import { loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import { createPostgresOrderStatusProjectionStore } from "../../rms/ordering/src/index.ts";
import { createInternalOrderSubmitted } from "../../../tooling/environment/pilot-order-submitted.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const id = (n) => "01a0fe00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const rounds = 22;

/**
 * v15 b13 order-projection-and-round-race (DEC-ORDER-STATUS-EVERY-ROUND). At DEMO Store 2 the
 * pilot worker's order status update failed on every retry for the 21st round of a dine-in table
 * (and held back every later update of that table's Order): the status stopped at 20 rounds.
 *
 * A table orders 22 rounds through the pilot's real staff round composition (each charged on the
 * card machine and accepted, as at a pay-first Store) under the restricted NOBYPASSRLS API role
 * with the rendered pilot ACL. The pilot's own order status consumer (createInternalOrderSubmitted,
 * as the business worker composes it) then takes every round's OrderSubmitted event in order on the
 * pilot's transaction runner as that same restricted role (the pilot's business worker role). Each
 * round reaches the status, and the guest's status read holds all 22. Synthetic TEST references.
 */
it("a table's 21st and later rounds reach the order status", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_long_table" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_ltb");
    const worker = api + "_w";
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayFirst" });
      const { soup, tableReference, reference, scope } = store;
      const server = await store.staff(id(0x710), [
        "ordering.order.create_staff",
        "dining.operate",
        "dining.session.close",
      ]);
      const counter = await store.counterFor(server);
      const pay = withPaidBatchAcceptance(counter.cardMachinePayment, {
        accept: await store.acceptanceFor(server),
        nextReference: reference,
      });
      const as = { sessionCookie: server.sessionCookie, csrf: server.csrf };
      let orderReference = null;
      for (let round = 1; round <= rounds; round += 1) {
        const placed = await counter.staffDiningRound({
          ...as,
          command: {
            operationReference: reference(),
            tableReference,
            tip: { kind: "None" },
            recordedAfterOutage: false,
            lines: [
              {
                sellableReference: soup.skuReference,
                quantity: 1,
                optionSelections: [],
                note: null,
              },
            ],
          },
        });
        assert.deepEqual([placed.status, placed.totalMinor], ["Placed", "735"], "round " + round);
        orderReference ??= placed.orderReference;
        assert.equal(placed.orderReference, orderReference);
        const paid = await pay({
          ...as,
          command: {
            operationReference: reference(),
            orderReference,
            orderBatchReference: placed.orderBatchReference,
            expectedTotalMinor: placed.totalMinor,
            slipReference: "AUTH 7712" + String(round).padStart(2, "0"),
            takenAt: null,
          },
        });
        assert.deepEqual([paid.status, paid.acceptance], ["Recorded", "Accepted"]);
      }

      // The pilot business worker's order status consumer. The pilot runs its business worker as
      // the API role (the eventing grants are the API role's), on the same transaction runner.
      const asWorker = store.restricted;
      const consumer = createInternalOrderSubmitted(store.resources);
      const events = (
        await admin.query(
          `SELECT event_id::text AS event, (payload_json->>'batchSequence')::int AS round
           FROM platform_eventing.outbox_event
           WHERE aggregate_id=$1 AND event_type='OrderSubmitted' ORDER BY aggregate_version`,
          [orderReference],
        )
      ).rows;
      assert.deepEqual(
        events.map((event) => event.round),
        Array.from({ length: rounds - 1 }, (_, index) => index + 2),
      );
      for (const event of events)
        assert.deepEqual(
          await asWorker.run(async (tx) =>
            consumer.consume(tx, await loadOutboxEnvelope(tx, event.event)),
          ),
          { status: "processed" },
          "round " + event.round,
        );
      const [projected] = (
        await admin.query(
          `SELECT p.source_version, jsonb_array_length(g.projection_snapshot_json->'batches') AS shown
           FROM rms_ordering.order_status_projection p
           JOIN rms_ordering.order_status_projection_generation g ON g.generation_id=p.generation_id
           WHERE p.order_id=$1`,
          [orderReference],
        )
      ).rows;
      const lastEvent = (
        await admin.query(
          "SELECT aggregate_version::int AS version FROM platform_eventing.outbox_event WHERE event_id=$1",
          [events.at(-1).event],
        )
      ).rows[0].version;
      assert.equal(projected.shown, rounds);
      assert.equal(projected.source_version, lastEvent);
      // Every delivery was recorded once, completed.
      const [{ completed }] = (
        await admin.query(
          `SELECT count(*)::int AS completed FROM platform_eventing.consumer_inbox
           WHERE consumer_name='ordering.order-status-projection:v1' AND status='completed'
             AND event_id = ANY($1::uuid[])`,
          [events.map((event) => event.event)],
        )
      ).rows;
      assert.equal(completed, rounds - 1);

      // The guest's status read, as the restricted API role: the stored status with all 22 rounds.
      // (The kitchen's per-round progress the guest page adds is read by its own reader, whose
      // round bound has its unit test: no kitchen tickets are made here without the kitchen worker.)
      const read = await store.asApi(async (tx) => {
        const status = await createPostgresOrderStatusProjectionStore({
          ...scope,
          authorize: async () => true,
          validateCurrentSource: async () => false,
        }).load({ transaction: tx, orderReference });
        return { status };
      });
      assert.equal(read.status.snapshot.batches.length, rounds);
      assert.equal(read.status.snapshot.orderType, "DineIn");
      // The restricted role is what ran all this.
      for (const run of [(work) => store.asApi(work), (work) => asWorker.run(work)])
        assert.equal(
          (
            await run((tx) =>
              tx.query(
                "SELECT (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass",
                [],
              ),
            )
          ).rows[0].bypass,
          false,
        );
    } finally {
      vi.unstubAllEnvs();
      if (store !== null) await store.close();
      for (const name of [api, worker]) {
        await admin.query("DROP OWNED BY " + name).catch(() => undefined);
        await admin.query("DROP ROLE " + name).catch(() => undefined);
      }
      await admin.end();
    }
  });
});
