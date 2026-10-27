import { canonicalizeRfc8785, sha256Hex } from "../../bop/audit/src/index.ts";
import {
  createDiningTable,
  createPostgresDiningCheckoutCommitmentStore,
  parseDiningParticipant,
  parseDiningSession,
  prepareDiningCheckoutCommitment,
} from "../../rms/dining/src/index.ts";
import {
  createOrderItemSnapshots,
  parseCheckoutValidationEvidence,
} from "../../rms/ordering/src/index.ts";
import { orderWriteFixture } from "../../rms/ordering/src/tests/order-creation-store.fixture.ts";
import assert from "node:assert/strict";
import { createPriceQuote, createPostgresPriceQuoteStore } from "../../rms/pricing/src/index.ts";
import { input as quoteInput } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { createStoreConfigurationVersion } from "../../rms/store/src/index.ts";
import { createMerchantOrdinaryRefundBusinessDate } from "../../../apps/api/src/merchant-ordinary-refund-business-date.ts";
import { diningOrderCapacityLinkFromHistory } from "../../../apps/api/src/customer-dining-checkout-composition.ts";
import { seedStorePublication } from "./store-publication-seed.mjs";

/**
 * WP-2423 dine-in journey: synthetic, test-only fixtures for one table Order with several rounds.
 * Every round reuses the shared Order/Store/Dining identities of the ordering write fixture and gets
 * its own Batch, submission, Cart, quote, checkout and commitment identities (prefix remap).
 */
const hash = (value) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));

/**
 * One round of the shared dine-in Order, captured at `at`, with round-specific identities.
 * `submitter` (DEC-DINING-ANY-PARTICIPANT-SUBMIT) is another seated guest's Guest session who
 * submits and pays this round; the Cart lines keep the fixture guest as the one who added them.
 */
export function journeyRound({ at, prefix, submitter = null }) {
  const f = orderWriteFixture({ at, dineIn: true });
  const record = f.request.record,
    batch = record.order.batches[0],
    evidence = f.request.checkoutValidationEvidence;
  const replaced = new Set([
    batch.orderBatchReference,
    batch.submissionReference,
    batch.sourceCartReference,
    batch.quoteReference,
    batch.checkoutValidationReference,
    evidence.validationReference,
    evidence.fulfillment.evidenceReference,
    ...record.items.flatMap((item) => [item.orderItemReference, item.cartItemReference]),
  ]);
  const remap = (value) => {
    if (typeof value === "string" && replaced.has(value)) return prefix + value.slice(8);
    if (Array.isArray(value)) return value.map(remap);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v)]));
    return value;
  };
  const round = remap(f);
  if (submitter !== null) {
    round.request.record.guestSessionReference = submitter;
    round.request.record.order.batches[0].submittedByActorReference = submitter;
    round.request.checkoutValidationEvidence.guestSessionReference = submitter;
    round.snapshotInput.checkoutValidationEvidence.guestSessionReference = submitter;
  }
  return Object.freeze({
    f: round,
    batch: round.request.record.order.batches[0],
    /** Item snapshots as the Ordering writer rebuilds them (SKU = sellable, Ontario tax). */
    items(checkoutValidationEvidence = round.request.checkoutValidationEvidence) {
      return createOrderItemSnapshots({
        ...round.snapshotInput,
        checkoutValidationEvidence,
        lines: round.snapshotInput.lines.map((line) => ({
          ...line,
          catalog: { ...line.catalog, skuReference: line.catalog.sellableReference },
          pricing: {
            ...line.pricing,
            taxComponents: line.pricing.taxComponents.map((component) => ({
              ...component,
              jurisdictionCode: "CA-ON",
            })),
          },
        })),
      });
    },
    /** Checkout evidence bound to the Dining commitment the round was prepared under. */
    evidence(link) {
      return parseCheckoutValidationEvidence({
        ...round.request.checkoutValidationEvidence,
        fulfillment: {
          ...round.request.checkoutValidationEvidence.fulfillment,
          evidenceDigest: link.ownerSnapshotDigest,
        },
      });
    },
  });
}

/**
 * One occupied table: Active Session with the Host and a second (non-Host) participant.
 * `tableVersion` 2 is the table as seating moved it on (needed to release it when the table
 * closes); 1 keeps the earlier fixture for tests that never close the table.
 */
export async function seedJourneyDining({
  client,
  scope,
  round,
  startedAt,
  guestParticipant,
  tableVersion = 1,
}) {
  const record = round.f.request.record;
  const tableReference = round.f.scope.storeReference.slice(0, 24) + "00000000a001";
  const session = parseDiningSession({
    diningSessionReference: record.order.diningSessionReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    tableReference,
    tableAssignmentVersion: 1,
    phase: "Active",
    version: 2,
    startedByActorReference: record.guestSessionReference,
    startedAt,
    hostParticipantReference: round.f.cart.items[0].addedByParticipantReference,
  });
  const participant = (participantReference) =>
    parseDiningParticipant({
      participantReference,
      diningSessionReference: session.diningSessionReference,
      status: "Active",
      version: 1,
      joinedAt: startedAt,
      leftAt: null,
    });
  const host = participant(session.hostParticipantReference),
    guest = participant(guestParticipant);
  const table = createDiningTable({
    ...scope,
    tableReference,
    stableLabel: "SYNTHETIC-JOURNEY",
    areaReference: tableReference.slice(0, 24) + "00000000a002",
    areaCode: "ROOM",
    capacity: 4,
    accessibilityAttributes: [],
    lifecycle: "Published",
    qrStatus: "Active",
    qrVersion: 1,
    operationalState: "Available",
    blockReasonCode: null,
    activeDiningSessionReference: session.diningSessionReference,
    aggregateVersion: tableVersion,
    createdAt: startedAt,
    observedAt: startedAt,
  });
  await client.query(
    "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,$7,$5::jsonb,$6,$6)",
    [
      tableReference,
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      JSON.stringify(table),
      startedAt,
      tableVersion,
    ],
  );
  await client.query(
    "INSERT INTO rms_dining.dining_session (session_id,tenant_id,brand_id,store_id,table_id,version,phase,session_snapshot,started_at) VALUES ($1,$2,$3,$4,$5,2,'Active',$6::jsonb,$7)",
    [
      session.diningSessionReference,
      scope.tenantReference,
      scope.brandReference,
      scope.storeReference,
      tableReference,
      JSON.stringify(session),
      startedAt,
    ],
  );
  for (const p of [host, guest])
    await client.query(
      "INSERT INTO rms_dining.dining_participant (participant_id,tenant_id,brand_id,store_id,session_id,version,status,participant_snapshot) VALUES ($1,$2,$3,$4,$5,1,'Active',$6::jsonb)",
      [
        p.participantReference,
        scope.tenantReference,
        scope.brandReference,
        scope.storeReference,
        session.diningSessionReference,
        JSON.stringify(p),
      ],
    );
  let sequence = 0;
  const audit = (commitment) => ({
    auditId: tableReference.slice(0, 24) + (0xb000 + ++sequence).toString(16).padStart(12, "0"),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode:
      commitment.state === "Prepared" ? "DINING_CHECKOUT_PREPARE" : "DINING_CHECKOUT_SEAL",
    targetType: "DiningCheckoutCommitment",
    targetId: commitment.commitmentReference,
    reasonCode: "AUTHORIZED_DINING_CHECKOUT",
    correlationId: commitment.commitmentReference,
    occurredAt: commitment.orderingLinkedAt ?? commitment.preparedAt,
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const ownerRunner = {
    async run(work) {
      await client.query("BEGIN");
      try {
        const result = await work({ query: (sql, values) => client.query(sql, values) });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
  };
  return Object.freeze({
    session,
    host,
    guest,
    table,
    audit,
    /** Dining's checkout commitment for one round, prepared by `participant` (the Host unless
     * another seated participant submits the round) through the real owner store. */
    async prepare(
      target,
      { paymentOperationReference, participant = host, currentSession = session },
    ) {
      const r = target.f.request.record,
        b = target.batch,
        e = target.f.request.checkoutValidationEvidence;
      const prepared = prepareDiningCheckoutCommitment(
        {
          commitmentReference: e.fulfillment.evidenceReference,
          ...target.f.scope,
          diningSessionReference: session.diningSessionReference,
          // The session as it is now (a table whose checkout was started and cancelled moved on).
          sessionVersion: currentSession.version,
          tableReference,
          tableAssignmentVersion: 1,
          participantReference: participant.participantReference,
          participantVersion: participant.version,
          guestSessionReference: r.guestSessionReference,
          cartReference: b.sourceCartReference,
          cartVersion: b.sourceCartVersion,
          quoteReference: b.quoteReference,
          submissionReference: b.submissionReference,
          orderReference: r.order.orderReference,
          orderBatchReference: b.orderBatchReference,
          paymentOperationReference,
          intentHash: "a".repeat(64),
          preparedAt: e.fulfillment.checkedAt,
          preparationValidUntil: e.fulfillment.validUntil,
        },
        { session: currentSession, participant },
      );
      await createPostgresDiningCheckoutCommitmentStore(ownerRunner, scope, {
        now: () => e.fulfillment.checkedAt,
      }).append({ record: prepared, expectedVersion: 0, audit: audit(prepared) });
      return diningOrderCapacityLinkFromHistory(prepared);
    },
  });
}

/** Checkout allocation, session and details records written before a round is submitted. */
export async function seedJourneyCheckout(client, { round, evidence, link, references }) {
  const r = round.f.request.record,
    b = round.batch,
    scope = round.f.scope,
    at = evidence.validatedAt;
  await client.query(
    "INSERT INTO rms_ordering.checkout_session_allocation (brand_id,store_id,create_operation_id,guest_session_id,cart_id,cart_version,quote_id,quote_version,checkout_session_id,submission_id,payment_operation_id,allocated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11)",
    [
      scope.brandReference,
      scope.storeReference,
      references.createOperation,
      r.guestSessionReference,
      b.sourceCartReference,
      b.sourceCartVersion,
      b.quoteReference,
      references.checkoutSession,
      b.submissionReference,
      link.paymentOperationReference,
      at,
    ],
  );
  await client.query(
    "INSERT INTO rms_ordering.checkout_session_record (brand_id,store_id,checkout_session_id,create_operation_id,submission_id,payment_operation_id,guest_session_id,cart_id,snapshot_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)",
    [
      scope.brandReference,
      scope.storeReference,
      references.checkoutSession,
      references.createOperation,
      b.submissionReference,
      link.paymentOperationReference,
      r.guestSessionReference,
      b.sourceCartReference,
      JSON.stringify({
        schemaVersion: 1,
        checkoutSessionReference: references.checkoutSession,
        createOperationReference: references.createOperation,
        submissionReference: b.submissionReference,
        paymentOperationReference: link.paymentOperationReference,
        validation: evidence,
        createdAt: at,
      }),
      at,
    ],
  );
  await client.query(
    "INSERT INTO rms_ordering.checkout_details_record (brand_id,store_id,details_id,details_version,operation_id,guest_session_id,cart_id,snapshot_json,recorded_at) VALUES ($1,$2,$3,1,$4,$5,$6,$7::jsonb,$8)",
    [
      scope.brandReference,
      scope.storeReference,
      references.details,
      references.detailsOperation,
      r.guestSessionReference,
      b.sourceCartReference,
      JSON.stringify({
        schemaVersion: 1,
        detailsReference: references.details,
        detailsVersion: 1,
        ...scope,
        guestSessionReference: r.guestSessionReference,
        cartReference: b.sourceCartReference,
        cartVersion: b.sourceCartVersion,
        quoteReference: b.quoteReference,
        quoteVersion: 1,
        orderType: "DineIn",
        pickupContact: null,
        receipt: { choice: "InSession", email: null },
        policies: [],
        recordedAt: at,
      }),
      at,
    ],
  );
}

/**
 * Payment's facts for one round as Payment records them: the intent created when payment was
 * requested (window = request + 30 minutes), the attempt, the Provider observation, the verified
 * webhook, the terminal fact and the current payment-status projection.
 */
export async function seedJourneyPayment(
  client,
  {
    scope,
    providerAccountReference,
    round,
    refs,
    outcome,
    requestedAt,
    occurredAt,
    totalMinor,
    idempotencyDigest,
    providerEnvironment = "Test",
  },
) {
  const r = round.f.request.record,
    b = round.batch,
    s = scope;
  const succeeded = outcome === "Succeeded";
  const expires = new Date(Date.parse(requestedAt) + 30 * 60_000).toISOString();
  const key = refs.paymentIntent;
  await client.query(
    "INSERT INTO rms_payment.payment_intent (payment_intent_id,brand_id,store_id,payment_operation_id,order_id,order_batch_id,submission_id,guest_session_id,source_cart_id,source_cart_version,quote_id,preparation_id,capacity_allocation_id,intent_digest,preparation_source_digest,order_allocation_minor,tip_minor,total_minor,currency_code,payment_method,capture_mode,aggregate_version,creation_status,prepared_at,capacity_expires_at,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,0,$16,'CAD','OnlineCard','Automatic',1,'ProviderCreatePending',$17,$18,$17)",
    [
      key,
      s.brandReference,
      s.storeReference,
      refs.paymentOperation,
      r.order.orderReference,
      b.orderBatchReference,
      b.submissionReference,
      r.guestSessionReference,
      b.sourceCartReference,
      b.sourceCartVersion,
      b.quoteReference,
      refs.preparation,
      refs.commitment,
      hash(["payment-intent", key]),
      hash(["preparation", key]),
      totalMinor,
      requestedAt,
      expires,
    ],
  );
  await client.query(
    "INSERT INTO rms_payment.payment_attempt (payment_attempt_id,brand_id,store_id,payment_intent_id,attempt_number,provider,provider_environment,provider_idempotency_digest,created_at) VALUES ($1,$2,$3,$4,1,'Stripe',$7,$5,$6)",
    [
      refs.attempt,
      s.brandReference,
      s.storeReference,
      key,
      idempotencyDigest ?? hash(["idempotency", key]),
      requestedAt,
      providerEnvironment,
    ],
  );
  await client.query(
    "INSERT INTO rms_payment.payment_intent_operation_record (payment_operation_id,brand_id,store_id,payment_intent_id,guest_session_id,intent_digest,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [
      refs.paymentOperation,
      s.brandReference,
      s.storeReference,
      key,
      r.guestSessionReference,
      hash(["payment-intent", key]),
      requestedAt,
    ],
  );
  // WP-2423 abandoned payment: "CreateUnknown" — the Provider create's answer was lost (timeout):
  // the attempt's only observation is an unknown failure, so the guest never got a card form.
  if (outcome === "CreateUnknown") {
    await client.query(
      "INSERT INTO rms_payment.payment_provider_observation (provider_observation_id,brand_id,store_id,payment_intent_id,payment_attempt_id,observation_kind,failure_code,retry_disposition,safe_reason_code,recorded_at) VALUES ($1,$2,$3,$4,$5,'Failure','Unknown','Unknown','CREATE_RESULT_UNKNOWN',$6)",
      [refs.observation, s.brandReference, s.storeReference, key, refs.attempt, occurredAt],
    );
    return;
  }
  // WP-2423 abandoned payment: "Open" — the guest started paying (the Provider intent exists) and
  // never confirmed it, so there is no outcome, webhook or status projection.
  const open = outcome === "Open";
  await client.query(
    "INSERT INTO rms_payment.payment_provider_observation (provider_observation_id,brand_id,store_id,payment_intent_id,payment_attempt_id,observation_kind,normalized_status,provider_intent_reference,provider_transaction_reference,requested_minor,authorized_minor,captured_minor,refunded_minor,currency_code,evidence_digest,provider_observed_at,recorded_at) VALUES ($1,$2,$3,$4,$5,'Snapshot',$6,$7,$8,$9,$10,$10,0,'CAD',$11,$12,$12)",
    [
      refs.observation,
      s.brandReference,
      s.storeReference,
      key,
      refs.attempt,
      succeeded ? "Captured" : open ? "RequiresCustomerAction" : "Failed",
      refs.providerIntent,
      succeeded ? "ch_" + refs.providerIntent.slice(3) : null,
      totalMinor,
      succeeded ? totalMinor : 0,
      hash(["observation", key]),
      occurredAt,
    ],
  );
  if (open) return;
  await client.query(
    "INSERT INTO rms_payment.provider_webhook_record (webhook_receipt_id,brand_id,store_id,provider,provider_environment,provider_account_id,provider_event_id,provider_event_type,provider_created_at,received_at,signature_timestamp,evidence_digest,accepted_at,raw_evidence_expires_at,dedupe_expires_at) VALUES ($1,$2,$3,'Stripe','Test',$4,$5,$6,$7,$7,$7,$8,$7,$7::timestamptz+interval '30 days',$7::timestamptz+interval '90 days')",
    [
      refs.webhook,
      s.brandReference,
      s.storeReference,
      providerAccountReference,
      refs.providerEvent,
      succeeded ? "payment_intent.succeeded" : "payment_intent.payment_failed",
      occurredAt,
      hash(["webhook", key]),
    ],
  );
  await client.query(
    "INSERT INTO rms_payment.payment_terminal_fact (payment_transaction_id,brand_id,store_id,payment_intent_id,payment_attempt_id,order_id,webhook_receipt_id,provider_event_id,provider_account_id,provider_environment,provider_intent_reference,provider_observation_id,authoritative_source,terminal_outcome,amount_minor,currency_code,failure_reason,retry_disposition,occurred_at,recorded_at,evidence_digest,event_id,causation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Test',$10,$11,'VerifiedWebhook',$12,$13,$14,$15,$16,$17,$17,$18,$19,$7)",
    [
      refs.transaction,
      s.brandReference,
      s.storeReference,
      key,
      refs.attempt,
      r.order.orderReference,
      refs.webhook,
      refs.providerEvent,
      providerAccountReference,
      refs.providerIntent,
      refs.observation,
      outcome,
      succeeded ? totalMinor : null,
      succeeded ? "CAD" : null,
      succeeded ? null : "Declined",
      succeeded ? null : "NewOperation",
      occurredAt,
      hash(["terminal", key]),
      refs.paymentEvent,
    ],
  );
  await client.query(
    "INSERT INTO rms_payment.payment_status_projection (projection_generation_id,brand_id,store_id,payment_intent_id,payment_transaction_id,payment_attempt_id,order_id,terminal_status,amount_minor,currency_code,failure_reason,retry_disposition,terminal_occurred_at,source_event_id,source_aggregate_version,projection_name,projection_version,projected_at,last_rebuilt_at,freshness_status,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,2,'payment_status_v1',1,$13,NULL,'Fresh',true)",
    [
      refs.projection,
      s.brandReference,
      s.storeReference,
      key,
      refs.transaction,
      refs.attempt,
      r.order.orderReference,
      outcome,
      succeeded ? totalMinor : null,
      succeeded ? "CAD" : null,
      succeeded ? null : "Declined",
      succeeded ? null : "NewOperation",
      occurredAt,
      refs.paymentEvent,
    ],
  );
}

/**
 * Staff accept a paid round and Ordering records its payment Confirmed; the kitchen ticket is
 * created with one queued work item per order item (as the owners record them).
 */
export async function seedJourneyAcceptance(
  client,
  { scope, round, items, refs, staff, version, previousRevision, acceptedAt, kitchenAt },
) {
  const r = round.f.request.record,
    b = round.batch,
    s = scope;
  await client.query(
    "INSERT INTO rms_ordering.order_acceptance_record (acceptance_id,operation_id,brand_id,store_id,order_id,order_batch_id,expected_order_version,accepted_order_version,actor_type,actor_id,purpose_code,permission_code,reason_code,workflow_version_id,transition_id,source_digest,accepted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'User',$9,'OrderAcceptance','order.accept','SYNTHETIC_TEST',$10,$11,$12,$13)",
    [
      refs.acceptance,
      refs.acceptanceOperation,
      s.brandReference,
      s.storeReference,
      r.order.orderReference,
      b.orderBatchReference,
      version,
      version + 1,
      staff,
      refs.acceptanceWorkflow,
      refs.acceptanceTransition,
      hash(["acceptance", refs.acceptance]),
      acceptedAt,
    ],
  );
  await client.query(
    "INSERT INTO rms_ordering.order_revision (revision_id,brand_id,store_id,order_id,kind,version,expected_version,previous_revision_id,initial_submission_id,occurred_at) VALUES ($1,$2,$3,$4,'Acceptance',$5,$6,$7,NULL,$8)",
    [
      refs.acceptance,
      s.brandReference,
      s.storeReference,
      r.order.orderReference,
      version + 1,
      version,
      previousRevision,
      acceptedAt,
    ],
  );
  await client.query(
    "INSERT INTO rms_ordering.order_payment_disposition_record (disposition_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_transaction_id,payment_intent_id,payment_attempt_id,payment_event_id,source_checkpoint,correlation_id,source_version,source_digest,evaluated_at,disposition,confirmation_id,source_snapshot_digest,confirmed_at,order_confirmed_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'Confirmed',$16,$17,$15,$18)",
    [
      refs.disposition,
      s.brandReference,
      s.storeReference,
      r.order.orderReference,
      b.orderBatchReference,
      b.submissionReference,
      refs.transaction,
      refs.paymentIntent,
      refs.attempt,
      refs.paymentEvent,
      refs.acceptance,
      refs.correlation,
      version + 1,
      hash(["disposition", refs.disposition]),
      acceptedAt,
      refs.confirmation,
      hash(["snapshot", refs.disposition]),
      refs.confirmedEvent,
    ],
  );
  await client.query(
    "INSERT INTO rms_kitchen.kitchen_ticket (kitchen_ticket_id,brand_id,store_id,order_id,order_batch_id,confirmation_id,consumer_name,consumer_version,source_event_id,source_aggregate_version,source_snapshot_digest,confirmed_at,correlation_id,semantic_event_binding_digest,source_evidence_id,source_evidence_version,source_evidence_digest,source_evidence_captured_at,work_plan_id,work_plan_version,work_plan_digest,work_plan_generated_at,aggregate_version,status,created_by_actor_type,updated_by_actor_type,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,'kitchen.confirmed-order:v1',1,$7,$8,$9,$10,$11,$12,$13,1,$14,$10,$16,1,$17,$15,1,'Open','System','System',$15,$15)",
    [
      refs.ticket,
      s.brandReference,
      s.storeReference,
      r.order.orderReference,
      b.orderBatchReference,
      refs.confirmation,
      refs.confirmedEvent,
      version + 1,
      hash(["snapshot", refs.disposition]),
      acceptedAt,
      refs.correlation,
      hash(["binding", refs.ticket]),
      refs.sourceEvidence,
      hash(["evidence", refs.ticket]),
      kitchenAt,
      refs.workPlan,
      hash(["plan", refs.ticket]),
    ],
  );
  for (const [j, item] of items.entries())
    await client.query(
      "INSERT INTO rms_kitchen.kitchen_work_item (kitchen_work_item_id,brand_id,store_id,kitchen_ticket_id,order_id,order_batch_id,order_item_id,source_evidence_id,work_plan_id,source_item_ordinal,split_ordinal,version,status,required_quantity,completed_quantity,product_id,product_version_id,sku_id,menu_version_id,localized_display_names_json,selected_options_json,source_line_digest,station_id,routing_rule_id,routing_rule_version,routing_rule_digest,preparation_id,preparation_version,preparation_digest,preparation_instructions_json,execution_snapshot_digest,created_by_actor_type,updated_by_actor_type,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,1,'Queued',$11,0,$12,$13,$14,$15,$16::jsonb,'[]'::jsonb,$17,$18,$19,1,$20,$21,1,$22,$23::jsonb,$24,'System','System',$25,$25)",
      [
        refs.workItems[j],
        s.brandReference,
        s.storeReference,
        refs.ticket,
        r.order.orderReference,
        b.orderBatchReference,
        item.orderItemReference,
        refs.sourceEvidence,
        refs.workPlan,
        j + 1,
        item.quantity,
        item.catalog.productReference,
        item.catalog.productVersionReference,
        item.catalog.skuReference,
        item.catalog.menuVersionReference,
        JSON.stringify(item.catalog.localizedNames),
        hash(["line", refs.ticket, j]),
        refs.station,
        refs.routing,
        hash(["routing", refs.ticket]),
        refs.preparationStep,
        hash(["preparation-step", refs.ticket]),
        JSON.stringify(["Synthetic preparation"]),
        hash(["execution", refs.ticket, j]),
        kitchenAt,
      ],
    );
}

/**
 * Published Store configuration whose business day starts at `businessDayStart` (local time), so
 * a refund requested now is on a later business date than a capture before that instant.
 * Synthetic test-only Store facts; actual published owner records/proof.
 */
export async function seedJourneyStorePublication({
  client,
  scope,
  publishedAt,
  businessDayStart,
  prefix,
  // How long the publication's launch evidence stays valid (default two days after publishing).
  validUntil = new Date(Date.parse(publishedAt) + 2 * 86400000).toISOString(),
}) {
  const id = (n) =>
    n === 90
      ? scope.tenantReference
      : prefix + "-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const at = publishedAt;
  const fields = {
    configurationReference: id(1),
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    configurationVersion: 1,
    lifecycle: "Published",
    source: "StoreOverride",
    brandBaseVersionReference: id(4),
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    timeZone: "America/Toronto",
    businessDayStartLocalTime: businessDayStart,
    addressReference: id(5),
    contactReference: id(6),
    receiptReference: id(7),
    taxConfigurationReference: id(8),
    paymentConfigurationReference: id(9),
    capacityConfigurationReference: null,
    enabledServiceModes: ["DineIn", "Pickup"],
    weeklySchedule: Array.from({ length: 7 }, (_, i) => ({
      isoWeekday: i + 1,
      intervals:
        i === 0
          ? [
              {
                startLocalTime: "09:00:00",
                endLocalTime: "22:00:00",
                endsNextDay: false,
                serviceModes: ["DineIn", "Pickup"],
                orderCutoffSeconds: 900,
                leadTimeSeconds: 1200,
              },
            ]
          : [],
    })),
    exceptions: [],
    effectiveFrom: at,
    effectiveUntil: null,
    supersedesConfigurationReference: null,
    reasonCode: "PILOT_CONFIGURATION",
    authoredByReference: id(10),
    approvedByReference: id(11),
    approvalEvidenceReference: id(12),
    publicationReference: id(13),
    liveGateEvidenceReference: id(14),
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
  };
  const configuration = createStoreConfigurationVersion(fields);
  const row = {
    configuration_id: id(1),
    brand_id: scope.brandReference,
    store_id: scope.storeReference,
    configuration_version: 1,
    lifecycle: "Published",
    configuration_source: "StoreOverride",
    brand_base_version_reference: id(4),
    default_locale: "en-CA",
    currency_code: "CAD",
    time_zone: "America/Toronto",
    business_day_start_local_time: businessDayStart,
    address_reference: id(5),
    contact_reference: id(6),
    receipt_reference: id(7),
    tax_configuration_reference: id(8),
    payment_configuration_reference: id(9),
    capacity_configuration_reference: null,
    enabled_service_modes: ["DineIn", "Pickup"],
    effective_from: at,
    effective_until: null,
    supersedes_configuration_reference: null,
    reason_code: "PILOT_CONFIGURATION",
    authored_by_reference: id(10),
    approved_by_reference: id(11),
    approval_evidence_reference: id(12),
    publication_reference: id(13),
    live_gate_evidence_reference: id(14),
    created_at: at,
    updated_at: at,
    data_classification: "ConfigurationMetadata",
  };
  await client.query(
    "INSERT INTO rms_store.store_configuration_version SELECT * FROM jsonb_populate_record(NULL::rms_store.store_configuration_version,$1::jsonb)",
    [JSON.stringify(row)],
  );
  await client.query(
    "INSERT INTO rms_store.store_weekly_service_period VALUES($1,$2,$3,$4,1,1,'09:00:00','22:00:00',false,ARRAY['DineIn','Pickup'],900,1200,'ConfigurationMetadata')",
    [id(20), scope.brandReference, scope.storeReference, id(1)],
  );
  const digest = "sha256:" + sha256Hex(canonicalizeRfc8785(configuration));
  await client.query(
    "INSERT INTO rms_store.store_configuration_publication_content VALUES ($1,$2,$3,$4,'STORE_CONFIGURATION','STORE_CONFIGURATION',$5,$6,'StoreOverride',$7,'ConfigurationMetadata')",
    [scope.brandReference, scope.storeReference, id(1), id(70), digest, configuration, at],
  );
  await seedStorePublication(client, id, configuration, digest, undefined, undefined, validUntil);
  const storeOptions = {
    ...scope,
    timeZone: "America/Toronto",
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    requiredLiveGateRequirementCodes: ["SYNTHETIC_STORE_READY"],
    authorize: async () => true,
  };
  return { storeOptions, businessDate: createMerchantOrdinaryRefundBusinessDate(storeOptions) };
}

/** The original Pricing quote of one round (as additional-original-quote, per-round identities). */
export async function seedJourneyQuote({ runner, scope, snapshot, prefix }) {
  assert.equal(snapshot.items.length, 1);
  const item = snapshot.items[0],
    original = item.pricing;
  const base = quoteInput();
  const expiresAt = new Date(Date.parse(original.quotedAt) + 300000).toISOString();
  const currencyMetadata = {
    ...base.currencyMetadata,
    metadataVersion: original.currencyMetadataVersion,
    metadataVersionReference: original.currencyMetadataVersionReference,
    metadataDigest: original.currencyMetadataDigest,
  };
  const quote = createPriceQuote({
    ...base,
    quoteReference: snapshot.batch.quoteReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    cartReference: snapshot.batch.sourceCartReference,
    cartVersion: snapshot.batch.sourceCartVersion,
    inputDigest: original.quoteInputDigest,
    createdAt: original.quotedAt,
    expiresAt,
    currencyMetadata,
    priceBook: {
      ...base.priceBook,
      brandReference: scope.brandReference,
      currencyMetadata,
      priceBookReference: original.priceResolution.priceBookReference,
      versionReference: original.priceResolution.priceBookVersionReference,
      snapshotDigest: original.priceResolution.priceBookDigest,
      entries: [
        {
          ...base.priceBook.entries[0],
          entryReference: original.priceResolution.priceEntryReference,
          sellableReference: original.sellableReference,
          amount: original.unitPrice,
          scopeKind: "Store",
          scopeReference: scope.storeReference,
          channelCode: original.priceResolution.channelCode,
          orderType: "DineIn",
          reasonCode: original.priceResolution.reasonCode,
        },
      ],
    },
    taxConfiguration: {
      ...base.taxConfiguration,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      configurationReference: original.taxConfigurationReference,
      versionReference: original.taxConfigurationVersionReference,
      snapshotDigest: original.taxConfigurationDigest,
      jurisdictionCode: original.taxComponents[0].jurisdictionCode,
      currencyMetadata,
      registrationEvidence: {
        ...base.taxConfiguration.registrationEvidence,
        validUntil: expiresAt,
      },
      professionalEvidence: {
        ...base.taxConfiguration.professionalEvidence,
        validUntil: expiresAt,
        snapshotReference: original.taxConfigurationVersionReference,
        snapshotDigest: original.taxConfigurationDigest,
      },
      rules: [
        {
          ...base.taxConfiguration.rules[0],
          orderType: "DineIn",
          ruleReference: original.taxComponents[0].ruleVersionReference,
          taxClassificationReference: original.taxComponents[0].taxClassificationReference,
          taxComponentCode: original.taxComponents[0].taxComponentCode,
          rate: original.taxComponents[0].rate,
        },
      ],
    },
    lines: [
      {
        ...base.lines[0],
        lineReference: original.lineReference,
        sellableReference: original.sellableReference,
        productVersionReference: item.catalog.productVersionReference,
        menuVersionReference: item.catalog.menuVersionReference,
        quantity: item.quantity,
        priceContext: {
          ...base.lines[0].priceContext,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          sellableReference: original.sellableReference,
          channelCode: original.priceResolution.channelCode,
          orderType: "DineIn",
          evaluatedAt: original.quotedAt,
        },
        taxContext: {
          ...base.lines[0].taxContext,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          jurisdictionCode: original.taxComponents[0].jurisdictionCode,
          taxClassificationReference: original.taxComponents[0].taxClassificationReference,
          orderType: "DineIn",
          evaluatedAt: original.quotedAt,
        },
      },
    ],
  });
  for (const component of ["subtotal", "discount", "tax", "fee", "total"])
    assert.equal(quote.lines[0][component].amountMinor, original[component].amountMinor);
  let sequence = 0;
  const id = (n) => prefix + "-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  await createPostgresPriceQuoteStore(
    runner(),
    {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
    },
    { generateReference: () => id(++sequence) },
  ).append({
    quote,
    audit: {
      auditId: id(90),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "PRICING_QUOTE_CREATE",
      targetType: "PricingPriceQuote",
      targetId: quote.quoteReference,
      reasonCode: "AUTHORIZED_CART_QUOTE",
      correlationId: id(91),
      occurredAt: quote.createdAt,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    },
  });
}
