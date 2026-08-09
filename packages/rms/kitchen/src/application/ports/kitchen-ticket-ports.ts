import type { AppendAuditRecordInput } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import type { ResolveConfirmedOrderKitchenSourceInput } from "@rms/ordering";

import type {
  ConfirmedOrderIntakeReceipt,
  KitchenReference,
} from "../../contracts/confirmed-order-intake.js";
import type { KitchenWorkCreatedEnvelope } from "../../contracts/kitchen-work-created-event.js";
import type {
  KitchenPlanningSource,
  KitchenTicket,
  KitchenTicketCreationAction,
} from "../../contracts/kitchen-ticket.js";

export interface KitchenTicketCreationEffect {
  readonly receipt: ConfirmedOrderIntakeReceipt;
  readonly ticket: KitchenTicket;
  readonly action: KitchenTicketCreationAction;
  readonly audit: AppendAuditRecordInput;
  readonly event: KitchenWorkCreatedEnvelope;
  readonly effectDigest: string;
}

export interface KitchenTicketSemanticIdentity {
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly sourceEventReference: KitchenReference;
  readonly confirmationReference: KitchenReference;
  readonly orderBatchReference: KitchenReference;
  readonly transaction: ConsumerTransaction;
}

export type KitchenTicketIdentityResolution =
  | { readonly status: "NotFound" }
  | { readonly status: "Resolved"; readonly effect: unknown }
  | { readonly status: "Conflict" };

export type KitchenTicketCommitResult =
  | { readonly status: "Created"; readonly effect: unknown }
  | { readonly status: "AlreadyCreated"; readonly effect: unknown }
  | { readonly status: "Conflict"; readonly effect: unknown };

export type KitchenStableReferencePurpose =
  | "KitchenTicket"
  | "KitchenWorkItem"
  | "KitchenCreationAction"
  | "KitchenCreationAudit"
  | "KitchenWorkCreatedEvent";

export interface KitchenTicketCreationPorts {
  readonly orderingSource: {
    resolve(input: ResolveConfirmedOrderKitchenSourceInput): Promise<unknown>;
  };
  readonly plans: {
    resolve(input: {
      readonly receipt: ConfirmedOrderIntakeReceipt;
      readonly source: KitchenPlanningSource;
    }): Promise<unknown | null>;
  };
  readonly clock: {
    now(): Promise<string>;
  };
  readonly references: {
    derive(purpose: KitchenStableReferencePurpose, canonicalIdentity: string): string;
  };
  readonly digests: {
    sha256(canonicalValue: string): string;
  };
  readonly repository: {
    resolveBySemanticKeys(
      input: KitchenTicketSemanticIdentity,
    ): Promise<KitchenTicketIdentityResolution>;
    commit(input: {
      readonly effect: KitchenTicketCreationEffect;
      readonly transaction: ConsumerTransaction;
    }): Promise<KitchenTicketCommitResult>;
  };
}
