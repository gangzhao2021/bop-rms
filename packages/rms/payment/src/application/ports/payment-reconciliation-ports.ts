import type {
  PaymentProviderOutcome,
  RetrieveIntentRequest,
} from "../../contracts/payment-provider-adapter.js";
import type { PaymentTerminalObservation } from "../payment-terminal-fact.js";
import type {
  PaymentOperationalReconciliationCandidate,
  PaymentReconciliationDifferenceReason,
  PaymentReconciliationCheck,
  PaymentReconciliationOutcome,
  PaymentReconciliationRunInput,
  PaymentReconciliationRunResult,
  PaymentSettlementReconciliationCandidate,
} from "../payment-reconciliation.js";

export interface PaymentReconciliationPorts {
  readonly authorization: {
    authorize(input: PaymentReconciliationRunInput): Promise<boolean>;
  };
  readonly lease: {
    claim(input: {
      readonly runReference: string;
      readonly jobName: "payment-reconciliation:v1";
      readonly scheduledAt: string;
    }): Promise<boolean>;
    release(input: {
      readonly runReference: string;
      readonly jobName: "payment-reconciliation:v1";
    }): Promise<void>;
  };
  readonly repository: {
    loadRun(input: {
      readonly runReference: string;
    }): Promise<PaymentReconciliationRunResult | null>;
    commit(
      input: PaymentReconciliationRunResult,
    ): Promise<
      | { readonly status: "Created"; readonly result: PaymentReconciliationRunResult }
      | { readonly status: "Duplicate"; readonly result: PaymentReconciliationRunResult }
      | { readonly status: "Conflict"; readonly result: PaymentReconciliationRunResult }
    >;
  };
  readonly candidates: {
    claimOperational(input: {
      readonly runReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly cutoffAt: string;
      readonly limit: number;
    }): Promise<readonly PaymentOperationalReconciliationCandidate[]>;
    claimDailySettlement(input: {
      readonly runReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly cutoffAt: string;
      readonly limit: number;
    }): Promise<readonly PaymentSettlementReconciliationCandidate[]>;
  };
  readonly provider: {
    retrieveIntent(request: RetrieveIntentRequest): Promise<PaymentProviderOutcome>;
  };
  readonly terminal: {
    record(observation: PaymentTerminalObservation): Promise<{
      readonly status: "Created" | "AlreadyCommitted";
      readonly paymentTransactionReference: string;
    }>;
  };
  readonly references: {
    generate(purpose: "Check" | "Observation"): string;
    exceptionFor(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly candidateReference: string;
      readonly reason: PaymentReconciliationDifferenceReason;
    }): string;
  };
  readonly clock: { now(): string };
}

export interface PaymentReconciliationQueryPorts {
  readonly authorization: {
    authorize(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly actorReference: string;
      readonly purpose: "PaymentReconciliationRead";
      readonly observedAt: string;
    }): Promise<boolean>;
  };
  readonly checks: {
    list(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly exactReference: string | null;
      readonly outcome: PaymentReconciliationOutcome | null;
      readonly hasException: boolean | null;
      readonly checkedFrom: string | null;
      readonly checkedUntil: string | null;
      readonly afterCheckedAt: string | null;
      readonly afterCheckReference: string | null;
      readonly limit: number;
    }): Promise<readonly PaymentReconciliationCheck[]>;
  };
}
