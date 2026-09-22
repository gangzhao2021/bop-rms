import { createOrdinaryRefundFailureRecorder } from "../../../apps/api/src/ordinary-refund-failure-recorder.ts";
import { createOrdinaryRefundProcessing } from "../../../apps/api/src/ordinary-refund-processing.ts";
import { createPostgresPaymentReceiptCoverageSource } from "../../rms/payment/src/infrastructure/persistence/payment-receipt-coverage-source.ts";
import { createPostgresOrdinaryRefundPositionSource } from "../../rms/payment/src/infrastructure/ordinary-refund-position-source.ts";
import { createPostgresOrdinaryRefundReconciliationRuntime } from "../../rms/payment/src/infrastructure/ordinary-refund-reconciliation-runtime.ts";
import { createStripeOrdinaryRefundAdapter } from "../../rms/payment/src/infrastructure/stripe/stripe-ordinary-refund-adapter.ts";
import { decodeOrdinaryRefundObservation } from "../../rms/payment/src/application/ordinary-refund-observation.ts";
import { createPostgresOrdinaryRefundObservationRuntime } from "../../rms/payment/src/infrastructure/ordinary-refund-observation-runtime.ts";
import { createPostgresOrdinaryRefundSendRuntime } from "../../rms/payment/src/infrastructure/ordinary-refund-send-runtime.ts";
import { createPostgresOrdinaryRefundRecoverySource } from "../../rms/payment/src/infrastructure/ordinary-refund-recovery-source.ts";
import { createPostgresOrdinaryRefundDispatchRuntime } from "../../rms/payment/src/infrastructure/ordinary-refund-dispatch-runtime.ts";
import { createOrdinaryRefundProviderRequest } from "../../rms/payment/src/application/ordinary-refund-provider-request.ts";
import { seedOrdinaryRefundSession } from "./ordinary-refund-session.mjs";
import { createMerchantOrdinaryRefundCommand } from "../../../apps/api/src/merchant-ordinary-refund-command.ts";
import { seedOrdinaryRefundWorkforce } from "./ordinary-refund-workforce.mjs";
import { seedOrdinaryRefundStorePublication } from "./ordinary-refund-store-publication.mjs";
import { createPostgresOrdinaryRefundOperationRuntime } from "../../rms/payment/src/infrastructure/ordinary-refund-operation-runtime.ts";
import { createPostgresOrdinaryRefundOperationExecutionSource } from "../../rms/payment/src/infrastructure/ordinary-refund-operation-execution-source.ts";
import { createPostgresOrdinaryRefundApprovalSource } from "../../rms/payment/src/infrastructure/ordinary-refund-approval-source.ts";
import { createPostgresOrdinaryRefundApprovalStore } from "../../rms/payment/src/infrastructure/persistence/ordinary-refund-approval-store.ts";
import { createPostgresPaymentCompensationSource } from "../../rms/payment/src/index.ts";
import { createPostgresPaymentProviderObservationStore } from "../../rms/payment/src/index.ts";
import assert from "node:assert/strict";
import { createPostgresOrdinaryRefundCaptureSource } from "../../rms/payment/src/infrastructure/persistence/ordinary-refund-capture-source.ts";
import {
  createPostgresOrdinaryRefundExecutionBalanceSource,
  createPostgresOrdinaryRefundApprovalSubjectSource,
  createPostgresOrdinaryRefundRequestStore,
} from "../../rms/payment/src/infrastructure/persistence/ordinary-refund-request-store.ts";
import {
  allocateOrdinaryRefundFromQuote,
  createPostgresPriceQuoteHistoryReader,
  createPostgresConfiguredPriceQuoteHistoryReader,
} from "../../rms/pricing/src/index.ts";
import { createPostgresOrdinaryRefundPricingSource } from "../../rms/payment/src/infrastructure/ordinary-refund-pricing-source.ts";
import { ordinaryRefundRequestFixture } from "../../rms/payment/src/tests/ordinary-refund-request.fixture.ts";
import { createPostgresOrderRefundBasisReader } from "../../rms/ordering/src/index.ts";

// Drain both database branches before propagating a failure so outer cleanup
// cannot mask the actual error or terminate a still-running sibling transaction.
async function together(promises) {
  const settled = await Promise.allSettled(promises);
  for (const result of settled) if (result.status === "rejected") throw result.reason;
  return settled.map((result) => result.value);
}

// Actual persisted Ordering/Pricing/Payment sources and request write.
// Current merchant authority remains synthetic. No Provider network refund.
export async function exerciseOrdinaryRefundCapture({
  client,
  runner,
  scope,
  terminalScope,
  record,
  fact,
  captured,
  hash,
  validateOnly = false,
  storePublication,
  refundObservationFault = false,
}) {
  const id = (n) => "01909979-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const at = new Date().toISOString();
  const basis = await runner().run((tx) =>
    createPostgresOrderRefundBasisReader({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      authorize: async () => true,
    }).load(tx, {
      orderReference: fact.orderReference,
      orderBatchReference: record.intent.preparation.orderBatchReference,
      submissionReference: record.intent.preparation.submissionReference,
      quoteReference: record.intent.preparation.quoteReference,
      observedAt: at,
    }),
  );
  const quoteScope = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  const quote = await (
    basis.quoteVersion === 2
      ? createPostgresConfiguredPriceQuoteHistoryReader(runner(), quoteScope)
      : createPostgresPriceQuoteHistoryReader(runner(), quoteScope)
  ).load(record.intent.preparation.quoteReference);
  assert.ok(quote);
  const allocation = allocateOrdinaryRefundFromQuote(quote, {
    tipAmountMinor: record.intent.preparation.tip.amountMinor,
    items: basis.items.map((item) => ({
      orderItemReference: item.orderItemReference,
      quoteLineReference: item.quoteLineReference,
      quantity: item.quantity,
      occupiedUnitOrdinals: [],
      refundQuantity: item.quantity,
    })),
  });
  assert.equal(allocation.amountMinor, fact.amount.amountMinor);
  const request = {
    ...ordinaryRefundRequestFixture(at),
    ...scope,
    orderReference: fact.orderReference,
    requestReference: id(1),
    operationReference: id(2),
    actorReference: id(3),
    auditReference: id(4),
    amountMinor: allocation.amountMinor,
    payments: [
      {
        paymentTransactionReference: fact.paymentTransactionReference,
        paymentIntentReference: fact.paymentIntentReference,
        paymentAttemptReference: fact.paymentAttemptReference,
        firstCaptureReference: fact.observationReference,
        sourceReference: allocation.sourceReference,
        sourceDigest: allocation.sourceDigest,
        items: allocation.items.map((item) => ({
          orderItemReference: item.orderItemReference,
          refundUnitOrdinals: item.refundUnitOrdinals,
          components: item.components,
        })),
      },
    ],
  };
  const source = (extra = {}) =>
    createPostgresOrdinaryRefundCaptureSource({
      scope: { ...scope, ...terminalScope },
      now: () => new Date().toISOString(),
      authorize: async () => true,
      validatePricing: createPostgresOrdinaryRefundPricingSource({
        scope,
        authorize: async () => true,
      }),
      ...extra,
    });
  const read = (candidate = request, target = source()) =>
    runner().run((tx) => target(tx, { request: candidate, history: [] }));
  const tampered = {
    ...request,
    payments: request.payments.map((payment) => ({
      ...payment,
      items: payment.items.map((item) => ({
        ...item,
        components: {
          ...item.components,
          netAmountMinor: item.components.netAmountMinor - 1n,
          taxAmountMinor: item.components.taxAmountMinor + 1n,
        },
      })),
    })),
  };
  await assert.rejects(read(tampered));
  await assert.rejects(
    read({
      ...request,
      payments: request.payments.map((payment) => ({
        ...payment,
        sourceDigest: "sha256:" + "f".repeat(64),
      })),
    }),
  );
  const balances = await read();
  assert.equal(balances.length, 1);
  assert.equal(balances[0].capturedAmountMinor, fact.amount.amountMinor);
  assert.equal(balances[0].otherOccupiedAmountMinor, 0n);
  assert.equal(balances[0].firstCapturedAt, fact.occurredAt);
  assert.equal(balances[0].firstCaptureRecordedAt, fact.recordedAt);
  for (const field of [
    "paymentTransactionReference",
    "paymentIntentReference",
    "paymentAttemptReference",
    "firstCaptureReference",
  ]) {
    await assert.rejects(
      read({ ...request, payments: [{ ...request.payments[0], [field]: id(80) }] }),
    );
  }
  await assert.rejects(read({ ...request, orderReference: id(81) }));
  await assert.rejects(read({ ...request, tenantReference: id(82) }));
  await assert.rejects(read(request, source({ authorize: async () => false })));
  await assert.rejects(read(request, source({ validatePricing: async () => false })));
  await assert.rejects(
    read(
      request,
      source({ scope: { ...scope, ...terminalScope, providerAccountReference: id(83) } }),
    ),
  );
  await assert.rejects(
    read(request, source({ scope: { ...scope, ...terminalScope, environment: "Live" } })),
  );
  const audit = {
    auditId: request.auditReference,
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "User", reference: request.actorReference },
    actionCode: "PAYMENT_ORDINARY_REFUND_REQUESTED",
    targetType: "PaymentRefundRequest",
    targetId: request.requestReference,
    reasonCode: request.reasonCode,
    correlationId: request.operationReference,
    occurredAt: at,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Restricted",
    retentionPolicyCode: "FINANCIAL_COMPLIANCE",
    retentionPolicyVersion: 1,
  };
  const store = createPostgresOrdinaryRefundRequestStore({
    scope,
    authorize: async () => true,
    validateSources: source(),
  });
  async function completeRefund(requestWasCommitted = false, receiptOptions) {
    assert.equal(
      (await runner().run((tx) => store.record(tx, request, audit))).status,
      requestWasCommitted ? "AlreadyCommitted" : "Created",
    );
    assert.equal(
      (await runner().run((tx) => store.record(tx, request, audit))).status,
      "AlreadyCommitted",
    );
    const executionBalance = createPostgresOrdinaryRefundExecutionBalanceSource({
      scope,
      authorize: async () => true,
      validateSources: source(),
    });
    const executionQuery = {
      orderReference: request.orderReference,
      requestReference: request.requestReference,
    };
    const execution = await runner().run((tx) => executionBalance(tx, executionQuery));
    assert.equal(execution.positions[0].requestAmountMinor, request.amountMinor);
    assert.equal(execution.positions[0].occupiedAmountMinor, request.amountMinor);
    assert.equal(execution.positions[0].unoccupiedAmountMinor, 0n);
    assert.equal(execution.claimVersion, 1);
    const subjectQuery = {
      orderReference: request.orderReference,
      requestReference: request.requestReference,
      observedAt: at,
    };
    const subjectSource = createPostgresOrdinaryRefundApprovalSubjectSource({
      scope,
      authorize: async () => true,
    });
    const subject = await runner().run((tx) => subjectSource(tx, subjectQuery));
    assert.equal(subject.requesterReference, request.actorReference);
    assert.equal(subject.claimVersion, 1);
    assert.equal(subject.request.amountMinor, request.amountMinor);
    assert.equal(subject.subject.requestReference, request.requestReference);
    assert.equal(subject.subject.orderReference, request.orderReference);
    const operation = {
      ...subject.subject,
      operationReference: id(120),
      providerOperationReference: id(121),
      paymentTransactionReference: fact.paymentTransactionReference,
      paymentIntentReference: fact.paymentIntentReference,
      paymentAttemptReference: fact.paymentAttemptReference,
      firstCaptureReference: fact.observationReference,
      providerAccountReference: terminalScope.providerAccountReference,
      executorReference: request.actorReference,
      auditReference: id(122),
      approvalReference: null,
      claimVersion: subject.claimVersion,
      preparedAt: at,
      environment: terminalScope.environment,
      currencyCode: "CAD",
      amountMinor: request.amountMinor,
      status: "Prepared",
    };
    const channelRequest = createOrdinaryRefundProviderRequest(
      operation,
      balances[0].providerBinding,
    );
    assert.equal(channelRequest.providerIntentReference, fact.providerIntentReference);
    assert.equal(channelRequest.context.paymentAttemptReference, fact.paymentAttemptReference);
    assert.equal(channelRequest.amount.amountMinor, request.amountMinor);
    assert.equal(
      channelRequest.idempotencyKey,
      "ordinary-refund:" + operation.providerOperationReference,
    );
    // Actual capture/Pricing/request occupancy; executor authority remains synthetic.
    const executionSource = (extra = {}) =>
      createPostgresOrdinaryRefundOperationExecutionSource({
        scope: { ...scope, ...terminalScope },
        authorize: async () => true,
        validatePricing: createPostgresOrdinaryRefundPricingSource({
          scope,
          authorize: async () => true,
        }),
        executor: async (_tx, query) => ({
          ...query,
          permissionCode: "payment.refund.execute",
          active: true,
          allowed: true,
        }),
        ...extra,
      });
    const resolveExecution = (candidate = operation, target = executionSource()) =>
      runner().run((tx) => target(tx, candidate, new Date().toISOString()));
    const executionFacts = await resolveExecution();
    assert.equal(executionFacts.position.occupiedAmountMinor, request.amountMinor);
    assert.equal(executionFacts.position.unoccupiedAmountMinor, 0n);
    for (const patch of [
      { providerAccountReference: id(123) },
      { environment: terminalScope.environment === "Test" ? "Live" : "Test" },
      { amountMinor: request.amountMinor - 1n },
      { firstCaptureReference: id(123) },
      { paymentIntentReference: id(123) },
      { claimVersion: 2 },
    ])
      await assert.rejects(resolveExecution({ ...operation, ...patch }));
    await assert.rejects(
      resolveExecution(
        operation,
        executionSource({
          executor: async (_tx, query) => ({
            ...query,
            permissionCode: "payment.refund.execute",
            active: true,
            allowed: false,
          }),
        }),
      ),
    );
    await assert.rejects(
      resolveExecution(operation, executionSource({ authorize: async () => false })),
    );
    const replaySubject = await runner().run((tx) =>
      subjectSource(tx, { ...subjectQuery, observedAt: new Date().toISOString() }),
    );
    assert.deepEqual(replaySubject.subject, subject.subject);
    await assert.rejects(
      runner().run((tx) => subjectSource(tx, { ...subjectQuery, requestReference: id(91) })),
    );
    await assert.rejects(
      runner().run((tx) =>
        createPostgresOrdinaryRefundApprovalSubjectSource({
          scope: { ...scope, tenantReference: id(92) },
          authorize: async () => true,
        })(tx, subjectQuery),
      ),
    );
    let authorityReads = 0;
    await assert.rejects(
      runner().run((tx) =>
        createPostgresOrdinaryRefundApprovalSubjectSource({
          scope,
          authorize: async () => ++authorityReads === 1,
        })(tx, subjectQuery),
      ),
    );
    assert.equal(authorityReads, 2);
    const workforce = await seedOrdinaryRefundWorkforce({
      client,
      scope,
      requester: request.actorReference,
      approver: id(101),
      at,
    });
    const approvalOptions = {
      scope,
      authorize: async () => true,
      authority: workforce.authority,
    };
    const prepared = await runner().run((tx) =>
      createPostgresOrdinaryRefundApprovalSource(approvalOptions)(tx, {
        ...subjectQuery,
        approvalReference: id(100),
        approverReference: id(101),
        observedAt: requestWasCommitted ? new Date().toISOString() : subjectQuery.observedAt,
      }),
    );
    const approvalInput = {
      ...prepared,
      operationReference: id(102),
      auditReference: id(103),
    };
    const approvalAudit = {
      ...audit,
      occurredAt: prepared.approval.approvedAt,
      auditId: id(103),
      actor: { type: "User", reference: id(101) },
      actionCode: "PAYMENT_ORDINARY_REFUND_APPROVED",
      targetType: "PaymentRefundApproval",
      targetId: id(100),
      correlationId: id(102),
    };
    const approvals = createPostgresOrdinaryRefundApprovalStore(approvalOptions);
    const results = await together([
      runner().run((tx) => approvals.record(tx, approvalInput, approvalAudit)),
      runner().run((tx) => approvals.record(tx, approvalInput, approvalAudit)),
    ]);
    assert.deepEqual(results.map((entry) => entry.status).sort(), ["AlreadyCommitted", "Created"]);
    const countApproval = (reference) =>
      runner().run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        const rows = await tx.query(
          "SELECT count(*)::int AS count FROM rms_payment.ordinary_refund_approval WHERE approval_id=$1",
          [reference],
        );
        return rows.rows[0].count;
      });
    assert.equal(await countApproval(id(100)), 1);
    const runtime = (extra = {}) =>
      createPostgresOrdinaryRefundOperationRuntime({
        ...approvalOptions,
        providerAccountReference: terminalScope.providerAccountReference,
        environment: terminalScope.environment,
        validatePricing: createPostgresOrdinaryRefundPricingSource({
          scope,
          authorize: async () => true,
        }),
        executor: async (_tx, query) => ({
          ...query,
          permissionCode: "payment.refund.execute",
          active: true,
          allowed: true,
        }),
        // Synthetic dates force escalation; actual Store publication adapter is tested separately.
        businessDate: async (_tx, query) =>
          query.occurredAt === fact.occurredAt ? "2026-09-12" : "2026-09-13",
        ...extra,
      });
    const approvedOperation = { ...operation, approvalReference: id(100) };
    const prepareOperation = (op = approvedOperation, target = runtime()) =>
      runner().run((tx) =>
        target.prepareAndRecord(
          tx,
          Object.fromEntries(
            [
              "orderReference",
              "requestReference",
              "paymentAttemptReference",
              "operationReference",
              "providerOperationReference",
              "executorReference",
              "auditReference",
              "approvalReference",
            ].map((key) => [key, op[key]]),
          ),
          {
            reasonCode: audit.reasonCode,
            retentionPolicyCode: audit.retentionPolicyCode,
            retentionPolicyVersion: audit.retentionPolicyVersion,
          },
        ),
      );
    await assert.rejects(prepareOperation(operation));
    await assert.rejects(prepareOperation({ ...approvedOperation, approvalReference: id(199) }));
    await assert.rejects(
      prepareOperation(
        approvedOperation,
        runtime({
          authority: async (tx, query) => ({
            ...(await approvalOptions.authority(tx, query)),
            recentMfaAt: "2020-01-01T00:00:00.000Z",
          }),
        }),
      ),
    );
    await assert.rejects(
      prepareOperation(
        approvedOperation,
        runtime({
          executor: async (_tx, query) => ({
            ...query,
            permissionCode: "payment.refund.execute",
            active: true,
            allowed: false,
          }),
        }),
      ),
    );
    const { businessDate, storeOptions } =
      storePublication ??
      (await seedOrdinaryRefundStorePublication({
        client,
        scope,
        firstCapturedAt: fact.occurredAt,
      }));
    const currentDate = await runner().run((tx) =>
      businessDate(tx, { ...scope, occurredAt: new Date().toISOString() }),
    );
    assert.match(currentDate, /^\d{4}-\d{2}-\d{2}$/);
    const session = await seedOrdinaryRefundSession({
      client,
      runner,
      scope,
      requester: request.actorReference,
      at: requestWasCommitted ? new Date().toISOString() : at,
    });
    const command = createMerchantOrdinaryRefundCommand({
      persistence: session.persistence,
      authentication: session.authentication,
      resolveConfiguration: async (_tx, resolved) => {
        assert.deepEqual(resolved, { ...scope, actorReference: request.actorReference });
        return {
          providerAccountReference: terminalScope.providerAccountReference,
          environment: terminalScope.environment,
          workforce: workforce.options,
          store: storeOptions,
        };
      },
      audit: {
        reasonCode: audit.reasonCode,
        retentionPolicyCode: audit.retentionPolicyCode,
        retentionPolicyVersion: audit.retentionPolicyVersion,
      },
    });
    const commandInput = {
      sessionCookie: session.sessionCookie,
      csrf: session.csrf,
      command: {
        orderReference: request.orderReference,
        requestReference: request.requestReference,
        paymentAttemptReference: fact.paymentAttemptReference,
        operationReference: approvedOperation.operationReference,
        auditReference: approvedOperation.auditReference,
        approvalReference: approvedOperation.approvalReference,
      },
    };
    await assert.rejects(command({ ...commandInput, csrf: "synthetic-invalid-csrf" }));
    const operationResults = await together([command(commandInput), command(commandInput)]);
    assert.deepEqual(operationResults.map((x) => x.status).sort(), ["AlreadyCommitted", "Created"]);
    const persisted = (
      await client.query(
        "SELECT provider_operation_id::text AS provider,executor_id::text AS actor FROM rms_payment.ordinary_refund_operation WHERE operation_id=$1",
        [approvedOperation.operationReference],
      )
    ).rows;
    assert.deepEqual(persisted, [
      { provider: approvedOperation.operationReference, actor: request.actorReference },
    ]);
    const dispatchRuntime = (extra = {}) =>
      createPostgresOrdinaryRefundDispatchRuntime({
        ...approvalOptions,
        providerAccountReference: terminalScope.providerAccountReference,
        environment: terminalScope.environment,
        executor: workforce.executor,
        businessDate,
        validatePricing: createPostgresOrdinaryRefundPricingSource({
          scope,
          authorize: async () => true,
        }),
        ...extra,
      });
    const dispatchInput = {
      orderReference: request.orderReference,
      requestReference: request.requestReference,
      operationReference: approvedOperation.operationReference,
      dispatchReference: id(150),
      auditReference: id(151),
      approvalReference: approvedOperation.approvalReference,
    };
    const dispatchPolicy = {
      reasonCode: audit.reasonCode,
      retentionPolicyCode: audit.retentionPolicyCode,
      retentionPolicyVersion: audit.retentionPolicyVersion,
    };
    const beginDispatch = (value = dispatchInput, target = dispatchRuntime()) =>
      runner().run((tx) => target.record(tx, value, dispatchPolicy));
    await assert.rejects(
      beginDispatch(
        { ...dispatchInput, approvalReference: null },
        dispatchRuntime({
          businessDate: async (_tx, query) =>
            query.occurredAt === fact.occurredAt ? "2026-09-12" : "2026-09-13",
        }),
      ),
    );
    await assert.rejects(beginDispatch({ ...dispatchInput, approvalReference: id(199) }));
    let providerSends = 0;
    let visibleBeforeSend = false;
    let sentRequest;
    let generatedObservationIdentities = 0;
    let observedInput;
    const observationStore = (extra = {}) =>
      createPostgresOrdinaryRefundObservationRuntime({
        scope,
        providerAccountReference: terminalScope.providerAccountReference,
        environment: terminalScope.environment,
        authorize: async () => true,
        ...extra,
      });
    const persistObservation = (value) =>
      runner().run((tx) => observationStore().record(tx, value));

    let refundLookupCalls = 0;
    let refundPayload;
    const stripeRefund = createStripeOrdinaryRefundAdapter({
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      environment: terminalScope.environment,
      apiVersion: "2024-06-20",
      secretKey: "sk_test_SYNTHETICONLY",
      connectedAccount: null,
      now: () => new Date().toISOString(),
      fetch: async (_url, init) => {
        if (init.method === "GET") {
          refundLookupCalls++;
          return globalThis.Response.json({
            object: "list",
            url: "/v1/refunds",
            has_more: false,
            data: [refundPayload],
          });
        }
        const body = new globalThis.URLSearchParams(String(init.body));
        refundPayload = {
          object: "refund",
          id: "re_SYNTHETICORDINARY001",
          payment_intent: body.get("payment_intent"),
          amount: Number(body.get("amount")),
          currency: "cad",
          status: "succeeded",
          created: Math.floor(Date.now() / 1000),
          metadata: { bop_refund_binding: body.get("metadata[bop_refund_binding]") },
        };
        return globalThis.Response.json(refundPayload);
      },
    });
    const sendOptions = {
      dispatch: {
        ...approvalOptions,
        providerAccountReference: terminalScope.providerAccountReference,
        environment: terminalScope.environment,
        executor: workforce.executor,
        businessDate,
        validatePricing: createPostgresOrdinaryRefundPricingSource({
          scope,
          authorize: async () => true,
        }),
      },
      authorizeRecovery: async () => true,
      transactions: runner(),
      provider: {
        refundPayment: async (providerRequest) => {
          providerSends++;
          // Independent connection can observe this row only after commit.
          const visible = await client.query(
            "SELECT count(*)::int AS count FROM rms_payment.ordinary_refund_dispatch WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3",
            [scope.brandReference, scope.storeReference, approvedOperation.operationReference],
          );
          visibleBeforeSend = visible.rows[0].count === 1;
          sentRequest = providerRequest;
          assert.equal(providerRequest.providerIntentReference, fact.providerIntentReference);
          assert.equal(providerRequest.amount.amountMinor, request.amountMinor);
          return stripeRefund.refundPayment(providerRequest);
        },
      },
      generateObservationIdentity: () => {
        generatedObservationIdentities++;
        return { observationReference: id(160), auditReference: id(161) };
      },
    };
    const failedCommitSend = createPostgresOrdinaryRefundSendRuntime({
      ...sendOptions,
      transactions: {
        run: (work) =>
          runner().run(async (tx) => {
            await work(tx);
            throw new Error("synthetic commit boundary failure");
          }),
      },
    });
    await assert.rejects(
      failedCommitSend(dispatchInput, dispatchPolicy),
      /synthetic commit boundary failure/,
    );
    assert.equal(providerSends, 0);
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM rms_payment.ordinary_refund_dispatch WHERE brand_id=$1 AND store_id=$2",
          [scope.brandReference, scope.storeReference],
        )
      ).rows[0].count,
      0,
    );
    generatedObservationIdentities = 0;
    const recordOlderCumulative = async () => {
      const recorded = await createPostgresPaymentProviderObservationStore(
        runner(),
        { brandReference: scope.brandReference, storeReference: scope.storeReference },
        { now: () => new Date().toISOString() },
      ).record({
        observationReference: id(90),
        paymentIntentReference: fact.paymentIntentReference,
        snapshot: {
          ...captured,
          refundedAmount: { amountMinor: 1n, currencyCode: "CAD" },
          observedAt: new Date().toISOString(),
          evidenceDigest: hash("synthetic unmatched refund"),
        },
      });
      assert.equal(recorded.status, "Recorded");
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM rms_payment.payment_provider_observation WHERE provider_observation_id=$1",
            [id(90)],
          )
        ).rows[0].count,
        1,
      );
    };
    const processingCandidate = {
      operationReference: approvedOperation.operationReference,
      orderReference: request.orderReference,
      requestReference: request.requestReference,
      workKind: "Dispatch",
    };
    const processing = (payment = sendOptions) =>
      createOrdinaryRefundProcessing({
        payment: {
          ...payment,
          provider: { ...payment.provider, lookupRefund: stripeRefund.lookupRefund },
        },
        authorizeDiscovery: async () => true,
        dispatchIdentities: async () => ({
          dispatchReference: dispatchInput.dispatchReference,
          auditReference: dispatchInput.auditReference,
          approvalReference: dispatchInput.approvalReference,
        }),
        dispatchAudit: dispatchPolicy,
        receipt: receiptOptions,
        now: () => new Date().toISOString(),
        receiptFreshAfter: () => captured.observedAt,
      });
    const send = receiptOptions
      ? () => processing().dispatch(processingCandidate)
      : createPostgresOrdinaryRefundSendRuntime(sendOptions);
    const positionOptions = {
      scope,
      providerAccountReference: terminalScope.providerAccountReference,
      environment: terminalScope.environment,
      authorize: async () => true,
    };
    const ordinaryPosition = (overrides = {}) =>
      runner().run((tx) =>
        createPostgresOrdinaryRefundPositionSource({ ...positionOptions, ...overrides })(tx, {
          orderReference: request.orderReference,
          paymentTransactionReference: fact.paymentTransactionReference,
          paymentIntentReference: fact.paymentIntentReference,
          paymentAttemptReference: fact.paymentAttemptReference,
          observedAt: new Date().toISOString(),
        }),
      );
    const receiptCoverage = () =>
      runner().run((tx) =>
        createPostgresPaymentReceiptCoverageSource({
          scope: { ...terminalScope, tenantReference: scope.tenantReference },
          authorize: async () => true,
        }).resolve(tx, {
          orderReference: request.orderReference,
          observedAt: new Date().toISOString(),
          freshAfter: captured.observedAt,
          expectedBatches: [
            {
              orderBatchReference: record.intent.preparation.orderBatchReference,
              orderAllocationMinor: record.intent.preparation.orderAllocation.amountMinor,
            },
          ],
        }),
      );
    const pendingCoverage = await receiptCoverage();
    assert.equal(pendingCoverage.pendingRefund.amountMinor, request.amountMinor);
    assert.equal(pendingCoverage.refunded.amountMinor, 0n);
    assert.equal(pendingCoverage.refundDisposition, "Pending");
    const pendingPosition = await ordinaryPosition();
    assert.equal(pendingPosition.pendingMinor, request.amountMinor);
    assert.equal(pendingPosition.confirmedMinor, 0n);
    if (refundObservationFault || receiptOptions) {
      const failedOutcomeOptions = {
        ...sendOptions,
        transactions: {
          run: (work) =>
            runner().run(async (tx) => {
              let wroteOutcome = false;
              const result = await work({
                query: async (sql, values) => {
                  const result = await tx.query(sql, values);
                  if (sql.includes("INSERT INTO rms_payment.ordinary_refund_observation"))
                    wroteOutcome = true;
                  return result;
                },
              });
              if (wroteOutcome) throw new Error("synthetic outcome commit failure");
              return result;
            }),
        },
      };
      const failedOutcomeSend = receiptOptions
        ? () => processing(failedOutcomeOptions).dispatch(processingCandidate)
        : createPostgresOrdinaryRefundSendRuntime(failedOutcomeOptions);
      await assert.rejects(
        failedOutcomeSend(dispatchInput, dispatchPolicy),
        /synthetic outcome commit failure/,
      );
      assert.equal(providerSends, 1);
      assert.equal(visibleBeforeSend, true);
      assert.equal(generatedObservationIdentities, 1);
      const state = (
        await client.query(
          "SELECT (SELECT count(*)::int FROM rms_payment.ordinary_refund_dispatch WHERE brand_id=$1 AND store_id=$2) AS dispatches,(SELECT count(*)::int FROM rms_payment.ordinary_refund_observation WHERE brand_id=$1 AND store_id=$2) AS observations,(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1 AND store_id=$2 AND action_code='PAYMENT_ORDINARY_REFUND_OBSERVED') AS audits",
          [scope.brandReference, scope.storeReference],
        )
      ).rows[0];
      assert.deepEqual(state, { dispatches: 1, observations: 0, audits: 0 });
      if (receiptOptions) {
        await createOrdinaryRefundFailureRecorder({
          scope,
          transactions: runner(),
          authorize: async () => true,
          newAuditReference: () => id(180),
          now: () => new Date().toISOString(),
          retentionPolicyCode: dispatchPolicy.retentionPolicyCode,
          retentionPolicyVersion: dispatchPolicy.retentionPolicyVersion,
        })(processingCandidate, "ORDINARY_REFUND_EXECUTION_FAILED");
        const failure = (
          await client.query(
            "SELECT target_id,reason_code,after_summary_json FROM platform_audit.audit_record WHERE audit_id=$1",
            [id(180)],
          )
        ).rows;
        assert.deepEqual(failure, [
          {
            target_id: approvedOperation.operationReference,
            reason_code: "ORDINARY_REFUND_EXECUTION_FAILED",
            after_summary_json: { workKind: "Dispatch" },
          },
        ]);
      }

      assert.equal((await ordinaryPosition()).pendingMinor, request.amountMinor);
      const retry = await send(dispatchInput, dispatchPolicy);
      assert.equal(retry.status, "AlreadyCommitted");
      assert.equal(retry.state, "NeedsReconciliation");
      assert.equal(providerSends, 1);
      assert.equal(generatedObservationIdentities, 1);
      const recovered = await runner().run((tx) =>
        createPostgresOrdinaryRefundRecoverySource({
          scope,
          providerAccountReference: terminalScope.providerAccountReference,
          environment: terminalScope.environment,
          authorize: async () => true,
        })(tx, {
          orderReference: request.orderReference,
          operationReference: approvedOperation.operationReference,
        }),
      );
      assert.ok(recovered);
      assert.deepEqual(recovered.request, sentRequest);
      assert.deepEqual(recovered.dispatch, retry.dispatch);
      await client.query(
        "UPDATE bop_permission.permission_grant SET lifecycle='Revoked',version=version+1 WHERE brand_id=$1 AND store_id=$2 AND permission_id IN (SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='payment.refund.execute')",
        [scope.brandReference, scope.storeReference],
      );
      await assert.rejects(command(commandInput));
      const reconciliationOptions = {
        scope,
        providerAccountReference: terminalScope.providerAccountReference,
        environment: terminalScope.environment,
        authorize: async () => true,
        transactions: runner(),
        provider: stripeRefund,
      };
      const reconcile = createPostgresOrdinaryRefundReconciliationRuntime(reconciliationOptions);
      const job = {
        orderReference: request.orderReference,
        operationReference: approvedOperation.operationReference,
        observationReference: id(166),
        auditReference: id(167),
      };
      const reconcileCandidate = { ...processingCandidate, workKind: "Reconcile" };
      const composed = receiptOptions
        ? processing({
            ...sendOptions,
            generateObservationIdentity: () => ({
              observationReference: job.observationReference,
              auditReference: job.auditReference,
            }),
          })
        : null;
      const runReconcile = () =>
        composed ? composed.reconcile(reconcileCandidate) : reconcile(job);
      const results = await together([runReconcile(), runReconcile()]);
      assert.deepEqual(results.map((result) => result.status).sort(), [
        "AlreadyCommitted",
        "Created",
      ]);
      assert.deepEqual(results[0].observation, results[1].observation);
      assert.equal(results[0].observation.outcome.kind, "RefundObservation");
      assert.equal(results[0].observation.outcome.providerRefundReference, refundPayload.id);
      assert.equal(results[0].observation.state, "NeedsReconciliation");
      const lookupsAfterFirst = refundLookupCalls;
      assert.ok(lookupsAfterFirst >= 1 && lookupsAfterFirst <= 2);
      assert.equal((await reconcile(job)).status, "AlreadyCommitted");
      await assert.rejects(reconcile({ ...job, auditReference: id(168) }));
      await assert.rejects(
        createPostgresOrdinaryRefundReconciliationRuntime({
          ...reconciliationOptions,
          authorize: async () => false,
        })(job),
      );
      assert.equal(refundLookupCalls, lookupsAfterFirst);
      assert.equal(providerSends, 1);
      const reconciledCounts = (
        await client.query(
          "SELECT (SELECT count(*)::int FROM rms_payment.ordinary_refund_observation WHERE brand_id=$1 AND store_id=$2) AS observations,(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1 AND store_id=$2 AND action_code='PAYMENT_ORDINARY_REFUND_OBSERVED') AS audits",
          [scope.brandReference, scope.storeReference],
        )
      ).rows[0];
      assert.deepEqual(reconciledCounts, { observations: 1, audits: 1 });
      const confirmedCoverage = await receiptCoverage();
      assert.equal(confirmedCoverage.refunded.amountMinor, request.amountMinor);
      assert.equal(confirmedCoverage.pendingRefund.amountMinor, 0n);
      assert.equal(confirmedCoverage.refundDisposition, "NonePending");
      assert.notEqual(
        confirmedCoverage.batches[0].refundPositionDigest,
        pendingCoverage.batches[0].refundPositionDigest,
      );
      assert.ok(
        confirmedCoverage.batches[0].refundPositionVersion >
          pendingCoverage.batches[0].refundPositionVersion,
      );
      const confirmed = await ordinaryPosition();
      assert.equal(confirmed.confirmedMinor, request.amountMinor);
      assert.equal(confirmed.pendingMinor, 0n);
      assert.equal(confirmed.version, pendingPosition.version + 1);
      assert.notEqual(confirmed.snapshotDigest, pendingPosition.snapshotDigest);
      assert.deepEqual(await ordinaryPosition(), confirmed);
      await assert.rejects(ordinaryPosition({ authorize: async () => false }));
      await assert.rejects(ordinaryPosition({ providerAccountReference: id(899) }));
      await assert.rejects(ordinaryPosition({ environment: "Live" }));
      // A balance transaction fences the actual observation writer, not just
      // another reader. Lock timeout must leave no partial evidence or Audit.
      await runner().run(async (tx) => {
        await createPostgresOrdinaryRefundPositionSource(positionOptions)(tx, {
          orderReference: request.orderReference,
          paymentTransactionReference: fact.paymentTransactionReference,
          paymentIntentReference: fact.paymentIntentReference,
          paymentAttemptReference: fact.paymentAttemptReference,
          observedAt: new Date().toISOString(),
        });
        await assert.rejects(
          runner().run(async (competing) => {
            await competing.query("SET LOCAL lock_timeout = '200ms'", []);
            await createPostgresOrdinaryRefundObservationRuntime(positionOptions).record(
              competing,
              {
                orderReference: request.orderReference,
                operationReference: approvedOperation.operationReference,
                observationReference: id(170),
                auditReference: id(171),
                outcome: results[0].observation.outcome,
              },
            );
          }),
          (error) => error.code === "55P03",
        );
      });
      assert.deepEqual(await ordinaryPosition(), confirmed);
      const afterTimeout = (
        await client.query(
          "SELECT (SELECT count(*)::int FROM rms_payment.ordinary_refund_observation WHERE brand_id=$1 AND store_id=$2) AS observations,(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1 AND store_id=$2 AND action_code='PAYMENT_ORDINARY_REFUND_OBSERVED') AS audits",
          [scope.brandReference, scope.storeReference],
        )
      ).rows[0];
      assert.deepEqual(afterTimeout, { observations: 1, audits: 1 });
      if (composed) {
        await recordOlderCumulative();
        assert.equal((await ordinaryPosition()).confirmedMinor, request.amountMinor);
        await composed.afterReconcile(reconcileCandidate);
        await composed.afterReconcile(reconcileCandidate);
        assert.equal(providerSends, 1);
      }

      return;
    }
    const firstDispatch = await together([
      send(dispatchInput, dispatchPolicy),
      send(dispatchInput, dispatchPolicy),
    ]);
    assert.equal(providerSends, 1);
    assert.equal(visibleBeforeSend, true);
    assert.equal(sentRequest.providerIntentReference, fact.providerIntentReference);
    assert.equal(sentRequest.amount.amountMinor, request.amountMinor);
    assert.equal(generatedObservationIdentities, 1);
    const recordedObservation = decodeOrdinaryRefundObservation(
      (
        await client.query(
          "SELECT record_json::text AS record FROM rms_payment.ordinary_refund_observation WHERE brand_id=$1 AND store_id=$2 AND observation_id=$3",
          [scope.brandReference, scope.storeReference, id(160)],
        )
      ).rows[0].record,
    );
    assert.equal(recordedObservation.outcome.kind, "RefundObservation");
    assert.equal(recordedObservation.outcome.status, "succeeded");
    assert.equal(recordedObservation.outcome.providerRefundReference, "re_SYNTHETICORDINARY001");
    observedInput = {
      orderReference: request.orderReference,
      operationReference: approvedOperation.operationReference,
      observationReference: id(160),
      auditReference: id(161),
      outcome: recordedObservation.outcome,
    };
    const observationCounts = async () =>
      (
        await client.query(
          "SELECT (SELECT count(*)::int FROM rms_payment.ordinary_refund_observation WHERE brand_id=$1 AND store_id=$2) AS observations,(SELECT count(*)::int FROM platform_audit.audit_record WHERE brand_id=$1 AND store_id=$2 AND action_code='PAYMENT_ORDINARY_REFUND_OBSERVED') AS audits",
          [scope.brandReference, scope.storeReference],
        )
      ).rows[0];
    assert.deepEqual(await observationCounts(), { observations: 1, audits: 1 });
    assert.equal((await persistObservation(observedInput)).status, "AlreadyCommitted");
    await assert.rejects(
      persistObservation({
        ...observedInput,
        outcome: { ...observedInput.outcome, safeReasonCode: "DIFFERENT_REASON" },
      }),
    );
    await assert.rejects(
      runner().run((tx) =>
        observationStore({ authorize: async () => false }).record(tx, observedInput),
      ),
    );
    const secondObservation = {
      ...observedInput,
      observationReference: id(162),
      auditReference: id(163),
    };
    const secondPair = await together([
      persistObservation(secondObservation),
      persistObservation(secondObservation),
    ]);
    assert.deepEqual(secondPair.map((result) => result.status).sort(), [
      "AlreadyCommitted",
      "Created",
    ]);
    assert.deepEqual(secondPair[0].observation, secondPair[1].observation);
    assert.deepEqual(await observationCounts(), { observations: 2, audits: 2 });
    const failedObservation = {
      ...observedInput,
      observationReference: id(164),
      auditReference: id(165),
    };
    await runner().run(async (tx) => {
      await assert.rejects(
        observationStore().record(
          {
            query: async (sql, values) => {
              if (sql.includes("INSERT INTO platform_audit.audit_record"))
                throw new Error("synthetic observation Audit failure");
              return tx.query(sql, values);
            },
          },
          failedObservation,
        ),
        /synthetic observation Audit failure/,
      );
    });
    await runner().run(async (tx) => {
      let revoked = false;
      await assert.rejects(
        observationStore({ authorize: async () => !revoked }).record(
          {
            query: async (sql, values) => {
              const result = await tx.query(sql, values);
              if (sql.includes("INSERT INTO rms_payment.ordinary_refund_observation"))
                revoked = true;
              return result;
            },
          },
          failedObservation,
        ),
      );
    });
    assert.deepEqual(await observationCounts(), { observations: 2, audits: 2 });

    assert.ok(firstDispatch.every((result) => result.state === "NeedsReconciliation"));
    assert.equal((await send(dispatchInput, dispatchPolicy)).status, "AlreadyCommitted");
    assert.equal(providerSends, 1);

    assert.deepEqual(firstDispatch.map((x) => x.status).sort(), ["AlreadyCommitted", "Created"]);
    assert.deepEqual(firstDispatch[0].dispatch, firstDispatch[1].dispatch);
    assert.equal(
      firstDispatch[0].dispatch.providerOperationReference,
      approvedOperation.operationReference,
    );
    await client.query(
      "UPDATE bop_permission.permission_grant g SET lifecycle='Revoked',version=version+1 WHERE brand_id=$1 AND store_id=$2 AND permission_id IN (SELECT permission_id FROM bop_permission.permission_definition WHERE action_code='payment.refund.execute')",
      [scope.brandReference, scope.storeReference],
    );
    await assert.rejects(command(commandInput));
    const recoveryOptions = {
      scope,
      providerAccountReference: terminalScope.providerAccountReference,
      environment: terminalScope.environment,
      // Synthetic system reconciliation grant, independent of revoked human execution.
      authorize: async () => true,
    };
    const recoveryQuery = {
      orderReference: request.orderReference,
      operationReference: approvedOperation.operationReference,
    };
    const recover = (extra = {}, query = recoveryQuery) =>
      runner().run((tx) =>
        createPostgresOrdinaryRefundRecoverySource({ ...recoveryOptions, ...extra })(tx, query),
      );
    const recoveredRequest = await recover();
    assert.ok(recoveredRequest);
    assert.equal(recoveredRequest.request.providerIntentReference, fact.providerIntentReference);
    assert.equal(recoveredRequest.request.amount.amountMinor, request.amountMinor);
    assert.equal(
      recoveredRequest.request.idempotencyKey,
      "ordinary-refund:" + approvedOperation.operationReference,
    );
    assert.deepEqual(recoveredRequest.dispatch, firstDispatch[0].dispatch);
    assert.equal(await recover({}, { ...recoveryQuery, operationReference: id(198) }), null);
    await assert.rejects(recover({ providerAccountReference: id(197) }));
    await assert.rejects(
      recover({ environment: terminalScope.environment === "Test" ? "Live" : "Test" }),
    );
    await assert.rejects(recover({ authorize: async () => false }));
    let recoveryAuthorizations = 0;
    await assert.rejects(recover({ authorize: async () => ++recoveryAuthorizations < 3 }));
    assert.equal(recoveryAuthorizations, 3);
    const recoveredDispatch = await beginDispatch();
    assert.equal(recoveredDispatch.status, "AlreadyCommitted");
    assert.deepEqual(recoveredDispatch.dispatch, firstDispatch[0].dispatch);

    await assert.rejects(
      runner().run((tx) =>
        approvals.record(
          tx,
          {
            ...approvalInput,
            claimVersion: 2,
          },
          approvalAudit,
        ),
      ),
    );
    const failedInput = {
      ...approvalInput,
      approval: { ...prepared.approval, approvalReference: id(104) },
      operationReference: id(105),
      auditReference: id(106),
    };
    const failedAudit = {
      ...approvalAudit,
      auditId: id(106),
      targetId: id(104),
      correlationId: id(105),
    };
    await runner().run(async (tx) => {
      const broken = {
        query: async (sql, params) => {
          if (sql.startsWith("INSERT INTO platform_audit.audit_record"))
            throw new Error("synthetic approval Audit failure");
          return tx.query(sql, params);
        },
      };
      // Catch inside outer transaction: writer must undo its own partial append.
      await assert.rejects(approvals.record(broken, failedInput, failedAudit));
    });
    assert.equal(await countApproval(id(104)), 0);
    const compensation = createPostgresPaymentCompensationSource({
      transactions: runner(),
      scope: terminalScope,
      tenantReference: scope.tenantReference,
      clock: { now: () => new Date().toISOString() },
      authorize: async () => true,
      // No third refund owner exists in this fixture; ordinary is read internally.
      otherRefunds: async () => ({ confirmedMinor: 0n, pendingMinor: 0n, version: 1 }),
    });
    const identityQuery = {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      orderReference: request.orderReference,
      paymentTransactionReference: fact.paymentTransactionReference,
      paymentIntentReference: fact.paymentIntentReference,
      paymentAttemptReference: fact.paymentAttemptReference,
    };
    const identity = await compensation.resolveIdentity(identityQuery);
    assert.ok(identity);
    const compensationQuery = {
      ...identityQuery,
      environment: identity.environment,
      identityVersion: identity.identityVersion,
      identityDigest: identity.identityDigest,
    };
    const blockedBalance = await compensation.resolve(compensationQuery);
    assert.ok(blockedBalance);
    assert.equal(blockedBalance.pendingRefundClaimedAmount.amountMinor, 0n);
    assert.equal(blockedBalance.confirmedRefundedAmount.amountMinor, request.amountMinor);
    assert.equal(blockedBalance.capturedAmount.amountMinor, request.amountMinor);
    await recordOlderCumulative();
    // An older cumulative amount is covered by the individually confirmed refund.
    // It must not make actual confirmation disappear or falsely block the source.
    await read();
    const stillConfirmed = await compensation.resolve(compensationQuery);
    assert.equal(stillConfirmed.confirmedRefundedAmount.amountMinor, request.amountMinor);
    assert.equal(stillConfirmed.pendingRefundClaimedAmount.amountMinor, 0n);
    assert.equal((await ordinaryPosition()).confirmedMinor, request.amountMinor);
    // A later refund observation must not destroy access to the original request.
    // Recovery alone does not identify that observation as this refund's outcome.
    assert.deepEqual(await recover(), recoveredRequest);
  }
  if (validateOnly)
    return {
      request,
      commitRequest: () => runner().run((tx) => store.record(tx, request, audit)),
      completeRefund: (receiptOptions) => completeRefund(true, receiptOptions),
    };
  return completeRefund();
}
