import { exerciseOrdinaryRefundCapture } from "./ordinary-refund-capture.mjs";
import { exerciseCompensationRuntime } from "./payment-compensation-runtime.mjs";
import { exerciseCompensationSource } from "./payment-compensation-source.mjs";
import { exerciseCustomerReceiptRead } from "./customer-receipt-read.mjs";
import { exerciseDiningCustomerStatus } from "./dining-customer-status.mjs";
import { exerciseCapturedOrderKitchen } from "./captured-order-kitchen.mjs";
import {
  createOrderPaymentOutcomeConsumerService,
  createPostgresOrderPaymentOutcomeStore,
  createPostgresOrderTerminationStore,
} from "../../rms/ordering/src/index.ts";
import { createOrderPaidOutcomeSource } from "../../../apps/api/src/order-paid-outcome-source.ts";
import { createOrderPaidContextSource } from "../../../apps/api/src/order-paid-context-source.ts";
import { createOrderCapturedPaymentSource } from "../../../apps/api/src/order-captured-payment-source.ts";
import { createLocalCustomerRuntime } from "../../../apps/api/src/local-customer-runtime.ts";
import { createApiRuntimeLogger } from "../../../apps/api/src/server.ts";
import { fixture as entryFixture } from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
import { createStripeOnlineClientHandoff } from "../../rms/payment/src/infrastructure/stripe/stripe-online-client-handoff.ts";
import { normalizeStripeOnlineIntentResponse } from "../../rms/payment/src/infrastructure/stripe/stripe-online-intent-response.ts";
import { createCustomerSessionPaymentIntent } from "../../../apps/api/src/customer-session-payment-intent.ts";
import { killSwitchEvaluation } from "../../rms/payment/src/tests/payment-intent-creation.fixture.ts";
import { createCustomerOrderPaymentClaimAdmission } from "../../../apps/api/src/customer-order-payment-admission.ts";
import { createCustomerIntactReservationPaymentAction } from "../../../apps/api/src/customer-payment-workflow-action.ts";
import { buildCustomerPaymentPreparationSnapshot } from "../../../apps/api/src/customer-payment-preparation-snapshot.ts";
import { createPostgresSubmissionFinalValidationStore } from "../../rms/inventory/src/index.ts";
import { createCustomerCapacityPaymentClaimAdmission } from "../../../apps/api/src/customer-capacity-payment-admission.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createPostgresAdmittedPaymentIntentCreationStore,
  createPaymentIntentCreationService,
  createPostgresPaymentProviderObservationStore,
  createPostgresPaymentTerminalStore,
  createPostgresPaymentStatusStore,
  createPostgresPaymentReceiptCoverageSource,
  createPaymentStatusEventConsumerService,
  buildPaymentStatusProjection,
  createPostgresPaymentTerminalSource,
  createPaymentTerminalService,
  createPaymentReconciliationService,
  parsePaymentIntentCreationRecord,
} from "../../rms/payment/src/index.ts";
import { createCustomerInventoryPaymentClaimAdmission } from "../../../apps/api/src/customer-inventory-payment-admission.ts";

/** Real owner persistence, synthetic explicit policy; no Provider network operations. */
export async function exerciseSubmissionInventoryPayment({
  journey,
  admin,
  runner,
  role,
  scope,
  stock,
  order,
  clock,
  amounts,
  selection,
  quoteVersion,
  positive = false,
  paymentWorkflow,
  authorize,
  sessionPayment,
  at,
}) {
  const id = (n) => "01909992-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const hash = (value) =>
    "sha256:" +
    createHash("sha256")
      .update(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))
      .digest("hex");
  await admin.query("GRANT USAGE ON SCHEMA rms_payment TO " + role);
  await admin.query("GRANT UPDATE(order_id) ON rms_ordering.order_header TO " + role);
  await admin.query("GRANT UPDATE(order_batch_id) ON rms_ordering.order_batch TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT ON rms_payment.payment_intent,rms_payment.payment_attempt,rms_payment.payment_intent_operation_record,rms_payment.payment_provider_observation TO " +
      role,
  );
  if (order.order.orderType === "DineIn") {
    await admin.query("GRANT USAGE ON SCHEMA rms_dining TO " + role);
    await admin.query("GRANT SELECT ON rms_dining.dining_checkout_commitment TO " + role);
    await admin.query(
      "GRANT SELECT,UPDATE ON rms_dining.dining_table,rms_dining.dining_session,rms_dining.dining_participant TO " +
        role,
    );
  } else {
    await admin.query("GRANT USAGE ON SCHEMA rms_fulfillment TO " + role);
    await admin.query(
      "GRANT SELECT ON rms_fulfillment.capacity_asap_commitment,rms_fulfillment.capacity_slot TO " +
        role,
    );
  }
  const inventoryRecord = await createPostgresSubmissionFinalValidationStore(runner, scope, {
    authorize,
    resolveCurrent: async () => {
      throw new Error("read-only final record source");
    },
  }).load({
    submissionReference: order.submissionReference,
    actorReference: order.guestSessionReference,
  });
  const preparation = buildCustomerPaymentPreparationSnapshot(
    {
      scope,
      owner: order.order.orderType === "DineIn" ? "Dining" : "AsapPickup",
      quoteVersion,
    },
    { preparationReference: id(2), order, capacity: clock, selection, inventory: inventoryRecord },
  );
  assert.deepEqual(preparation.total, amounts.total);
  const snapshotOptions = {
    scope,
    owner: order.order.orderType === "DineIn" ? "Dining" : "AsapPickup",
    quoteVersion,
  };
  const snapshotInput = {
    preparationReference: id(2),
    order,
    capacity: clock,
    selection,
    inventory: inventoryRecord,
  };
  for (const changed of [
    { ...snapshotInput, inventory: null },
    { ...snapshotInput, capacity: { ...clock, orderReference: id(99) } },
    { ...snapshotInput, selection: { ...selection, guestSessionReference: id(99) } },
  ])
    assert.throws(() => buildCustomerPaymentPreparationSnapshot(snapshotOptions, changed), {
      code: "CUSTOMER_PAYMENT_PREPARATION_UNAVAILABLE",
    });
  assert.equal(
    buildCustomerPaymentPreparationSnapshot(snapshotOptions, snapshotInput).sourceDigest,
    preparation.sourceDigest,
  );
  assert.notEqual(
    buildCustomerPaymentPreparationSnapshot(snapshotOptions, {
      ...snapshotInput,
      inventory: { ...inventoryRecord, validationReference: id(98) },
    }).sourceDigest,
    preparation.sourceDigest,
    "Inventory provenance must participate in preparation digest",
  );

  let record = parsePaymentIntentCreationRecord({
    intent: {
      paymentIntentReference: id(1),
      paymentOperationReference: clock.paymentOperationReference,
      intentDigest: hash({ order: order.order.orderReference, clock, amounts }),
      preparation,
      paymentMethod: "OnlineCard",
      captureMode: "Automatic",
      aggregateVersion: 1,
      creationStatus: "ProviderCreatePending",
      createdAt: at,
    },
    attempt: {
      paymentAttemptReference: id(3),
      paymentIntentReference: id(1),
      attemptNumber: 1,
      provider: "Stripe",
      providerEnvironment: "Test",
      providerIdempotencyDigest: hash(id(4)),
      createdAt: at,
    },
    providerOutcome: null,
  });
  const audit = {
    auditId: id(5),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode: "PAYMENT_INTENT_CREATE",
    targetType: "PaymentIntent",
    targetId: id(1),
    reasonCode: "AUTHORIZED_PAYMENT_INTENT_CREATE",
    occurredAt: at,
    correlationId: id(6),
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "SYNTHETIC_AUDIT",
    retentionPolicyVersion: 1,
  };
  let deny = true,
    failAudit = false,
    loseAck = false,
    checks = 0,
    lockObserved = false,
    expireLot = false,
    actionBinding = paymentWorkflow;
  const expiryReadsBeforePayment = stock.expiryReadCount();
  const admission = createCustomerOrderPaymentClaimAdmission({
    scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
    quoteVersion,
    capacityForOrder: (currentOrder) => {
      const action = createCustomerIntactReservationPaymentAction({
        scope,
        currentOrder,
        quoteVersion,
        workflow: actionBinding,
        authorize: async (tx, input) => !deny && (await authorize(tx, input)),
        authorizeOverride: async () => false,
      });
      const inventory = createCustomerInventoryPaymentClaimAdmission({
        scope,
        authorize,
        resolveExpiryCutoff: async (tx, input) => {
          const cutoff = await stock.resolveExpiryCutoff(tx, input);
          return expireLot ? input.observedAt : cutoff;
        },
        evaluate: async (tx, input) => {
          checks++;
          assert.equal(input.inventory.record.orderReference, currentOrder.order.orderReference);
          assert.equal(input.inventory.reservations.length, 1);
          assert.equal(
            input.inventory.reservations[0].reservation.binding.lotReference,
            stock.lotReference,
          );
          assert.equal(input.inventory.accounts[0].lotReference, stock.lotReference);
          assert.equal(input.inventory.accounts[0].expiryDate, stock.expiryDate);
          return action(tx, input);
        },
      });
      return createCustomerCapacityPaymentClaimAdmission({
        scope,
        owner: currentOrder.order.orderType === "DineIn" ? "Dining" : "AsapPickup",
        inventory,
      });
    },
  });
  const transactions = {
    async run(work) {
      let wrote = false;
      const result = await runner.run((tx) =>
        work({
          query: async (sql, values) => {
            if (sql.startsWith("SELECT clock_timestamp() >=") && stock.expiryCutoff !== null) {
              assert.equal(
                values[1],
                stock.expiryCutoff < record.intent.preparation.capacityExpiresAt
                  ? stock.expiryCutoff
                  : record.intent.preparation.capacityExpiresAt,
                "actual lot cutoff must reach Payment database clock gate",
              );
            }
            if (sql.startsWith("INSERT INTO rms_payment.payment_intent ")) {
              wrote = true;
              await admin.query("BEGIN");
              try {
                await assert.rejects(
                  admin.query(
                    "SELECT order_id FROM rms_ordering.order_header WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 FOR UPDATE NOWAIT",
                    [scope.brandReference, scope.storeReference, order.order.orderReference],
                  ),
                  { code: "55P03" },
                );
              } finally {
                await admin.query("ROLLBACK");
              }
              const capacityKey =
                order.order.orderType === "DineIn"
                  ? "DiningCheckout:" +
                    scope.tenantReference +
                    ":" +
                    scope.brandReference +
                    ":" +
                    scope.storeReference +
                    ":" +
                    clock.commitmentReference
                  : "FulfillmentAsap:" +
                    scope.brandReference +
                    ":" +
                    scope.storeReference +
                    ":" +
                    order.submissionReference;
              await admin.query("BEGIN");
              try {
                const capacityLock = await admin.query(
                  "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
                  [capacityKey],
                );
                assert.equal(
                  capacityLock.rows[0].acquired,
                  false,
                  "capacity append must remain fenced at Payment INSERT",
                );
              } finally {
                await admin.query("ROLLBACK");
              }

              await admin.query("BEGIN");
              try {
                await assert.rejects(
                  admin.query(
                    "SELECT item_id FROM rms_inventory.inventory_item WHERE tenant_id=$1 AND brand_id=$2 AND item_id=$3 FOR UPDATE NOWAIT",
                    [scope.tenantReference, scope.brandReference, stock.itemReference],
                  ),
                  { code: "55P03" },
                );
                lockObserved = true;
              } finally {
                await admin.query("ROLLBACK");
              }
            }
            if (wrote && failAudit && sql.startsWith("INSERT INTO platform_audit.audit_record"))
              throw new Error("synthetic Payment Audit failure");
            return tx.query(sql, values);
          },
        }),
      );
      if (wrote && loseAck) {
        loseAck = false;
        throw new Error("synthetic lost Payment commit acknowledgement");
      }
      return result;
    },
  };
  const store = createPostgresAdmittedPaymentIntentCreationStore(
    transactions,
    {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
    },
    { now: () => new Date().toISOString(), generateObservationReference: () => id(7) },
    admission,
  );
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_payment.payment_intent) AS intents," +
          "(SELECT count(*)::int FROM rms_payment.payment_attempt) AS attempts," +
          "(SELECT count(*)::int FROM rms_payment.payment_intent_operation_record) AS operations," +
          "(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='PAYMENT_INTENT_CREATE') AS audits",
      )
    ).rows[0];
  const input = { record, audit };
  await runner.run(async (tx) => {
    const wrongOrder = {
      ...record,
      intent: {
        ...record.intent,
        preparation: {
          ...record.intent.preparation,
          orderReference: id(97),
        },
      },
    };
    assert.equal(await admission.admit(tx, wrongOrder, new Date().toISOString()), false);
    assert.equal(checks, 0, "wrong Order binding must deny before Inventory policy");
  });
  if (stock.expiryDate !== null) {
    expireLot = true;
    await assert.rejects(store.claim(input), { code: "PAYMENT_INTENT_PERMISSION_DENIED" });
    assert.deepEqual(await counts(), { intents: 0, attempts: 0, operations: 0, audits: 0 });
    assert.equal(checks, 0, "expired lot must deny before timing policy evaluation");
    expireLot = false;
  }
  // Explicit fixture bindings must match the actual published action; unknown bindings deny.
  deny = false;
  for (const override of [
    { permissionCode: "synthetic.other" },
    { intactReservationRuleReference: id(96) },
    { paymentCommandCode: "UnsupportedPaymentCommand" },
    { action: "UnavailableAction" },
  ]) {
    actionBinding = { ...paymentWorkflow, ...override };
    await assert.rejects(store.claim(input), { code: "PAYMENT_INTENT_PERMISSION_DENIED" });
    assert.deepEqual(await counts(), { intents: 0, attempts: 0, operations: 0, audits: 0 });
  }
  actionBinding = paymentWorkflow;
  deny = true;
  const checksBeforeMainClaims = checks;
  await assert.rejects(store.claim(input), { code: "PAYMENT_INTENT_PERMISSION_DENIED" });
  assert.deepEqual(await counts(), { intents: 0, attempts: 0, operations: 0, audits: 0 });
  deny = false;
  failAudit = true;
  await assert.rejects(store.claim(input), { code: "PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE" });
  failAudit = false;
  assert.equal(lockObserved, true);
  assert.deepEqual(await counts(), { intents: 0, attempts: 0, operations: 0, audits: 0 });
  let providerCalls = 0;
  const providerForbidden = async () => {
    providerCalls++;
    throw new Error("lost local acknowledgement must not call Provider");
  };
  const paymentCommand = {
    paymentOperationReference: clock.paymentOperationReference,
    submissionReference: order.submissionReference,
    cartReference: preparation.sourceCartReference,
    expectedCartVersion: preparation.sourceCartVersion,
    quoteReference: preparation.quoteReference,
    tipSelectionReference: selection.selectionReference,
    requestedAt: clock.paymentRequestedAt,
  };
  const paymentPorts = {
    providerEnvironment: "Test",
    clock: { now: () => new Date().toISOString() },
    authorization: {
      authorize: async (request) => {
        const permitted = await runner.run((tx) =>
          authorize(tx, {
            actorReference: order.guestSessionReference,
            submissionReference: request.submissionReference,
          }),
        );
        return permitted
          ? {
              action: "CreatePaymentIntent",
              guestSessionReference: order.guestSessionReference,
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
            }
          : null;
      },
    },
    // Explicit synthetic kill-switch policy; actual current owner admission is below.
    killSwitch: {
      evaluate: async (request) => {
        const evaluation = killSwitchEvaluation({ evaluatedAt: request.evaluatedAt });
        return Object.freeze({
          ...evaluation,
          effectiveControl: Object.freeze({
            ...evaluation.effectiveControl,
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
      generate: (purpose) => (purpose === "PaymentIntent" ? id(1) : id(3)),
      hash: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
      equals: (left, right) => left === right,
      providerIdempotencyKey: () => id(4),
    },
    repository: {
      ...store,
      claim: async (value) => {
        record = value.record;
        return store.claim(value);
      },
    },
    provider: {
      createIntent: providerForbidden,
      retrieveIntent: providerForbidden,
      confirmIntent: providerForbidden,
      cancelIntent: providerForbidden,
      captureIntent: providerForbidden,
      refundPayment: providerForbidden,
    },
  };
  const additionalFor = (key, reference) => {
    const additional = journey?.additionalPayment;
    return additional && String(additional.session[key]) === String(reference) ? additional : null;
  };
  const paymentHistory = {
    resolveOperation: (reference) =>
      (additionalFor("paymentOperationReference", reference)?.history ?? store).resolveOperation(
        reference,
      ),
  };
  let preparationSequence = 0;
  let submissionResolutionCount = 0;
  const sessionIntentOptions = sessionPayment
    ? {
        access: sessionPayment.access,
        tenantReference: scope.tenantReference,
        resolveSubmission: async (session) => {
          const additional = additionalFor("submissionReference", session.submissionReference);
          if (additional) {
            assert.deepEqual(session, additional.session);
            additional.resolutions++;
            return { kind: "Additional", orders: additional.orders, tips: additional.tips };
          }
          submissionResolutionCount++;
          assert.equal(session.submissionReference, order.submissionReference);
          assert.equal(session.validation.brandReference, scope.brandReference);
          assert.equal(session.validation.storeReference, scope.storeReference);
          assert.equal(session.validation.orderType, order.order.orderType);
          return { kind: "Initial", orders: sessionPayment.orders, tips: sessionPayment.tips };
        },
        orders: sessionPayment.orders,
        tips: sessionPayment.tips,
        inventory: {
          load: (input) => {
            const additional = additionalFor("submissionReference", input.submissionReference);
            if (additional) return additional.inventory.load(input);
            return createPostgresSubmissionFinalValidationStore(runner, scope, {
              authorize,
              resolveCurrent: async () => {
                throw new Error("read-only payment inventory source");
              },
            }).load(input);
          },
        },
        nextPreparationReference: () => id(2 + preparationSequence++ * 10000),
        history: paymentHistory,
        payment: (context) => {
          const additional = additionalFor(
            "submissionReference",
            context.session.submissionReference,
          );
          if (additional) {
            assert.deepEqual(context.session, additional.session);
            return additional.payment(context);
          }
          assert.equal(context.session.submissionReference, order.submissionReference);
          return paymentPorts;
        },
      }
    : null;
  const paymentService = sessionIntentOptions
    ? createCustomerSessionPaymentIntent(sessionIntentOptions)
    : createPaymentIntentCreationService(paymentPorts);
  let paymentRuntime;
  let clientHandoffProvider, paymentTerminal;
  try {
    const serviceInput = sessionPayment ? sessionPayment.input : paymentCommand;
    loseAck = true;
    let expiryReadsBeforeRecovery;
    if (sessionPayment) {
      const origin = journey?.origin ?? "https://pilot.example";
      const entry = entryFixture().options;
      const access = sessionPayment.access;
      const runtimeOptions = {
        scope: access.scope,
        entry: {
          ...entry,
          session: {
            ...entry.session,
            credentials: access.credentials,
            binding: {
              validate: (input) =>
                access.transactions.run((tx) => access.binding(tx).validate(input)),
            },
          },
        },
        sessionTransactions: access.transactions,
        cartTransactions: access.transactions,
        menuTransactions: {
          run: async () => {
            throw new Error("unused menu route");
          },
        },
        menuStores: { resolvePublic: async () => null },
        allowedOrigin: origin,
        now: access.now,
        uuidV7Factory: () => {
          throw new Error("unused menu reference");
        },
        receipt: { ...access, transactions: runner },
        orderStatus: {
          ...access,
          transactions: runner,
          paymentScope: {
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            providerAccountReference: id(90),
            environment: "Test",
          },
        },
        payment: {
          access,
          history: paymentHistory,
          intent: sessionIntentOptions,
          handoff: {
            transactions: runner,
            currentAdmission: (session) =>
              additionalFor("submissionReference", session.submissionReference)?.currentAdmission ??
              admission,
            allowConfirmation: async () => true, // Existing explicit synthetic policy.
            provider: {
              retrieve: (...args) => {
                const additional = journey?.additionalPayment;
                if (
                  additional &&
                  args[0]?.context?.paymentAttemptReference === additional.paymentAttemptReference
                )
                  return additional.handoffProvider.retrieve(...args);
                if (!clientHandoffProvider) throw new Error("handoff fixture not initialized");
                return clientHandoffProvider.retrieve(...args);
              },
            },
          },
          result: {
            terminal: {
              read: (...args) => {
                if (!paymentTerminal) throw new Error("terminal fixture not initialized");
                return paymentTerminal.read(...args);
              },
            },
          },
        },
        runtime: { logger: createApiRuntimeLogger({ write: () => undefined }) },
      };
      if (journey) {
        assert.ok(journey.runtime?.server.listening);
        journey.attachPayment(runtimeOptions);
        paymentRuntime = journey.runtime;
      } else {
        paymentRuntime = createLocalCustomerRuntime(runtimeOptions);
        await paymentRuntime.listen();
      }
      const server = paymentRuntime.server;
      {
        const url = `http://127.0.0.1:${server.address().port}/api/v1/checkout-sessions/${serviceInput.checkoutSessionReference}/payment-intents`;
        const request = () =>
          globalThis.fetch(url, {
            method: "POST",
            headers: {
              origin,
              "sec-fetch-site": "same-origin",
              "content-type": "application/json",
              cookie: `__Host-bop-guest=${serviceInput.sessionCredential}`,
              "x-csrf-token": serviceInput.csrfCredential,
              "idempotency-key": serviceInput.selectionReference,
            },
            body: JSON.stringify({
              tip: {
                amountMinor: serviceInput.tip.amountMinor.toString(),
                currency: serviceInput.tip.currencyCode,
              },
            }),
          });
        if (journey) journey.replayInitialPayment = request;
        const lost = await request();
        assert.equal(lost.status, 503);
        assert.equal((await lost.json()).error.code, "payment_service_unavailable");
        assert.equal(providerCalls, 0);
        deny = true;
        expiryReadsBeforeRecovery = stock.expiryReadCount();
        const submissionResolutionsBeforeReplay = submissionResolutionCount;
        const replay = await request();
        assert.equal(replay.status, 202, JSON.stringify(journey?.paymentCalls));
        assert.equal(submissionResolutionsBeforeReplay, 1);
        assert.equal(submissionResolutionCount, submissionResolutionsBeforeReplay);
        assert.equal(replay.headers.get("cache-control"), "no-store");
        const body = await replay.json();
        assert.equal(body.payment.creationStatus, "Processing");
        assert.equal(body.payment.checkoutSessionReference, serviceInput.checkoutSessionReference);
        assert.equal(body.payment.paymentIntentReference, record.intent.paymentIntentReference);
        assert.deepEqual(Object.keys(body.payment).sort(), [
          "checkoutSessionReference",
          "creationStatus",
          "orderReference",
          "paymentIntentReference",
          "total",
        ]);
      }
    } else {
      await assert.rejects(paymentService.create(serviceInput), {
        code: "PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE",
      });
      deny = true;
      expiryReadsBeforeRecovery = stock.expiryReadCount();
    }
    assert.equal(providerCalls, 0);
    const serviceRecovered = await paymentService.create(serviceInput);
    assert.equal(serviceRecovered.status, "Processing");
    assert.deepEqual(serviceRecovered.record, record);
    assert.equal(providerCalls, 0);
    const recovered = await store.claim({ record, audit });
    assert.equal(
      stock.expiryReadCount(),
      expiryReadsBeforeRecovery,
      "original Payment recovery must not re-resolve expiry",
    );
    if (stock.expiryDate !== null) assert(expiryReadsBeforeRecovery > expiryReadsBeforePayment);
    else assert.equal(expiryReadsBeforeRecovery, 0);
    assert.equal(recovered.status, "Existing");
    assert.deepEqual(recovered.record, record);
    assert.equal(
      checks,
      checksBeforeMainClaims + 3,
      "existing Payment recovery must not repeat Inventory admission",
    );
    assert.deepEqual(await counts(), { intents: 1, attempts: 1, operations: 1, audits: 1 });
    if (sessionPayment) {
      deny = false;
      const providerReference = "pi_SYNTHETICHANDOFF0001";
      const stripePayload = {
        object: "payment_intent",
        id: providerReference,
        currency: "cad",
        livemode: false,
        capture_method: "automatic",
        payment_method_types: ["card"],
        amount: Number(record.intent.preparation.total.amountMinor),
        amount_received: 0,
        amount_capturable: 0,
        status: "requires_payment_method",
        latest_charge: null,
        client_secret: providerReference + "_secret_SYNTHETICONLY",
      };
      const retrieve = {
        operation: "RetrieveIntent",
        purpose: "RetrievePaymentIntent",
        context: {
          provider: "Stripe",
          environment: "Test",
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          paymentAttemptReference: record.attempt.paymentAttemptReference,
          operationReference: record.intent.paymentOperationReference,
        },
        providerIntentReference: providerReference,
      };
      const observation = normalizeStripeOnlineIntentResponse(
        retrieve,
        stripePayload,
        new Date().toISOString(),
      );
      const observed = await store.recordObservation({
        record: parsePaymentIntentCreationRecord({ ...record, providerOutcome: observation }),
      });
      let handoffReads = 0;
      const provider = createStripeOnlineClientHandoff({
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        environment: "Test",
        apiVersion: "2024-06-20",
        secretKey: "sk_test_SYNTHETICONLY",
        connectedAccount: null,
        now: () => new Date().toISOString(),
        fetch: async () => {
          handoffReads++;
          return globalThis.Response.json(stripePayload);
        },
      });
      clientHandoffProvider = provider;
      const input = {
        sessionCredential: sessionPayment.input.sessionCredential,
        csrfCredential: sessionPayment.input.csrfCredential,
        checkoutSessionReference: sessionPayment.input.checkoutSessionReference,
      };
      await admin.query("GRANT SELECT ON rms_payment.provider_webhook_record TO " + role);
      await admin.query("GRANT SELECT,INSERT ON rms_payment.payment_terminal_fact TO " + role);
      const terminalScope = {
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        providerAccountReference: id(90),
        environment: "Test",
      };
      const terminal = createPostgresPaymentTerminalStore(runner, terminalScope);
      paymentTerminal = terminal;
      const handoffServer = paymentRuntime.server;
      {
        const url = `http://127.0.0.1:${handoffServer.address().port}/api/v1/checkout-sessions/${input.checkoutSessionReference}/payment-handoff`;
        const requestHandoff = () =>
          globalThis.fetch(url, {
            method: "POST",
            headers: {
              origin: journey?.origin ?? "https://pilot.example",
              "sec-fetch-site": "same-origin",
              "content-type": "application/json",
              cookie: `__Host-bop-guest=${input.sessionCredential}`,
              "x-csrf-token": input.csrfCredential,
            },
            body: "{}",
          });
        const response = await requestHandoff();
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("referrer-policy"), "no-referrer");
        assert.deepEqual(await response.json(), {
          schemaVersion: 1,
          clientSecret: stripePayload.client_secret,
        });
        assert.equal(handoffReads, 1);
        assert.deepEqual(
          await store.resolveOperation(record.intent.paymentOperationReference),
          observed,
        );
        assert.equal(Object.hasOwn(observed, "clientSecret"), false);
        deny = true;
        const deniedResponse = await requestHandoff();
        assert.equal(deniedResponse.status, 422);
        assert.equal((await deniedResponse.json()).error.code, "payment_handoff_not_ready");
        assert.equal(
          handoffReads,
          1,
          "denied current inventory/workflow must not fetch a credential",
        );
        const resultUrl = url.replace("/payment-handoff", "/payment-result");
        const requestResult = (csrf = input.csrfCredential) =>
          globalThis.fetch(resultUrl, {
            headers: {
              "sec-fetch-site": "same-origin",
              cookie: `__Host-bop-guest=${input.sessionCredential}`,
              "x-csrf-token": csrf,
            },
          });
        const pending = await requestResult();
        assert.equal(pending.status, 200);
        assert.equal((await pending.json()).payment.status, "Pending");
        const captured = normalizeStripeOnlineIntentResponse(
          retrieve,
          {
            ...stripePayload,
            status: "succeeded",
            amount_received: stripePayload.amount,
            latest_charge: {
              object: "charge",
              id: "ch_SYNTHETICRESULT0001",
              payment_intent: providerReference,
              currency: "cad",
              livemode: false,
              amount: stripePayload.amount,
              amount_captured: stripePayload.amount,
              amount_refunded: 0,
              paid: true,
              captured: true,
              status: "succeeded",
              payment_method_details: { type: "card" },
            },
          },
          new Date().toISOString(),
        );
        const observations = createPostgresPaymentProviderObservationStore(
          runner,
          {
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
          },
          { now: () => new Date().toISOString() },
        );
        const retrieval = {
          observationReference: id(8),
          paymentIntentReference: recovered.record.intent.paymentIntentReference,
          snapshot: {
            ...captured,
            context: { ...captured.context, operationReference: id(91) },
          },
        };
        await assert.rejects(
          observations.record({ ...retrieval, paymentIntentReference: id(999) }),
          {
            code: "PAYMENT_INTENT_PROVIDER_RESULT_INVALID",
          },
        );
        const appended = await observations.record(retrieval);
        assert.equal(appended.status, "Recorded");
        assert.equal((await observations.record(retrieval)).status, "AlreadyRecorded");
        await assert.rejects(
          observations.append({ observationReference: id(8), snapshot: observation }),
          { code: "PAYMENT_INTENT_IDEMPOTENCY_CONFLICT" },
        );
        assert.equal(
          (await (await requestResult()).json()).payment.status,
          "Pending",
          "normalized capture alone is not the committed terminal result",
        );
        let sequence = 1000;
        const terminalService = createPaymentTerminalService({
          source: createPostgresPaymentTerminalSource(runner, terminalScope),
          repository: terminal,
          clock: { now: () => new Date().toISOString() },
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
        const terminalInput = {
          observationReference: id(8),
          causationReference: id(91),
          webhookReceiptReference: null,
          providerEventReference: null,
          providerAccountReference: id(90),
          providerIntentReference: providerReference,
          environment: "Test",
          paymentIntentReference: record.intent.paymentIntentReference,
          paymentAttemptReference: record.attempt.paymentAttemptReference,
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
        const checkedAt = new Date().toISOString();
        const reconciliation = createPaymentReconciliationService({
          authorization: { authorize: async () => true },
          lease: { claim: async () => true, release: async () => undefined },
          repository: {
            loadRun: async () => null,
            commit: async (result) => ({ status: "Created", result }),
          },
          candidates: {
            claimOperational: async () => [
              {
                candidateReference: id(92),
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                paymentIntentReference: record.intent.paymentIntentReference,
                paymentAttemptReference: record.attempt.paymentAttemptReference,
                orderReference: preparation.orderReference,
                providerAccountReference: id(90),
                providerIntentReference: providerReference,
                environment: "Test",
                paymentMethod: "OnlineCard",
                captureMode: "Automatic",
                internalStatus: "Pending",
                requestedAmount: captured.requestedAmount,
                capturedAmount: { ...captured.capturedAmount, amountMinor: 0n },
                refundedAmount: captured.refundedAmount,
                lastObservedAt: observation.observedAt,
                dueAt: checkedAt,
              },
            ],
            claimDailySettlement: async () => [],
          },
          provider: {
            retrieveIntent: async (request) => {
              assert.equal(request.context.operationReference, id(91));
              return retrieval.snapshot;
            },
          },
          observations,
          terminal: {
            // The Provider's authoritative capture occurrence (as the pilot simulator reports it),
            // not the time this reconciliation query observed it.
            occurrence: async ({ candidate, snapshot }) => {
              assert.equal(candidate.providerIntentReference, providerReference);
              assert.equal(snapshot.status, "Captured");
              return { status: "Captured", occurredAt: captured.observedAt };
            },
            record: async (input) => {
              const committed = await terminalService.record(input);
              assert.equal(committed.status, "Created");
              return {
                status: committed.status,
                paymentTransactionReference: committed.fact.paymentTransactionReference,
              };
            },
          },
          references: {
            generate: (purpose) => (purpose === "Observation" ? id(8) : id(93)),
            exceptionFor: () => id(94),
          },
          clock: { now: () => new Date().toISOString() },
        });
        const reconciled = await reconciliation.run({
          runReference: id(91),
          mode: "Operational",
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          actorReference: null,
          purpose: "ReconcilePayments",
          scheduledAt: checkedAt,
          cutoffAt: checkedAt,
          maxCandidates: 1,
        });
        assert.equal(reconciled.result.counts.Healed, 1);
        assert.equal((await terminalService.record(terminalInput)).status, "AlreadyCommitted");
        let capturedSourceAllowed = true;
        const capturedSource = createOrderCapturedPaymentSource({
          scope: terminalScope,
          now: () => new Date().toISOString(),
          authorize: async (_, event) =>
            capturedSourceAllowed && event.payload.orderReference === preparation.orderReference,
        });
        const terminalFact = await terminal.read(record.intent.paymentIntentReference);
        assert(terminalFact);
        if (order.order.orderType === "Pickup") {
          await admin.query(
            "GRANT SELECT ON rms_payment.ordinary_refund_request,rms_payment.ordinary_refund_operation,rms_payment.ordinary_refund_dispatch,rms_payment.ordinary_refund_observation,rms_payment.payment_compensation_action_history,rms_payment.payment_compensation_refund TO " +
              role,
          );
          let coverageAllowed = true;
          const coverage = createPostgresPaymentReceiptCoverageSource({
            scope: { ...terminalScope, tenantReference: scope.tenantReference },
            authorize: async (_tx, request) =>
              coverageAllowed && request.orderReference === preparation.orderReference,
          });
          const coverageInput = () => ({
            orderReference: preparation.orderReference,
            observedAt: new Date().toISOString(),
            freshAfter: captured.observedAt,
            expectedBatches: [
              {
                orderBatchReference: preparation.orderBatchReference,
                orderAllocationMinor: preparation.orderAllocation.amountMinor,
              },
            ],
          });
          const resolved = await runner.run((tx) => coverage.resolve(tx, coverageInput()));
          assert.equal(resolved.captured.amountMinor, preparation.total.amountMinor);
          assert.equal(resolved.tip.amountMinor, preparation.tip.amountMinor);
          assert.equal(resolved.refunded.amountMinor, 0n);
          assert.equal(
            resolved.batches[0].paymentTransactionReference,
            terminalFact.paymentTransactionReference,
          );
          assert.equal(Object.hasOwn(resolved, "paymentStatus"), false);
          coverageAllowed = false;
          await assert.rejects(
            runner.run((tx) => coverage.resolve(tx, coverageInput())),
            { code: "PAYMENT_RECEIPT_COVERAGE_PERMISSION_DENIED" },
          );
          coverageAllowed = true;
          const mismatch = coverageInput();
          mismatch.expectedBatches[0].orderAllocationMinor += 1n;
          await assert.rejects(
            runner.run((tx) => coverage.resolve(tx, mismatch)),
            { code: "PAYMENT_RECEIPT_COVERAGE_UNAVAILABLE" },
          );
          const incomplete = coverageInput();
          incomplete.expectedBatches.push({
            orderBatchReference: id(799),
            orderAllocationMinor: 1n,
          });
          await assert.rejects(
            runner.run((tx) => coverage.resolve(tx, incomplete)),
            { code: "PAYMENT_RECEIPT_COVERAGE_UNAVAILABLE" },
          );
          const stale = coverageInput();
          stale.freshAfter = new Date(Date.parse(captured.observedAt) + 1).toISOString();
          await assert.rejects(
            runner.run((tx) => coverage.resolve(tx, stale)),
            { code: "PAYMENT_RECEIPT_COVERAGE_UNAVAILABLE" },
          );
          await runner.run(async (tx) => {
            await coverage.resolve(tx, coverageInput());
            await tx.query("SAVEPOINT receipt_refund_observation", []);
            try {
              const refundAt = new Date().toISOString();
              const writer = createPostgresPaymentProviderObservationStore(
                { run: async (work) => work(tx) },
                { brandReference: scope.brandReference, storeReference: scope.storeReference },
                { now: () => new Date().toISOString() },
              );
              const refundSnapshot = {
                ...captured,
                context: {
                  ...captured.context,
                  operationReference: record.intent.paymentOperationReference,
                },
                observedAt: refundAt,
                refundedAmount: { amountMinor: 1n, currencyCode: "CAD" },
              };
              await writer.append({ observationReference: id(780), snapshot: refundSnapshot });
              // A cumulative Provider total without an owning ordinary/compensation
              // refund fact is not enough to issue a trusted refunded receipt.
              await assert.rejects(
                coverage.resolve(tx, {
                  ...coverageInput(),
                  freshAfter: refundAt,
                }),
                { code: "PAYMENT_RECEIPT_COVERAGE_UNAVAILABLE" },
              );
              await writer.append({
                observationReference: id(781),
                snapshot: {
                  ...refundSnapshot,
                  refundedAmount: { amountMinor: 2n, currencyCode: "CAD" },
                },
              });
              await assert.rejects(coverage.resolve(tx, coverageInput()), {
                code: "PAYMENT_RECEIPT_COVERAGE_UNAVAILABLE",
              });
              // A newer zero-refund observation cannot erase already observed refunded money.
              const regressionAt = new Date(Date.parse(refundAt) + 1).toISOString();
              const regressionWriter = createPostgresPaymentProviderObservationStore(
                { run: async (work) => work(tx) },
                { brandReference: scope.brandReference, storeReference: scope.storeReference },
                { now: () => regressionAt },
              );
              await regressionWriter.append({
                observationReference: id(782),
                snapshot: {
                  ...refundSnapshot,
                  observedAt: regressionAt,
                  refundedAmount: { amountMinor: 0n, currencyCode: "CAD" },
                },
              });
              await assert.rejects(
                coverage.resolve(tx, { ...coverageInput(), observedAt: regressionAt }),
                {
                  code: "PAYMENT_RECEIPT_COVERAGE_UNAVAILABLE",
                },
              );
            } finally {
              await tx.query("ROLLBACK TO SAVEPOINT receipt_refund_observation", []);
              await tx.query("RELEASE SAVEPOINT receipt_refund_observation", []);
            }
          });
          assert.equal(
            (await runner.run((tx) => coverage.resolve(tx, coverageInput()))).refunded.amountMinor,
            0n,
          );
        }
        await admin.query(
          "GRANT SELECT,INSERT ON rms_payment.payment_status_projection TO " + role,
        );
        let statusAllowed = true;
        const statusStore = createPostgresPaymentStatusStore({
          scope: terminalScope,
          authorize: async () => statusAllowed,
        });
        const statusProjection = buildPaymentStatusProjection({
          event: terminalFact.event,
          generationReference: id(++sequence),
          projectedAt: new Date().toISOString(),
        });
        const loadStatus = () =>
          runner.run((transaction) =>
            statusStore.load({
              transaction,
              paymentIntentReference: terminalFact.paymentIntentReference,
            }),
          );
        assert.equal(await loadStatus(), null);
        let statusFailureReached = false;
        await runner.run(async (tx) => {
          await assert.rejects(
            statusStore.write({
              transaction: {
                query: (sql, values) => {
                  if (sql.startsWith("INSERT INTO rms_payment.payment_status_projection")) {
                    statusFailureReached = true;
                    throw new Error("synthetic status insert failure");
                  }
                  return tx.query(sql, values);
                },
              },
              projection: statusProjection,
            }),
            { code: "PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE" },
          );
        });
        assert.equal(statusFailureReached, true);
        assert.equal(await loadStatus(), null);
        await admin.query(
          "GRANT SELECT,INSERT,UPDATE ON platform_eventing.consumer_inbox TO " + role,
        );
        let statusReferencesAllowed = true;
        const statusConsumer = createPaymentStatusEventConsumerService({
          scope: terminalScope,
          authorization: {
            authorize: async (_tx, event) =>
              statusAllowed && event.aggregateId === terminalFact.paymentIntentReference,
          },
          projections: statusStore,
          references: {
            generateGeneration: () => {
              assert.equal(statusReferencesAllowed, true);
              return statusProjection.generationReference;
            },
            now: () => {
              assert.equal(statusReferencesAllowed, true);
              return statusProjection.projectedAt;
            },
          },
          sha256: (value) => createHash("sha256").update(value).digest("hex"),
        });
        let inboxFailureReached = false;
        await runner.run(async (tx) => {
          await assert.rejects(
            statusConsumer.consume(
              {
                query: (sql, values) => {
                  if (sql.startsWith("UPDATE platform_eventing.consumer_inbox")) {
                    inboxFailureReached = true;
                    throw new Error("synthetic Inbox completion failure");
                  }
                  return tx.query(sql, values);
                },
              },
              terminalFact.event,
            ),
          );
        });
        assert.equal(inboxFailureReached, true);
        assert.equal(await loadStatus(), null);
        const statusInboxCount = async () =>
          (
            await admin.query(
              "SELECT count(*)::int AS count FROM platform_eventing.consumer_inbox WHERE brand_id=$1 AND store_id=$2 AND event_id=$3 AND consumer_name='payment.status-projection:v1'",
              [scope.brandReference, scope.storeReference, terminalFact.event.eventId],
            )
          ).rows[0].count;
        assert.equal(await statusInboxCount(), 0);
        const statuses = await Promise.all(
          [0, 1].map(() =>
            runner.run((transaction) => statusConsumer.consume(transaction, terminalFact.event)),
          ),
        );
        assert.deepEqual(statuses.map((value) => value.status).sort(), [
          "duplicate_completed",
          "processed",
        ]);
        statusReferencesAllowed = false;
        assert.equal(
          (
            await runner.run((transaction) =>
              statusConsumer.consume(transaction, terminalFact.event),
            )
          ).status,
          "duplicate_completed",
        );
        assert.equal(await statusInboxCount(), 1);
        assert.deepEqual(await loadStatus(), statusProjection);
        await assert.rejects(
          runner.run((transaction) =>
            statusStore.write({
              transaction,
              projection: {
                ...statusProjection,
                snapshot: {
                  ...statusProjection.snapshot,
                  amount: { amountMinor: 1n, currencyCode: "CAD" },
                },
              },
            }),
          ),
          { code: "PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE" },
        );
        statusAllowed = false;
        await assert.rejects(
          runner.run((transaction) => statusConsumer.consume(transaction, terminalFact.event)),
          { code: "PAYMENT_STATUS_PERMISSION_DENIED" },
        );
        await assert.rejects(loadStatus(), { code: "PAYMENT_STATUS_PERMISSION_DENIED" });
        await assert.rejects(
          runner.run((transaction) =>
            statusStore.write({
              transaction,
              projection: statusProjection,
            }),
          ),
          { code: "PAYMENT_STATUS_PERMISSION_DENIED" },
        );
        statusAllowed = true;

        const capturedPayment = await runner.run((tx) =>
          capturedSource.resolve(tx, terminalFact.event),
        );
        assert.equal(
          capturedPayment.payment.intent.paymentIntentReference,
          record.intent.paymentIntentReference,
        );
        assert.equal(
          capturedPayment.payment.intent.preparation.total.amountMinor,
          preparation.total.amountMinor,
        );
        assert.deepEqual(capturedPayment.terminal, terminalFact);
        await assert.rejects(
          runner.run((tx) =>
            capturedSource.resolve(tx, {
              ...terminalFact.event,
              eventId: id(95),
            }),
          ),
          { code: "ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE" },
        );
        await assert.rejects(
          runner.run((tx) =>
            capturedSource.resolve(tx, {
              ...terminalFact.event,
              payload: { ...terminalFact.event.payload, amountMinor: "1" },
            }),
          ),
          { code: "ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE" },
        );
        await admin.query(
          "GRANT SELECT ON rms_ordering.order_acceptance_record,rms_ordering.order_termination_record,rms_ordering.order_fulfillment_completion_record TO " +
            role,
        );
        let paidOrderReadAllowed = true;
        let paidInventoryReadAllowed = true;
        const paidContextSource = createOrderPaidContextSource({
          scope: terminalScope,
          tenantReference: scope.tenantReference,
          authorizeInventory: async (_, current) =>
            paidInventoryReadAllowed &&
            current.submissionReference === preparation.submissionReference &&
            current.actorReference === preparation.guestSessionReference,
          quoteVersion,
          now: () => new Date().toISOString(),
          authorize: async () => capturedSourceAllowed,
          authorizeOrder: async (_, currentScope) =>
            paidOrderReadAllowed &&
            currentScope.orderReference === preparation.orderReference &&
            currentScope.orderBatchReference === preparation.orderBatchReference,
        });
        const paidContext = await runner.run((tx) =>
          paidContextSource.resolve(tx, terminalFact.event),
        );
        assert.equal(paidContext.order.order.orderReference, preparation.orderReference);
        assert.equal(paidContext.order.submissionReference, preparation.submissionReference);
        assert.equal(paidContext.order.items.length, order.items.length);
        assert.equal(paidContext.acceptance, null);
        assert.equal(paidContext.initialExecution.phase, "Submitted");
        assert.equal(paidContext.initialExecution.checkpoint, order.submissionReference);
        assert.equal(
          paidContext.capacity.owner,
          order.order.orderType === "DineIn" ? "Dining" : "AsapPickup",
        );
        assert.equal(
          paidContext.capacity.commitment.orderBatchReference,
          preparation.orderBatchReference,
        );
        assert.equal(
          paidContext.capacity.commitment.paymentOperationReference,
          record.intent.paymentOperationReference,
        );

        assert.equal(paidContext.terminal.event.eventId, terminalFact.event.eventId);
        assert.equal(
          paidContext.inventory.record.submissionReference,
          preparation.submissionReference,
        );
        assert.equal(paidContext.inventory.items.length, inventoryRecord.items.length);
        assert.equal(
          paidContext.inventory.reservations.length,
          inventoryRecord.reservationSet?.entries.length ?? 0,
        );
        const waitingSource = createOrderPaidOutcomeSource({
          context: paidContextSource,
          quoteVersion,
          release: {
            action: "SYNTHETIC_UNUSED",
            purposeCode: "SYNTHETIC_UNUSED",
            permissionCode: "SYNTHETIC_UNUSED",
            nextState: "Accepted",
          },
          generateConfirmationReference: () => {
            throw new Error("waiting cannot generate a confirmation");
          },
          resolveWorkflow: async () => {
            throw new Error("waiting cannot evaluate an accepted-order release");
          },
          generateDispositionReference: () => id(96),
          sha256: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
        });
        const waiting = await runner.run((transaction) =>
          waitingSource.loadExact({
            transaction,
            paymentEvent: terminalFact.event,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            orderReference: preparation.orderReference,
            paymentTransactionReference: terminalFact.paymentTransactionReference,
            paymentIntentReference: record.intent.paymentIntentReference,
            paymentAttemptReference: record.attempt.paymentAttemptReference,
            paymentEventReference: terminalFact.event.eventId,
          }),
        );
        assert.equal(waiting.disposition, "AwaitingAcceptance");
        assert.equal(waiting.sourceCheckpoint, order.submissionReference);
        assert.equal(waiting.orderBatchReference, preparation.orderBatchReference);
        await admin.query(
          "GRANT SELECT,INSERT,UPDATE ON platform_eventing.consumer_inbox TO " + role,
        );
        await admin.query(
          "GRANT SELECT ON rms_ordering.order_payment_failure_record,rms_ordering.order_payment_disposition_record TO " +
            role,
        );
        const canonicalDigest = (value) =>
          "sha256:" + createHash("sha256").update(value).digest("hex");
        const waitingConsumer = createOrderPaymentOutcomeConsumerService({
          authorization: { authorize: async () => true }, // Synthetic System capability.
          source: waitingSource,
          outcomes: createPostgresOrderPaymentOutcomeStore({
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            sha256: canonicalDigest,
            audit: async () => {
              throw new Error("waiting must not request outcome Audit");
            },
          }),
          references: { generate: () => id(97) },
          digests: { sha256: canonicalDigest },
        });
        for (let attempt = 0; attempt < 2; attempt++) {
          await assert.rejects(
            runner.run((tx) => waitingConsumer.consume(tx, terminalFact.event)),
            {
              name: "ConsumerTransactionRollback",
              outcome: { status: "retry_required", errorCode: "CONSUMER_TEMPORARY_FAILURE" },
            },
          );
        }
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM platform_eventing.consumer_inbox WHERE event_id=$1 AND consumer_name='ordering.payment-outcome:v1'",
              [terminalFact.event.eventId],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(await statusInboxCount(), 1);
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM rms_ordering.order_payment_disposition_record WHERE payment_event_id=$1",
              [terminalFact.event.eventId],
            )
          ).rows[0].n,
          0,
        );
        assert.equal(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM platform_eventing.outbox_event WHERE event_type='OrderConfirmed'",
            )
          ).rows[0].n,
          0,
        );
        paidInventoryReadAllowed = false;
        await assert.rejects(
          runner.run((tx) => paidContextSource.resolve(tx, terminalFact.event)),
          {
            code: "ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE",
          },
        );
        paidInventoryReadAllowed = true;
        paidOrderReadAllowed = false;
        await assert.rejects(
          runner.run((tx) => paidContextSource.resolve(tx, terminalFact.event)),
          {
            code: "ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE",
          },
        );
        capturedSourceAllowed = false;
        await assert.rejects(
          runner.run((tx) => capturedSource.resolve(tx, terminalFact.event)),
          {
            code: "ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE",
          },
        );
        paidOrderReadAllowed = true;
        capturedSourceAllowed = true;
        if (positive) {
          await exerciseCapturedOrderKitchen({
            additionalServices: statusConsumer.registrations.map((registration) => ({
              registration,
              consume: (transaction, envelope) => statusConsumer.consume(transaction, envelope),
            })),
            admin,
            runner,
            role,
            scope,
            order,
            quoteVersion,
            paymentWorkflow,
            context: paidContextSource,
            paymentScope: terminalScope,
            event: terminalFact.event,
          });
          if (order.order.orderType === "DineIn") {
            await exerciseDiningCustomerStatus({
              admin,
              runner,
              role,
              scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
              order,
              quoteVersion,
              paymentEvent: terminalFact.event,
              services: statusConsumer.registrations.map((registration) => ({
                registration,
                consume: (transaction, envelope) => statusConsumer.consume(transaction, envelope),
              })),
            });
          }
          assert.ok(
            (
              await admin.query(
                "SELECT published_at FROM platform_eventing.outbox_event WHERE brand_id=$1 AND store_id=$2 AND event_id=$3",
                [scope.brandReference, scope.storeReference, terminalFact.event.eventId],
              )
            ).rows[0].published_at,
          );
          assert.deepEqual(await loadStatus(), statusProjection);
          assert.equal(await statusInboxCount(), 1);
          if (sessionPayment) {
            if (order.order.orderType === "Pickup") {
              await exerciseCompensationSource({
                admin,
                runner,
                role,
                scope: terminalScope,
                fact: terminalFact,
              });
              let ordinaryRefundFixture;
              if (quoteVersion === 2) {
                await admin.query("GRANT USAGE ON SCHEMA rms_pricing TO " + role);
                await admin.query("GRANT SELECT ON rms_pricing.price_quote TO " + role);
                ordinaryRefundFixture = await exerciseOrdinaryRefundCapture({
                  client: admin,
                  captured,
                  hash,
                  runner: () => runner,
                  scope,
                  terminalScope,
                  record,
                  fact: terminalFact,
                  validateOnly: true,
                });
              }
              await exerciseCustomerReceiptRead({
                server: paymentRuntime.server,
                ordinaryRefundFixture,
                admin,
                runner,
                role,
                scope,
                order,
                preparation,
                sessionPayment,
                paymentScope: terminalScope,
                paymentFreshAfter: captured.observedAt,
              });
            }
            const statusServer = paymentRuntime.server;
            {
              const statusUrl =
                "http://127.0.0.1:" +
                statusServer.address().port +
                "/api/v1/orders/" +
                preparation.orderReference +
                "/status";
              const headers = {
                "sec-fetch-site": "same-origin",
                cookie: "__Host-bop-guest=" + sessionPayment.input.sessionCredential,
                "x-csrf-token": sessionPayment.input.csrfCredential,
              };
              const response = await globalThis.fetch(statusUrl, { headers });
              assert.equal(response.status, 200);
              assert.equal(response.headers.get("cache-control"), "no-store");
              const body = await response.json();
              assert.equal(body.status.order.orderReference, preparation.orderReference);
              assert.equal(
                body.status.order.canonicalPhase,
                order.order.orderType === "Pickup" ? "Fulfilled" : "Submitted",
              );
              assert.equal(body.status.order.paymentStatus, "NotReported");
              assert.deepEqual(
                body.status.sources.kitchen.batches.map((batch) => batch.status),
                ["Ready"],
              );
              assert.equal(body.status.sources.payments.length, 1);
              assert.equal(body.status.sources.payments[0].status, "Succeeded");
              assert.equal(
                body.status.sources.payments[0].amount.amountMinor,
                amounts.total.amountMinor.toString(),
              );
              const forbidden = await globalThis.fetch(statusUrl, {
                headers: { ...headers, "x-csrf-token": "z".repeat(43) },
              });
              assert.equal(forbidden.status, 404);
              assert.equal(
                (
                  await globalThis.fetch(
                    statusUrl.replace(preparation.orderReference, id(999999)),
                    {
                      headers,
                    },
                  )
                ).status,
                404,
              );
            }
          }
        } else {
          await admin.query(
            "GRANT SELECT,INSERT ON rms_ordering.order_termination_record,rms_ordering.order_payment_disposition_record TO " +
              role,
          );
          const terminationAt = new Date().toISOString();
          const termination = {
            terminationReference: id(210),
            operationReference: id(211),
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            orderReference: preparation.orderReference,
            orderBatchReference: preparation.orderBatchReference,
            expectedOrderVersion: 1,
            terminatedOrderVersion: 2,
            expectedSourceCheckpoint: order.submissionReference,
            previousPhase: "Submitted",
            phase: "Cancelled",
            actorType: "User",
            actorReference: id(212),
            purposeCode: "SyntheticMerchantCancellation",
            permissionCode: "order.cancel",
            reasonCode: "SYNTHETIC_TEST",
            workflowVersionReference: id(213),
            transitionReference: id(214),
            sourceDigest: canonicalDigest("synthetic-current-cancellation-policy"),
            terminatedAt: terminationAt,
          };
          const terminalWriter = createPostgresOrderTerminationStore({
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            authorize: async () => true,
            validateCurrentSource: async () => true, // Explicit synthetic Staff/policy gates.
            audit: async (record) => ({
              auditId: id(215),
              brandId: scope.brandReference,
              storeId: scope.storeReference,
              actor: { type: "User", reference: record.actorReference },
              actionCode: "ORDER_TERMINATED",
              targetType: "Order",
              targetId: record.orderReference,
              correlationId: record.operationReference,
              reasonCode: record.reasonCode,
              occurredAt: record.terminatedAt,
              sourceChannel: "MERCHANT_WEB",
              afterSummary: { phase: record.phase },
              dataClassification: "Restricted",
              retentionPolicyCode: "FINANCIAL_COMPLIANCE",
              retentionPolicyVersion: 1,
            }),
          });
          await runner.run((transaction) =>
            terminalWriter.commit({ transaction, record: termination }),
          );
          paidInventoryReadAllowed = false;
          const terminatedContext = await runner.run((tx) =>
            paidContextSource.resolve(tx, terminalFact.event),
          );
          assert.equal(terminatedContext.initialExecution.phase, "Cancelled");
          assert.equal(
            terminatedContext.initialExecution.checkpoint,
            termination.terminationReference,
          );
          assert.equal(terminatedContext.capacity, null);
          assert.equal(terminatedContext.inventory, null);
          const compensationConsumer = createOrderPaymentOutcomeConsumerService({
            authorization: { authorize: async () => true }, // Explicit synthetic System capability.
            source: waitingSource, // Same actual context/source, now observes durable termination.
            outcomes: createPostgresOrderPaymentOutcomeStore({
              brandReference: scope.brandReference,
              storeReference: scope.storeReference,
              sha256: canonicalDigest,
              audit: async ({ orderReference, correlationReference, outcome }) => ({
                auditId: id(216),
                brandId: scope.brandReference,
                storeId: scope.storeReference,
                actor: { type: "System" },
                actionCode: "ORDER_PAYMENT_DISPOSITION_RECORDED",
                targetType: "Order",
                targetId: orderReference,
                correlationId: correlationReference,
                afterSummary: { outcome },
                reasonCode: "PAID_ORDER_TERMINATED",
                occurredAt: new Date().toISOString(),
                sourceChannel: "EVENT_CONSUMER",
                dataClassification: "Restricted",
                retentionPolicyCode: "FINANCIAL_COMPLIANCE",
                retentionPolicyVersion: 1,
              }),
            }),
            references: { generate: () => id(217) },
            digests: { sha256: canonicalDigest },
          });
          const compensated = await runner.run((tx) =>
            compensationConsumer.consume(tx, terminalFact.event),
          );
          assert.equal(compensated.result.status, "CompensationRequired");
          if (order.order.orderType === "Pickup" && quoteVersion === 2) {
            await exerciseCompensationRuntime({
              admin,
              runner,
              role,
              scope: terminalScope,
              fact: terminalFact,
              disposition: compensated.result.disposition,
              services: [
                ...statusConsumer.registrations.map((registration) => ({
                  registration,
                  consume: (tx, event) => statusConsumer.consume(tx, event),
                })),
                ...compensationConsumer.registrations.map((registration) => ({
                  registration,
                  consume: async (tx, event) =>
                    (await compensationConsumer.consume(tx, event)).consumerOutcome,
                })),
              ],
            });
          }

          assert.equal(compensated.result.disposition.reason, "SubmissionCancelled");
          assert.equal(compensated.result.disposition.kitchenReleaseDisposition, "Blocked");
          assert.equal(
            compensated.result.disposition.sourceCheckpoint,
            termination.terminationReference,
          );
          const repeatedCompensation = await runner.run((tx) =>
            compensationConsumer.consume(tx, terminalFact.event),
          );
          assert.equal(repeatedCompensation.consumerOutcome.status, "duplicate_completed");
          assert.deepEqual(repeatedCompensation.result, compensated.result);
          const terminalCounts = (
            await admin.query(
              "SELECT (SELECT count(*)::int FROM platform_eventing.consumer_inbox WHERE event_id=$1 AND consumer_name='ordering.payment-outcome:v1') AS inbox," +
                "(SELECT count(*)::int FROM rms_ordering.order_payment_disposition_record WHERE payment_event_id=$1) AS dispositions," +
                "(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE event_type='OrderConfirmed') AS confirmations," +
                "(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='ORDER_PAYMENT_DISPOSITION_RECORDED') AS audits",
              [terminalFact.event.eventId],
            )
          ).rows[0];
          assert.deepEqual(terminalCounts, {
            inbox: 1,
            dispositions: 1,
            confirmations: 0,
            audits: 1,
          });
        }
        const success = await requestResult();
        assert.equal(success.status, 200);
        assert.equal(success.headers.get("cache-control"), "no-store");
        assert.equal(success.headers.get("referrer-policy"), "no-referrer");
        assert.deepEqual(await success.json(), {
          schemaVersion: 1,
          payment: {
            checkoutSessionReference: input.checkoutSessionReference,
            paymentIntentReference: record.intent.paymentIntentReference,
            orderReference: preparation.orderReference,
            status: "Succeeded",
            total: { amountMinor: preparation.total.amountMinor.toString(), currency: "CAD" },
          },
        });
        assert.equal((await requestResult("z".repeat(43))).status, 404);
        const persisted = (
          await admin.query(
            "SELECT (SELECT count(*)::int FROM rms_payment.payment_provider_observation) AS observations," +
              "(SELECT count(*)::int FROM rms_payment.payment_terminal_fact) AS terminals," +
              "(SELECT count(*)::int FROM platform_eventing.outbox_event WHERE event_type='PaymentSucceeded') AS events",
          )
        ).rows[0];
        // Configured Pickup now includes the durable cumulative observation from
        // the completed ordinary refund; capture terminal/event remain one.
        assert.deepEqual(
          persisted,
          {
            observations:
              positive && sessionPayment && quoteVersion === 2 && order.order.orderType === "Pickup"
                ? 3
                : 2,
            terminals: 1,
            events: 1,
          },
          JSON.stringify({
            positive,
            sessionPayment: !!sessionPayment,
            quoteVersion,
            orderType: order.order.orderType,
          }),
        );
        assert.equal(handoffReads, 1, "result query never calls Provider");
      }
      assert.deepEqual(await counts(), { intents: 1, attempts: 1, operations: 1, audits: 1 });
    }
    return recovered.record;
  } finally {
    if (paymentRuntime && !journey) await paymentRuntime.shutdown("SIGTERM");
  }
}
