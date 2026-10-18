import { createHash } from "node:crypto";
import process from "node:process";
import { createOpenPaymentAttemptResolution } from "../../apps/api/dist/open-payment-attempt-resolution.js";
import {
  createPaymentTerminalService,
  createPostgresCardMachinePaymentStore,
  createPostgresPaymentIntentCreationStore,
  createPostgresPaymentProviderObservationStore,
  createPostgresPaymentTerminalSource,
  createPostgresPaymentTerminalStore,
  parsePaymentInstant,
} from "../../packages/rms/payment/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";

/**
 * WP-2423 abandoned payment: the Provider idempotency key of an attempt's create, derived from the
 * attempt (a fresh reference per attempt, so still one key per create). Payment stores only its
 * digest; deriving it lets Payment repeat the same create later to learn what the Provider holds
 * when the create's answer was lost (DEC-DINING-ABANDONED-PAYMENT, unknown create outcome).
 */
export function pilotCreateIntentIdempotencyKey(input) {
  return "create-intent:" + String(input.paymentAttemptReference);
}
const keyDigest = (key) => "sha256:" + createHash("sha256").update(key).digest("hex");

/**
 * WP-2423 abandoned payment (DEC-DINING-ABANDONED-PAYMENT): TEST-ONLY internal simulator binding of
 * Payment's open-attempt resolution. Each call opens the simulated Provider, asks it for the round's
 * latest online attempt (cancelling one the guest never confirmed) and records the terminal outcome
 * through Payment's terminal owner, exactly as a customer's "check payment" records a retrieval.
 * The real Stripe binding uses the same resolution with the Stripe adapter (retrieve + cancel).
 */
export function createInternalOpenPaymentResolution(
  resources,
  { createSimulatedProvider, providerAccountReference },
) {
  if (process.env.NODE_ENV !== "development" || !isPilotRuntime())
    throw new Error("SIMULATION_ONLY");
  const { scope, transactions, now, credentials } = resources,
    reference = credentials.reference;
  const terminalScope = { ...scope, providerAccountReference, environment: "Test" };
  const history = createPostgresPaymentIntentCreationStore(transactions, scope, {
    now,
    generateObservationReference: reference,
  });
  const terminal = (verification) =>
    createPostgresPaymentTerminalStore(transactions, terminalScope, verification);
  const observations = createPostgresPaymentProviderObservationStore(transactions, scope, { now });
  return {
    async resolve(paymentOperationReference) {
      const simulator = await createSimulatedProvider();
      try {
        // The terminal occurrence of the simulated Provider (Cancelled for an abandoned attempt).
        const verification = {
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
              original.status ===
                (observation.failureReason === "Cancelled" ? "Cancelled" : observation.status) &&
              original.occurredAt === observation.occurredAt
            );
          },
        };
        const service = createPaymentTerminalService({
          source: createPostgresPaymentTerminalSource(transactions, terminalScope, verification),
          repository: terminal(verification),
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
        const resolution = createOpenPaymentAttemptResolution({
          load: async (operation) => {
            const record = await history.resolveOperation(operation);
            const card = await transactions.run((tx) =>
              createPostgresCardMachinePaymentStore({
                scope,
                authorize: async () => isPilotRuntime(),
              }).loadByPaymentOperation(tx, operation),
            );
            const fact =
              record === null ? null : await terminal().read(record.intent.paymentIntentReference);
            return {
              record,
              cardMachine: card !== null,
              terminal:
                fact === null ||
                String(fact.paymentAttemptReference) !==
                  String(record.attempt.paymentAttemptReference)
                  ? null
                  : { outcome: fact.outcome, failureReason: fact.failureReason },
            };
          },
          provider: simulator.adapter,
          // Only an attempt whose recorded key digest matches (attempts created before the key was
          // derived from the attempt can't be asked about again; staff are told after the grace).
          createIdempotencyKey: (record) => {
            const key = pilotCreateIntentIdempotencyKey(record.attempt);
            return keyDigest(key) === record.attempt.providerIdempotencyDigest ? key : null;
          },
          newReference: reference,
          recordTerminal: async ({
            record,
            snapshot,
            status,
            failureReason,
            causationReference,
          }) => {
            const occurrence = await simulator.readTerminalOccurrence({
              operation: "RetrieveIntent",
              purpose: "RetrievePaymentIntent",
              context: snapshot.context,
              providerIntentReference: snapshot.providerIntentReference,
            });
            const observationReference = reference();
            await observations.record({
              observationReference,
              paymentIntentReference: record.intent.paymentIntentReference,
              snapshot,
            });
            return service.record({
              observationReference,
              causationReference,
              webhookReceiptReference: null,
              providerEventReference: null,
              providerAccountReference,
              providerIntentReference: snapshot.providerIntentReference,
              environment: "Test",
              paymentIntentReference: record.intent.paymentIntentReference,
              paymentAttemptReference: record.attempt.paymentAttemptReference,
              ...scope,
              source: "ProviderRetrieval",
              status,
              amount: status === "Captured" ? snapshot.capturedAmount : null,
              failureReason,
              retryDisposition:
                status === "Captured"
                  ? null
                  : failureReason === "Cancelled"
                    ? "Never"
                    : "NewOperation",
              occurredAt: parsePaymentInstant(occurrence.occurredAt),
              evidenceDigest: snapshot.evidenceDigest,
            });
          },
        });
        return await resolution.resolve(paymentOperationReference);
      } finally {
        simulator.close();
      }
    },
  };
}
