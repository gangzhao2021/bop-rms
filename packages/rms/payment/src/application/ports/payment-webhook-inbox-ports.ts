import type {
  PaymentWebhookInboxRecord,
  PaymentWebhookProcessingCompletion,
} from "../payment-webhook-inbox.js";
import type { WebhookDigest, WebhookInstant } from "../provider-webhook-verification.js";

export interface PaymentWebhookInboxPorts {
  readonly references: {
    generateReceipt(): string;
    hashEvidence(value: Uint8Array): string;
    equalsDigest(left: string, right: string): boolean;
  };
  readonly repository: {
    accept(input: {
      readonly record: PaymentWebhookInboxRecord;
    }): Promise<
      | { readonly status: "Accepted"; readonly record: PaymentWebhookInboxRecord }
      | { readonly status: "Duplicate"; readonly record: PaymentWebhookInboxRecord }
      | { readonly status: "Conflict"; readonly record: PaymentWebhookInboxRecord }
    >;
    process(input: {
      readonly webhookReceiptReference: string;
      readonly consumerName: "payment.provider-webhook.v1";
      readonly requestedAt: WebhookInstant;
      readonly handler: (record: PaymentWebhookInboxRecord) => Promise<WebhookDigest>;
    }): Promise<
      | {
          readonly status: "Completed";
          readonly completion: PaymentWebhookProcessingCompletion;
        }
      | {
          readonly status: "AlreadyCompleted";
          readonly completion: PaymentWebhookProcessingCompletion;
        }
      | { readonly status: "NotFound" }
    >;
  };
  readonly mapper: {
    process(input: {
      readonly receipt: Omit<PaymentWebhookInboxRecord, "copyRawEvidence">;
      readonly rawEvidence: Uint8Array;
    }): Promise<{ readonly resultDigest: string }>;
  };
}
