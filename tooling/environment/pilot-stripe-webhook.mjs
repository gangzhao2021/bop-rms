// WP-2423 DEC-STRIPE-PILOT-WIRING: the Stripe webhook receiver of the pilot API.
//
// Raw body → signature verification (current/next secret, five-minute window) → Payment Webhook
// Inbox (one immutable receipt per Stripe event, Restricted raw evidence) → mapper. The mapper
// re-reads the intent from Stripe (authoritative state; out-of-order or stale events cannot
// regress anything) and records the attempt's terminal outcome through the existing Payment
// terminal owner, which commits the fact, its Audit and PaymentSucceeded/PaymentFailed once.
// Logs carry reason codes only: never the body, signature, keys, Provider IDs or payment data.
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  createPaymentTerminalService,
  createPaymentWebhookInboxService,
  createPostgresPaymentIntentCreationStore,
  createPostgresPaymentProviderObservationStore,
  createPostgresPaymentTerminalSource,
  createPostgresPaymentTerminalStore,
  createPostgresPaymentWebhookInboxStore,
  createProviderWebhookVerificationService,
  parsePaymentInstant,
  parsePaymentIntentCreationRecord,
  parseStripeWebhookPaymentEvent,
  PaymentTerminalError,
  verifyStripeWebhookSignature,
} from "../../packages/rms/payment/src/index.ts";
import { readStripeWebhookSecrets } from "./pilot-payment-config.mjs";
import { isStripeProvider } from "./pilot-stripe-provider.mjs";

const json = (value) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
const digest = (value) => "sha256:" + createHash("sha256").update(json(value)).digest("hex");

/** Records one attempt's terminal outcome from Stripe's current state of its intent. */
export function createStripeTerminalRecorder(resources, { provider, providerAccountReference }) {
  if (!isStripeProvider(provider)) throw Error("PILOT_STRIPE_PROVIDER_REQUIRED");
  const { scope, transactions, now, credentials } = resources,
    reference = credentials.reference;
  const terminalScope = { ...scope, providerAccountReference, environment: provider.environment };
  // A retrieval-sourced outcome must equal Stripe's own record of when it happened.
  const verification = {
    verifyOccurrence: async (_tx, observation) => {
      const original = await provider.readTerminalOccurrence({
        operation: "RetrieveIntent",
        purpose: "RetrievePaymentIntent",
        context: {
          ...scope,
          provider: "Stripe",
          environment: provider.environment,
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
  const terminal = createPostgresPaymentTerminalStore(transactions, terminalScope, verification);
  const observations = createPostgresPaymentProviderObservationStore(transactions, scope, { now });
  const history = createPostgresPaymentIntentCreationStore(transactions, scope, {
    now,
    generateObservationReference: reference,
  });
  const service = createPaymentTerminalService({
    source: createPostgresPaymentTerminalSource(transactions, terminalScope, verification),
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
        sourceChannel:
          fact.source === "VerifiedWebhook" ? "PROVIDER_WEBHOOK" : "PAYMENT_RECONCILIATION",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      }),
    },
  });
  /**
   * `webhook` is the verified receipt that caused this read (or null for a customer "check
   * payment" / reconciliation read). Returns a closed result code; never throws for a terminal
   * outcome that another path has already recorded.
   */
  async function record({ paymentOperationReference, providerIntentReference, webhook = null }) {
    const raw = await history.resolveOperation(paymentOperationReference);
    if (!raw) return { result: "Unlinked" };
    const record = parsePaymentIntentCreationRecord(raw);
    const snapshot = record.providerOutcome;
    // The create answer was lost: the open-payment resolution repeats the same create later.
    if (snapshot?.kind !== "Snapshot") return { result: "AwaitingCreateResolution" };
    if (snapshot.providerIntentReference !== providerIntentReference)
      return { result: "SupersededAttempt" };
    const prior = await terminal.read(record.intent.paymentIntentReference);
    if (prior !== null && prior.paymentAttemptReference === record.attempt.paymentAttemptReference)
      return { result: "AlreadyRecorded", outcome: prior.outcome };
    const causationReference = webhook?.receipt.webhookReceiptReference ?? reference();
    const retrieval = {
      operation: "RetrieveIntent",
      purpose: "RetrievePaymentIntent",
      context: { ...snapshot.context, operationReference: reference() },
      providerIntentReference,
    };
    const observed = await provider.readTerminalObservation(retrieval, {
      failedEventAt:
        webhook?.event.eventType === "payment_intent.payment_failed"
          ? webhook.event.createdAt
          : null,
    });
    const occurrence = observed.occurrence;
    if (occurrence === null) return { result: "NotTerminal" };
    const status = occurrence.status === "Captured" ? "Captured" : "Failed";
    const type = webhook?.event.eventType;
    const fromEvent =
      webhook !== null &&
      ((status === "Captured" && type === "payment_intent.succeeded") ||
        (status === "Failed" &&
          (type === "payment_intent.payment_failed" || type === "payment_intent.canceled")));
    const observationReference = reference();
    await observations.record({
      observationReference,
      paymentIntentReference: record.intent.paymentIntentReference,
      snapshot: observed.snapshot,
    });
    try {
      await service.record({
        observationReference,
        causationReference: fromEvent ? causationReference : reference(),
        webhookReceiptReference: fromEvent ? webhook.receipt.webhookReceiptReference : null,
        providerEventReference: fromEvent ? webhook.receipt.providerEventReference : null,
        providerAccountReference,
        providerIntentReference,
        environment: provider.environment,
        paymentIntentReference: record.intent.paymentIntentReference,
        paymentAttemptReference: record.attempt.paymentAttemptReference,
        ...scope,
        source: fromEvent ? "VerifiedWebhook" : "ProviderRetrieval",
        status,
        amount: status === "Captured" ? observed.snapshot.capturedAmount : null,
        failureReason: status === "Captured" ? null : occurrence.failureReason,
        retryDisposition:
          status === "Captured"
            ? null
            : occurrence.failureReason === "Cancelled"
              ? "Never"
              : "NewOperation",
        occurredAt: parsePaymentInstant(occurrence.occurredAt),
        evidenceDigest: observed.snapshot.evidenceDigest,
      });
    } catch (error) {
      // Another path (the guest's "check payment", a duplicate delivery) committed first.
      if (
        error instanceof PaymentTerminalError &&
        error.code === "PAYMENT_TERMINAL_OUTCOME_CONFLICT"
      ) {
        const now = await terminal.read(record.intent.paymentIntentReference);
        if (now !== null && now.paymentAttemptReference === record.attempt.paymentAttemptReference)
          return { result: "AlreadyRecorded", outcome: now.outcome };
      }
      throw error;
    }
    // DEC-PAYMENT-CARD-RETRY: the declined attempt's intent is cancelled so its client credential
    // can never be confirmed later; another card is a new attempt with a new intent.
    if (status === "Failed" && occurrence.status === "Failed")
      await provider.cancelDeclinedIntent(snapshot.context, providerIntentReference);
    return {
      result: "Recorded",
      outcome: status === "Captured" ? "Succeeded" : "Failed",
      source: fromEvent ? "VerifiedWebhook" : "ProviderRetrieval",
    };
  }
  return Object.freeze({ record });
}

/**
 * The webhook port the API route calls. `onRejected(reasonCode)` receives only the closed
 * verification reason code (for the operations log); nothing else about a rejected request.
 */
export function createPilotStripeWebhookReceiver(
  resources,
  { provider, directory, stripe, providerAccountReference, onRejected = () => undefined },
) {
  if (!isStripeProvider(provider)) throw Error("PILOT_STRIPE_PROVIDER_REQUIRED");
  const { scope, transactions, now, credentials } = resources;
  const recorder = createStripeTerminalRecorder(resources, { provider, providerAccountReference });
  const verification = createProviderWebhookVerificationService({
    configuration: {
      resolve: async (input) => {
        if (
          input.environment !== provider.environment ||
          input.providerAccountReference !== providerAccountReference
        )
          return null;
        return {
          provider: "Stripe",
          environment: provider.environment,
          providerAccountReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          ...(await readStripeWebhookSecrets(directory, stripe)),
        };
      },
    },
    signature: { verify: verifyStripeWebhookSignature },
    securityAudit: {
      record: async (entry) => {
        if (entry.outcome === "Rejected") onRejected(entry.reasonCode);
      },
    },
  });
  const inbox = createPaymentWebhookInboxService({
    references: {
      generateReceipt: credentials.reference,
      hashEvidence: (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex"),
      equalsDigest: (left, right) =>
        left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right)),
    },
    repository: createPostgresPaymentWebhookInboxStore(transactions, scope, { now }),
    mapper: {
      async process({ receipt, rawEvidence }) {
        const event = parseStripeWebhookPaymentEvent(rawEvidence);
        if (event.kind === "Ignored")
          return {
            resultDigest: digest(["Ignored", receipt.webhookReceiptReference, event.eventType]),
          };
        if (event.paymentOperationReference === null)
          return { resultDigest: digest(["Unlinked", receipt.webhookReceiptReference]) };
        const outcome = await recorder.record({
          paymentOperationReference: event.paymentOperationReference,
          providerIntentReference: event.providerIntentReference,
          webhook: { receipt, event },
        });
        return { resultDigest: digest([outcome, receipt.webhookReceiptReference]) };
      },
    },
  });
  return Object.freeze({
    /** Throws on rejection; the route answers 400 for a verification failure, else 503. */
    async receive({ signatureHeader, rawBody, receivedAt }) {
      const verified = await verification.verify({
        provider: "Stripe",
        environment: provider.environment,
        providerAccountReference,
        receivedAt,
        signatureHeader,
        rawBody,
      });
      const accepted = await inbox.accept(verified);
      const processed = await inbox.process({
        webhookReceiptReference: accepted.receipt.webhookReceiptReference,
        requestedAt: parsePaymentInstant(now()),
      });
      return Object.freeze({ accepted: accepted.status, processed: processed.status });
    },
  });
}
