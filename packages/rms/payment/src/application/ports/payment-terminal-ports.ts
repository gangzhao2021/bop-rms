import type { AppendAuditRecordInput } from "@bop/audit";

import type { PaymentTerminalEnvelope } from "../../contracts/payment-terminal-event.js";
import type {
  PaymentTerminalFact,
  PaymentTerminalIntentSource,
  PaymentTerminalObservation,
} from "../payment-terminal-fact.js";

export interface PaymentTerminalPorts {
  readonly clock: {
    now(): string;
  };
  readonly references: {
    generate(purpose: "PaymentTransaction" | "Event"): string;
  };
  readonly source: {
    resolve(observation: PaymentTerminalObservation): Promise<PaymentTerminalIntentSource | null>;
  };
  readonly audit: {
    create(input: {
      readonly fact: Omit<PaymentTerminalFact, "event">;
      readonly correlationReference: string;
    }): Promise<AppendAuditRecordInput>;
  };
  readonly repository: {
    commit(input: {
      readonly fact: PaymentTerminalFact;
      readonly audit: AppendAuditRecordInput;
      readonly event: PaymentTerminalEnvelope;
    }): Promise<
      | { readonly status: "Created"; readonly fact: PaymentTerminalFact }
      | { readonly status: "AlreadyCommitted"; readonly fact: PaymentTerminalFact }
      | { readonly status: "Conflict"; readonly fact: PaymentTerminalFact }
    >;
  };
}
