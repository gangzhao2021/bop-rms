import { parsePaymentReference } from "./payment-provider-adapter.js";
import {
  cloneVerifiedWebhook,
  createPaymentWebhookInboxRecord,
  parsePaymentWebhookInboxRecord,
  parsePaymentWebhookProcessingCompletion,
  parsePaymentWebhookReceiptSnapshot,
  PaymentWebhookInboxError,
  paymentWebhookInboxConsumer,
  type AcceptPaymentWebhookResult,
  type PaymentWebhookInboxRecord,
  type ProcessPaymentWebhookResult,
} from "./payment-webhook-inbox.js";
import { parseWebhookDigest, parseWebhookInstant } from "./provider-webhook-verification.js";
import type { PaymentWebhookInboxPorts } from "./ports/payment-webhook-inbox-ports.js";

function fail(code: ConstructorParameters<typeof PaymentWebhookInboxError>[0]): never {
  throw new PaymentWebhookInboxError(code);
}

function dependency(error: unknown): never {
  if (error instanceof PaymentWebhookInboxError) throw error;
  return fail("PAYMENT_WEBHOOK_INBOX_DEPENDENCY_UNAVAILABLE");
}

function addDays(value: string, days: number) {
  return parseWebhookInstant(new Date(Date.parse(value) + days * 86_400_000).toISOString());
}

function digestsEqual(ports: PaymentWebhookInboxPorts, left: string, right: string): boolean {
  try {
    const equal = ports.references.equalsDigest(left, right);
    if (typeof equal !== "boolean") return fail("PAYMENT_WEBHOOK_INBOX_DEPENDENCY_UNAVAILABLE");
    return equal;
  } catch (error) {
    return dependency(error);
  }
}

function sameIdentity(left: PaymentWebhookInboxRecord, right: PaymentWebhookInboxRecord): boolean {
  return (
    left.provider === right.provider &&
    left.environment === right.environment &&
    left.providerAccountReference === right.providerAccountReference &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference &&
    left.providerEventReference === right.providerEventReference
  );
}

function safeReceipt(record: PaymentWebhookInboxRecord) {
  const { copyRawEvidence: _copyRawEvidence, ...receipt } = record;
  void _copyRawEvidence;
  return parsePaymentWebhookReceiptSnapshot(receipt);
}

export function createPaymentWebhookInboxService(ports: PaymentWebhookInboxPorts) {
  return Object.freeze({
    async accept(value: unknown): Promise<AcceptPaymentWebhookResult> {
      let verified;
      try {
        verified = cloneVerifiedWebhook(value);
      } catch {
        return fail("PAYMENT_WEBHOOK_INBOX_INPUT_INVALID");
      }
      const rawEvidence = verified.copyRawBody();
      let calculated;
      try {
        calculated = parseWebhookDigest(ports.references.hashEvidence(rawEvidence));
      } catch {
        rawEvidence.fill(0);
        return fail("PAYMENT_WEBHOOK_INBOX_DEPENDENCY_UNAVAILABLE");
      }
      let evidenceMatches;
      try {
        evidenceMatches = digestsEqual(ports, calculated, verified.evidenceDigest);
      } catch (error) {
        rawEvidence.fill(0);
        throw error;
      }
      if (!evidenceMatches) {
        rawEvidence.fill(0);
        return fail("PAYMENT_WEBHOOK_INBOX_EVIDENCE_MISMATCH");
      }
      let receiptReference;
      try {
        receiptReference = parsePaymentReference(ports.references.generateReceipt());
      } catch {
        rawEvidence.fill(0);
        return fail("PAYMENT_WEBHOOK_INBOX_DEPENDENCY_UNAVAILABLE");
      }
      const proposed = createPaymentWebhookInboxRecord({
        webhookReceiptReference: receiptReference,
        provider: verified.provider,
        environment: verified.environment,
        providerAccountReference: verified.providerAccountReference,
        brandReference: verified.brandReference,
        storeReference: verified.storeReference,
        providerEventReference: verified.providerEventReference,
        providerEventType: verified.providerEventType,
        providerCreatedAt: verified.providerCreatedAt,
        receivedAt: verified.receivedAt,
        signatureTimestamp: verified.signatureTimestamp,
        evidenceDigest: verified.evidenceDigest,
        acceptedAt: verified.receivedAt,
        rawEvidenceExpiresAt: addDays(verified.receivedAt, 30),
        dedupeExpiresAt: addDays(verified.receivedAt, 90),
        rawEvidence,
      });
      rawEvidence.fill(0);
      const outcome = await ports.repository.accept({ record: proposed }).catch(dependency);
      if (
        outcome.status !== "Accepted" &&
        outcome.status !== "Duplicate" &&
        outcome.status !== "Conflict"
      )
        return fail("PAYMENT_WEBHOOK_INBOX_DEPENDENCY_UNAVAILABLE");
      let record;
      try {
        record = parsePaymentWebhookInboxRecord(outcome.record);
      } catch {
        return fail("PAYMENT_WEBHOOK_INBOX_DEPENDENCY_UNAVAILABLE");
      }
      if (
        !sameIdentity(proposed, record) ||
        !digestsEqual(ports, proposed.evidenceDigest, record.evidenceDigest)
      )
        return fail("PAYMENT_WEBHOOK_INBOX_IDENTITY_CONFLICT");
      if (outcome.status === "Conflict") return fail("PAYMENT_WEBHOOK_INBOX_IDENTITY_CONFLICT");
      return Object.freeze({
        status: outcome.status,
        disposition: "Acknowledge",
        receipt: safeReceipt(record),
      });
    },

    async process(value: unknown): Promise<ProcessPaymentWebhookResult> {
      let webhookReceiptReference;
      let requestedAt;
      try {
        if (
          value === null ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          Object.getPrototypeOf(value) !== Object.prototype
        )
          return fail("PAYMENT_WEBHOOK_INBOX_INPUT_INVALID");
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const keys = Reflect.ownKeys(value);
        if (
          keys.length !== 2 ||
          keys.some((key) => key !== "webhookReceiptReference" && key !== "requestedAt") ||
          !("value" in (descriptors.webhookReceiptReference ?? {})) ||
          !("value" in (descriptors.requestedAt ?? {})) ||
          !descriptors.webhookReceiptReference?.enumerable ||
          !descriptors.requestedAt?.enumerable
        )
          return fail("PAYMENT_WEBHOOK_INBOX_INPUT_INVALID");
        webhookReceiptReference = parsePaymentReference(descriptors.webhookReceiptReference?.value);
        requestedAt = parseWebhookInstant(descriptors.requestedAt?.value);
      } catch {
        return fail("PAYMENT_WEBHOOK_INBOX_INPUT_INVALID");
      }
      const outcome = await ports.repository
        .process({
          webhookReceiptReference,
          consumerName: paymentWebhookInboxConsumer,
          requestedAt,
          handler: async (recordValue) => {
            const record = parsePaymentWebhookInboxRecord(recordValue);
            const rawEvidence = record.copyRawEvidence();
            try {
              const { copyRawEvidence: _copyRawEvidence, ...receipt } = record;
              void _copyRawEvidence;
              const mapped = await ports.mapper.process({
                receipt: parsePaymentWebhookReceiptSnapshot(receipt),
                rawEvidence,
              });
              return parseWebhookDigest(mapped.resultDigest);
            } finally {
              rawEvidence.fill(0);
            }
          },
        })
        .catch(dependency);
      if (outcome.status === "NotFound") return fail("PAYMENT_WEBHOOK_INBOX_NOT_FOUND");
      if (outcome.status !== "Completed" && outcome.status !== "AlreadyCompleted")
        return fail("PAYMENT_WEBHOOK_INBOX_DEPENDENCY_UNAVAILABLE");
      let completion;
      try {
        completion = parsePaymentWebhookProcessingCompletion(outcome.completion);
      } catch {
        return fail("PAYMENT_WEBHOOK_INBOX_DEPENDENCY_UNAVAILABLE");
      }
      if (completion.webhookReceiptReference !== webhookReceiptReference)
        return fail("PAYMENT_WEBHOOK_INBOX_DEPENDENCY_UNAVAILABLE");
      return Object.freeze({ status: outcome.status, completion });
    },
  });
}
