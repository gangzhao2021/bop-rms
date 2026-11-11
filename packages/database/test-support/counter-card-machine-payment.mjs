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
import { createMerchantCounterOrderCancellation } from "../../../apps/api/src/merchant-counter-order-cancellation.ts";
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
  /**
   * WP-2423 M127: when given, the order is a live (not paper) counter order nobody paid for, and a
   * manager cancels it as the pilot API role (exactly the rendered pilot ACL). The journey ends there.
   */
  pilot = null,
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
  // WP-2423 M160: a back-entered paid-at time is checked against when the Store's records begin
  // (pilot api SELECT grants).
  await admin.query("GRANT USAGE ON SCHEMA rms_store TO " + role);
  await admin.query(
    "GRANT SELECT ON rms_store.store_configuration_version,rms_store.store_configuration_publication_content TO " +
      role,
  );
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
    recordedAfterOutage: pilot === null,
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
  // The Orders read asks which dishes contain alcohol (the pilot api role reads it).
  await admin.query("GRANT USAGE ON SCHEMA rms_catalog TO " + role);
  await admin.query("GRANT SELECT ON rms_catalog.sku,rms_catalog.product_alcohol_mark TO " + role);
  // The Orders read's Payment status projection (the pilot api role reads it).
  await admin.query("GRANT SELECT ON rms_payment.payment_status_projection TO " + role);
  // The one-order read's pickup contact (pilot api SELECT grants).
  await admin.query(
    "GRANT SELECT ON rms_ordering.checkout_contact_redaction,rms_ordering.checkout_details_record,rms_ordering.digital_receipt_record,rms_ordering.order_checkout_details_link,rms_ordering.order_submission_record TO " +
      role,
  );
  // WP-2423 M61: the one-order read's record of who did what reads who handed a pickup over, who
  // asked for and approved each refund, and the members' names (pilot api SELECT grants).
  await admin.query("GRANT USAGE ON SCHEMA rms_fulfillment,bop_membership TO " + role);
  await admin.query(
    "GRANT SELECT ON rms_fulfillment.pickup_handoff_record,rms_fulfillment.fulfillment,rms_payment.ordinary_refund_request,rms_payment.ordinary_refund_decline,rms_payment.ordinary_refund_operation,rms_payment.ordinary_refund_observation,rms_payment.ordinary_refund_approval,bop_membership.membership,bop_membership.member_profile_version TO " +
      role,
  );
  // ... and the Store's role assignments that label staff by role when they have no name.
  await admin.query("GRANT USAGE ON SCHEMA bop_permission TO " + role);
  await admin.query(
    "GRANT SELECT ON bop_permission.role_administration_version,bop_permission.role,bop_permission.role_assignment,bop_permission.role_assignment_change,bop_permission.role_assignment_change_decision,bop_permission.role_assignment_sole_operator_approval TO " +
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
  // WP-2423 M127: an unpaid counter order is cancelled only by someone who may cancel orders, and
  // never when it is a paper order (a sale that happened during the outage: it is recorded and
  // paid). Nothing is written by either refusal.
  assert.equal(unpaidListed.counter.canCancelUnpaid, false);
  assert.equal(unpaidListed.counter.cancelledBeforePayment, null);
  const cancelUnpaid = (session) =>
    createMerchantCounterOrderCancellation({
      persistence: { ...session.persistence, now: () => new Date().toISOString() },
      authentication: session.authentication,
      installContext: async (tx, selected) => {
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [selected.tenantReference, selected.brandReference, selected.storeReference],
        );
      },
      nextReference: next,
    });
  const cancelInput = (session) => ({
    sessionCookie: session.sessionCookie,
    csrf: session.csrf,
    command: {
      operationReference: next(),
      orderReference,
      orderBatchReference: String(batch.orderBatchReference),
      expectedOrderVersion: 1,
      reasonCode: "COUNTER_GUEST_LEFT_UNPAID",
    },
  });
  const terminations = async () =>
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM rms_ordering.order_termination_record WHERE order_id=$1",
        [orderReference],
      )
    ).rows[0].n;
  // Front of house (takes and charges counter orders) may not cancel one.
  await assert.rejects(cancelUnpaid(counterSession)(cancelInput(counterSession)), {
    code: "COUNTER_CANCEL_PERMISSION_DENIED",
  });
  if (pilot !== null)
    return await exerciseCounterUnpaidCancellation({
      admin,
      pilot,
      scope,
      at,
      next,
      quoteVersion,
      orderReference,
      batch,
      stock,
      cancelUnpaid,
      terminations,
      payInput,
      command,
      counts,
      before,
    });
  const managerSession = await seedMerchantAcceptanceSession({
    admin,
    runner,
    role,
    scope,
    actor: next(),
    at,
    extraPermissions: ["ordering.order.create_staff", "ordering.order.cancel"],
    referencePrefix: "01909a83",
    sessionReferencePrefix: "01909a84",
  });
  await assert.rejects(cancelUnpaid(managerSession)(cancelInput(managerSession)), {
    code: "COUNTER_CANCEL_PAPER_ORDER",
  });
  assert.equal(await terminations(), 0);
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
      // WP-2423 item 11: a paid counter order reaches the kitchen of a Store set up in the product.
      kitchenRoutingThroughProduct: true,
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
          // WP-2423 M127: paid, so it can't be cancelled unpaid; it never was.
          canCancelUnpaid: false,
          cancelledBeforePayment: null,
        });
      },
    });
  return { payment: saved, event: paymentEvent };
}

/**
 * WP-2423 M127: a manager cancels a live counter order nobody paid for, as the pilot API role
 * (NOBYPASSRLS, exactly the rendered pilot ACL): the append-only User termination with its audit,
 * the reserved stock released under their name, Orders reading it as cancelled before payment with
 * the reason (and no longer cancellable), a retry answering with the first outcome, and the card
 * machine refusing a payment afterwards.
 */
async function exerciseCounterUnpaidCancellation({
  admin,
  pilot,
  scope,
  at,
  next,
  quoteVersion,
  orderReference,
  batch,
  stock,
  cancelUnpaid,
  terminations,
  payInput,
  command,
  counts,
  before,
}) {
  const manager = next();
  const seeded = await seedMerchantAcceptanceSession({
    admin,
    runner: pilot.runner,
    scope,
    actor: manager,
    at,
    extraPermissions: ["ordering.order.create_staff", "ordering.order.cancel"],
    referencePrefix: "01909a85",
    sessionReferencePrefix: "01909a86",
  });
  const managerSession = {
    ...seeded,
    persistence: { ...seeded.persistence, transactions: pilot.runner },
  };
  const queue = createPersistentMerchantOrderQueue({
    persistence: { ...managerSession.persistence, now: () => new Date().toISOString() },
    quoteVersion,
    acceptanceConfigured: true,
  });
  const listed = async () =>
    (
      await queue({ sessionCookie: managerSession.sessionCookie, afterOrderReference: null })
    ).items.find((item) => item.orderReference === orderReference);
  const reserved = async () =>
    (
      await admin.query(
        "SELECT reserved::text AS n FROM rms_inventory.stock_balance WHERE account_id=$1",
        [stock.accountReference],
      )
    ).rows[0].n;
  const releases = async () =>
    (
      await admin.query(
        "SELECT record_json FROM rms_inventory.stock_movement WHERE movement_type='Release' ORDER BY ledger_version",
      )
    ).rows.map((row) => row.record_json);
  const unpaid = await listed();
  assert.equal(unpaid?.currentPhase, "Submitted");
  assert.equal(unpaid.counter.recordedAfterOutage, false);
  assert.equal(unpaid.counter.canCancelUnpaid, true);
  assert.equal(unpaid.counter.cancelledBeforePayment, null);
  const heldBefore = await reserved();
  assert.notEqual(heldBefore, "0");
  assert.deepEqual(await releases(), []);

  const cancelCommand = {
    operationReference: next(),
    orderReference,
    orderBatchReference: String(batch.orderBatchReference),
    expectedOrderVersion: unpaid.currentVersion,
    reasonCode: "COUNTER_GUEST_LEFT_UNPAID",
  };
  const cancel = (overrides = {}) =>
    cancelUnpaid(managerSession)({
      sessionCookie: managerSession.sessionCookie,
      csrf: managerSession.csrf,
      command: { ...cancelCommand, ...overrides },
    });
  const cancelled = await cancel();
  assert.equal(cancelled.status, "Cancelled");
  // The append-only termination names the staff member and the reason, with its audit.
  const termination = (
    await admin.query(
      "SELECT termination_id::text AS id,actor_type,actor_id::text AS actor,reason_code,purpose_code,permission_code,previous_phase,phase FROM rms_ordering.order_termination_record WHERE order_id=$1",
      [orderReference],
    )
  ).rows;
  assert.equal(termination.length, 1);
  assert.deepEqual(
    { ...termination[0], id: undefined },
    {
      id: undefined,
      actor_type: "User",
      actor: manager,
      reason_code: "COUNTER_GUEST_LEFT_UNPAID",
      purpose_code: "CounterUnpaidCancellation",
      permission_code: "ordering.order.cancel",
      previous_phase: "Submitted",
      phase: "Cancelled",
    },
  );
  const audits = (
    await admin.query(
      "SELECT actor_type,actor_reference::text AS actor,reason_code FROM platform_audit.audit_record WHERE action_code='ORDER_TERMINATED' AND target_id=$1",
      [orderReference],
    )
  ).rows;
  assert.deepEqual(audits, [
    { actor_type: "User", actor: manager, reason_code: "COUNTER_GUEST_LEFT_UNPAID" },
  ]);
  // The reserved stock is back at once, released under the staff member's name.
  assert.equal(await reserved(), "0");
  const released = await releases();
  assert.equal(released.length, 1);
  assert.equal(released[0].performedBy, manager);
  assert.equal(released[0].reasonCode, "STAFF_CANCELLED_BEFORE_PREPARATION");
  // Released at the cancellation's instant (its references derive from the termination).
  assert.equal(Date.parse(released[0].occurredAt), Date.parse(cancelled.cancelledAt));
  assert.equal(released[0].movementReference.slice(0, 14), termination[0].id.slice(0, 14));

  // Orders: cancelled before payment by staff, with the reason; it no longer offers the cancel.
  const after = await listed();
  assert.equal(after.currentPhase, "Cancelled");
  assert.deepEqual(after.counter.cancelledBeforePayment, {
    reasonCode: "COUNTER_GUEST_LEFT_UNPAID",
    cancelledAt: cancelled.cancelledAt,
  });
  assert.equal(after.counter.canCancelUnpaid, false);
  // WP-2423 M61/M127: the order's record says who cancelled it, by name and never an id.
  const recorded = (
    await queue({
      sessionCookie: managerSession.sessionCookie,
      afterOrderReference: null,
      orderReference,
    })
  ).record;
  assert.deepEqual(
    recorded.cancellations.map((entry) => [entry.what, entry.by]),
    [["Order", "You"]],
  );
  assert.doesNotMatch(JSON.stringify(recorded), /[0-9a-f]{8}-[0-9a-f]{4}-/u);

  // A lost answer retried (even after picking another reason) answers with what was recorded;
  // nothing is written twice. Another cancellation of the same order is refused.
  const movements = async () =>
    (await admin.query("SELECT count(*)::int AS n FROM rms_inventory.stock_movement")).rows[0].n;
  const written = { terminations: await terminations(), movements: await movements() };
  for (const overrides of [{}, { reasonCode: "COUNTER_GUEST_CHANGED_MIND" }])
    assert.deepEqual(await cancel(overrides), {
      status: "AlreadyCancelled",
      cancelledAt: cancelled.cancelledAt,
    });
  await assert.rejects(cancel({ operationReference: next() }), {
    code: "COUNTER_CANCEL_NOT_CANCELLABLE",
  });
  assert.deepEqual({ terminations: await terminations(), movements: await movements() }, written);
  assert.equal(await reserved(), "0");

  // The card machine can no longer record a payment for it: nothing is charged or written.
  await assert.rejects(command(payInput({ operationReference: next(), takenAt: null })), {
    code: "CARD_MACHINE_NOT_PAYABLE",
  });
  assert.deepEqual(await counts(), before);
  return { cancelled };
}
