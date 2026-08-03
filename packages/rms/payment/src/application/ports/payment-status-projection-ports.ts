import type { PaymentTerminalEnvelope } from "../../contracts/payment-terminal-event.js";
import type {
  PaymentStatusProjection,
  PaymentStatusFreshness,
} from "../payment-status-projection.js";

export interface PaymentStatusProjectionPorts {
  readonly references: {
    generateGeneration(): string;
    now(): string;
  };
  readonly repository: {
    consume(input: {
      readonly consumerName: "payment.status-projection:v1";
      readonly event: PaymentTerminalEnvelope;
      readonly projection: PaymentStatusProjection;
    }): Promise<
      | { readonly status: "Completed"; readonly projection: PaymentStatusProjection }
      | { readonly status: "Duplicate"; readonly projection: PaymentStatusProjection }
      | { readonly status: "Conflict"; readonly projection: PaymentStatusProjection }
    >;
    rebuild(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly generationReference: string;
      readonly rebuiltAt: string;
      readonly projections: readonly PaymentStatusProjection[];
    }): Promise<readonly PaymentStatusProjection[]>;
  };
  readonly rebuild: {
    authorize(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly actorReference: string;
      readonly purpose: "RebuildPaymentStatusProjection";
      readonly requestedAt: string;
    }): Promise<boolean>;
    loadTerminalEvents(input: {
      readonly brandReference: string;
      readonly storeReference: string;
    }): Promise<readonly PaymentTerminalEnvelope[]>;
  };
}

export interface PaymentStatusQueryPorts {
  readonly authorization: {
    authorize(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly actorReference: string;
      readonly purpose: "PaymentStatusRead";
      readonly observedAt: string;
    }): Promise<boolean>;
  };
  readonly projections: {
    load(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly paymentIntentReference: string;
    }): Promise<PaymentStatusProjection | null>;
    list(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly exactPaymentOrOrderReference: string | null;
      readonly terminalStatus: "Succeeded" | "Failed" | null;
      readonly occurredFrom: string | null;
      readonly occurredUntil: string | null;
      readonly afterOccurredAt: string | null;
      readonly afterPaymentIntentReference: string | null;
      readonly freshnessStatus: PaymentStatusFreshness | null;
      readonly limit: number;
    }): Promise<readonly PaymentStatusProjection[]>;
  };
}
