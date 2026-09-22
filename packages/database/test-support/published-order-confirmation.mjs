import { exerciseKitchenTicketCreation } from "./kitchen-ticket-creation.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createOrderPaidOutcomeSource } from "../../../apps/api/src/order-paid-outcome-source.ts";
import {
  createPostgresOrderAcceptanceReader,
  createPostgresOrderKitchenSourceStore,
  createPostgresOrderTerminationStore,
  createPostgresOrderInitialExecutionReader,
  createPostgresOrderCreationQueryStore,
  createPostgresOrderPaymentOutcomeStore,
  createOrderPaymentOutcomeConsumerService,
} from "../../rms/ordering/src/index.ts";

/** Real publication, Order/acceptance readers and consumer writes; synthetic Payment and owner gates. */
export async function exercisePublishedOrderConfirmation({
  admin,
  role,
  runner,
  scope,
  orderRecord,
  request,
  gates,
  at,
  id,
}) {
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const batch = orderRecord.order.batches[0];
  const amount = orderRecord.items.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n);
  const preparation = {
    preparationReference: id(8001),
    orderReference: orderRecord.order.orderReference,
    orderBatchReference: batch.orderBatchReference,
    submissionReference: orderRecord.submissionReference,
    sourceCartReference: batch.sourceCartReference,
    sourceCartVersion: batch.sourceCartVersion,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    guestSessionReference: orderRecord.guestSessionReference,
    quoteReference: batch.quoteReference,
    capacityAllocationReference: id(8002),
    readiness: "PaymentPending",
    transactionBoundary: "OrderSubmissionPaymentPreparation",
    orderAllocation: { amountMinor: amount, currencyCode: "CAD" },
    tip: { amountMinor: 100n, currencyCode: "CAD" },
    total: { amountMinor: amount + 100n, currencyCode: "CAD" },
    committedAt: at,
    capacityExpiresAt: new Date(Date.parse(at) + 1800000).toISOString(),
    sourceDigest: hash("SYNTHETIC_PREPARATION"),
  };
  const event = {
    eventId: id(8003),
    eventType: "PaymentSucceeded",
    schemaVersion: 1,
    occurredAt: at,
    producerModule: "@rms/payment",
    tenantId: scope.brandReference,
    storeId: scope.storeReference,
    aggregateType: "PaymentIntent",
    aggregateId: id(8004),
    aggregateVersion: 2n,
    correlationId: id(8005),
    causationId: id(8006),
    actor: { type: "System" },
    payload: {
      paymentTransactionReference: id(8007),
      paymentIntentReference: id(8004),
      paymentAttemptReference: id(8008),
      orderReference: preparation.orderReference,
      amountMinor: preparation.total.amountMinor.toString(),
      currencyCode: "CAD",
      evidenceKind: "Captured",
      terminalOccurredAt: at,
    },
    redactionClassification: "payment",
    replayMetadata: { replaySafe: true },
  };
  const acceptanceReader = createPostgresOrderAcceptanceReader({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    authorize: async () => true, // Explicit synthetic current read capability.
  });
  const executionReader = createPostgresOrderInitialExecutionReader({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    authorize: async () => true, // Explicit synthetic current read capability.
  });
  let reads = 0;
  let sequence = 8100;
  let resourceAllowed = true;
  let ruleAllowed = true;
  const sourceOptions = {
    quoteVersion: 1,
    context: {
      resolve: async (transaction, received) => {
        reads++;
        assert.deepEqual(received, event);
        const acceptance = await acceptanceReader.loadByBatch({
          transaction,
          orderReference: preparation.orderReference,
          orderBatchReference: preparation.orderBatchReference,
        });
        const initialExecution = await executionReader.loadByBatch({
          transaction,
          orderReference: preparation.orderReference,
          orderBatchReference: preparation.orderBatchReference,
        });
        const reader = createPostgresOrderCreationQueryStore(
          { run: async (work) => work(transaction) },
          { brandReference: scope.brandReference, storeReference: scope.storeReference },
          1,
        );
        return reader.withCurrentSubmission(preparation.submissionReference, async (_, order) => ({
          order,
          acceptance,
          initialExecution,
          observedAt: at,
          // Only Payment fact is synthetic here. Complete captured context has a separate DB journey.
          payment: { intent: { preparation } },
        }));
      },
    },
    release: {
      action: "ReleasePaidOrder",
      purposeCode: "PublicationBindingFixture",
      permissionCode: "order.release",
      nextState: "Accepted",
    },
    resolveWorkflow: async ({ transaction, context }) => ({
      request: {
        ...request,
        currentState: "Accepted",
        resourceVersion: context.acceptance.acceptedOrderVersion,
        action: "ReleasePaidOrder",
        observedAt: context.observedAt,
      },
      gates: {
        ...gates,
        authorizeResource: async (tx, input) => {
          assert.equal(tx, transaction);
          return resourceAllowed && (await gates.authorizeResource(tx, input));
        },
        evaluateRule: async (tx, input) => {
          assert.equal(tx, transaction);
          return ruleAllowed && (await gates.evaluateRule(tx, input));
        },
      },
    }),
    generateDispositionReference: () => id(++sequence),
    generateConfirmationReference: () => id(++sequence),
    sha256: hash,
  };
  const source = createOrderPaidOutcomeSource(sourceOptions);
  const sourceInput = (transaction) => ({
    transaction,
    paymentEvent: event,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    orderReference: preparation.orderReference,
    paymentTransactionReference: event.payload.paymentTransactionReference,
    paymentIntentReference: event.payload.paymentIntentReference,
    paymentAttemptReference: event.payload.paymentAttemptReference,
    paymentEventReference: event.eventId,
  });
  await assert.rejects(
    runner().run((transaction) =>
      source.loadExact({
        ...sourceInput(transaction),
        paymentEventReference: id(8999),
      }),
    ),
  );
  assert.equal(reads, 0);
  resourceAllowed = false;
  await assert.rejects(runner().run((transaction) => source.loadExact(sourceInput(transaction))));
  resourceAllowed = true;
  ruleAllowed = false;
  await assert.rejects(runner().run((transaction) => source.loadExact(sourceInput(transaction))));
  ruleAllowed = true;
  const withUnappliedEffect = createOrderPaidOutcomeSource({
    ...sourceOptions,
    release: { ...sourceOptions.release, action: "ReleasePaidOrderWithEffect" },
    resolveWorkflow: async (input) => {
      const workflow = await sourceOptions.resolveWorkflow(input);
      return {
        ...workflow,
        request: { ...workflow.request, action: "ReleasePaidOrderWithEffect" },
      };
    },
  });
  await assert.rejects(
    runner().run((transaction) => withUnappliedEffect.loadExact(sourceInput(transaction))),
    { code: "ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE" },
  );
  const candidate = await runner().run((transaction) => source.loadExact(sourceInput(transaction)));
  assert.equal(candidate.disposition, "Confirmed");
  assert.equal(candidate.sourceCheckpoint, id(710));
  assert.equal(candidate.sourceVersion, 2);

  await admin.query("GRANT USAGE ON SCHEMA platform_eventing TO " + role);
  await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_eventing.consumer_inbox TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT ON platform_eventing.outbox_event,rms_ordering.order_payment_disposition_record,rms_ordering.order_payment_failure_record TO " +
      role,
  );
  const outcomes = createPostgresOrderPaymentOutcomeStore({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    sha256: hash,
    audit: async ({ orderReference, correlationReference, outcome }) => ({
      auditId: id(++sequence),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "ORDER_PAYMENT_DISPOSITION_RECORDED",
      targetType: "Order",
      targetId: orderReference,
      correlationId: correlationReference,
      afterSummary: { outcome },
      reasonCode: "PAYMENT_CAPTURED",
      occurredAt: at,
      sourceChannel: "EVENT_CONSUMER",
      dataClassification: "Restricted",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    }),
  });
  const consumer = createOrderPaymentOutcomeConsumerService({
    authorization: { authorize: async () => true }, // Explicit synthetic System capability.
    source,
    outcomes,
    references: { generate: () => id(++sequence) },
    digests: { sha256: hash },
  });
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_ordering.order_payment_disposition_record WHERE payment_event_id=$1) AS dispositions," +
          "(SELECT count(*)::int FROM platform_eventing.consumer_inbox WHERE event_id=$1) AS inbox," +
          "(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE causation_id=$1 AND event_type='OrderConfirmed') AS events," +
          "(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='ORDER_PAYMENT_DISPOSITION_RECORDED') AS audits",
        [event.eventId],
      )
    ).rows[0];
  await assert.rejects(runner({ failAudit: true }).run((tx) => consumer.consume(tx, event)));
  assert.deepEqual(await counts(), { dispositions: 0, inbox: 0, events: 0, audits: 0 });
  const confirmed = await runner().run((tx) => consumer.consume(tx, event));
  assert.equal(confirmed.result.status, "OrderConfirmed");
  const originalReads = reads;
  const replay = await runner().run((tx) => consumer.consume(tx, event));
  assert.equal(replay.consumerOutcome.status, "duplicate_completed");
  assert.deepEqual(replay.result, confirmed.result);
  assert.equal(reads, originalReads);
  assert.deepEqual(await counts(), { dispositions: 1, inbox: 1, events: 1, audits: 1 });
  let kitchenReadAllowed = true;
  const kitchenSource = createPostgresOrderKitchenSourceStore({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    quoteVersion: 1,
    sha256: hash,
    authorize: async () => kitchenReadAllowed, // Explicit synthetic System capability.
  });
  const kitchenQuery = {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    orderReference: preparation.orderReference,
    orderBatchReference: preparation.orderBatchReference,
    confirmationReference: confirmed.result.disposition.confirmationReference,
    sourceEventReference: confirmed.result.orderConfirmedEventReference,
    sourceAggregateVersion: BigInt(confirmed.result.disposition.sourceVersion),
    sourceSnapshotDigest: confirmed.result.disposition.sourceSnapshotDigest,
    observedAt: at,
  };
  const readKitchen = (patch = {}) =>
    runner().run((transaction) =>
      kitchenSource.resolve({
        transaction,
        query: { ...kitchenQuery, ...patch },
      }),
    );
  const kitchenEvidence = await readKitchen();
  assert.equal(kitchenEvidence.items.length, orderRecord.items.length);
  assert.equal(kitchenEvidence.evidenceReference, orderRecord.submissionReference);
  kitchenEvidence.items.forEach((item, i) => {
    assert.equal(item.quantity, orderRecord.items[i].quantity);
    assert.equal(item.customerNote, orderRecord.items[i].customerNote);
    assert.deepEqual(item.localizedDisplayNames, orderRecord.items[i].catalog.localizedNames);
    assert.deepEqual(
      item.selectedOptions,
      orderRecord.items[i].catalog.options.map((option) => ({
        optionReference: option.optionReference,
        quantity: option.quantity,
        localizedNames: option.localizedNames,
      })),
    );
  });
  for (const patch of [
    { confirmationReference: id(8900) },
    { sourceEventReference: id(8901) },
    { sourceAggregateVersion: 1n },
    { sourceSnapshotDigest: hash("changed") },
  ])
    await assert.rejects(readKitchen(patch));
  kitchenReadAllowed = false;
  await assert.rejects(readKitchen(), { code: "ORDER_KITCHEN_SOURCE_PERMISSION_DENIED" });
  kitchenReadAllowed = true;
  assert.deepEqual(await readKitchen(), kitchenEvidence);
  const storedConfirmation = await runner().run((transaction) =>
    outcomes.loadByPaymentEvent({ transaction, paymentEventReference: event.eventId }),
  );
  assert(storedConfirmation?.orderConfirmedEvent);
  const recoverKitchen = await exerciseKitchenTicketCreation({
    admin,
    role,
    runner,
    scope,
    source: kitchenSource,
    sourceQuery: kitchenQuery,
    orderRecord,
    event: storedConfirmation.orderConfirmedEvent,
    at,
    id,
  });
  return async () => {
    await assert.rejects(
      runner().run((transaction) => source.loadExact(sourceInput(transaction))),
      {
        code: "WORKFLOW_DEFINITION_UNAVAILABLE",
      },
    );
    const recovered = await runner().run((tx) => consumer.consume(tx, event));
    assert.deepEqual(recovered.result, confirmed.result);
    assert.deepEqual(await counts(), { dispositions: 1, inbox: 1, events: 1, audits: 1 });
    await admin.query("GRANT INSERT ON rms_ordering.order_termination_record TO " + role);
    const termination = {
      terminationReference: id(8910),
      operationReference: id(8911),
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      orderReference: preparation.orderReference,
      orderBatchReference: preparation.orderBatchReference,
      expectedOrderVersion: 2,
      terminatedOrderVersion: 3,
      expectedSourceCheckpoint: id(710),
      previousPhase: "Accepted",
      phase: "Cancelled",
      actorType: "User",
      actorReference: id(5),
      purposeCode: "SyntheticCancellation",
      permissionCode: "order.cancel",
      reasonCode: "SYNTHETIC_TEST",
      workflowVersionReference: id(8912),
      transitionReference: id(8913),
      sourceDigest: hash("synthetic-cancellation-gate"),
      terminatedAt: at,
    };
    const terminator = createPostgresOrderTerminationStore({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      authorize: async () => true,
      validateCurrentSource: async () => true,
      audit: async (record) => ({
        auditId: id(8914),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "User", reference: id(5) },
        actionCode: "ORDER_TERMINATED",
        targetType: "Order",
        targetId: record.orderReference,
        correlationId: record.operationReference,
        reasonCode: record.reasonCode,
        occurredAt: at,
        sourceChannel: "MERCHANT_WEB",
        afterSummary: { phase: record.phase },
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      }),
    });
    await runner().run((transaction) => terminator.commit({ transaction, record: termination }));
    await assert.rejects(readKitchen(), { code: "ORDER_KITCHEN_SOURCE_DEPENDENCY_UNAVAILABLE" });
    const historical = await runner().run((tx) => consumer.consume(tx, event));
    assert.deepEqual(historical.result, confirmed.result);
    await recoverKitchen();
  };
}
