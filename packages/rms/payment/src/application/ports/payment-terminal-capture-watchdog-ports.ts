import type { AppendAuditRecordInput } from "@bop/audit";
import type { TaskRecord } from "@bop/task";
import type { OrderAcceptanceEvidence } from "@rms/ordering";

import type { PaymentProviderAdapter } from "../../contracts/payment-provider-adapter.js";
import type { PaymentTerminalObservation } from "../payment-terminal-fact.js";
import type {
  PaymentTerminalAuthorizationEvidence,
  PaymentTerminalCaptureWatchdogCommand,
  PaymentTerminalCaptureWatchdogOperationRecord,
  PaymentTerminalWatchdogAction,
  PaymentTerminalWatchdogActionReceipt,
  PaymentTerminalWatchdogExceptionReceipt,
  PaymentTerminalWatchdogLeaseReceipt,
  PaymentTerminalWatchdogTerminalReceipt,
} from "../payment-terminal-capture-watchdog.js";

export interface PaymentTerminalCaptureWatchdogPorts {
  readonly authorization: {
    authorize(command: PaymentTerminalCaptureWatchdogCommand): Promise<boolean>;
  };
  readonly repository: {
    resolveOperation(input: {
      readonly operationReference: string;
    }): Promise<PaymentTerminalCaptureWatchdogOperationRecord | null>;
    commit(input: {
      readonly record: PaymentTerminalCaptureWatchdogOperationRecord;
      readonly fenceReference: string;
      readonly fenceVersion: number;
    }): Promise<
      | {
          readonly status: "Created" | "Duplicate";
          readonly record: PaymentTerminalCaptureWatchdogOperationRecord;
        }
      | {
          readonly status: "Conflict";
          readonly record: PaymentTerminalCaptureWatchdogOperationRecord;
        }
    >;
  };
  readonly lease: {
    claim(input: {
      readonly paymentAttemptReference: string;
      readonly operationReference: string;
      readonly jobName: "payment-terminal-capture-watchdog:v1";
    }): Promise<PaymentTerminalWatchdogLeaseReceipt | null>;
    release(input: {
      readonly paymentAttemptReference: string;
      readonly operationReference: string;
      readonly jobName: "payment-terminal-capture-watchdog:v1";
      readonly fenceReference: string;
      readonly fenceVersion: number;
    }): Promise<void>;
  };
  readonly clock: {
    now(): string;
  };
  readonly source: {
    resolveAuthorization(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly paymentAttemptReference: string;
    }): Promise<PaymentTerminalAuthorizationEvidence | null>;
  };
  readonly ordering: {
    resolveAcceptance(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly orderReference: string;
      readonly orderBatchReference: string;
      readonly paymentAttemptReference: string;
    }): Promise<OrderAcceptanceEvidence | null>;
  };
  readonly audit: {
    createAction(input: {
      readonly action: PaymentTerminalWatchdogAction;
      readonly actionReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly paymentAttemptReference: string;
      readonly actorReference: string | null;
      readonly occurredAt: string;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly actions: {
    resolve(input: {
      readonly action: PaymentTerminalWatchdogAction;
      readonly paymentAttemptReference: string;
    }): Promise<PaymentTerminalWatchdogActionReceipt | null>;
    claim(input: {
      readonly action: PaymentTerminalWatchdogAction;
      readonly actionReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly paymentAttemptReference: string;
      readonly authorizationDigest: string;
      readonly acceptanceDigest: string | null;
      readonly actionDigest: string;
      readonly providerIdempotencyKey: string;
      readonly claimedAt: string;
      readonly fenceReference: string;
      readonly fenceVersion: number;
      readonly audit: AppendAuditRecordInput;
    }): Promise<PaymentTerminalWatchdogActionReceipt>;
    recordOutcome(input: {
      readonly actionReference: string;
      readonly paymentAttemptReference: string;
      readonly expectedPhase:
        "Claimed" | "InvocationUnknown" | "ResolvedAuthorized" | "TerminalObserved";
      readonly nextPhase: "InvocationUnknown" | "ResolvedAuthorized" | "TerminalObserved";
      readonly observedAt: string;
      readonly fenceReference: string;
      readonly fenceVersion: number;
    }): Promise<PaymentTerminalWatchdogActionReceipt>;
  };
  readonly provider: PaymentProviderAdapter;
  readonly terminal: {
    resolve(input: {
      readonly paymentAttemptReference: string;
    }): Promise<PaymentTerminalWatchdogTerminalReceipt | null>;
    record(
      observation: PaymentTerminalObservation,
    ): Promise<PaymentTerminalWatchdogTerminalReceipt>;
  };
  readonly tasks: {
    ensure(input: {
      readonly taskReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly sourceType: "PAYMENT_ATTEMPT";
      readonly sourceReference: string;
      readonly sourceDigest: string;
      readonly taskType: "TERMINAL_CAPTURE_WATCHDOG";
      readonly severityCode: "CRITICAL";
      readonly priorityCode: "CRITICAL";
      readonly assignmentKind: "Queue";
      readonly hardDeadline: string;
      readonly requestedAt: string;
      readonly evaluatedAt: string;
      readonly receiptValidUntil: string;
    }): Promise<TaskRecord>;
  };
  readonly exceptions: {
    ensure(
      input: PaymentTerminalWatchdogExceptionReceipt,
    ): Promise<PaymentTerminalWatchdogExceptionReceipt>;
  };
  readonly references: {
    hash(value: string): string;
    equals(left: string, right: string): boolean;
    actionFor(input: {
      readonly paymentAttemptReference: string;
      readonly action: "Capture" | "Cancel";
    }): string;
    providerIdempotencyKey(input: {
      readonly environment: "Test" | "Live";
      readonly brandReference: string;
      readonly storeReference: string;
      readonly paymentAttemptReference: string;
      readonly action: "Capture" | "Cancel";
      readonly purpose: "CapturePaymentIntent" | "CancelPaymentIntent";
      readonly amountMinor: bigint;
      readonly currencyCode: "CAD";
    }): string;
    observationFor(input: {
      readonly paymentAttemptReference: string;
      readonly outcome: "Captured" | "Failed";
    }): string;
    terminalCausationFor(input: {
      readonly paymentAttemptReference: string;
      readonly outcome: "Captured" | "Failed";
    }): string;
    taskFor(input: { readonly paymentAttemptReference: string }): string;
    exceptionFor(input: { readonly paymentAttemptReference: string }): string;
  };
}
