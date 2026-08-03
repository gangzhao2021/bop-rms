import type { PaymentReference } from "../../contracts/payment-provider-adapter.js";
import type {
  ProviderWebhookVerificationErrorCode,
  WebhookDigest,
  WebhookInstant,
} from "../provider-webhook-verification.js";

export interface StripeWebhookSecretConfiguration {
  readonly provider: "Stripe";
  readonly environment: "Test" | "Live";
  readonly providerAccountReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly currentSecret: Uint8Array;
  readonly nextSecret: null | {
    readonly secret: Uint8Array;
    readonly validFrom: WebhookInstant;
    readonly validUntil: WebhookInstant;
  };
}

export interface StripeWebhookSignatureVerification {
  readonly signatureTimestamp: WebhookInstant;
  readonly evidenceDigest: WebhookDigest;
  readonly matchedSecretSlot: "Current" | "Next";
}

export interface ProviderWebhookVerificationPorts {
  readonly configuration: {
    resolve(input: {
      readonly provider: "Stripe";
      readonly environment: "Test" | "Live";
      readonly providerAccountReference: PaymentReference;
      readonly receivedAt: WebhookInstant;
    }): Promise<StripeWebhookSecretConfiguration | null>;
  };
  readonly signature: {
    verify(input: {
      readonly rawBody: Uint8Array;
      readonly signatureHeader: string;
      readonly receivedAt: WebhookInstant;
      readonly configuration: StripeWebhookSecretConfiguration;
    }): StripeWebhookSignatureVerification;
  };
  readonly securityAudit: {
    record(input: {
      readonly provider: "Stripe";
      readonly environment: "Test" | "Live";
      readonly providerAccountReference: PaymentReference;
      readonly brandReference: PaymentReference;
      readonly storeReference: PaymentReference;
      readonly receivedAt: WebhookInstant;
      readonly outcome: "Verified" | "Rejected";
      readonly reasonCode: "SIGNATURE_VERIFIED" | ProviderWebhookVerificationErrorCode;
      readonly evidenceDigest: WebhookDigest | null;
    }): Promise<void>;
  };
}
