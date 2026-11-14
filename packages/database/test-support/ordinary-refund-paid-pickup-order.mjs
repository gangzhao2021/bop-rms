import assert from "node:assert/strict";
import { seedStaffItemCancellationQuote } from "./staff-item-cancellation-pricing.mjs";

/**
 * WP-2423 Q19: a paid, accepted pickup Order with two lines (synthetic test-only prices, 13%
 * exclusive tax, tip) as the ordinary refund acceptance tests seed it: Pricing quote, Ordering
 * submission/batch/items/acceptance/disposition and Payment intent/attempt/captured terminal
 * fact, written by the owner (admin) client. Same rows as the Q5 escalation acceptance.
 */
export function createPaidPickupOrderSeeder({
  admin,
  ownerRunner,
  scope,
  id,
  hash,
  fresh,
  time,
  minutes,
  acceptorReference,
  provider,
  lines: LINES,
  tipMinor: TIP_MINOR,
  capturedMinor: CAPTURED_MINOR,
}) {
  const { brandReference: brand, storeReference: store } = scope;
  const submittedAt = time(-minutes(40)),
    paidAt = time(-minutes(39)),
    acceptedAt = time(-minutes(38));
  const requester = acceptorReference;
  const businessDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(
    new Date(submittedAt),
  );
  async function seedOrder(n) {
    const b = n + 100;
    const order = { order: id(n + 1), guest: id(n + 2) };
    const refs = {
      batch: id(b + 1),
      submission: id(b + 2),
      cart: id(b + 3),
      quote: id(b + 4),
      checkout: id(b + 9),
      cartLines: [id(b + 40), id(b + 41)],
      items: [id(b + 50), id(b + 51)],
      intent: id(b + 80),
      attempt: id(b + 81),
      transaction: id(b + 82),
      event: id(b + 83),
      disposition: id(b + 84),
      confirmation: id(b + 85),
      confirmedEvent: id(b + 86),
      observation: id(b + 87),
      webhook: id(b + 88),
      acceptance: id(b + 89),
      paymentOperation: id(b + 90),
      correlation: id(b + 91),
      providerIntent: "pi_SYNTHETICQ5" + b,
    };
    order.batch = refs;
    await admin.query(
      "INSERT INTO rms_ordering.order_number_allocation (order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at,business_date_configuration_id,business_date_configuration_version,business_date_content_digest,time_zone,business_day_start,business_date_boundary_at,boundary_disambiguation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,'America/Toronto','00:00',$7,'Exact')",
      [
        order.order,
        brand,
        store,
        businessDate,
        n / 1000,
        String(n / 1000),
        submittedAt,
        id(50),
        hash("bd"),
      ],
    );
    await admin.query(
      "INSERT INTO rms_ordering.order_header (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,dining_session_id,created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,closure_status,payment_status,created_at) VALUES ($1,$2,$3,$4,$5,'Pickup','Web',NULL,$6,$6,1,'Submitted','Open','NotReported',$7)",
      [order.order, brand, store, businessDate, String(n / 1000), order.guest, submittedAt],
    );
    const inputDigest = hash(["quote-input", b]);
    const { quote, snapshots } = await seedStaffItemCancellationQuote({
      runner: ownerRunner,
      scope,
      orderBatchReference: refs.batch,
      quoteReference: refs.quote,
      cartReference: refs.cart,
      cartVersion: 1,
      inputDigest,
      quotedAt: time(-minutes(42)),
      capturedAt: time(-minutes(41)),
      addedAt: time(-minutes(45)),
      actorReference: order.guest,
      nextReference: fresh,
      lines: LINES.map((line, j) => ({
        ...line,
        cartLineReference: refs.cartLines[j],
        orderItemReference: refs.items[j],
        sellableReference: id(600 + j),
        priceEntryReference: id(b + 92 + j),
      })),
    });
    const orderAllocationMinor = quote.total.amountMinor;
    assert.equal(orderAllocationMinor + TIP_MINOR, CAPTURED_MINOR);
    await admin.query(
      "INSERT INTO rms_ordering.order_submission_record (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,source_cart_id,source_cart_version,quote_id,created_at,submission_kind) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,'Initial')",
      [
        refs.submission,
        brand,
        store,
        order.order,
        order.guest,
        hash(["intent", b]),
        refs.cart,
        refs.quote,
        submittedAt,
      ],
    );
    await admin.query(
      "INSERT INTO rms_ordering.order_batch (order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,source_cart_version,checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)",
      [
        refs.batch,
        brand,
        store,
        order.order,
        refs.submission,
        refs.cart,
        refs.checkout,
        refs.quote,
        order.guest,
        submittedAt,
      ],
    );
    // The receipt and refund item readers check each row against its immutable snapshot.
    const snapshot = (j) =>
      typeof snapshots[j] === "string" ? JSON.parse(snapshots[j]) : snapshots[j];
    for (const [j, orderItem] of refs.items.entries())
      await admin.query(
        "INSERT INTO rms_ordering.order_item (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at,ordinal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)",
        [
          orderItem,
          brand,
          store,
          order.order,
          refs.batch,
          refs.cartLines[j],
          LINES[j].quantity,
          snapshot(j).catalog.snapshotDigest,
          snapshot(j).pricing.quoteInputDigest,
          snapshots[j],
          snapshot(j).snapshotCapturedAt,
          j + 1,
        ],
      );
    await admin.query(
      "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'Initial',1,0,NULL,$1,$5)",
      [refs.submission, brand, store, order.order, submittedAt],
    );
    await admin.query(
      "INSERT INTO rms_payment.payment_intent (payment_intent_id,brand_id,store_id,payment_operation_id,order_id,order_batch_id,submission_id,guest_session_id,source_cart_id,source_cart_version,quote_id,preparation_id,capacity_allocation_id,intent_digest,preparation_source_digest,order_allocation_minor,tip_minor,total_minor,currency_code,payment_method,capture_mode,aggregate_version,creation_status,prepared_at,capacity_expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$14,$15,$16,$17,'CAD','OnlineCard','Automatic',1,'ProviderCreatePending',$18,$19,$18)",
      [
        refs.intent,
        brand,
        store,
        refs.paymentOperation,
        order.order,
        refs.batch,
        refs.submission,
        order.guest,
        refs.cart,
        refs.quote,
        id(b + 95),
        id(b + 96),
        hash(["payment-intent", b]),
        hash(["preparation", b]),
        orderAllocationMinor,
        TIP_MINOR,
        CAPTURED_MINOR,
        submittedAt,
        time(-minutes(10)),
      ],
    );
    await admin.query(
      "INSERT INTO rms_payment.payment_attempt (payment_attempt_id,brand_id,store_id,payment_intent_id,attempt_number,provider,provider_environment,provider_idempotency_digest,created_at) VALUES ($1,$2,$3,$4,1,'Stripe','Test',$5,$6)",
      [refs.attempt, brand, store, refs.intent, hash(["idempotency", b]), submittedAt],
    );
    await admin.query(
      "INSERT INTO rms_payment.payment_intent_operation_record (payment_operation_id,brand_id,store_id,payment_intent_id,guest_session_id,intent_digest,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [
        refs.paymentOperation,
        brand,
        store,
        refs.intent,
        order.guest,
        hash(["payment-intent", b]),
        submittedAt,
      ],
    );
    await admin.query(
      "INSERT INTO rms_payment.payment_provider_observation (provider_observation_id,brand_id,store_id,payment_intent_id,payment_attempt_id,observation_kind,normalized_status,provider_intent_reference,provider_transaction_reference,requested_minor,authorized_minor,captured_minor,refunded_minor,currency_code,evidence_digest,provider_observed_at,recorded_at) VALUES ($1,$2,$3,$4,$5,'Snapshot','Captured',$6,$7,$8,$8,$8,0,'CAD',$9,$10,$10)",
      [
        refs.observation,
        brand,
        store,
        refs.intent,
        refs.attempt,
        refs.providerIntent,
        "ch_SYNTHETICQ5" + b,
        CAPTURED_MINOR,
        hash(["observation", b]),
        paidAt,
      ],
    );
    await admin.query(
      "INSERT INTO rms_payment.provider_webhook_record (webhook_receipt_id,brand_id,store_id,provider,provider_environment,provider_account_id,provider_event_id,provider_event_type,provider_created_at,received_at,signature_timestamp,evidence_digest,accepted_at,raw_evidence_expires_at,dedupe_expires_at) VALUES ($1,$2,$3,'Stripe','Test',$4,$5,'payment_intent.succeeded',$6,$6,$6,$7,$6,$6::timestamptz+interval '30 days',$6::timestamptz+interval '90 days')",
      [
        refs.webhook,
        brand,
        store,
        provider,
        "evt_SYNTHETICQ5" + String(b).padStart(8, "0"),
        paidAt,
        hash(["webhook", b]),
      ],
    );
    await admin.query(
      "INSERT INTO rms_payment.payment_terminal_fact (payment_transaction_id,brand_id,store_id,payment_intent_id,payment_attempt_id,order_id,webhook_receipt_id,provider_event_id,provider_account_id,provider_environment,provider_intent_reference,provider_observation_id,authoritative_source,terminal_outcome,amount_minor,currency_code,failure_reason,retry_disposition,occurred_at,recorded_at,evidence_digest,event_id,causation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Test',$10,$11,'VerifiedWebhook','Succeeded',$12,'CAD',NULL,NULL,$13,$13,$14,$15,$7)",
      [
        refs.transaction,
        brand,
        store,
        refs.intent,
        refs.attempt,
        order.order,
        refs.webhook,
        "evt_SYNTHETICQ5" + String(b).padStart(8, "0"),
        provider,
        refs.providerIntent,
        refs.observation,
        CAPTURED_MINOR,
        paidAt,
        hash(["terminal", b]),
        refs.event,
      ],
    );
    await admin.query(
      "INSERT INTO rms_ordering.order_acceptance_record (acceptance_id,operation_id,brand_id,store_id,order_id,order_batch_id,expected_order_version,accepted_order_version,actor_type,actor_id,purpose_code,permission_code,reason_code,workflow_version_id,transition_id,source_digest,accepted_at) VALUES ($1,$2,$3,$4,$5,$6,1,2,'User',$7,'OrderAcceptance','order.accept','SYNTHETIC_TEST',$8,$9,$10,$11)",
      [
        refs.acceptance,
        id(b + 97),
        brand,
        store,
        order.order,
        refs.batch,
        requester,
        id(b + 98),
        id(b + 99),
        hash(["acceptance", b]),
        acceptedAt,
      ],
    );
    await admin.query(
      "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'Acceptance',2,1,$5,NULL,$6)",
      [refs.acceptance, brand, store, order.order, refs.submission, acceptedAt],
    );
    await admin.query(
      "INSERT INTO rms_ordering.order_payment_disposition_record (disposition_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_transaction_id,payment_intent_id,payment_attempt_id,payment_event_id,source_checkpoint,correlation_id,source_version,source_digest,evaluated_at,disposition,confirmation_id,source_snapshot_digest,confirmed_at,order_confirmed_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,2,$13,$14,'Confirmed',$15,$16,$14,$17)",
      [
        refs.disposition,
        brand,
        store,
        order.order,
        refs.batch,
        refs.submission,
        refs.transaction,
        refs.intent,
        refs.attempt,
        refs.event,
        refs.acceptance,
        refs.correlation,
        hash(["disposition", b]),
        acceptedAt,
        refs.confirmation,
        hash(["snapshot", b]),
        refs.confirmedEvent,
      ],
    );
    return order;
  }
  return Object.assign(seedOrder, { paidAt, businessDate });
}
