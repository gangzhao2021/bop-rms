import { seedOrdinaryRefundSession } from "./ordinary-refund-session.mjs";
import { createMerchantAcceptanceConfigurationResolver } from "../../../apps/api/src/merchant-acceptance-configuration-resolver.ts";
import { createPersistentMerchantOrderQueue } from "../../../apps/api/src/persistent-merchant-order-queue.ts";
import { seedMerchantAcceptanceSession } from "./merchant-acceptance-session.mjs";
import { createMerchantOrderAcceptanceCommand } from "../../../apps/api/src/merchant-order-acceptance-command.ts";
import { exerciseCapturedOrderFulfillment } from "./captured-order-fulfillment.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createMerchantPaidOrderAcceptance } from "../../../apps/api/src/merchant-paid-order-acceptance.ts";
import { createOrderPaidOutcomeSource } from "../../../apps/api/src/order-paid-outcome-source.ts";
import { evaluateIntactReservationPaymentRule } from "../../rms/inventory/src/index.ts";
import {
  createPostgresMerchantOrderIndex,
  createPostgresOrderPaymentAcceptanceWaitStore,
  createOrderPaymentOutcomeConsumerService,
  createPostgresOrderPaymentOutcomeStore,
  createPostgresOrderKitchenSourceStore,
} from "../../rms/ordering/src/index.ts";
import { exerciseKitchenTicketCreation } from "./kitchen-ticket-creation.mjs";

/** Actual captured Payment/resource context and published actions; external policy authority remains synthetic. */
export async function exerciseCapturedOrderKitchen({
  /** WP-2423 Q7: inspect the order queue's view of this Order before it is accepted. */
  onQueueItem,
  kitchenNow,
  reuseInventoryRecipe,
  onPickupReady,
  additionalServices = [],
  admin,
  runner,
  role,
  scope,
  order,
  quoteVersion,
  paymentWorkflow,
  paymentScope,
  context,
  event,
}) {
  const index = createPostgresMerchantOrderIndex({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    authorize: async () => true, // Isolated internal source test authority.
  });
  const indexed = await runner.run((transaction) =>
    index.list({ transaction, afterOrderReference: null, limit: 100 }),
  );
  const discovered = indexed.items.find(
    (item) => item.orderReference === order.order.orderReference,
  );
  assert.ok(discovered);
  assert.equal(discovered.initialSubmissionReference, order.submissionReference);
  assert.equal(discovered.initialBatchReference, order.order.batches[0].orderBatchReference);
  assert.equal(discovered.orderType, order.order.orderType);
  assert.equal(Object.hasOwn(discovered, "aggregateVersion"), false);
  let sequence = 61000;
  const id = (n) => "0190ef00-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const next = () => id(sequence++);
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const actor = next();
  const at = new Date().toISOString();
  await admin.query(
    "GRANT SELECT,INSERT ON rms_ordering.order_acceptance_record,rms_ordering.order_acceptance_hold,rms_ordering.order_acceptance_hold_resolution,rms_ordering.order_payment_disposition_record,rms_ordering.order_payment_failure_record,rms_ordering.order_payment_acceptance_wait TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT ON rms_ordering.order_batch_checkout_cancellation,rms_ordering.order_staff_cancellation,rms_ordering.order_item_staff_cancellation TO " +
      role,
  );
  // WP-2423 Q7: the order queue shows counter orders and their card-machine payments.
  await admin.query(
    "GRANT SELECT ON rms_ordering.counter_order_entry,rms_ordering.staff_dining_round_entry,rms_payment.card_machine_payment,rms_payment.card_machine_refund TO " +
      role,
  );
  await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_eventing.consumer_inbox TO " + role);
  const record = {
    acceptanceReference: next(),
    operationReference: next(),
    orderReference: order.order.orderReference,
    orderBatchReference: order.order.batches[0].orderBatchReference,
    expectedOrderVersion: 1,
  };
  const gates = {
    authorizeResource: async () => true,
    authorizeAction: async () => true,
    authorizeOverride: async () => false,
    evaluateRule: async () => {
      throw new Error("accept has no configured rules");
    },
  };
  let actorAllowed = false;
  const merchant = createMerchantPaidOrderAcceptance({
    scope,
    quoteVersion,
    context,
    actorReference: actor,
    authorizeActor: async () => actorAllowed, // Explicit synthetic test authorization only.
    workflowVersionReference: paymentWorkflow.workflowVersionReference,
    reasonCode: "SYNTHETIC_TEST",
    acceptance: {
      action: "Accept",
      purposeCode: paymentWorkflow.purposeCode,
      permissionCode: "order.accept",
    },
    gates,
    authorize: async (_tx, candidate) => candidate.actorReference === actor,
    audit: async (accepted) => ({
      auditId: next(),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "User", reference: actor },
      actionCode: "ORDER_ACCEPTED",
      targetType: "Order",
      targetId: accepted.orderReference,
      correlationId: accepted.operationReference,
      reasonCode: accepted.reasonCode,
      occurredAt: accepted.acceptedAt,
      sourceChannel: "MERCHANT_WEB",
      afterSummary: { phase: "Accepted" },
      dataClassification: "Restricted",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    }),
  });
  let observedAt = at;
  const source = createOrderPaidOutcomeSource({
    context,
    quoteVersion,
    sha256: hash,
    release: {
      action: "ReleasePaidOrder",
      purposeCode: paymentWorkflow.purposeCode,
      permissionCode: "order.release",
      nextState: "Accepted",
    },
    generateDispositionReference: next,
    generateConfirmationReference: next,
    resolveWorkflow: async ({ context: current }) => {
      observedAt = current.observedAt;
      assert.equal(current.terminal.event.eventId, event.eventId);
      assert.equal(current.acceptance.acceptanceReference, record.acceptanceReference);
      return {
        request: {
          ...scope,
          actorReference: actor,
          resourceReference: record.orderReference,
          resourceVersion: 2,
          purposeCode: paymentWorkflow.purposeCode,
          applicabilityCode: order.order.orderType,
          expectedVersionReference: paymentWorkflow.workflowVersionReference,
          currentState: "Accepted",
          action: "ReleasePaidOrder",
          observedAt,
        },
        gates: {
          ...gates,
          evaluateRule: async (_tx, request) =>
            request.ruleReference === paymentWorkflow.intactReservationRuleReference &&
            current.capacity !== null &&
            current.inventory !== null &&
            evaluateIntactReservationPaymentRule(current.inventory),
        },
      };
    },
  });
  const outcomes = createPostgresOrderPaymentOutcomeStore({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    sha256: hash,
    audit: async ({ orderReference, correlationReference, outcome }) => ({
      auditId: next(),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "ORDER_PAYMENT_DISPOSITION_RECORDED",
      targetType: "Order",
      targetId: orderReference,
      correlationId: correlationReference,
      afterSummary: { outcome },
      reasonCode: "PAYMENT_CAPTURED",
      occurredAt: observedAt,
      sourceChannel: "EVENT_CONSUMER",
      dataClassification: "Restricted",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    }),
  });
  const waits = createPostgresOrderPaymentAcceptanceWaitStore({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    sha256: hash,
    authorize: async () => true, // Isolated internal consumer test authority.
    validateCurrent: async (transaction, { event: paid, record: waiting }) => {
      const current = await source.loadExact({
        transaction,
        paymentEvent: paid,
        brandReference: paid.tenantId,
        storeReference: paid.storeId,
        orderReference: paid.payload.orderReference,
        paymentTransactionReference: paid.payload.paymentTransactionReference,
        paymentIntentReference: paid.payload.paymentIntentReference,
        paymentAttemptReference: paid.payload.paymentAttemptReference,
        paymentEventReference: paid.eventId,
      });
      return (
        current?.disposition === "AwaitingAcceptance" &&
        [
          "brandReference",
          "storeReference",
          "orderReference",
          "orderBatchReference",
          "submissionReference",
          "sourceVersion",
          "sourceCheckpoint",
        ].every((key) => current[key] === waiting[key])
      );
    },
    audit: async ({ event: paid, record: waiting }) => ({
      auditId: next(),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "ORDER_PAYMENT_WAIT_RECORDED",
      targetType: "OrderPaymentWait",
      targetId: waiting.dispositionReference,
      correlationId: paid.correlationId,
      afterSummary: { outcome: "AwaitingAcceptance" },
      reasonCode: "ORDER_ACCEPTANCE_PENDING",
      occurredAt: waiting.evaluatedAt,
      sourceChannel: "EVENT_CONSUMER",
      dataClassification: "Restricted",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    }),
  });
  const consumer = createOrderPaymentOutcomeConsumerService({
    authorization: { authorize: async () => true },
    source,
    outcomes,
    references: { generate: next },
    digests: { sha256: hash },
    // WP-2423 Q1: as in the pilot worker, the consumer records the paid batch as awaiting staff
    // acceptance and later resumes it to its outcome.
    waiting: {
      record: async ({ transaction, event: paid, disposition }) =>
        (await waits.record(transaction, paid, disposition)).record,
      load: ({ transaction, event: paid }) => waits.load(transaction, paid),
    },
  });
  // PaymentSucceeded is consumed before staff acceptance: Ordering records the batch as paid and
  // awaiting acceptance, which is what offers it for acceptance in the merchant queue.
  const waited = await runner.run((tx) => consumer.consume(tx, event));
  assert.equal(waited.consumerOutcome.status, "processed");
  assert.equal(waited.result.status, "AwaitingOrderAcceptance");
  assert.equal(waited.result.disposition.orderBatchReference, record.orderBatchReference);
  const accept = (command = record) =>
    runner.run((transaction) => merchant.commit({ transaction, command, paymentEvent: event }));
  await assert.rejects(accept(), { code: "ORDER_ACCEPTANCE_RECORD_UNAVAILABLE" });
  actorAllowed = true;
  await assert.rejects(accept({ ...record, sourceDigest: hash("CALLER_FORGED") }));
  await assert.rejects(accept({ ...record, expectedOrderVersion: 2 }), {
    code: "ORDER_ACCEPTANCE_RECORD_UNAVAILABLE",
  });
  const session = await seedMerchantAcceptanceSession({
    admin,
    runner,
    role,
    scope,
    actor,
    at,
    kitchenPermission: kitchenNow !== undefined,
    // Staff accept from an ordinary Workforce Session; a NamedKdsOperator Session may only enter
    // the workspace and operate the Kitchen (IDR-0039), so the Kitchen gets its own Session below.
    authenticationPolicyCode: "WorkforceStandard",
  });
  const kitchenSession =
    kitchenNow === undefined
      ? undefined
      : {
          ...(await seedOrdinaryRefundSession({
            client: admin,
            runner: () => runner,
            scope,
            requester: actor,
            at,
            policyCode: "NamedKdsOperator",
            referencePrefix: "01909966",
          })),
          revokeKitchen: session.revokeKitchen,
        };
  const queue = createPersistentMerchantOrderQueue({
    persistence: { ...session.persistence, now: () => new Date().toISOString() },
    quoteVersion,
    acceptanceConfigured: true,
  });
  const beforeAcceptance = await queue({
    sessionCookie: session.sessionCookie,
    afterOrderReference: null,
  });
  assert.equal(
    beforeAcceptance.items.find((item) => item.orderReference === record.orderReference)
      ?.canRequestAcceptance,
    true,
  );
  await onQueueItem?.(
    beforeAcceptance.items.find((item) => item.orderReference === record.orderReference),
  );
  const resolveConfiguration = createMerchantAcceptanceConfigurationResolver({
    now: () => new Date().toISOString(),
    authorize: async (_tx, selected) =>
      selected.tenantReference === scope.tenantReference &&
      selected.brandReference === scope.brandReference &&
      selected.storeReference === scope.storeReference &&
      selected.actorReference === actor,
    resolvePolicy: async () => ({
      paymentScope,
      initial: {
        context,
        quoteVersion,
        gates,
        workflowVersionReference: paymentWorkflow.workflowVersionReference,
        reasonCode: "SYNTHETIC_TEST",
        acceptance: {
          action: "Accept",
          purposeCode: paymentWorkflow.purposeCode,
          permissionCode: "order.accept",
        },
      },
    }),
  });
  const authenticatedAccept = createMerchantOrderAcceptanceCommand({
    persistence: session.persistence,
    authentication: session.authentication,
    generateAuditReference: next,
    audit: { retentionPolicyCode: "FINANCIAL_COMPLIANCE", retentionPolicyVersion: 1 },
    resolveConfiguration: async (transaction, selected, command) => {
      assert.deepEqual(selected, { ...scope, actorReference: actor });
      assert.deepEqual(command, record);
      const resolved = await resolveConfiguration(transaction, selected, command);
      assert.equal(resolved.kind, "Initial");
      assert.deepEqual(resolved.paymentEvent, event);
      return resolved;
    },
  });
  const commandInput = {
    sessionCookie: session.sessionCookie,
    csrf: session.csrf,
    command: record,
  };
  await assert.rejects(authenticatedAccept({ ...commandInput, csrf: "synthetic-invalid" }));
  const authenticatedResult = await authenticatedAccept(commandInput);
  assert.deepEqual(authenticatedResult, { status: "Created", acceptedOrderVersion: 2 });
  assert.deepEqual(await authenticatedAccept(commandInput), {
    status: "AlreadyCommitted",
    acceptedOrderVersion: 2,
  });
  const accepted = await accept();
  assert.equal(accepted.status, "AlreadyCommitted");
  assert.notEqual(accepted.record.sourceDigest, hash("SYNTHETIC_MERCHANT_ELIGIBILITY"));
  const replay = await accept({ ...record, acceptanceReference: next() });
  assert.equal(replay.status, "AlreadyCommitted");
  assert.deepEqual(replay.record, accepted.record);
  await assert.rejects(accept({ ...record, operationReference: next() }), {
    code: "ORDER_ACCEPTANCE_RECORD_UNAVAILABLE",
  });
  actorAllowed = false;
  await assert.rejects(accept(), { code: "ORDER_ACCEPTANCE_RECORD_UNAVAILABLE" });
  actorAllowed = true;
  const currentQueue = await queue({
    sessionCookie: session.sessionCookie,
    afterOrderReference: null,
  });
  const currentOrder = currentQueue.items.find(
    (item) => item.orderReference === record.orderReference,
  );
  assert.ok(currentOrder);
  assert.equal(currentOrder.canRequestAcceptance, false);
  assert.equal(currentOrder.currentVersion, 2);
  assert.equal(currentOrder.currentPhase, "Accepted");
  assert.equal(Object.hasOwn(currentOrder, "guestSessionReference"), false);
  assert.equal(Object.hasOwn(currentOrder, "initialSubmissionReference"), false);
  await session.revoke();
  await assert.rejects(authenticatedAccept(commandInput));
  // After acceptance the pilot worker resumes the unresolved wait to its outcome.
  const unresolved = await runner.run((tx) => waits.listUnresolved(tx, 100));
  assert.ok(unresolved.includes(event.eventId));
  const confirmed = {
    result: await runner.run((tx) => consumer.resumePending(tx, event)),
  };
  assert.equal(confirmed.result.disposition.disposition, "Confirmed");
  assert.equal(
    (await runner.run((tx) => waits.listUnresolved(tx, 100))).includes(event.eventId),
    false,
  );
  const repeated = await runner.run((tx) => consumer.consume(tx, event));
  assert.equal(repeated.consumerOutcome.status, "duplicate_completed");
  assert.deepEqual(repeated.result, confirmed.result);
  const saved = await runner.run((transaction) =>
    outcomes.loadByPaymentEvent({
      transaction,
      paymentEventReference: event.eventId,
    }),
  );
  assert.ok(saved.orderConfirmedEvent);
  const fulfillment = await exerciseCapturedOrderFulfillment({
    onPickupReady,
    additionalServices,
    paymentWorkflow,
    admin,
    runner,
    role,
    scope,
    quoteVersion,
    event: saved.orderConfirmedEvent,
    order,
    hash,
  });
  const kitchenSource = createPostgresOrderKitchenSourceStore({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    quoteVersion,
    sha256: hash,
    authorize: async () => true,
  });
  const disposition = confirmed.result.disposition;
  const sourceQuery = {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    orderReference: record.orderReference,
    orderBatchReference: record.orderBatchReference,
    confirmationReference: disposition.confirmationReference,
    sourceEventReference: saved.orderConfirmedEvent.eventId,
    sourceAggregateVersion: BigInt(disposition.sourceVersion),
    sourceSnapshotDigest: disposition.sourceSnapshotDigest,
    observedAt,
  };
  await exerciseKitchenTicketCreation({
    merchantKitchen: kitchenSession === undefined ? undefined : { session: kitchenSession, actor },
    kitchenNow,
    onItemReady: fulfillment?.consumeReady,
    reuseInventoryRecipe: reuseInventoryRecipe ?? order.order.orderType === "DineIn",
    admin,
    role,
    runner: (options = {}) => ({
      run: (work) =>
        runner.run((transaction) =>
          work({
            query: (sql, values) => {
              if (options.failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                throw new Error("synthetic mandatory Audit failure");
              return transaction.query(sql, values);
            },
          }),
        ),
    }),
    scope,
    source: kitchenSource,
    sourceQuery,
    orderRecord: order,
    event: saved.orderConfirmedEvent,
    at: observedAt,
    id,
  });
}
