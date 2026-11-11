import assert from "node:assert/strict";
import pg from "pg";
import { it, vi } from "vitest";
import { createCustomerDiningCheckoutScope } from "../../../apps/api/src/customer-dining-checkout-scope.ts";
import { createCustomerDiningRoundWithdraw } from "../../../apps/api/src/customer-dining-round-withdraw.ts";
import { createInternalBatchCancellation } from "../../../tooling/environment/pilot-batch-cancellation.mjs";
import { applyWorkflowRelease } from "../../../tooling/environment/workflow-release-install.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { prepareRealStaffRoundStore } from "../test-support/real-staff-round-store.mjs";
import { createPilotApiRole } from "../test-support/sole-operator-brand-gate.mjs";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";
import { isDiningRoundReturnedToCart } from "../../../packages/rms/ordering/src/index.ts";

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

      // "Continue to payment": the round is submitted unpaid, the cart emptied.
      const continueToPayment = async (who, cart) => {
        const quoted = await pipeline.quote(who, {
          operationReference: reference(),
          cartReference: cart.cartReference,
          cartVersion: cart.cartVersion,
          requestedAt: now(),
        });
        assert.equal(quoted.status, "Quoted");
        await pipeline.saveDetails(who, {
          operationReference: reference(),
          detailsReference: reference(),
          cartReference: cart.cartReference,
          cartVersion: cart.cartVersion,
          quoteReference: quoted.quoteReference,
        });
        const checkout = await pipeline.startCheckout(who, {
          createOperationReference: reference(),
          cartReference: cart.cartReference,
          cartVersion: cart.cartVersion,
          quoteReference: quoted.quoteReference,
        });
        assert.equal(checkout.status, "Started");
        await pipeline.preparePayment(who, {
          checkoutSessionReference: checkout.checkoutSessionReference,
          selectionReference: reference(),
          tip: { amountMinor: 0n, currencyCode: "CAD" },
          recordedAfterOutage: false,
        });
      };
      await continueToPayment(a, before);
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
      // v15 batch-5 (shared-table-staff-round): the table's only round is now cancelled unpaid.
      // Staff still read it on the table's order, as cancelled and not charged, never as a total
      // of dishes nobody owes (the read used to list no round and every dish in the totals).
      const floor = await store.staff(label(0x701), []);
      const queue = createPersistentMerchantOrderQueue({
        persistence: { ...floor.persistence, now },
        quoteVersion: 1,
        acceptanceConfigured: true,
      });
      const detail = await queue({
        sessionCookie: floor.sessionCookie,
        afterOrderReference: null,
        orderReference: batch.order,
      });
      assert.deepEqual(
        detail.items[0].batches.map((round) => [
          round.orderBatchReference,
          round.sequence,
          round.acceptanceStatus,
          round.staffCancellation,
        ]),
        [[batch.batch, 1, "Cancelled", null]],
      );
      assert.equal(detail.lines.items.length, 2);
      // v15 batch-5: a stale payment page asks Ordering whether this round came back to the
      // cart; as the pilot API role, it has, and a round it never saw has not.
      assert.equal(
        await store.asApi((tx) => isDiningRoundReturnedToCart(tx, store.ownerScope, batch.batch)),
        true,
      );
      assert.equal(
        await store.asApi((tx) => isDiningRoundReturnedToCart(tx, store.ownerScope, label(0x7ff))),
        false,
      );
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

      // The returned dishes are sent again (by phone B this time) and stopped again by a later
      // Guest Session of phone B (the same phone at the table), then sent and stopped once more:
      // they come back each time, as they were, though no cart operation added those lines.
      // TEST-ONLY: the later session is B's row copied with fresh credentials (the rotation a
      // re-bound phone gets), and B's own session then ends.
      const guestCredentials = configured.entry.session.credentials;
      const laterSessionOf = async (who) => {
        const next = {
          sessionCredential: guestCredentials.generateCredential("Session"),
          csrfCredential: guestCredentials.generateCredential("Csrf"),
        };
        const old = (
          await admin.query(
            "SELECT guest_session_id::text AS id FROM bop_identity.guest_session WHERE session_selector_hash=decode($1,'hex')",
            [guestCredentials.hashCredential("Session", who.sessionCredential)],
          )
        ).rows[0].id;
        await admin.query("SET session_replication_role = replica");
        await admin.query(
          `INSERT INTO bop_identity.guest_session (guest_session_id, session_selector_hash, csrf_selector_hash, operation_id,
             operation_intent_hash, brand_id, store_id, public_store_id, public_table_id, channel, locale,
             qr_id, qr_revocation_version, dining_state, status, created_at, last_seen_at, idle_expires_at,
             absolute_expires_at, order_closed_at, closure_expires_at, rotated_from_guest_session_id,
             revocation_reason, revoked_at, version, dining_session_id, dining_participant_id)
           SELECT $2, decode($3,'hex'), decode($4,'hex'), $5, operation_intent_hash, brand_id, store_id,
             public_store_id, public_table_id, channel, locale, qr_id, qr_revocation_version, dining_state,
             'Active', created_at, last_seen_at, idle_expires_at, absolute_expires_at, NULL, NULL, $1::uuid,
             NULL, NULL, 1, dining_session_id, dining_participant_id
           FROM bop_identity.guest_session WHERE guest_session_id=$1::uuid`,
          [
            old,
            reference(),
            guestCredentials.hashCredential("Session", next.sessionCredential),
            guestCredentials.hashCredential("Csrf", next.csrfCredential),
            reference(),
          ],
        );
        await admin.query(
          "UPDATE bop_identity.guest_session SET status='Revoked', revocation_reason='Rotated', revoked_at=now(), version=version+1 WHERE guest_session_id=$1",
          [old],
        );
        await admin.query("SET session_replication_role = origin");
        return next;
      };
      const roundAgain = async (who) => {
        const cart = await cartOf(who);
        assert.equal(cart.pendingItems.length, 2);
        await continueToPayment(who, cart);
        const latest = (
          await admin.query(
            `SELECT b.order_batch_id::text AS batch, (SELECT count(*)::int FROM rms_ordering.order_batch o
               WHERE o.order_id=b.order_id AND (o.submitted_at, o.order_batch_id) <= (b.submitted_at, b.order_batch_id)) AS n
             FROM rms_ordering.order_batch b ORDER BY b.submitted_at DESC, b.order_batch_id DESC LIMIT 1`,
          )
        ).rows[0];
        assert.notEqual(latest.batch, batch.batch);
        return latest;
      };
      let laterB = null;
      for (const n of [2, 3]) {
        // Round 2 is sent by B's first session, round 3 by the later one.
        const round = await roundAgain(laterB ?? b);
        if (laterB === null) laterB = await laterSessionOf(b);
        const who = laterB;
        assert.equal((await lines(emptied.cartReference)).length, 0, "round " + n);
        // Phone A can't stop it.
        assert.deepEqual(await ask(a, reference(), round.n), { status: "NotWithdrawable" });
        unexpected.length = 0;
        const again = await ask(who, reference(), round.n).catch((error) => ({
          error: String(error),
        }));
        assert.deepEqual(
          again,
          { status: "Returned" },
          "round " + n + ": " + String(unexpected[0]?.stack ?? ""),
        );
        const backAgain = await lines(emptied.cartReference);
        assert.deepEqual(
          backAgain.map((line) => [line.sku, line.quantity, line.note, line.adder, line.evidence]),
          sent.map((line) => [line.sku, line.quantity, line.note, line.adder, line.evidence]),
          "round " + n,
        );
      }
      const recorded = (
        await admin.query(
          "SELECT guest_session_id=submitted_guest_session_id AS same, jsonb_array_length(returned_items_json) AS n FROM rms_ordering.dining_round_cart_return ORDER BY occurred_at",
        )
      ).rows;
      // Round 1 asked by the session that sent it; round 2 by a later session of the same phone
      // (sent by B's first session); round 3 sent and stopped by that later session.
      assert.deepEqual(recorded, [
        { same: true, n: 2 },
        { same: false, n: 2 },
        { same: true, n: 2 },
      ]);
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

/**
 * WP-2423 shared-table-checkout (a) with shared-table-cart-staff-round M38: at a pay-first table
 * the payer pays only part of a line (one of their two teas); the rest of the table's dishes wait
 * (2000_520) and come back once the round is sent. The payer then stops before paying: the round's
 * tea comes back with the quantity the round took, though no cart operation recorded the split.
 * The dishes are then sent whole and stopped again: the lines that came back from the waiting list
 * (no cart operation added them either) come back as they were set aside. Every dish once, with
 * its quantity, note, evidence and the phone that added it. Restricted pilot API role.
 */
it("M38 with a split line: the payer pays one of two teas, stops, and every dish comes back once with its quantity", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_wdsplit" }, async (context) => {
    const admin = new Client(context.clientConfig);
    await admin.connect();
    vi.stubEnv("NODE_ENV", "development");
    const api = await createPilotApiRole(admin, context, "wp2423_wds");
    let store = null;
    try {
      store = await prepareRealStaffRoundStore({ admin, context, api, paymentTiming: "PayFirst" });
      const { tea, soup, tableReference, reference, now } = store;
      const label = (n) => "01a0fd00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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
          operationReference: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000002`,
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
      const lines = async (cartReference) =>
        (
          await admin.query(
            "SELECT cart_line_id::text AS line, sellable_id::text AS sku, quantity, customer_note AS note, added_by_participant_id::text AS adder, catalog_selection_evidence_json AS evidence FROM rms_ordering.cart_line WHERE cart_id=$1 ORDER BY sellable_id, added_at, cart_line_id",
            [cartReference],
          )
        ).rows;
      const before = await cartOf(a);
      const cartReference = before.cartReference;
      const sent = await lines(cartReference);
      assert.deepEqual(
        sent.map((line) => [line.sku, line.quantity]).sort(),
        [
          [soup.skuReference, 1],
          [tea.skuReference, 2],
        ].sort(),
      );
      const teaLine = sent.find((line) => line.sku === tea.skuReference);
      // Per dish, how many units are in the table's cart, with what a guest reads of each.
      const units = async () => {
        const now = await lines(cartReference);
        const by = new Map();
        for (const line of now) {
          const key = JSON.stringify([line.sku, line.note, line.adder, line.evidence]);
          by.set(key, (by.get(key) ?? 0) + line.quantity);
        }
        return [...by.entries()].sort();
      };
      const original = await units();

      const scopePort = createCustomerDiningCheckoutScope({
        scope: { tenantReference: store.tenantReference, ...store.ownerScope },
        transactions: { run: (work) => store.asApi(work) },
        credentials: configured.entry.session.credentials,
        binding: configured.diningStaffCall.binding,
        newReference: reference,
        now,
      });
      const scoped = (who, command) =>
        scopePort.apply({ ...who, operationReference: reference(), command });
      // A pays one of the two teas: the other tea and B's soup wait.
      const chosen = await scoped(a, {
        action: "Choose",
        cartReference,
        expectedCartVersion: before.cartVersion,
        choice: "Chosen",
        lines: [{ cartItemReference: teaLine.line, quantity: 1 }],
      });
      assert.equal(chosen.status, "Chosen", JSON.stringify(chosen));
      assert.equal(chosen.setAsideUnits, 2);
      const continueToPayment = async (who, cart) => {
        const quoted = await pipeline.quote(who, {
          operationReference: reference(),
          cartReference: cart.cartReference,
          cartVersion: cart.cartVersion,
          requestedAt: now(),
        });
        assert.equal(quoted.status, "Quoted");
        await pipeline.saveDetails(who, {
          operationReference: reference(),
          detailsReference: reference(),
          cartReference: cart.cartReference,
          cartVersion: cart.cartVersion,
          quoteReference: quoted.quoteReference,
        });
        const checkout = await pipeline.startCheckout(who, {
          createOperationReference: reference(),
          cartReference: cart.cartReference,
          cartVersion: cart.cartVersion,
          quoteReference: quoted.quoteReference,
        });
        assert.equal(checkout.status, "Started");
        await pipeline.preparePayment(who, {
          checkoutSessionReference: checkout.checkoutSessionReference,
          selectionReference: reference(),
          tip: { amountMinor: 0n, currencyCode: "CAD" },
          recordedAfterOutage: false,
        });
      };
      const roundCart = await cartOf(a);
      // The round's cart is that one tea; the rest waits.
      assert.deepEqual(
        (await lines(cartReference)).map((line) => [line.line, line.sku, line.quantity]),
        [[teaLine.line, tea.skuReference, 1]],
      );
      await continueToPayment(a, roundCart);
      // The round is sent: the waiting dishes come back to the table's cart once.
      const back = await scoped(b, { action: "Return" });
      assert.equal(back.status, "Returned", JSON.stringify(back));
      assert.equal(back.returnedUnits, 2);

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
      const unexpected = [];
      const withdraw = createCustomerDiningRoundWithdraw({
        scope: { tenantReference: store.tenantReference, ...store.ownerScope },
        transactions: { run: (work) => store.asApi(work) },
        credentials: configured.entry.session.credentials,
        binding: configured.diningStaffCall.binding,
        resolvePayment: async () => ({ status: "NoPayment" }),
        cancellation,
        newReference: reference,
        now,
        onUnexpected: (error) => unexpected.push(error),
      }).withdraw;
      const latestRound = async () =>
        (
          await admin.query(
            `SELECT (SELECT count(*)::int FROM rms_ordering.order_batch o
               WHERE o.order_id=b.order_id AND (o.submitted_at, o.order_batch_id) <= (b.submitted_at, b.order_batch_id)) AS n
             FROM rms_ordering.order_batch b ORDER BY b.submitted_at DESC, b.order_batch_id DESC LIMIT 1`,
          )
        ).rows[0].n;
      // A stops: the tea the round took (one, from the split line) comes back.
      const first = await withdraw({ ...a, operationReference: reference(), roundNumber: 1 });
      assert.deepEqual(first, { status: "Returned" }, String(unexpected[0]?.stack ?? ""));
      assert.deepEqual(await units(), original, "every dish once after the split round");

      // Everything is sent whole, by B this time (the waiting tea and soup came back on their own
      // lines), and B stops it: those lines come back as they were set aside.
      const whole = await cartOf(b);
      assert.equal(
        whole.pendingItems.reduce((sum, item) => sum + item.quantity, 0),
        3,
      );
      await continueToPayment(b, whole);
      const n = await latestRound();
      const again = await withdraw({ ...b, operationReference: reference(), roundNumber: n });
      assert.deepEqual(again, { status: "Returned" }, String(unexpected[0]?.stack ?? ""));
      assert.deepEqual(await units(), original, "every dish once after the whole round");
      const returns = (
        await admin.query(
          "SELECT count(*)::int AS n, sum(jsonb_array_length(returned_items_json))::int AS items FROM rms_ordering.dining_round_cart_return",
        )
      ).rows[0];
      assert.deepEqual(returns, { n: 2, items: 1 + 3 });
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
