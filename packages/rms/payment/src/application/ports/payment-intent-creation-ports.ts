import type { AppendAuditRecordInput } from "@bop/audit";
import type { OrderPaymentPreparationEvidence } from "@rms/ordering";

import type { PaymentProviderAdapter } from "../../contracts/payment-provider-adapter.js";
import type { PaymentInstant, PaymentIntentCreationRecord } from "../payment-intent-creation.js";
import type { PaymentKillSwitchPort } from "./payment-kill-switch-ports.js";

export interface PaymentIntentCreationPorts {
  readonly providerEnvironment: "Test" | "Live";
  readonly clock: {
    now(): string;
  };
  readonly killSwitch: PaymentKillSwitchPort;
  readonly authorization: {
    authorize(input: {
      readonly action: "CreatePaymentIntent";
      readonly paymentOperationReference: string;
      readonly submissionReference: string;
      readonly observedAt: PaymentInstant;
    }): Promise<{
      readonly action: "CreatePaymentIntent";
      readonly guestSessionReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
    } | null>;
  };
  readonly ordering: {
    preparePayment(input: {
      readonly submissionReference: string;
      readonly cartReference: string;
      readonly expectedCartVersion: number;
      readonly quoteReference: string;
      readonly tipSelectionReference: string | null;
      readonly requestedAt: PaymentInstant;
    }): Promise<OrderPaymentPreparationEvidence>;
  };
  readonly audit: {
    create(input: {
      readonly paymentIntentReference: string;
      readonly paymentOperationReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly observedAt: PaymentInstant;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly references: {
    generate(purpose: "PaymentIntent" | "PaymentAttempt"): string;
    hash(value: string): string;
    equals(left: string, right: string): boolean;
    providerIdempotencyKey(input: {
      readonly environment: "Test" | "Live";
      readonly paymentOperationReference: string;
      readonly paymentAttemptReference: string;
    }): string;
  };
  readonly repository: {
    resolveOperation(
      paymentOperationReference: string,
    ): Promise<PaymentIntentCreationRecord | null>;
    claim(input: {
      readonly record: PaymentIntentCreationRecord;
      readonly audit: AppendAuditRecordInput;
    }): Promise<{
      readonly status: "Claimed" | "Existing";
      readonly record: PaymentIntentCreationRecord;
    }>;
    recordObservation(input: {
      readonly record: PaymentIntentCreationRecord;
    }): Promise<PaymentIntentCreationRecord>;
  };
  readonly provider: PaymentProviderAdapter;
}
