import type { AppendAuditRecordInput } from "@bop/audit";

import type { PaymentRefundedEnvelope } from "../../contracts/payment-refunded-event.js";
import type { PaymentProviderAdapter } from "../../contracts/payment-provider-adapter.js";
import type {
  PaidWithoutFulfillableOrderDisposition,
  PaymentCompensationActionPhase,
  PaymentCompensationActionReceipt,
  PaymentCompensationCase,
  PaymentCompensationIdentitySource,
  PaymentCompensationLeaseReceipt,
  PaymentCompensationOperationRecord,
  PaymentCompensationSource,
  PaymentInteracInPersonClaimReceipt,
  PaymentInteracInPersonEvidence,
  PaymentOperationsReconciliationReceipt,
  PaymentProviderConfirmedRefundFact,
  PaymentRefundCompositionReceipt,
} from "../paid-without-fulfillable-order.js";
import { paidWithoutFulfillableOrderJobName } from "../paid-without-fulfillable-order.js";

export interface PaidWithoutFulfillableOrderPorts {
  readonly authorization: {
    authorize(disposition: PaidWithoutFulfillableOrderDisposition): Promise<boolean>;
    authorizeInterac(evidence: PaymentInteracInPersonEvidence): Promise<boolean>;
    authorizeOperations(receipt: PaymentOperationsReconciliationReceipt): Promise<boolean>;
  };
  readonly clock: {
    now(): string;
  };
  readonly repository: {
    resolveOperation(input: {
      readonly operationReference: string;
    }): Promise<PaymentCompensationOperationRecord | null>;
    commitOperation(input: {
      readonly record: PaymentCompensationOperationRecord;
      readonly fenceReference: string;
      readonly fenceVersion: number;
    }): Promise<
      | {
          readonly status: "Created" | "Updated" | "Duplicate";
          readonly record: PaymentCompensationOperationRecord;
        }
      | {
          readonly status: "Conflict";
          readonly record: PaymentCompensationOperationRecord;
        }
    >;
  };
  readonly lease: {
    claim(input: {
      readonly paymentAttemptReference: string;
      readonly operationReference: string;
      readonly jobName: typeof paidWithoutFulfillableOrderJobName;
    }): Promise<PaymentCompensationLeaseReceipt | null>;
    release(input: {
      readonly paymentAttemptReference: string;
      readonly operationReference: string;
      readonly jobName: typeof paidWithoutFulfillableOrderJobName;
      readonly fenceReference: string;
      readonly fenceVersion: number;
    }): Promise<void>;
  };
  readonly source: {
    resolveIdentity(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly orderReference: string;
      readonly paymentTransactionReference: string;
      readonly paymentIntentReference: string;
      readonly paymentAttemptReference: string;
    }): Promise<PaymentCompensationIdentitySource | null>;
    resolve(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly orderReference: string;
      readonly paymentTransactionReference: string;
      readonly paymentIntentReference: string;
      readonly paymentAttemptReference: string;
      readonly environment: "Test" | "Live";
      readonly identityVersion: number;
      readonly identityDigest: string;
    }): Promise<PaymentCompensationSource | null>;
  };
  readonly cases: {
    resolve(input: { readonly caseReference: string }): Promise<PaymentCompensationCase | null>;
    ensure(input: {
      readonly record: PaymentCompensationCase;
      readonly audit: AppendAuditRecordInput;
      readonly fenceReference: string;
      readonly fenceVersion: number;
    }): Promise<
      | { readonly status: "Created" | "Existing"; readonly record: PaymentCompensationCase }
      | { readonly status: "Conflict"; readonly record: PaymentCompensationCase }
    >;
    reconcile(input: {
      readonly current: PaymentCompensationCase;
      readonly next: PaymentCompensationCase;
      readonly refund: PaymentProviderConfirmedRefundFact | null;
      readonly operations: PaymentOperationsReconciliationReceipt | null;
      readonly fenceReference: string;
      readonly fenceVersion: number;
    }): Promise<
      | { readonly status: "Updated" | "Duplicate"; readonly record: PaymentCompensationCase }
      | { readonly status: "Conflict"; readonly record: PaymentCompensationCase }
    >;
  };
  readonly actions: {
    resolve(input: {
      readonly actionReference: string;
    }): Promise<PaymentCompensationActionReceipt | null>;
    claim(input: {
      readonly receipt: PaymentCompensationActionReceipt;
      readonly audit: AppendAuditRecordInput;
      readonly interacEvidence: PaymentInteracInPersonClaimReceipt | null;
      readonly fenceReference: string;
      readonly fenceVersion: number;
    }): Promise<PaymentCompensationActionReceipt>;
    recordOutcome(input: {
      readonly actionReference: string;
      readonly expectedPhase: PaymentCompensationActionPhase;
      readonly nextPhase: Exclude<PaymentCompensationActionPhase, "Claimed">;
      readonly observedAt: string;
      readonly fenceReference: string;
      readonly fenceVersion: number;
    }): Promise<PaymentCompensationActionReceipt>;
  };
  readonly interac: {
    resolveClaim(input: {
      readonly actionReference: string;
      readonly evidenceReference: string;
    }): Promise<PaymentInteracInPersonClaimReceipt | null>;
    resolve(input: {
      readonly compensationCaseReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly paymentTransactionReference: string;
      readonly paymentAttemptReference: string;
    }): Promise<PaymentInteracInPersonEvidence | null>;
    claim(input: {
      readonly evidence: PaymentInteracInPersonEvidence;
      readonly actionReference: string;
      readonly claimedAt: string;
      readonly fenceReference: string;
      readonly fenceVersion: number;
    }): Promise<PaymentInteracInPersonClaimReceipt>;
  };
  readonly provider: PaymentProviderAdapter;
  readonly refunds: {
    resolve(input: {
      readonly compensationCaseReference: string;
    }): Promise<PaymentRefundCompositionReceipt | null>;
    record(input: {
      readonly fact: PaymentProviderConfirmedRefundFact;
      readonly event: PaymentRefundedEnvelope;
      readonly audit: AppendAuditRecordInput;
      readonly fenceReference: string;
      readonly fenceVersion: number;
    }): Promise<
      | {
          readonly status: "Created" | "Duplicate";
          readonly receipt: PaymentRefundCompositionReceipt;
        }
      | {
          readonly status: "Conflict";
          readonly receipt: PaymentRefundCompositionReceipt;
        }
    >;
  };
  readonly operations: {
    resolve(input: {
      readonly compensationCaseReference: string;
    }): Promise<PaymentOperationsReconciliationReceipt | null>;
  };
  readonly audit: {
    createCase(input: {
      readonly caseReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly paymentTransactionReference: string;
      readonly occurredAt: string;
    }): Promise<AppendAuditRecordInput>;
    createAction(input: {
      readonly actionReference: string;
      readonly caseReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly paymentTransactionReference: string;
      readonly occurredAt: string;
    }): Promise<AppendAuditRecordInput>;
    createRefund(input: {
      readonly refundReference: string;
      readonly caseReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly occurredAt: string;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly references: {
    hash(value: string): string;
    equals(left: string, right: string): boolean;
    operationFor(input: {
      readonly environment: "Test" | "Live";
      readonly brandReference: string;
      readonly storeReference: string;
      readonly orderReference: string;
      readonly paymentTransactionReference: string;
      readonly paymentAttemptReference: string;
      readonly purpose: "CompensatePaidWithoutFulfillableOrder";
    }): string;
    caseFor(input: {
      readonly environment: "Test" | "Live";
      readonly paymentTransactionReference: string;
      readonly paymentAttemptReference: string;
      readonly orderReference: string;
      readonly reason: "PaidWithoutFulfillableOrder";
      readonly purpose: "CompensatePaidWithoutFulfillableOrder";
    }): string;
    actionFor(input: {
      readonly environment: "Test" | "Live";
      readonly compensationCaseReference: string;
      readonly paymentTransactionReference: string;
      readonly paymentAttemptReference: string;
      readonly purpose: "RefundPaidWithoutFulfillableOrder";
    }): string;
    providerIdempotencyKey(input: {
      readonly environment: "Test" | "Live";
      readonly compensationCaseReference: string;
      readonly paymentTransactionReference: string;
      readonly paymentAttemptReference: string;
      readonly actionReference: string;
      readonly purpose: "RefundPaidWithoutFulfillableOrder";
      readonly amountMinor: bigint;
      readonly currencyCode: "CAD";
      readonly actionDigest: string;
    }): string;
    refundFor(input: {
      readonly compensationCaseReference: string;
      readonly paymentTransactionReference: string;
    }): string;
    eventFor(input: { readonly refundReference: string }): string;
    causationFor(input: {
      readonly compensationCaseReference: string;
      readonly paymentAttemptReference: string;
      readonly source: "ProviderRetrieval" | "VerifiedWebhook";
    }): string;
  };
}
