import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { createCustomerDiningRoundWithdraw } from "../../../apps/api/src/customer-dining-round-withdraw.ts";
import { createInternalBatchCancellation } from "../../../tooling/environment/pilot-batch-cancellation.mjs";
import { applyWorkflowRelease } from "../../../tooling/environment/workflow-release-install.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";

const { Client } = pg;

/**
 * WP-2423 shared-table-cart-staff-round M38 (2000_411, 2000_412). At a pay-first table two phones
 * put dishes in the table's shared cart; phone A presses "Continue to payment" (the round is
 * submitted unpaid and the cart emptied) and then "Don't pay. Put the dishes back". Everything runs
 * through the pilot's real compositions (QR entry, join, binding, the table's Cart, quote,
 * checkout, payment preparation, the System's unpaid round cancellation with its released
 * Workflow) under the restricted NOBYPASSRLS API role holding the rendered pilot ACL. Payment's
 * answer from the Provider is a stand-in (no online attempt exists here; its Provider path is the
 * manager's, accepted in abandoned-payment). Synthetic TEST references only.
 */
it("M38: the payer stops before paying; the round is cancelled unpaid and both phones' dishes come back once", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_withdraw" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_wd");
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayFirst" });
      const { tea, soup, tableReference, reference, now } = store;
      const label = (n) => "01a0fc00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
      // The released unpaid round cancellation Workflow, installed by its operator tool.
      const hex = (Date.now() - 600_000).toString(16).padStart(12, "0");
      await admin.query("BEGIN");
      const release = await applyWorkflowRelease(
        admin,
        {
          release: "UnpaidDineInBatchCancellation",
          tenantReference: store.tenantReference,
          brandReference: store.ownerScope.brandReference,
          operatorReference: label(0x10),
          approvedByReference: label(0x11),
          approvalEvidenceReference: label(0x12),
          operationReference: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000001`,
        },
        () => Date.now() - 600_000 + 1000,
      );
      await admin.query("COMMIT");
      assert.equal(release.status, "Applied");

      const server = await store.staff(label(0x700), [
        "ordering.order.create_staff",
        "dining.operate",
        "dining.session.close",
      ]);
      const as = { sessionCookie: server.sessionCookie, csrf: server.csrf };
      let pipeline = null;
      await store.counterFor(server, { decorateStaffRoundPipeline: (real) => (pipeline = real) });
      const configured = await store.customerEntryFor(server);

      // Two phones at the table, each adding its own dish.
      const table = await pipeline.openTable(as, { tableReference });
      assert.equal(table.status, "Opened");
      const phone = async () => {
        const entered = await pipeline.enter({ tableReference, requestedAt: now() });
        assert.equal(entered.status, "Established");
        const issued = await pipeline.openTable(as, { tableReference });
        const joined = await pipeline.join(entered.credentials, {
          joinCredential: issued.joinCredential,
          operationReference: reference(),
        });
        return (
          await pipeline.bind(entered.credentials, {
            operationReference: reference(),
            admissionReference: joined.admissionReference,
          })
        ).credentials;
      };
      const a = await phone();
      const b = await phone();
      const cartOf = (who) =>
        pipeline.selectCart(who, { operationReference: reference(), requestedAt: now() });
      const add = async (who, sellableReference, quantity) => {
        const cart = await cartOf(who);
        const added = await pipeline.addItem(who, {
          operationReference: reference(),
          cartReference: cart.cartReference,
          expectedCartVersion: cart.cartVersion,
          sellableReference,
          quantity,
          optionSelections: [],
          customerNote: quantity > 1 ? "no ice" : null,
          requestedAt: now(),
        });
        assert.equal(added.status, "Applied");
      };
      await add(a, tea.skuReference, 2);
      await add(b, soup.skuReference, 1);
      const before = await cartOf(a);
      const lines = async (cartReference) =>
        (
          await admin.query(
            "SELECT sellable_id::text AS sku, quantity, customer_note AS note, added_by_participant_id::text AS adder, catalog_selection_evidence_json AS evidence FROM rms_ordering.cart_line WHERE cart_id=$1 ORDER BY sellable_id",
            [cartReference],
          )
        ).rows;
      const sent = await lines(before.cartReference);
      assert.equal(sent.length, 2);

      // Phone A presses "Continue to payment": the round is submitted unpaid, the cart emptied.
      const quoted = await pipeline.quote(a, {
        operationReference: reference(),
        cartReference: before.cartReference,
        cartVersion: before.cartVersion,
        requestedAt: now(),
      });
      assert.equal(quoted.status, "Quoted");
      await pipeline.saveDetails(a, {
        operationReference: reference(),
        detailsReference: reference(),
        cartReference: before.cartReference,
        cartVersion: before.cartVersion,
        quoteReference: quoted.quoteReference,
      });
      const checkout = await pipeline.startCheckout(a, {
        createOperationReference: reference(),
        cartReference: before.cartReference,
        cartVersion: before.cartVersion,
        quoteReference: quoted.quoteReference,
      });
      assert.equal(checkout.status, "Started");
      await pipeline.preparePayment(a, {
        checkoutSessionReference: checkout.checkoutSessionReference,
        selectionReference: reference(),
        tip: { amountMinor: 0n, currencyCode: "CAD" },
        recordedAfterOutage: false,
      });
      const emptied = await cartOf(a);
      assert.equal(emptied.pendingItems.length, 0);
      const counts = async () =>
        (
          await admin.query(
            `SELECT (SELECT count(*)::int FROM rms_ordering.order_batch_checkout_cancellation) AS cancellations,
               (SELECT count(*)::int FROM rms_ordering.dining_round_cart_return) AS returns,
               (SELECT count(*)::int FROM platform_eventing.outbox_event WHERE event_type='OrderCancelled') AS events,
               (SELECT count(*)::int FROM rms_ordering.cart_line WHERE cart_id=$1) AS lines`,
            [emptied.cartReference],
          )
        ).rows[0];
      const start = await counts();
      assert.deepEqual(start, { cancellations: 0, returns: 0, events: 0, lines: 0 });

      const cancellation = await createInternalBatchCancellation(store.resources, {
        loadWorkflow: async () => ({
          environment: "InternalTest",
          database: context.clientConfig.database,
          scope: { tenantReference: store.tenantReference, ...store.ownerScope },
          definition: release.plan.published,
        }),
        expectedDatabaseName: context.clientConfig.database,
        systemActorReference: label(0x20),
        providerAccountReference: label(0x21),
      });
      let payment = { status: "NoPayment" };
      const unexpected = [];
      let beforeTransaction = async () => undefined;
      const withdraw = createCustomerDiningRoundWithdraw({
        scope: { tenantReference: store.tenantReference, ...store.ownerScope },
        transactions: { run: (work) => store.asApi(work) },
        credentials: configured.entry.session.credentials,
        binding: configured.diningStaffCall.binding,
        resolvePayment: async () => {
          await beforeTransaction();
          return payment;
        },
        cancellation,
        newReference: reference,
        now,
        onUnexpected: (error) => unexpected.push(error),
      }).withdraw;
      const ask = (who, operationReference, roundNumber = 1) =>
        withdraw({ ...who, operationReference, roundNumber });

      // Phone B can't stop A's round; a round number that isn't A's either. Nothing written.
      assert.deepEqual(await ask(b, reference()), { status: "NotWithdrawable" });
      assert.deepEqual(await ask(a, reference(), 2), { status: "NotWithdrawable" });
      // Payment went through, or may still be going through: refused, nothing written.
      payment = { status: "Paid" };
      assert.deepEqual(await ask(a, reference()), { status: "Paid" });
      payment = { status: "Processing" };
      assert.deepEqual(await ask(a, reference()), { status: "PaymentPending" });
      assert.deepEqual(await counts(), start);

      // The guest's payment is recorded between Payment's answer and the cancellation: the
      // database refuses the cancellation and nothing comes back (never paid and returned).
      payment = { status: "NoPayment" };
      const batch = (
        await admin.query(
          "SELECT b.order_batch_id::text AS batch,b.order_id::text AS order,b.submission_id::text AS submission FROM rms_ordering.order_batch b ORDER BY b.submitted_at DESC LIMIT 1",
        )
      ).rows[0];
      beforeTransaction = async () => {
        await admin.query("SET session_replication_role = replica");
        await admin.query(
          "INSERT INTO rms_ordering.order_payment_acceptance_wait (wait_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_event_id,source_digest,evaluated_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),'{}'::jsonb)",
          [
            label(0x30),
            store.ownerScope.brandReference,
            store.ownerScope.storeReference,
            batch.order,
            batch.batch,
            batch.submission,
            label(0x31),
            "sha256:" + "4".repeat(64),
          ],
        );
        await admin.query("SET session_replication_role = origin");
      };
      await assert.rejects(ask(a, reference()), { code: "Unavailable" });
      assert.deepEqual(await counts(), start);
      await admin.query("SET session_replication_role = replica");
      await admin.query("DELETE FROM rms_ordering.order_payment_acceptance_wait WHERE wait_id=$1", [
        label(0x30),
      ]);
      await admin.query("SET session_replication_role = origin");
      beforeTransaction = async () => undefined;

      // Nothing was charged: cancelled unpaid by the guest, and both dishes back in the cart.
      const operation = reference();
      unexpected.length = 0;
      const returned = await ask(a, operation).catch((error) => ({ error, unexpected }));
      assert.deepEqual(returned, { status: "Returned" }, String(unexpected[0]?.stack ?? ""));
      const after = await counts();
      assert.deepEqual(after, { cancellations: 1, returns: 1, events: 1, lines: 2 });
      const cancelled = (
        await admin.query(
          "SELECT reason_code,expiry_record_id FROM rms_ordering.order_batch_checkout_cancellation",
        )
      ).rows[0];
      assert.deepEqual(cancelled, {
        reason_code: "GUEST_CANCELLED_UNPAID",
        expiry_record_id: null,
      });
      const audit = (
        await admin.query(
          "SELECT actor_type,source_channel,reason_code FROM platform_audit.audit_record WHERE action_code IN ('ORDERING_BATCH_CHECKOUT_CANCELLED','ORDERING_ROUND_RETURNED_TO_CART') ORDER BY action_code",
        )
      ).rows;
      assert.deepEqual(audit, [
        {
          actor_type: "System",
          source_channel: "CUSTOMER_PWA",
          reason_code: "GUEST_CANCELLED_UNPAID",
        },
        {
          actor_type: "System",
          source_channel: "CUSTOMER_PWA",
          reason_code: "GUEST_CANCELLED_UNPAID",
        },
      ]);
      // Each dish as it was: how many, the note, its Catalog evidence, and whose phone added it.
      const back = await lines(emptied.cartReference);
      assert.deepEqual(
        back.map((line) => [line.sku, line.quantity, line.note, line.adder]),
        sent.map((line) => [line.sku, line.quantity, line.note, line.adder]),
      );
      assert.deepEqual(
        back.map((line) => line.evidence),
        sent.map((line) => line.evidence),
      );
      // The table's cart reads the round as returned for both phones.
      const states = async () =>
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM rms_ordering.dining_round_cart_return WHERE order_batch_id=$1",
            [batch.batch],
          )
        ).rows[0].n;
      assert.equal(await states(), 1);
      // The same tap again, or another operation: nothing comes back twice.
      assert.deepEqual(await ask(a, operation), { status: "AlreadyReturned" });
      assert.deepEqual(await ask(a, reference()), { status: "AlreadyReturned" });
      assert.deepEqual(await counts(), after);
      // Append-only: the return can't be changed or deleted, even by the API role.
      await assert.rejects(
        store.asApi((tx) =>
          tx.query("DELETE FROM rms_ordering.dining_round_cart_return WHERE order_batch_id=$1", [
            batch.batch,
          ]),
        ),
      );
      assert.equal(await states(), 1);
      // The rendered pilot role ran it.
      const who = await store.asApi(async (tx) => {
        const seen = await tx.query(
          "SELECT current_user AS who,(SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass",
          [],
        );
        return seen.rows[0];
      });
      assert.deepEqual(who, { who: api, bypass: false });
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
