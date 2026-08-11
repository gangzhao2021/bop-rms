import type { AppendAuditRecordInput } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";

import type { KitchenWorkLifecycleEnvelope } from "../../contracts/kitchen-work-lifecycle-events.js";
import type {
  KitchenCapturedExpoDecision,
  KitchenExpoPolicyDecision,
  KitchenLifecycleWorkItemStatus,
  KitchenStartAdmissionDecision,
  KitchenWorkLifecycleAction,
  KitchenWorkLifecycleCommand,
  KitchenWorkLifecyclePurpose,
  KitchenWorkLifecycleResult,
} from "../../contracts/kitchen-work-lifecycle.js";

export type KitchenWorkLifecycleActionCode =
  | "KITCHEN_WORK_ITEM_ACCEPTED"
  | "KITCHEN_WORK_ITEM_STARTED"
  | "KITCHEN_WORK_ITEM_COMPLETION_RECORDED"
  | "KITCHEN_ORDER_ITEM_READY";

export type KitchenWorkLifecycleReasonCode =
  | "WORK_ITEM_ACCEPTED"
  | "WORK_ITEM_STARTED"
  | "COMPLETION_QUANTITY_RECORDED"
  | "EXPO_MARKED_READY"
  | "ALL_WORK_ITEMS_COMPLETED";

export interface KitchenWorkLifecycleMutation {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly ticketReference: string;
  readonly workItemReference: string;
  readonly orderItemReference: string;
  readonly expectedTicketVersion: bigint;
  readonly resultTicketVersion: bigint;
  readonly expectedWorkItemVersion: bigint;
  readonly resultWorkItemVersion: bigint;
  readonly beforeStatus: KitchenLifecycleWorkItemStatus;
  readonly afterStatus: KitchenLifecycleWorkItemStatus;
  readonly beforeCompletedQuantity: number;
  readonly afterCompletedQuantity: number;
  readonly requiredQuantity: number;
  readonly updatedAt: string;
}

export interface KitchenOrderItemReadyResult {
  readonly readyResultReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly ticketReference: string;
  readonly orderItemReference: string;
  readonly causalOperationReference: string;
  readonly actorType: "User" | "System";
  readonly actorReference: string | null;
  readonly workItems: readonly [
    Readonly<{ readonly workItemReference: string; readonly workItemVersion: bigint }>,
  ];
  readonly workItemsDigest: string;
  readonly readyQuantity: number;
  readonly requiredQuantity: number;
  readonly capturedExpo: KitchenCapturedExpoDecision;
  readonly readyAt: string;
}

export interface KitchenWorkLifecycleOperationRecord {
  readonly operationReference: string;
  readonly idempotencyKey: string | null;
  readonly intentDigest: string | null;
  readonly action: KitchenWorkLifecycleAction | "AutomaticKitchenOrderItemReady";
  readonly actionCode: KitchenWorkLifecycleActionCode;
  readonly purpose: KitchenWorkLifecyclePurpose;
  readonly reasonCode: KitchenWorkLifecycleReasonCode;
  readonly sourceChannel: "KDS_COMMAND" | "KITCHEN_AUTOMATION";
  readonly actorType: "User" | "System";
  readonly actorReference: string | null;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly ticketReference: string;
  readonly workItemReference: string | null;
  readonly orderItemReference: string;
  readonly expectedTicketVersion: bigint | null;
  readonly resultTicketVersion: bigint;
  readonly expectedWorkItemVersion: bigint | null;
  readonly resultWorkItemVersion: bigint | null;
  readonly beforeStatus: KitchenLifecycleWorkItemStatus | null;
  readonly afterStatus: KitchenLifecycleWorkItemStatus | null;
  readonly quantityDelta: number | null;
  readonly completedQuantity: number | null;
  readonly requiredQuantity: number | null;
  readonly acceptedOperationReference: string | null;
  readonly startedOperationReference: string | null;
  readonly admissionDecision: KitchenStartAdmissionDecision | null;
  readonly capturedExpo: KitchenCapturedExpoDecision | null;
  readonly parentOperationReference: string | null;
  readonly readyResultReference: string | null;
  readonly auditReference: string;
  readonly auditSemanticDigest: string;
  readonly eventReference: string | null;
  readonly eventSemanticDigest: string | null;
  readonly correlationReference: string;
  readonly causationReference: string | null;
  readonly occurredAt: string;
  readonly replayExpiresAt: string | null;
}

export interface KitchenWorkLifecycleEffect {
  readonly command: KitchenWorkLifecycleCommand;
  readonly intentDigest: string;
  readonly operation: KitchenWorkLifecycleOperationRecord;
  readonly mutation: KitchenWorkLifecycleMutation;
  readonly readyResult: KitchenOrderItemReadyResult | null;
  readonly automaticReadyOperation: KitchenWorkLifecycleOperationRecord | null;
  readonly automaticReadyEffectDigest: string | null;
  readonly audits: readonly AppendAuditRecordInput[];
  readonly event: KitchenWorkLifecycleEnvelope | null;
  readonly result: KitchenWorkLifecycleResult;
  readonly effectDigest: string;
}

export type KitchenWorkLifecycleResolution =
  { readonly status: "NotFound" } | { readonly status: "Found"; readonly effect: unknown };

export type KitchenWorkLifecycleCommit =
  { readonly status: "Committed"; readonly effect: unknown } | { readonly status: "Conflict" };

export type KitchenWorkLifecycleReferencePurpose =
  "KitchenWorkLifecycleOperation" | "KitchenWorkLifecycleAudit" | "KitchenWorkLifecycleEvent";

export type KitchenWorkLifecycleStableReferencePurpose =
  "KitchenAutomaticOrderItemReadyOperation" | "KitchenOrderItemReadyResult";

export interface KitchenWorkLifecyclePorts {
  readonly trustedContext: {
    resolveAuthority(): Promise<unknown>;
  };
  readonly correlationContext: {
    resolve(): Promise<unknown>;
  };
  readonly authorization: {
    authorize(input: {
      readonly action: KitchenWorkLifecycleAction;
      readonly purpose: KitchenWorkLifecyclePurpose;
      readonly permission: "kitchen.operate";
      readonly actorReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly observedAt: string;
    }): Promise<boolean>;
  };
  readonly transactions: {
    withTransaction<T>(operation: (transaction: ConsumerTransaction) => Promise<T>): Promise<T>;
  };
  readonly tenantContext: {
    install(input: {
      readonly actorReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly purpose: KitchenWorkLifecyclePurpose;
      readonly transaction: ConsumerTransaction;
    }): Promise<void>;
  };
  readonly idempotency: {
    acquireFence(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly idempotencyKey: string;
      readonly transaction: ConsumerTransaction;
    }): Promise<void>;
  };
  readonly repository: {
    resolveByIdempotency(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly idempotencyKey: string;
      readonly transaction: ConsumerTransaction;
    }): Promise<KitchenWorkLifecycleResolution>;
    loadSourceForUpdate(input: {
      readonly command: KitchenWorkLifecycleCommand;
      readonly transaction: ConsumerTransaction;
    }): Promise<unknown | null>;
    commit(input: {
      readonly effect: KitchenWorkLifecycleEffect;
      readonly transaction: ConsumerTransaction;
    }): Promise<KitchenWorkLifecycleCommit>;
  };
  readonly admission: {
    resolve(input: {
      readonly command: Extract<
        KitchenWorkLifecycleCommand,
        { readonly action: "StartKitchenWorkItem" }
      >;
      readonly acceptedOperationReference: string;
      readonly observedAt: string;
    }): Promise<unknown | null>;
  };
  readonly expo: {
    resolve(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly purpose: "KitchenReadiness";
      readonly ticketReference: string;
      readonly workItemReference: string;
      readonly orderItemReference: string;
      readonly observedAt: string;
    }): Promise<unknown | null>;
  };
  readonly references: {
    next(purpose: KitchenWorkLifecycleReferencePurpose): string;
    derive(purpose: KitchenWorkLifecycleStableReferencePurpose, canonicalIdentity: string): string;
  };
  readonly clock: {
    now(): string;
  };
  readonly digests: {
    sha256(canonicalValue: string): string;
  };
}

export type KitchenLifecycleExpoResolution = KitchenExpoPolicyDecision;
