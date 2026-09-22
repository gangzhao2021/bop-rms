import { createStripeOnlineClientHandoff } from "../../rms/payment/src/infrastructure/stripe/stripe-online-client-handoff.ts";
import { exerciseDiningSecondKitchenTicket } from "./dining-second-kitchen-ticket.mjs";
import { exerciseAdditionalAcceptanceHttp } from "./additional-dining-acceptance-http.mjs";
import { exerciseOrdinaryRefundCapture } from "./ordinary-refund-capture.mjs";
import { exerciseAdditionalDiningService } from "./additional-dining-service.mjs";
import { createDiningOrderPreparationProgress } from "../../../apps/api/src/dining-order-preparation-progress.ts";
import { createPostgresDiningOrderItemStateReader } from "../../rms/ordering/src/index.ts";
import { exerciseKitchenTicketCreation } from "./kitchen-ticket-creation.mjs";
import { createPostgresOrderKitchenSourceStore } from "../../rms/ordering/src/index.ts";
import { evaluateIntactReservationPaymentRule } from "../../rms/inventory/src/index.ts";
import { createMerchantPaidAdditionalOrderAcceptance } from "../../../apps/api/src/merchant-paid-additional-order-acceptance.ts";
import { encodeAdditionalDiningBatchSnapshot } from "../../rms/ordering/src/index.ts";
import { createAdditionalOrderPaidOutcomeSource } from "../../../apps/api/src/additional-order-paid-outcome-source.ts";
import {
  createOrderPaymentOutcomeConsumerService,
  createPostgresOrderPaymentOutcomeStore,
} from "../../rms/ordering/src/index.ts";
import { createAdditionalOrderPaidContextSource } from "../../../apps/api/src/additional-order-paid-context-source.ts";
import { createPostgresAdditionalDiningExecutionReader } from "../../rms/ordering/src/index.ts";
import {
  createPostgresPaymentProviderObservationStore,
  createPostgresPaymentTerminalStore,
  createPostgresPaymentTerminalSource,
  createPaymentTerminalService,
} from "../../rms/payment/src/index.ts";
import { normalizeStripeOnlineIntentResponse } from "../../rms/payment/src/infrastructure/stripe/stripe-online-intent-response.ts";
import { createPaymentIntentCreationService } from "../../rms/payment/src/index.ts";
import { createStripeOnlineIntentAdapter } from "../../rms/payment/src/infrastructure/stripe/stripe-online-intent-adapter.ts";
import { killSwitchEvaluation } from "../../rms/payment/src/tests/payment-intent-creation.fixture.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createCustomerAdditionalDiningPaymentStore,
  createCustomerAdditionalDiningPaymentAdmission,
} from "../../../apps/api/src/customer-additional-dining-payment-store.ts";
import { createCustomerAdditionalDiningHistoryAuthorization } from "../../../apps/api/src/customer-additional-dining-history-authorization.ts";
import { buildCustomerPaymentPreparationSnapshot } from "../../../apps/api/src/customer-payment-preparation-snapshot.ts";
import { createPostgresDiningCheckoutCommitmentStore } from "../../rms/dining/src/index.ts";
import { createPostgresSubmissionFinalValidationStore } from "../../rms/inventory/src/index.ts";
import {
  createPostgresPaymentTipSelectionStore,
  parsePaymentIntentCreationRecord,
} from "../../rms/payment/src/index.ts";

// Real owner stores and services; Provider responses are explicitly synthetic.
export async function exerciseAdditionalDiningPayment({
  journey,
  advanceClock,
  sessionPayment,
  checkoutSession,
  refundObservationFault = false,
  combinedOrder = false,
  client,
  runner,
  scope,
  stock,
  initial,
  snapshot,
  guest,
  workflow,
}) {
  const id = (n) => "01909991-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const now = () => new Date().toISOString();
  let denyAdditional = false;
  const authorize = async (_tx, input) =>
    !denyAdditional &&
    input.actorReference === snapshot.guestSessionReference &&
    input.submissionReference === snapshot.batch.submissionReference;
  const capacity = await createPostgresDiningCheckoutCommitmentStore(runner(), scope, {
    now,
  }).loadSubmission(snapshot.batch.submissionReference);
  const selection = await createPostgresPaymentTipSelectionStore(
    runner(),
    { brandReference: scope.brandReference, storeReference: scope.storeReference },
    { now },
  ).load(guest.tipSelectionReference);
  const inventorySource = createPostgresSubmissionFinalValidationStore(runner(), scope, {
    authorize,
    resolveCurrent: async () => {
      throw new Error("read only inventory history");
    },
  });
  const inventory = await inventorySource.load({
    submissionReference: snapshot.batch.submissionReference,
    actorReference: snapshot.guestSessionReference,
  });
  const execution = await runner().run((transaction) =>
    createPostgresAdditionalDiningExecutionReader({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      authorize: async (_tx, request) =>
        request.submissionReference === snapshot.batch.submissionReference,
    }).loadBySubmission({
      transaction,
      submissionReference: snapshot.batch.submissionReference,
      observedAt: now(),
    }),
  );
  assert(execution);
  assert.equal(execution.batchPhase, "Submitted");
  assert.equal(execution.batchVersion, snapshot.expectedOrderVersion + 1);
  assert.equal(execution.orderVersion, snapshot.expectedOrderVersion + 1);
  assert.equal(execution.batchCheckpoint, snapshot.batch.submissionReference);
  assert.equal(execution.acceptance, null);
  let preparation = buildCustomerPaymentPreparationSnapshot(
    {
      scope,
      owner: "Dining",
      quoteVersion: snapshot.snapshotVersion,
      submissionKind: "Additional",
    },
    { preparationReference: id(1), order: snapshot, capacity, selection, inventory },
  );
  assert.equal(preparation.orderBatchReference, snapshot.batch.orderBatchReference);
  const at = capacity.paymentRequestedAt;
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const record = parsePaymentIntentCreationRecord({
    intent: {
      paymentIntentReference: id(2),
      paymentOperationReference: capacity.paymentOperationReference,
      intentDigest: hash("synthetic additional intent"),
      preparation,
      paymentMethod: "OnlineCard",
      captureMode: "Automatic",
      aggregateVersion: 1,
      creationStatus: "ProviderCreatePending",
      createdAt: at,
    },
    attempt: {
      paymentAttemptReference: id(3),
      paymentIntentReference: id(2),
      attemptNumber: 1,
      provider: "Stripe",
      providerEnvironment: "Test",
      providerIdempotencyDigest: hash("synthetic additional provider operation"),
      createdAt: at,
    },
    providerOutcome: null,
  });
  const audit = {
    auditId: id(4),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode: "PAYMENT_INTENT_CREATE",
    targetType: "PaymentIntent",
    targetId: id(2),
    reasonCode: "AUTHORIZED_PAYMENT_INTENT_CREATE",
    occurredAt: at,
    correlationId: id(5),
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "SYNTHETIC_AUDIT",
    retentionPolicyVersion: 1,
  };
  const storeOptions = (paymentWorkflow, csrfCredential = guest.csrfCredential) => ({
    transactions: runner(),
    scope,
    quoteVersion: snapshot.snapshotVersion,
    clock: { now, generateObservationReference: () => id(6) },
    authorizeHistory: createCustomerAdditionalDiningHistoryAuthorization(
      { scope, identity: () => guest.identity },
      { sessionCredential: guest.sessionCredential, csrfCredential },
    ),
    inventory: {
      authorize,
      resolveExpiryCutoff: stock.resolveExpiryCutoff,
      workflow: paymentWorkflow,
      authorizeOverride: async () => false,
    },
  });
  const store = (paymentWorkflow, csrfCredential) =>
    createCustomerAdditionalDiningPaymentStore(storeOptions(paymentWorkflow, csrfCredential));
  const counts = async () =>
    (
      await client.query(
        "SELECT (SELECT count(*)::int FROM rms_payment.payment_intent WHERE payment_intent_id=$1) AS intents,(SELECT count(*)::int FROM rms_payment.payment_attempt WHERE payment_intent_id=$1) AS attempts,(SELECT count(*)::int FROM rms_payment.payment_intent_operation_record WHERE payment_intent_id=$1) AS operations,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='PAYMENT_INTENT_CREATE' AND target_id=$1) AS audits",
        [id(2)],
      )
    ).rows[0];
  const input = { record, audit };
  await assert.rejects(store(workflow.payment, guest.wrongCsrf).claim(input), {
    code: "PAYMENT_INTENT_PERMISSION_DENIED",
  });
  assert.deepEqual(await counts(), { intents: 0, attempts: 0, operations: 0, audits: 0 });
  await assert.rejects(
    store({ ...workflow.payment, permissionCode: "synthetic.wrong.permission" }).claim(input),
    { code: "PAYMENT_INTENT_PERMISSION_DENIED" },
  );
  assert.deepEqual(await counts(), { intents: 0, attempts: 0, operations: 0, audits: 0 });
  const repository = store(workflow.payment);
  let providerCalls = 0;
  const providerReference = "pi_SYNTHETICADDITIONAL001";
  const stripePayload = {
    object: "payment_intent",
    id: providerReference,
    currency: "cad",
    livemode: false,
    capture_method: "automatic",
    payment_method_types: ["card"],
    amount: Number(preparation.total.amountMinor),
    amount_received: 0,
    amount_capturable: 0,
    status: "requires_payment_method",
    latest_charge: null,
    client_secret: providerReference + "_secret_SYNTHETICONLY",
  };
  const provider = createStripeOnlineIntentAdapter({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    environment: "Test",
    apiVersion: "2024-06-20",
    secretKey: "sk_test_SYNTHETICONLY",
    connectedAccount: null,
    now,
    fetch: async (_url, request) => {
      providerCalls++;
      assert.equal(request.method, "POST");
      return globalThis.Response.json(stripePayload);
    },
  });
  const authorizeHistory = createCustomerAdditionalDiningHistoryAuthorization(
    { scope, identity: () => guest.identity },
    { sessionCredential: guest.sessionCredential, csrfCredential: guest.csrfCredential },
  );
  const paymentPorts = {
    providerEnvironment: "Test",
    clock: { now },
    repository,
    provider,
    authorization: {
      authorize: async (request) => {
        const allowed =
          request.submissionReference === snapshot.batch.submissionReference &&
          (await runner().run((tx) =>
            authorizeHistory(tx, {
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              submissionReference: snapshot.batch.submissionReference,
            }),
          ));
        return allowed
          ? {
              action: "CreatePaymentIntent",
              guestSessionReference: snapshot.guestSessionReference,
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
            }
          : null;
      },
    },
    killSwitch: {
      evaluate: async (request) => {
        const result = killSwitchEvaluation({ evaluatedAt: request.evaluatedAt });
        return Object.freeze({
          ...result,
          effectiveControl: Object.freeze({
            ...result.effectiveControl,
            scope: Object.freeze({
              kind: "Store",
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
            }),
          }),
        });
      },
    },
    ordering: { preparePayment: async () => preparation },
    audit: { create: async () => audit },
    references: {
      generate: (purpose) => (purpose === "PaymentIntent" ? id(2) : id(3)),
      hash,
      equals: (a, b) => a === b,
      providerIdempotencyKey: () => id(7),
    },
  };
  const service = createPaymentIntentCreationService(paymentPorts);
  const command = {
    paymentOperationReference: capacity.paymentOperationReference,
    submissionReference: snapshot.batch.submissionReference,
    cartReference: preparation.sourceCartReference,
    expectedCartVersion: preparation.sourceCartVersion,
    quoteReference: preparation.quoteReference,
    tipSelectionReference: selection.selectionReference,
    requestedAt: capacity.paymentRequestedAt,
  };
  let accepted;
  let httpRequest;
  let requestResult;
  let handoffReads = 0;
  const handoffProvider = createStripeOnlineClientHandoff({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    environment: "Test",
    apiVersion: "2024-06-20",
    secretKey: "sk_test_SYNTHETICONLY",
    connectedAccount: null,
    now,
    fetch: async () => {
      handoffReads++;
      return globalThis.Response.json(stripePayload);
    },
  });
  if (journey) {
    assert(sessionPayment);
    assert.ok(journey.runtime?.server.listening);
    assert.equal(journey.additionalPayment, undefined);
    assert.equal(checkoutSession.submissionReference, snapshot.batch.submissionReference);
    assert.equal(checkoutSession.paymentOperationReference, capacity.paymentOperationReference);
    assert.deepEqual(sessionPayment.access.scope, journey.scope);
    const initialPayment = await journey.replayInitialPayment();
    assert.equal(initialPayment.status, 200);
    const original = await initialPayment.json();
    journey.additionalPayment = {
      session: checkoutSession,
      orders: sessionPayment.orders,
      tips: sessionPayment.tips,
      inventory: inventorySource,
      history: repository,
      resolutions: 0,
      paymentAttemptReference: id(3),
      currentAdmission: createCustomerAdditionalDiningPaymentAdmission(
        storeOptions(workflow.payment),
      ),
      handoffProvider,
      payment: (context) => {
        assert(context.credentials.sessionCredential === guest.sessionCredential);
        assert(context.credentials.csrfCredential === guest.csrfCredential);
        const { preparationReference: _oldReference, ...expected } = preparation;
        const { preparationReference: _newReference, ...actual } = context.preparation;
        void _oldReference;
        void _newReference;
        assert.deepEqual(actual, expected);
        preparation = context.preparation;
        return paymentPorts;
      },
    };
    const server = journey.runtime.server;
    const input = sessionPayment.input;
    httpRequest = () =>
      globalThis.fetch(
        `http://127.0.0.1:${server.address().port}/api/v1/checkout-sessions/${input.checkoutSessionReference}/payment-intents`,
        {
          method: "POST",
          headers: {
            origin: journey.origin,
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
            cookie: "__Host-bop-guest=" + input.sessionCredential,
            "x-csrf-token": input.csrfCredential,
            "idempotency-key": input.selectionReference,
          },
          body: JSON.stringify({
            tip: {
              amountMinor: input.tip.amountMinor.toString(),
              currency: input.tip.currencyCode,
            },
          }),
        },
      );
    const first = await httpRequest();
    assert.equal(first.status, 201, JSON.stringify(journey.paymentCalls));
    assert.equal(first.headers.get("cache-control"), "no-store");
    const body = await first.json();
    assert.equal(body.payment.creationStatus, "Created");
    assert.equal(body.payment.paymentIntentReference, id(2));
    assert.equal(body.payment.checkoutSessionReference, checkoutSession.checkoutSessionReference);
    assert.equal(journey.additionalPayment.resolutions, 1);
    const persisted = await repository.resolveOperation(capacity.paymentOperationReference);
    assert(persisted);
    accepted = { status: "Created", record: persisted };
    const oldReplay = await journey.replayInitialPayment();
    assert.equal(oldReplay.status, 200);
    assert.deepEqual(await oldReplay.json(), original);
    assert.equal(journey.additionalPayment.resolutions, 1);
  } else {
    accepted = await service.create(command);
  }
  assert.equal(accepted.status, "Created");
  assert.equal(providerCalls, 1);
  assert.equal(
    accepted.record.intent.preparation.orderBatchReference,
    snapshot.batch.orderBatchReference,
  );
  assert.equal(accepted.record.providerOutcome.kind, "Snapshot");
  assert.equal(accepted.record.providerOutcome.providerIntentReference, providerReference);
  const committed = await counts();
  assert.deepEqual(committed, { intents: 1, attempts: 1, operations: 1, audits: 1 });
  if (httpRequest) {
    const replay = await httpRequest();
    assert.equal(replay.status, 200);
    const body = await replay.json();
    assert.equal(body.payment.creationStatus, "AlreadyCreated");
    assert.equal(body.payment.paymentIntentReference, id(2));
    assert.equal(journey.additionalPayment.resolutions, 1);
    assert.equal(providerCalls, 1);
  }
  const replay = await service.create(command);
  assert.equal(replay.status, "AlreadyCreated");
  assert.deepEqual(replay.record, accepted.record);
  assert.equal(providerCalls, 1);
  assert.equal(
    (await repository.claim({ record: { ...accepted.record, providerOutcome: null }, audit }))
      .status,
    "Existing",
  );
  assert.deepEqual(await counts(), committed);
  const observed = await client.query(
    "SELECT count(*)::int AS count FROM rms_payment.payment_provider_observation WHERE payment_intent_id=$1",
    [id(2)],
  );
  assert.equal(observed.rows[0].count, 1);
  if (journey) {
    const input = sessionPayment.input;
    const url = `http://127.0.0.1:${journey.runtime.server.address().port}/api/v1/checkout-sessions/${input.checkoutSessionReference}`;
    const headers = {
      "sec-fetch-site": "same-origin",
      cookie: "__Host-bop-guest=" + input.sessionCredential,
      "x-csrf-token": input.csrfCredential,
    };
    const requestHandoff = () =>
      globalThis.fetch(url + "/payment-handoff", {
        method: "POST",
        headers: { ...headers, origin: journey.origin, "content-type": "application/json" },
        body: "{}",
      });
    const handoff = await requestHandoff();
    assert.equal(handoff.status, 200, JSON.stringify(journey.paymentCalls));
    assert.equal(handoff.headers.get("cache-control"), "no-store");
    assert.equal(handoff.headers.get("referrer-policy"), "no-referrer");
    const client = await handoff.json();
    assert(client.clientSecret === stripePayload.client_secret);
    assert.equal(handoffReads, 1);
    denyAdditional = true;
    const denied = await requestHandoff();
    assert.equal(denied.status, 422);
    assert.equal(handoffReads, 1, "current denial must prevent credential retrieval");
    denyAdditional = false;
    requestResult = () => globalThis.fetch(url + "/payment-result", { headers });
    const pending = await requestResult();
    assert.equal(pending.status, 200);
    assert.equal((await pending.json()).payment.status, "Pending");
  }
  const amount = Number(preparation.total.amountMinor);
  const captured = normalizeStripeOnlineIntentResponse(
    {
      operation: "RetrieveIntent",
      purpose: "RetrievePaymentIntent",
      context: {
        provider: "Stripe",
        environment: "Test",
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        paymentAttemptReference: id(3),
        operationReference: id(20),
      },
      providerIntentReference: providerReference,
    },
    {
      object: "payment_intent",
      id: providerReference,
      currency: "cad",
      livemode: false,
      capture_method: "automatic",
      payment_method_types: ["card"],
      amount,
      amount_received: amount,
      amount_capturable: 0,
      status: "succeeded",
      latest_charge: {
        object: "charge",
        id: "ch_SYNTHETICADDITIONAL001",
        payment_intent: providerReference,
        currency: "cad",
        livemode: false,
        amount,
        amount_captured: amount,
        amount_refunded: 0,
        paid: true,
        captured: true,
        status: "succeeded",
        payment_method_details: { type: "card" },
      },
    },
    now(),
  );
  await createPostgresPaymentProviderObservationStore(
    runner(),
    { brandReference: scope.brandReference, storeReference: scope.storeReference },
    { now },
  ).record({
    observationReference: id(21),
    paymentIntentReference: id(2),
    snapshot: captured,
  });
  const terminalScope = {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    providerAccountReference:
      journey?.paymentOptions.orderStatus.paymentScope.providerAccountReference ?? id(22),
    environment: "Test",
  };
  let sequence = 100;
  const terminal = createPaymentTerminalService({
    source: createPostgresPaymentTerminalSource(runner(), terminalScope),
    repository: createPostgresPaymentTerminalStore(runner(), terminalScope),
    clock: { now },
    references: { generate: () => id(++sequence) },
    audit: {
      create: async ({ fact, correlationReference }) => ({
        auditId: id(++sequence),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "PAYMENT_TERMINAL_RECORDED",
        targetType: "PaymentIntent",
        targetId: fact.paymentIntentReference,
        afterSummary: { outcome: fact.outcome },
        reasonCode: "PAYMENT_CAPTURED",
        correlationId: correlationReference,
        occurredAt: fact.recordedAt,
        sourceChannel: "PAYMENT_RECONCILIATION",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      }),
    },
  });
  const observation = {
    observationReference: id(21),
    causationReference: id(20),
    webhookReceiptReference: null,
    providerEventReference: null,
    providerAccountReference: terminalScope.providerAccountReference,
    providerIntentReference: providerReference,
    environment: "Test",
    paymentIntentReference: id(2),
    paymentAttemptReference: id(3),
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    source: "ProviderRetrieval",
    status: "Captured",
    amount: captured.capturedAmount,
    failureReason: null,
    retryDisposition: null,
    occurredAt: captured.observedAt,
    evidenceDigest: captured.evidenceDigest,
  };
  const completed = await terminal.record(observation);
  assert.equal(completed.status, "Created");
  if (requestResult) {
    assert.equal(typeof advanceClock, "function");
    advanceClock(now());
    const response = await requestResult();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.equal(body.payment.status, "Succeeded");
    assert.equal(body.payment.paymentIntentReference, id(2));
    assert.equal(body.payment.checkoutSessionReference, checkoutSession.checkoutSessionReference);
    assert.equal(handoffReads, 1);
    assert.equal(providerCalls, 1);
  }
  const paidContext = createAdditionalOrderPaidContextSource({
    scope: terminalScope,
    tenantReference: scope.tenantReference,
    quoteVersion: snapshot.snapshotVersion,
    now,
    authorize: async () => true,
    authorizeOrder: async (_tx, request) =>
      request.submissionReference === snapshot.batch.submissionReference,
    authorizeInventory: authorize,
  });
  const context = await runner().run((transaction) =>
    paidContext.resolve(transaction, completed.fact.event),
  );
  assert.equal(
    context.execution.snapshot.batch.orderBatchReference,
    snapshot.batch.orderBatchReference,
  );
  assert.equal(context.execution.batchPhase, "Submitted");
  assert.equal(context.execution.acceptance, null);
  assert.equal(context.terminal.paymentIntentReference, id(2));
  assert.equal(context.inventory.record.submissionReference, snapshot.batch.submissionReference);
  assert.equal(context.capacity.commitment.submissionReference, snapshot.batch.submissionReference);
  if (!combinedOrder) {
    const source = createAdditionalOrderPaidOutcomeSource({
      context: paidContext,
      quoteVersion: snapshot.snapshotVersion,
      release: {
        action: "ReleasePaidOrder",
        purposeCode: "OrderFulfillment",
        permissionCode: "order.release",
        nextState: "Accepted",
      },
      generateDispositionReference: () => id(++sequence),
      generateConfirmationReference: () => {
        throw new Error("unaccepted Batch cannot confirm");
      },
      sha256: hash,
      resolveWorkflow: async () => {
        throw new Error("unaccepted Batch cannot release");
      },
    });
    const consumer = createOrderPaymentOutcomeConsumerService({
      authorization: { authorize: async () => true },
      source,
      outcomes: createPostgresOrderPaymentOutcomeStore({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        sha256: hash,
        audit: async () => {
          throw new Error("waiting has no final disposition audit");
        },
      }),
      references: { generate: () => id(++sequence) },
      digests: { sha256: hash },
    });
    await assert.rejects(
      runner().run((transaction) => consumer.consume(transaction, completed.fact.event)),
      {
        name: "ConsumerTransactionRollback",
        outcome: { status: "retry_required", errorCode: "CONSUMER_TEMPORARY_FAILURE" },
      },
    );
    const waitingRows = await client.query(
      "SELECT (SELECT count(*)::int FROM rms_ordering.order_payment_disposition_record) AS dispositions,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE event_type='OrderConfirmed') AS confirmations,(SELECT count(*)::int FROM platform_eventing.consumer_inbox WHERE consumer_name='ordering.payment-outcome:v1') AS inbox",
    );
    assert.deepEqual(waitingRows.rows[0], { dispositions: 0, confirmations: 0, inbox: 0 });
  }
  // Actual owner writer/current reader/publication; merchant authorization is synthetic.
  const acceptance = {
    acceptanceReference: id(1000),
    operationReference: id(1001),
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    orderReference: snapshot.orderReference,
    orderBatchReference: snapshot.batch.orderBatchReference,
    expectedOrderVersion: context.execution.orderVersion,
    acceptedOrderVersion: context.execution.orderVersion + 1,
    actorType: "User",
    actorReference: snapshot.guestSessionReference,
    purposeCode: workflow.payment.purposeCode,
    permissionCode: "order.accept",
    reasonCode: "SYNTHETIC_TEST",
    workflowVersionReference: workflow.payment.workflowVersionReference,
    transitionReference: workflow.payment.acceptanceTransitionReference,
    sourceDigest: hash(encodeAdditionalDiningBatchSnapshot(snapshot)),
    acceptedAt: now(),
  };
  const merchant = createMerchantPaidAdditionalOrderAcceptance({
    scope,
    quoteVersion: snapshot.snapshotVersion,
    acceptance: {
      action: "Accept",
      purposeCode: workflow.payment.purposeCode,
      permissionCode: "order.accept",
    },
    gates: workflow.gates,
    authorize: async (_tx, candidate) =>
      candidate.actorReference === snapshot.guestSessionReference,
    context: paidContext,
    actorReference: snapshot.guestSessionReference,
    authorizeActor: async () => true,
    workflowVersionReference: workflow.payment.workflowVersionReference,
    reasonCode: "SYNTHETIC_TEST",
    audit: async (record) => ({
      auditId: id(1002),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "User", reference: record.actorReference },
      actionCode: "ORDER_ACCEPTED",
      targetType: "Order",
      targetId: record.orderReference,
      correlationId: record.operationReference,
      reasonCode: record.reasonCode,
      occurredAt: record.acceptedAt,
      sourceChannel: "MERCHANT_WEB",
      afterSummary: { phase: "Accepted" },
      dataClassification: "Restricted",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    }),
  });
  const acceptanceCommand = {
    acceptanceReference: acceptance.acceptanceReference,
    operationReference: acceptance.operationReference,
    orderReference: acceptance.orderReference,
    orderBatchReference: acceptance.orderBatchReference,
    expectedOrderVersion: acceptance.expectedOrderVersion,
  };
  const accept = (value = acceptanceCommand) =>
    runner().run((transaction) =>
      merchant.commit({
        transaction,
        command: value,
        paymentEvent: completed.fact.event,
      }),
    );
  await assert.rejects(accept({ ...acceptanceCommand, sourceDigest: hash("forged") }));
  await assert.rejects(accept({ ...acceptanceCommand, expectedOrderVersion: 1 }));
  const readItems = () =>
    runner().run((transaction) =>
      createPostgresDiningOrderItemStateReader({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        authorize: async () => true,
      }).load({
        transaction,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        orderReference: snapshot.orderReference,
        diningSessionReference: snapshot.diningSessionReference,
        guestSessionReference: snapshot.guestSessionReference,
        observedAt: now(),
      }),
    );
  const earlier = combinedOrder ? await readItems() : null;
  await exerciseAdditionalAcceptanceHttp({
    initialAccepted: combinedOrder,
    client,
    runner,
    scope,
    actor: snapshot.guestSessionReference,
    at: now(),
    command: acceptanceCommand,
    auditReference: id(1002),
    paymentEvent: completed.fact.event,
    paymentScope: terminalScope,
    configuration: {
      context: paidContext,
      quoteVersion: snapshot.snapshotVersion,
      gates: workflow.gates,
      workflowVersionReference: workflow.payment.workflowVersionReference,
      reasonCode: "SYNTHETIC_TEST",
      acceptance: {
        action: "Accept",
        purposeCode: workflow.payment.purposeCode,
        permissionCode: "order.accept",
      },
    },
  });
  const recoveredAcceptance = await accept();
  assert.equal(recoveredAcceptance.status, "AlreadyCommitted");
  assert.equal(recoveredAcceptance.record.sourceDigest, acceptance.sourceDigest);
  await assert.rejects(accept({ ...acceptanceCommand, operationReference: id(1099) }));
  const acceptedContext = await runner().run((transaction) =>
    paidContext.resolve(transaction, completed.fact.event),
  );
  assert.equal(acceptedContext.execution.orderVersion, acceptance.acceptedOrderVersion);
  if (combinedOrder) {
    const after = await readItems();
    const previous = (state) =>
      state.items.filter((item) => item.orderBatchReference !== snapshot.batch.orderBatchReference);
    assert.deepEqual(previous(after), previous(earlier));
    assert.ok(previous(after).every((item) => item.acceptance !== null));
    assert.equal(acceptedContext.execution.batchPhase, "Accepted");
    assert.equal(after.orderVersion, acceptance.acceptedOrderVersion);
  }
  assert.equal(acceptedContext.execution.canonicalPhase, "Accepted");
  assert.equal(acceptedContext.execution.batchPhase, "Accepted");
  assert.equal(acceptedContext.execution.batchCheckpoint, acceptance.acceptanceReference);
  const acceptanceRows = await client.query(
    "SELECT (SELECT count(*)::int FROM rms_ordering.order_acceptance_record) AS acceptances,(SELECT count(*)::int FROM rms_ordering.order_revision) AS revisions",
  );
  assert.deepEqual(acceptanceRows.rows[0], {
    acceptances: combinedOrder ? 2 : 1,
    revisions: acceptance.acceptedOrderVersion,
  });
  const whole = await runner().run((transaction) =>
    createPostgresDiningOrderItemStateReader({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      authorize: async () => true,
    }).load({
      transaction,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      orderReference: snapshot.orderReference,
      diningSessionReference: snapshot.diningSessionReference,
      guestSessionReference: snapshot.guestSessionReference,
      observedAt: now(),
    }),
  );
  assert.equal(whole.orderVersion, acceptance.acceptedOrderVersion);
  assert.equal(new Set(whole.items.map((item) => item.orderBatchReference)).size, 2);
  const ownItems = whole.items.filter(
    (item) => item.orderBatchReference === snapshot.batch.orderBatchReference,
  );
  assert.deepEqual(
    ownItems.map((item) => item.orderItemReference).sort(),
    snapshot.items.map((item) => item.orderItemReference).sort(),
  );
  assert.ok(
    ownItems.every(
      (item) => item.acceptance.acceptanceReference === acceptance.acceptanceReference,
    ),
  );
  assert.ok(
    whole.items
      .filter((item) => item.orderBatchReference !== snapshot.batch.orderBatchReference)
      .every((item) => (combinedOrder ? item.acceptance !== null : item.acceptance === null)),
  );

  const releasedAt = now();
  const releaseSource = createAdditionalOrderPaidOutcomeSource({
    context: { resolve: (transaction, event) => paidContext.resolve(transaction, event) },
    quoteVersion: snapshot.snapshotVersion,
    release: {
      action: "ReleasePaidOrder",
      purposeCode: workflow.payment.purposeCode,
      permissionCode: "order.release",
      nextState: "Accepted",
    },
    generateDispositionReference: () => id(++sequence),
    generateConfirmationReference: () => id(++sequence),
    sha256: hash,
    resolveWorkflow: async ({ context: current }) => ({
      request: {
        ...scope,
        actorReference: snapshot.guestSessionReference,
        resourceReference: snapshot.orderReference,
        resourceVersion: current.execution.orderVersion,
        purposeCode: workflow.payment.purposeCode,
        applicabilityCode: "DineIn",
        expectedVersionReference: workflow.payment.workflowVersionReference,
        currentState: current.execution.canonicalPhase,
        action: "ReleasePaidOrder",
        observedAt: current.observedAt,
      },
      gates: {
        ...workflow.gates,
        evaluateRule: async (_tx, request) =>
          request.ruleReference === workflow.payment.intactReservationRuleReference &&
          evaluateIntactReservationPaymentRule(current.inventory),
      },
    }),
  });
  const releasedConsumer = createOrderPaymentOutcomeConsumerService({
    authorization: { authorize: async () => true },
    source: releaseSource,
    outcomes: createPostgresOrderPaymentOutcomeStore({
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
        occurredAt: releasedAt,
        sourceChannel: "EVENT_CONSUMER",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      }),
    }),
    references: { generate: () => id(++sequence) },
    digests: { sha256: hash },
  });
  const releasePaid = () =>
    runner().run((transaction) => releasedConsumer.consume(transaction, completed.fact.event));
  const confirmed = await releasePaid();
  assert.equal(confirmed.result.status, "OrderConfirmed");
  assert.equal(
    confirmed.result.disposition.orderBatchReference,
    snapshot.batch.orderBatchReference,
  );
  const repeated = await releasePaid();
  assert.equal(repeated.consumerOutcome.status, "duplicate_completed");
  assert.deepEqual(repeated.result, confirmed.result);
  const confirmationRows = await client.query(
    "SELECT (SELECT count(*)::int FROM rms_ordering.order_payment_disposition_record) AS dispositions,(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE event_type='OrderConfirmed') AS confirmations,(SELECT count(*)::int FROM platform_eventing.consumer_inbox WHERE consumer_name='ordering.payment-outcome:v1') AS inbox",
  );
  assert.deepEqual(confirmationRows.rows[0], {
    dispositions: combinedOrder ? 2 : 1,
    confirmations: combinedOrder ? 2 : 1,
    inbox: combinedOrder ? 2 : 1,
  });
  const kitchenSource = createPostgresOrderKitchenSourceStore({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    quoteVersion: snapshot.snapshotVersion,
    sha256: hash,
    authorize: async () => true,
  });
  const kitchenQuery = {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    orderReference: snapshot.orderReference,
    orderBatchReference: snapshot.batch.orderBatchReference,
    confirmationReference: confirmed.result.disposition.confirmationReference,
    sourceEventReference: confirmed.result.orderConfirmedEventReference,
    sourceAggregateVersion: BigInt(confirmed.result.disposition.sourceVersion),
    sourceSnapshotDigest: confirmed.result.disposition.sourceSnapshotDigest,
    observedAt: now(),
  };
  const readKitchen = (patch = {}) =>
    runner().run((transaction) =>
      kitchenSource.resolve({ transaction, query: { ...kitchenQuery, ...patch } }),
    );
  const kitchen = await readKitchen();
  assert.equal(kitchen.evidenceReference, snapshot.batch.submissionReference);
  assert.equal(kitchen.items.length, snapshot.items.length);
  kitchen.items.forEach((item, index) => {
    const original = snapshot.items[index];
    assert.equal(item.orderItemReference, original.orderItemReference);
    assert.equal(item.orderBatchReference, snapshot.batch.orderBatchReference);
    assert.equal(item.quantity, original.quantity);
    assert.equal(item.customerNote, original.customerNote);
    assert.deepEqual(item.localizedDisplayNames, original.catalog.localizedNames);
    assert.deepEqual(
      item.selectedOptions,
      original.catalog.options.map((option) => ({
        optionReference: option.optionReference,
        quantity: option.quantity,
        localizedNames: option.localizedNames,
      })),
    );
  });
  await assert.rejects(readKitchen({ orderBatchReference: id(2000) }));
  await assert.rejects(readKitchen({ sourceSnapshotDigest: hash("wrong kitchen snapshot") }));
  if (combinedOrder) {
    const saved = await runner().run((transaction) =>
      createPostgresOrderPaymentOutcomeStore({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        sha256: hash,
        audit: async () => {
          throw new Error("READ_ONLY");
        },
      }).loadByPaymentEvent({ transaction, paymentEventReference: completed.fact.event.eventId }),
    );
    const ticket = await exerciseDiningSecondKitchenTicket({
      client,
      runner,
      scope,
      source: kitchenSource,
      query: kitchenQuery,
      event: saved.orderConfirmedEvent,
    });
    const readyClock = await client.query(
      "SELECT max(updated_at) AS at FROM rms_kitchen.kitchen_ticket",
    );
    await exerciseAdditionalDiningService({
      combinedOrder: true,
      expectedOrderVersion: acceptedContext.execution.orderVersion,
      client,
      runner,
      scope,
      snapshot,
      capacity,
      initial,
      guest,
      hash,
      at: readyClock.rows[0].at.toISOString(),
    });
    return { accepted, completed, acceptedContext, confirmed, kitchen, ticket };
  }
  // Dedicated non-owner role for existing Kitchen RLS and complete lifecycle checks.
  const role = "wp2402_additional_kitchen";
  await client.query("CREATE ROLE " + role + " NOLOGIN");
  for (const schema of [
    "platform_audit",
    "platform_eventing",
    "platform_helpers",
    "bop_workflow",
    "bop_publishing",
    "rms_ordering",
    "rms_recipe",
    "rms_kitchen",
  ]) {
    await client.query("GRANT USAGE ON SCHEMA " + schema + " TO " + role);
    await client.query("GRANT SELECT ON ALL TABLES IN SCHEMA " + schema + " TO " + role);
  }
  await client.query(
    "GRANT INSERT,UPDATE ON ALL TABLES IN SCHEMA platform_audit,platform_eventing TO " + role,
  );
  await client.query(
    "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
      role,
  );
  await client.query(
    "GRANT UPDATE ON rms_ordering.order_header,rms_ordering.order_batch TO " + role,
  );
  const savedOutcome = await runner().run((transaction) =>
    createPostgresOrderPaymentOutcomeStore({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      sha256: hash,
      audit: async () => {
        throw new Error("read only");
      },
    }).loadByPaymentEvent({ transaction, paymentEventReference: completed.fact.event.eventId }),
  );
  await exerciseKitchenTicketCreation({
    admin: client,
    role,
    scope,
    source: kitchenSource,
    sourceQuery: kitchenQuery,
    orderRecord: snapshot,
    event: savedOutcome.orderConfirmedEvent,
    at: savedOutcome.orderConfirmedEvent.occurredAt,
    id: (n) => "01909990-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
    runner: (options = {}) => ({
      run: (work) =>
        runner().run(async (transaction) => {
          await transaction.query("SET LOCAL ROLE " + role, []);
          return work({
            query: (sql, values) => {
              if (options.failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                throw new Error("synthetic mandatory Audit failure");
              return transaction.query(sql, values);
            },
          });
        }),
    }),
  });

  // Lifecycle helper advances a synthetic clock; resolve after its persisted ticket time.
  const clock = await client.query("SELECT max(updated_at) AS at FROM rms_kitchen.kitchen_ticket");
  const progressAt = clock.rows[0].at.toISOString();
  const preparationProgress = await runner().run((transaction) =>
    createDiningOrderPreparationProgress({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      authorize: async () => true,
      authorizeKitchen: async () => true,
    }).load({
      transaction,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      orderReference: snapshot.orderReference,
      diningSessionReference: snapshot.diningSessionReference,
      guestSessionReference: snapshot.guestSessionReference,
      observedAt: progressAt,
    }),
  );
  assert.equal(preparationProgress.preparationPhase, "InProgress");
  assert.ok(
    preparationProgress.items
      .filter((item) => item.orderBatchReference === snapshot.batch.orderBatchReference)
      .every((item) => item.phase === "Ready"),
  );
  assert.ok(
    preparationProgress.items
      .filter((item) => item.orderBatchReference !== snapshot.batch.orderBatchReference)
      .every((item) => item.phase === "Submitted"),
  );

  await exerciseAdditionalDiningService({
    client,
    runner,
    scope,
    snapshot,
    capacity,
    initial,
    guest,
    at: progressAt,
    hash,
  });

  assert.equal((await terminal.record(observation)).status, "AlreadyCommitted");
  const terminals = await client.query(
    "SELECT count(*)::int AS count FROM rms_payment.payment_terminal_fact",
  );
  assert.equal(terminals.rows[0].count, 1);
  const events = await client.query(
    "SELECT count(*)::int AS count FROM platform_eventing.outbox_event WHERE event_type='PaymentSucceeded'",
  );
  assert.equal(events.rows[0].count, 1);
  const header = await client.query("SELECT payment_status FROM rms_ordering.order_header");
  assert.equal(
    header.rows[0].payment_status,
    "NotReported",
    "one Batch capture must not mark the whole Order paid",
  );
  await exerciseOrdinaryRefundCapture({
    refundObservationFault,
    client,
    runner,
    scope,
    terminalScope,
    record,
    fact: completed.fact,
    captured,
    snapshot,
    hash,
  });
}
