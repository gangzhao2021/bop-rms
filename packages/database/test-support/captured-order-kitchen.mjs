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
  createOrderPaymentOutcomeConsumerService,
  createPostgresOrderPaymentOutcomeStore,
  createPostgresOrderKitchenSourceStore,
} from "../../rms/ordering/src/index.ts";
import { exerciseKitchenTicketCreation } from "./kitchen-ticket-creation.mjs";

/** Actual captured Payment/resource context and published actions; external policy authority remains synthetic. */
export async function exerciseCapturedOrderKitchen({
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
    "GRANT SELECT,INSERT ON rms_ordering.order_acceptance_record,rms_ordering.order_payment_disposition_record,rms_ordering.order_payment_failure_record TO " +
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
  });
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
  await session.revoke();
  await assert.rejects(authenticatedAccept(commandInput));
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
  const consumer = createOrderPaymentOutcomeConsumerService({
    authorization: { authorize: async () => true },
    source,
    outcomes,
    references: { generate: next },
    digests: { sha256: hash },
  });
  const confirmed = await runner.run((tx) => consumer.consume(tx, event));
  assert.equal(confirmed.result.disposition.disposition, "Confirmed");
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
    merchantKitchen: kitchenNow === undefined ? undefined : { session, actor },
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
