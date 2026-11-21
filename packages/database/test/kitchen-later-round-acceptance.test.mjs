import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it, vi } from "vitest";
import { withPaidBatchAcceptance } from "../../../apps/api/src/merchant-card-machine-payment.ts";
import { brandKitchenCapabilityReference } from "../../../apps/api/src/merchant-kitchen-setup.ts";
import { createMerchantOrderStaffCancellation } from "../../../apps/api/src/merchant-order-staff-cancellation.ts";
import { loadOutboxEnvelope } from "../../bop/eventing/src/index.ts";
import { createInternalKitchen } from "../../../tooling/environment/pilot-kitchen.mjs";
import { createInternalPaidOutcome } from "../../../tooling/environment/pilot-paid-outcome.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { bootstrapKitchenRecipe } from "../test-support/kitchen-recipe-bootstrap.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const id = (n) => "01a0fe29-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");

/**
 * WP-2423 batch 29 (kitchen-source-and-outbox-wedge). v15 2026-11-17, Lane Dessert, a pay-first
 * table: a staff round and a guest round landed together, then the table's paid rounds were
 * accepted one after another. Each acceptance confirms its round (OrderConfirmed) and the
 * kitchen's consumer takes it a moment later. The kitchen read the round's Ordering source as of
 * the confirmation instant, so whenever the next round's acceptance (any later fact of the Order)
 * landed before the kitchen took the round, the read failed on every retry: four paid rounds never
 * reached the kitchen, and the Order's later updates (its cancellations) waited behind them.
 *
 * Here, through the pilot's real compositions under the restricted NOBYPASSRLS API role holding the
 * rendered pilot ACL: a pay-first table's rounds are sent by staff, paid on the card machine and
 * accepted back to back (each round placed while the one before it is still waiting for the
 * kitchen), and the pilot's own kitchen consumer (createInternalKitchen, as the business worker
 * runs it, on the same restricted transaction runner) then takes each confirmed round. Every paid
 * round gets its kitchen ticket. A paid round staff cancel before the kitchen took it is consumed
 * with nothing made, so it never holds the Order's later updates behind it. Synthetic TEST
 * references only; the card machine is the Store's (no Provider).
 */
it("a paid round reaches the kitchen even when the table's next round lands before the kitchen takes it", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_klround" }, async (context) => {
    const admin = new pg.Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_klr");
    const worker = api + "_w";
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayFirst" });
      const { soup, tableReference, reference, scope } = store;
      const server = await store.staff(id(0x710), [
        "ordering.order.create_staff",
        "ordering.order.cancel",
        "dining.operate",
        "dining.session.close",
      ]);
      const counter = await store.counterFor(server);
      const pay = withPaidBatchAcceptance(counter.cardMachinePayment, {
        accept: await store.acceptanceFor(server),
        nextReference: reference,
      });
      const as = { sessionCookie: server.sessionCookie, csrf: server.csrf };

      // TEST-ONLY owner setup: the soup's kitchen preparation, published on the Store's own
      // recipe (the kitchen line the fixture set up is the Brand's capability).
      const ownerRun = async (work) => {
        const client = new pg.Client(context.clientConfig);
        await client.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [store.tenantReference, scope.brandReference, scope.storeReference],
          );
          const value = await work({ query: (sql, values) => client.query(sql, values) });
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          await client.end();
        }
      };
      await bootstrapKitchenRecipe({
        admin,
        role: context.clientConfig.user,
        runner: () => ({ run: ownerRun }),
        scope,
        orderRecord: { items: [{ catalog: { skuReference: soup.skuReference, options: [] } }] },
        at: new Date(Date.parse(store.now()) - 3600_000).toISOString(),
        hash,
        references: { derive: (purpose, identity) => id(0x9000 + identity.length) },
        capability: brandKitchenCapabilityReference(scope.brandReference),
        reuseInventoryRecipe: true,
      });

      const placeRound = async () => {
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
        // The soup and its tax, to the cent (6.50 + 13 % = 7.35).
        assert.deepEqual([placed.status, placed.totalMinor], ["Placed", "735"]);
        return placed;
      };
      // The pilot business worker's paid-outcome consumer: it confirms a paid, accepted round
      // (OrderConfirmed), on the pilot's restricted transaction runner, as the worker runs it.
      const pilotWorkflow = {
        environment: "InternalTest",
        database: context.clientConfig.database,
        scope: store.ownerScope,
        workflow: store.workflow,
      };
      const paidOutcome = await createInternalPaidOutcome(
        store.resources,
        {},
        {
          loadPickupWorkflow: async () => pilotWorkflow,
          loadDiningWorkflow: async () => pilotWorkflow,
          loadAdditionalWorkflow: async () => pilotWorkflow,
          providerAccountReference: store.providerAccountReference,
          actorReference: id(0x720),
        },
      );
      const confirmPaid = async () => {
        const events = (
          await admin.query(
            "SELECT event_id::text AS event FROM platform_eventing.outbox_event o WHERE event_type='PaymentSucceeded' AND NOT EXISTS (SELECT 1 FROM platform_eventing.consumer_inbox i WHERE i.event_id=o.event_id AND i.status='completed' AND i.consumer_name='ordering.payment-outcome:v1') ORDER BY recorded_at",
          )
        ).rows;
        for (const { event } of events)
          await store.restricted.run(async (tx) =>
            paidOutcome.consume(tx, await loadOutboxEnvelope(tx, event)),
          );
      };
      const payRound = async (placed, slip) => {
        const paid = await pay({
          ...as,
          command: {
            operationReference: reference(),
            orderReference: placed.orderReference,
            orderBatchReference: placed.orderBatchReference,
            expectedTotalMinor: placed.totalMinor,
            slipReference: slip,
            takenAt: null,
          },
        });
        assert.deepEqual([paid.status, paid.acceptance], ["Recorded", "Accepted"]);
        await confirmPaid();
      };

      // Rounds 1-3 are sent, paid and accepted one after another; each next round is sent while
      // the one before is still waiting for the kitchen (as at the dessert table, the next
      // acceptance lands first). Round 4 is sent last and stays waiting for its payment.
      const first = await placeRound();
      await payRound(first, "AUTH 290001");
      const second = await placeRound();
      await payRound(second, "AUTH 290002");
      const third = await placeRound();
      await payRound(third, "AUTH 290003");
      await placeRound();
      const orderReference = first.orderReference;

      const confirmed = async () =>
        (
          await admin.query(
            `SELECT event_id::text AS event, payload_json->>'orderBatchReference' AS round
             FROM platform_eventing.outbox_event
             WHERE aggregate_id=$1 AND event_type='OrderConfirmed' ORDER BY aggregate_version`,
            [orderReference],
          )
        ).rows;
      const paidRounds = [first, second, third].map((round) => round.orderBatchReference);
      assert.deepEqual(
        (await confirmed()).map((event) => event.round),
        paidRounds,
      );

      // The pilot business worker's kitchen consumer, on the pilot's restricted transaction runner.
      const kitchen = createInternalKitchen(store.resources);
      const take = (event) =>
        store.restricted.run(async (tx) =>
          kitchen.worker.consume(tx, await loadOutboxEnvelope(tx, event)),
        );
      const tickets = async () =>
        (
          await admin.query(
            "SELECT order_batch_id::text AS round FROM rms_kitchen.kitchen_ticket WHERE order_id=$1 ORDER BY created_at",
            [orderReference],
          )
        ).rows.map((row) => row.round);
      for (const { event, round } of await confirmed())
        assert.deepEqual(
          await take(event),
          { status: "processed" },
          "the kitchen takes paid round " + (paidRounds.indexOf(round) + 1),
        );
      assert.deepEqual(await tickets(), paidRounds, "every paid round has its kitchen ticket");
      // Taken again (a redelivery), nothing is made twice.
      for (const { event } of await confirmed())
        assert.equal((await take(event)).status, "duplicate_completed");
      assert.deepEqual(await tickets(), paidRounds);

      // ── A paid, accepted round staff cancel before the kitchen took it: nothing is made for it,
      // and its confirmation is consumed once, so it holds nothing behind it.
      const fifth = await placeRound();
      await payRound(fifth, "AUTH 290005");
      const [{ version }] = (
        await admin.query(
          "SELECT max(version)::int AS version FROM rms_ordering.order_revision WHERE order_id=$1",
          [orderReference],
        )
      ).rows;
      const cancel = createMerchantOrderStaffCancellation({
        persistence: store.persistenceOf(server),
        authentication: server.authentication,
        nextReference: reference,
        installContext: async (tx, selected) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [selected.tenantReference, selected.brandReference, selected.storeReference],
          );
        },
      });
      const cancelled = await cancel({
        ...as,
        command: {
          orderReference,
          orderBatchReference: fifth.orderBatchReference,
          expectedOrderVersion: version,
          operationReference: reference(),
          reasonCode: "CUSTOMER_REQUEST",
        },
      });
      assert.equal(cancelled.status, "Cancelled", JSON.stringify(cancelled));
      const fifthEvent = (await confirmed()).find(
        (event) => event.round === fifth.orderBatchReference,
      );
      assert.ok(fifthEvent, "the cancelled round was confirmed before it was cancelled");
      assert.deepEqual(await take(fifthEvent.event), { status: "processed" });
      assert.deepEqual(await tickets(), paidRounds, "nothing is made for the cancelled round");
      const [inbox] = (
        await admin.query(
          "SELECT status FROM platform_eventing.consumer_inbox WHERE consumer_name='kitchen.confirmed-order:v1' AND event_id=$1",
          [fifthEvent.event],
        )
      ).rows;
      assert.equal(inbox.status, "completed");

      // The restricted role is what ran all this.
      assert.equal(
        (
          await store.restricted.run((tx) =>
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
