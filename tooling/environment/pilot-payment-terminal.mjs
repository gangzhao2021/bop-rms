import process from "node:process";
import { createCustomerCheckoutSessionRead } from "../../apps/api/dist/customer-checkout-session-read.js";
import {
  createPostgresPaymentIntentCreationStore,
  createPostgresPaymentTerminalStore,
  createPostgresPaymentTerminalSource,
  createPostgresPaymentProviderObservationStore,
  createPaymentTerminalService,
  parsePaymentInstant,
  parsePaymentIntentCreationRecord,
} from "../../packages/rms/payment/src/index.ts";
import { createCustomerSessionPaymentResult } from "../../apps/api/dist/customer-session-payment-result.js";
/** InternalTest simulated channel only. Does not perform Ordering settlement. */
export function createInternalPaymentTerminal(
  resources,
  checkout,
  intents,
  simulator,
  { providerAccountReference },
) {
  if (process.env.NODE_ENV !== "development" || simulator.simulation !== true)
    throw new Error("SIMULATION_ONLY");
  const { scope, transactions, now, credentials } = resources,
    reference = credentials.reference;
  const terminalScope = {
    ...scope,
    providerAccountReference: providerAccountReference,
    environment: "Test",
  };
  const history = createPostgresPaymentIntentCreationStore(transactions, scope, {
    now,
    generateObservationReference: reference,
  });
  const occurrenceVerification = {
    verifyOccurrence: async (_tx, observation) => {
      const original = await simulator.readTerminalOccurrence({
        operation: "RetrieveIntent",
        purpose: "RetrievePaymentIntent",
        context: {
          ...scope,
          provider: "Stripe",
          environment: "Test",
          paymentAttemptReference: observation.paymentAttemptReference,
          operationReference: observation.causationReference,
        },
        providerIntentReference: observation.providerIntentReference,
      });
      return (
        original.status === observation.status && original.occurredAt === observation.occurredAt
      );
    },
  };
  const terminal = createPostgresPaymentTerminalStore(
    transactions,
    terminalScope,
    occurrenceVerification,
  );
  const observations = createPostgresPaymentProviderObservationStore(transactions, scope, { now });
  const resultOptions = { access: checkout.accessOptions, history, terminal };
  const reader = createCustomerSessionPaymentResult(resultOptions);
  const service = createPaymentTerminalService({
    source: createPostgresPaymentTerminalSource(
      transactions,
      terminalScope,
      occurrenceVerification,
    ),
    repository: terminal,
    clock: { now },
    references: { generate: reference },
    audit: {
      create: async ({ fact, correlationReference }) => ({
        auditId: reference(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "PAYMENT_TERMINAL_RECORDED",
        targetType: "PaymentIntent",
        targetId: fact.paymentIntentReference,
        afterSummary: { outcome: fact.outcome },
        reasonCode: fact.outcome === "Failed" ? "PAYMENT_FAILED" : "PAYMENT_CAPTURED",
        correlationId: correlationReference,
        occurredAt: fact.recordedAt,
        sourceChannel: "PAYMENT_RECONCILIATION",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      }),
    },
  });
  async function recordSnapshot(
    record,
    retrieval,
    captured,
    expected,
    observationReference,
    causationReference,
  ) {
    const occurrence = await simulator.readTerminalOccurrence(retrieval);
    const occurredAt = parsePaymentInstant(occurrence.occurredAt);
    if (
      occurrence.status !== expected ||
      occurredAt > parsePaymentInstant(captured.observedAt) ||
      occurredAt > parsePaymentInstant(now())
    )
      throw new Error("SIMULATION_TERMINAL_TIME_UNAVAILABLE");
    await observations.record({
      observationReference,
      paymentIntentReference: record.intent.paymentIntentReference,
      snapshot: captured,
    });
    return service.record({
      observationReference,
      causationReference,
      webhookReceiptReference: null,
      providerEventReference: null,
      providerAccountReference: terminalScope.providerAccountReference,
      providerIntentReference: captured.providerIntentReference,
      environment: "Test",
      paymentIntentReference: record.intent.paymentIntentReference,
      paymentAttemptReference: record.attempt.paymentAttemptReference,
      ...scope,
      source: "ProviderRetrieval",
      status: expected,
      amount: expected === "Captured" ? captured.capturedAmount : null,
      failureReason: expected === "Failed" ? "Declined" : null,
      retryDisposition: expected === "Failed" ? "NewOperation" : null,
      occurredAt,
      evidenceDigest: captured.evidenceDigest,
    });
  }
  return {
    resultOptions,
    async reconcile(input) {
      const before = await reader.read(input);
      if (
        before.status === "Succeeded" ||
        before.status === "Failed" ||
        before.paymentIntentReference === null
      )
        return before;
      const session = await createCustomerCheckoutSessionRead(checkout.accessOptions).read(input);
      const raw = await history.resolveOperation(session.paymentOperationReference);
      if (!raw) throw new Error("SIMULATION_RECOVERY_UNAVAILABLE");
      const record = parsePaymentIntentCreationRecord(raw);
      if (record.intent.paymentIntentReference !== before.paymentIntentReference)
        throw new Error("SIMULATION_RECOVERY_CONFLICT");
      const snapshot = record.providerOutcome;
      if (snapshot?.kind !== "Snapshot") return reader.read(input);
      const causationReference = reference(),
        observationReference = reference();
      const retrieval = {
        operation: "RetrieveIntent",
        purpose: "RetrievePaymentIntent",
        context: { ...snapshot.context, operationReference: causationReference },
        providerIntentReference: snapshot.providerIntentReference,
      };
      // Revalidate customer ownership before contacting the read-only Provider operation.
      const current = await reader.read(input);
      if (current.paymentIntentReference !== before.paymentIntentReference)
        throw new Error("SIMULATION_RECOVERY_CONFLICT");
      if (current.status === "Succeeded" || current.status === "Failed") return current;
      const captured = await simulator.adapter.retrieveIntent(retrieval);
      if (!["Captured", "Failed"].includes(captured.status)) return reader.read(input);
      await reader.read(input);
      await recordSnapshot(
        record,
        retrieval,
        captured,
        captured.status,
        observationReference,
        causationReference,
      );
      return reader.read(input);
    },
    async confirm(input, confirmation) {
      if (!["SIMULATE_CAPTURE", "SIMULATE_FAILURE"].includes(confirmation))
        throw new Error("SIMULATION_CONFIRMATION_REQUIRED");
      const expected = confirmation === "SIMULATE_CAPTURE" ? "Captured" : "Failed";
      const prepared = await intents.resolveRequest(input);
      const created = await prepared.service.create(input),
        record = created.record;
      const prior = await terminal.read(record.intent.paymentIntentReference);
      if (prior !== null) {
        if (prior.outcome !== (expected === "Captured" ? "Succeeded" : "Failed"))
          throw new Error("SIMULATION_OUTCOME_CONFLICT");
        return { status: "AlreadyCommitted", fact: prior };
      }
      const snapshot = record.providerOutcome;
      if (snapshot?.kind !== "Snapshot") throw new Error("SIMULATION_INTENT_UNAVAILABLE");
      const causationReference = reference(),
        observationReference = reference();
      const retrieval = {
        operation: "RetrieveIntent",
        purpose: "RetrievePaymentIntent",
        context: { ...snapshot.context, operationReference: causationReference },
        providerIntentReference: snapshot.providerIntentReference,
      };
      let captured = await simulator.adapter.retrieveIntent(retrieval);
      if (["Captured", "Failed"].includes(captured.status) && captured.status !== expected)
        throw new Error("SIMULATION_OUTCOME_CONFLICT");
      if (captured.status !== expected) {
        await transactions.run(async (tx) => {
          const at = parsePaymentInstant(now()),
            decision = await prepared.admission.admit(tx, record, at);
          const end = parsePaymentInstant(now()),
            deadline =
              decision === true
                ? record.intent.preparation.capacityExpiresAt
                : decision === false
                  ? null
                  : decision.validUntil;
          if (
            !decision ||
            deadline === null ||
            end < at ||
            end >= deadline ||
            end >= record.intent.preparation.capacityExpiresAt
          )
            throw new Error("SIMULATION_CONFIRMATION_NOT_READY");
        });
        captured =
          expected === "Captured"
            ? await simulator.simulateCapture(retrieval, confirmation)
            : await simulator.simulateFailure(retrieval, confirmation);
      }
      if (captured.status !== expected) throw new Error("SIMULATION_OUTCOME_CONFLICT");
      const fact = await recordSnapshot(
        record,
        retrieval,
        captured,
        expected,
        observationReference,
        causationReference,
      );
      const result = await reader.read({
        sessionCredential: input.sessionCredential,
        csrfCredential: input.csrfCredential,
        checkoutSessionReference: input.checkoutSessionReference,
      });
      if (result.status !== (expected === "Captured" ? "Succeeded" : "Failed"))
        throw new Error("SIMULATION_RESULT_UNAVAILABLE");
      return fact;
    },
  };
}
