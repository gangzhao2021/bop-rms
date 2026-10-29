import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { exerciseCapturedOrderKitchen } from "./captured-order-kitchen.mjs";
import { createPostgresCounterOrderEntryStore } from "../../rms/ordering/src/index.ts";
import {
  createCardMachinePaymentEnvelope,
  createPaymentStatusEventConsumerService,
  createPostgresCardMachinePaymentStore,
  createPostgresPaymentStatusStore,
} from "../../rms/payment/src/index.ts";
import { createOrderPaidContextSource } from "../../../apps/api/src/order-paid-context-source.ts";
import { createOrderCapturedPaymentSource } from "../../../apps/api/src/order-captured-payment-source.ts";
import { createCustomerOrderPaymentClaimAdmission } from "../../../apps/api/src/customer-order-payment-admission.ts";
import { createCustomerIntactReservationPaymentAction } from "../../../apps/api/src/customer-payment-workflow-action.ts";
import { createCustomerInventoryPaymentClaimAdmission } from "../../../apps/api/src/customer-inventory-payment-admission.ts";
import { createCustomerCapacityPaymentClaimAdmission } from "../../../apps/api/src/customer-capacity-payment-admission.ts";
import { createMerchantCardMachinePayment } from "../../../apps/api/src/merchant-card-machine-payment.ts";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";
import { seedMerchantAcceptanceSession } from "./merchant-acceptance-session.mjs";

/**
 * WP-2423 Q7: a counter (Pos) pickup Order that went through the ordinary customer checkout is paid
 * on the Store's card machine. The staff command (real code; only the merchant session/permission
 * resolution is the caller's test double, `merchant`) rebuilds the payment preparation from owner
 * records, applies the online payment admission, records the payment with its PaymentSucceeded
 * event, and the Order then goes through the ordinary acceptance, release and kitchen path.
 */
export async function exerciseCounterCardMachinePayment({
  admin,
  runner,
  role,
  scope,
  order,
  clock,
  amounts,
  selection,
  quoteVersion,
  paymentWorkflow,
  authorize,
  stock,
  merchant,
  at,
  positive,
}) {
  const id = (n) => "01909995-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  let sequence = 0x5000;
  const next = () => id(++sequence);
  const sha = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  await admin.query("GRANT USAGE ON SCHEMA rms_payment,rms_fulfillment TO " + role);
  // Row fences the owner reads take (as the pilot API role holds them).
  await admin.query("GRANT UPDATE(order_id) ON rms_ordering.order_header TO " + role);
  await admin.query("GRANT UPDATE(order_batch_id) ON rms_ordering.order_batch TO " + role);
  await admin.query(
    "GRANT SELECT ON rms_payment.payment_intent,rms_payment.payment_attempt,rms_payment.payment_intent_operation_record,rms_payment.payment_provider_observation,rms_payment.payment_terminal_fact,rms_payment.payment_tip_selection TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT ON rms_fulfillment.capacity_asap_commitment,rms_fulfillment.capacity_slot TO " +
      role,
  );
  // The pilot grants these to the API role (pilot-acl-additions, WP-2423 Q7).
  await admin.query(
    "GRANT SELECT,INSERT ON rms_payment.card_machine_payment,rms_payment.card_machine_refund,rms_ordering.counter_order_entry TO " +
      role,
  );
  // WP-2423 Q7 slice 2: the staff record of a dine-in round (pilot-acl-additions, api SELECT).
  await admin.query("GRANT SELECT ON rms_ordering.staff_dining_round_entry TO " + role);
  // DEC-DINE-IN-PAY-LATER: the order queue reads which rounds were sent unpaid (pilot ACL: api
  // SELECT on order_pay_later_confirmation, docs/spec/pilot-acl-additions.json).
  await admin.query("GRANT SELECT ON rms_ordering.order_pay_later_confirmation TO " + role);
  await admin.query(
    "GRANT SELECT ON rms_ordering.order_acceptance_record,rms_ordering.order_acceptance_hold,rms_ordering.order_acceptance_hold_resolution,rms_ordering.order_termination_record,rms_ordering.order_fulfillment_completion_record,rms_ordering.order_item_staff_cancellation,rms_ordering.order_staff_cancellation,rms_ordering.order_batch_checkout_cancellation TO " +
      role,
  );
  const batch = order.order.batches[0];
  const ownerScope = { brandReference: scope.brandReference, storeReference: scope.storeReference };

  // The counter entry: the staff member who took the order on the walk-up guest's counter Cart.
  const entries = createPostgresCounterOrderEntryStore({
    ...ownerScope,
    authorize: async () => true,
  });
  const entry = {
    ...ownerScope,
    operationReference: next(),
    intentHash: sha("counter order"),
    actorReference: merchant.actorReference,
    guestSessionReference: order.guestSessionReference,
    cartReference: batch.sourceCartReference,
    tipSelectionReference: selection.selectionReference,
    recordedAfterOutage: true,
    createdAt: at,
    auditReference: next(),
  };
  const created = await runner.run((tx) => entries.record(tx, entry));
  assert.equal(created.status, "Created");
  assert.equal((await runner.run((tx) => entries.record(tx, entry))).status, "AlreadyRecorded");
  const found = await runner.run((tx) => entries.loadOrder(tx, batch.sourceCartReference));
  assert.equal(String(found.orderReference), String(order.order.orderReference));

  const admission = ({ scope: selected, preparation, allowed }) =>
    createCustomerOrderPaymentClaimAdmission({
      scope: { brandReference: selected.brandReference, storeReference: selected.storeReference },
      quoteVersion,
      capacityForOrder: (currentOrder) =>
        createCustomerCapacityPaymentClaimAdmission({
          scope: selected,
          owner: "AsapPickup",
          inventory: createCustomerInventoryPaymentClaimAdmission({
            scope: selected,
            authorize: async (tx, input) =>
              input.submissionReference === String(preparation.submissionReference) &&
              input.actorReference === String(preparation.guestSessionReference) &&
              (await allowed()) &&
              (await authorize(tx, input)),
            resolveExpiryCutoff: (tx, input) => stock.resolveExpiryCutoff(tx, input),
            evaluate: createCustomerIntactReservationPaymentAction({
              scope: selected,
              currentOrder,
              quoteVersion,
              workflow: paymentWorkflow,
              authorize: async (tx, input) => (await allowed()) && (await authorize(tx, input)),
              authorizeOverride: async () => false,
            }),
          }),
        }),
    });
  const command = createMerchantCardMachinePayment({
    persistence: { transactions: runner, now: () => new Date().toISOString() },
    authentication: { authorize: async () => ({ sessionReference: merchant.sessionReference }) },
    admission,
    environment: "Test",
    nextReference: next,
  });
  const payInput = (overrides = {}) => ({
    sessionCookie: merchant.cookie,
    csrf: "synthetic-csrf",
    command: {
      operationReference: id(1),
      orderReference: String(order.order.orderReference),
      orderBatchReference: String(batch.orderBatchReference),
      expectedTotalMinor: amounts.total.amountMinor.toString(),
      slipReference: "AUTH 482913",
      // A paper order paid during an outage, entered once the system was back.
      takenAt: new Date(Date.parse(at) - 20 * 60_000).toISOString(),
      ...overrides,
    },
  });
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_payment.card_machine_payment) AS payments," +
          "(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE event_type='PaymentSucceeded') AS events," +
          "(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='PAYMENT_CARD_MACHINE_RECORDED') AS audits",
      )
    ).rows[0];
  const before = await counts();
  // WP-2423 (v15 751dd768): before it is paid, the sent counter order is read from the server (a
  // reload of the counter page or another tablet loses nothing): Orders lists when it is released
  // if unpaid, the one-order read what to charge (the amount the payment record checks), and what
  // this person may do with its payment. A counter staff member (front of house) may record it but
  // may not open payments and refunds.
  const counterSession = await seedMerchantAcceptanceSession({
    admin,
    runner,
    role,
    scope,
    actor: next(),
    at,
    extraPermissions: ["ordering.order.create_staff"],
    referencePrefix: "01909983",
    sessionReferencePrefix: "01909984",
  });
  // The Orders read's Payment status projection (the pilot api role reads it).
  await admin.query("GRANT SELECT ON rms_payment.payment_status_projection TO " + role);
  // The one-order read's pickup contact (pilot api SELECT grants).
  await admin.query(
    "GRANT SELECT ON rms_ordering.checkout_contact_redaction,rms_ordering.checkout_details_record,rms_ordering.digital_receipt_record,rms_ordering.order_checkout_details_link,rms_ordering.order_submission_record TO " +
      role,
  );
  const unpaidQueue = createPersistentMerchantOrderQueue({
    persistence: { ...counterSession.persistence, now: () => new Date().toISOString() },
    quoteVersion,
    acceptanceConfigured: true,
  });
  const orderReference = String(order.order.orderReference);
  const unpaidListed = (
    await unpaidQueue({ sessionCookie: counterSession.sessionCookie, afterOrderReference: null })
  ).items.find((item) => item.orderReference === orderReference);
  assert.equal(unpaidListed?.awaitingPayment, true);
  assert.equal(unpaidListed?.counter?.paidOnCardMachine, null);
  // Released at the pickup capacity expiry the checkout clock set (Fulfillment's record).
  assert.equal(Date.parse(unpaidListed.counter.payBy), Date.parse(String(clock.capacityExpiresAt)));
  // The list polled by every tablet leaves the amount out.
  assert.equal(unpaidListed.counter.amountDueMinor, null);
  assert.equal(unpaidListed.canRecordCardMachinePayment, true);
  assert.equal(unpaidListed.canViewPayments, false);
  const unpaidDetail = (
    await unpaidQueue({
      sessionCookie: counterSession.sessionCookie,
      afterOrderReference: null,
      orderReference,
    })
  ).items[0];
  assert.equal(unpaidDetail.counter.amountDueMinor, amounts.total.amountMinor.toString());
  assert.equal(unpaidDetail.counter.payBy, unpaidListed.counter.payBy);
  // Staff key the amount the card machine charged; a different amount is refused with the total.
  await assert.rejects(command(payInput({ expectedTotalMinor: "1" })), {
    code: "CARD_MACHINE_AMOUNT_CHANGED",
    totalMinor: amounts.total.amountMinor.toString(),
  });
  // A card number is never accepted as the slip reference.
  await assert.rejects(command(payInput({ slipReference: "1234 5678 9012 3456" })), {
    code: "CARD_MACHINE_INPUT_INVALID",
  });
  // Staff without the ordering permission are refused before anything is read.
  merchant.allowed = false;
  await assert.rejects(command(payInput()), { code: "CARD_MACHINE_PERMISSION_DENIED" });
  merchant.allowed = true;
  assert.deepEqual(await counts(), before);

  const paid = await command(payInput());
  assert.equal(paid.status, "Recorded");
  assert.equal(paid.amountMinor, amounts.total.amountMinor.toString());
  assert.equal(paid.recordingReason, "RecordedAfterOutage");
  assert.deepEqual(await counts(), {
    payments: before.payments + 1,
    events: before.events + 1,
    audits: before.audits + 1,
  });
  // The same staff command replays; another payment of the same Batch is refused.
  assert.equal((await command(payInput())).status, "AlreadyRecorded");
  await assert.rejects(command(payInput({ operationReference: id(2), takenAt: null })), {
    code: "CARD_MACHINE_ALREADY_PAID",
  });
  assert.deepEqual(await counts(), {
    payments: before.payments + 1,
    events: before.events + 1,
    audits: before.audits + 1,
  });
  // The Batch can no longer be paid online either.
  await assert.rejects(
    admin.query(
      "INSERT INTO rms_payment.payment_intent (payment_intent_id,brand_id,store_id,payment_operation_id,order_id,order_batch_id,submission_id,guest_session_id,source_cart_id,source_cart_version,quote_id,preparation_id,capacity_allocation_id,intent_digest,preparation_source_digest,order_allocation_minor,tip_minor,total_minor,currency_code,payment_method,capture_mode,aggregate_version,creation_status,prepared_at,capacity_expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$13,1,0,1,'CAD','OnlineCard','Automatic',1,'ProviderCreatePending',$14,$14::timestamptz+interval '30 minutes',$14)",
      [
        next(),
        scope.brandReference,
        scope.storeReference,
        next(),
        order.order.orderReference,
        batch.orderBatchReference,
        order.submissionReference,
        order.guestSessionReference,
        batch.sourceCartReference,
        batch.quoteReference,
        next(),
        next(),
        sha("intent"),
        at,
      ],
    ),
    /paid on the card machine/u,
  );
  const cards = createPostgresCardMachinePaymentStore({
    scope: { tenantReference: scope.tenantReference, ...ownerScope },
    authorize: async () => true,
  });
  const saved = await runner.run((tx) => cards.loadByOperation(tx, id(1)));
  assert.equal(saved.slipReference, "AUTH 482913");
  assert.equal(saved.paymentOperationReference, clock.paymentOperationReference);
  assert.equal(saved.preparation.tip.amountMinor, amounts.tip.amountMinor);
  const event = (
    await admin.query("SELECT payload_json FROM platform_eventing.outbox_event WHERE event_id=$1", [
      saved.eventReference,
    ])
  ).rows[0];
  assert.ok(event, "the PaymentSucceeded event is in the outbox");
  await assert.rejects(
    admin.query("UPDATE rms_payment.card_machine_payment SET slip_reference=NULL"),
    /append-only/u,
  );
  // Day end: the machine's takings by when the money moved, apart from online takings.
  const day = await runner.run((tx) =>
    cards.summarize(tx, {
      from: new Date(Date.parse(at) - 60 * 60_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  assert.deepEqual(day, {
    paymentCount: 1,
    backEnteredCount: 1,
    takenMinor: amounts.total.amountMinor,
    tipMinor: amounts.tip.amountMinor,
    refundCount: 0,
    refundedMinor: 0n,
  });

  const paymentScope = { ...ownerScope, providerAccountReference: id(90), environment: "Test" };
  const paymentEvent = await runner.run(
    async (tx) =>
      (
        await createOrderCapturedPaymentSource({
          scope: paymentScope,
          now: () => new Date().toISOString(),
          authorize: async () => true,
        }).resolve(tx, createCardMachinePaymentEnvelope(saved))
      ).terminal.event,
  );
  assert.equal(paymentEvent.eventType, "PaymentSucceeded");
  assert.equal(paymentEvent.payload.amountMinor, amounts.total.amountMinor.toString());
  const context = createOrderPaidContextSource({
    scope: paymentScope,
    tenantReference: scope.tenantReference,
    authorizeInventory: async (_, current) =>
      current.submissionReference === String(order.submissionReference) &&
      current.actorReference === String(order.guestSessionReference),
    quoteVersion,
    now: () => new Date().toISOString(),
    authorize: async () => true,
    authorizeOrder: async () => true,
  });
  const paidContext = await runner.run((tx) => context.resolve(tx, paymentEvent));
  assert.equal(paidContext.payment.intent.paymentMethod, "StoreCardMachine");
  assert.equal(paidContext.capacity.owner, "AsapPickup");
  assert.equal(paidContext.initialExecution.phase, "Submitted");
  // No Provider status projection for a card-machine payment; the consumer still completes.
  await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_eventing.consumer_inbox TO " + role);
  await admin.query("GRANT SELECT,INSERT ON rms_payment.payment_status_projection TO " + role);
  const statusConsumer = createPaymentStatusEventConsumerService({
    scope: ownerScope,
    authorization: { authorize: async () => true },
    projections: createPostgresPaymentStatusStore({
      scope: paymentScope,
      authorize: async () => true,
      authorizeOrder: async () => true,
    }),
    references: { generateGeneration: next, now: () => new Date().toISOString() },
    sha256: (value) => createHash("sha256").update(value).digest("hex"),
    cardMachine: {
      isCardMachinePayment: async (tx, value) =>
        (await cards.loadByIntent(tx, value.aggregateId)) !== null,
    },
  });
  const status = await runner.run((tx) => statusConsumer.consume(tx, paymentEvent));
  assert.equal(status.status, "processed");
  assert.equal(
    (await runner.run((tx) => statusConsumer.consume(tx, paymentEvent))).status,
    "duplicate_completed",
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM rms_payment.payment_status_projection WHERE payment_intent_id=$1",
        [saved.paymentIntentReference],
      )
    ).rows[0].n,
    0,
  );
  if (positive)
    await exerciseCapturedOrderKitchen({
      admin,
      runner,
      role,
      scope,
      order,
      quoteVersion,
      paymentWorkflow,
      context,
      paymentScope,
      event: paymentEvent,
      onQueueItem: (item) => {
        assert.equal(item.sourceChannel, "Pos");
        assert.deepEqual(item.counter, {
          recordedAfterOutage: true,
          paidOnCardMachine: {
            amountMinor: amounts.total.amountMinor.toString(),
            takenAt: String(saved.takenAt),
            recordedAfterOutage: true,
            refundedMinor: "0",
          },
          // Paid: nothing left to charge and no release time.
          payBy: null,
          amountDueMinor: null,
        });
      },
    });
  return { payment: saved, event: paymentEvent };
}
