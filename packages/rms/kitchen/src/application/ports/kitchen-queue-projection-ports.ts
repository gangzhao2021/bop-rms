import type { ConsumerTransaction } from "@bop/eventing";

import type { KitchenWorkLifecycleEnvelope } from "../../contracts/kitchen-work-lifecycle-events.js";

import type {
  KitchenQueueGetQuery,
  KitchenQueueListQuery,
  KitchenQueueRebuildRequest,
  KitchenQueueRow,
  KitchenQueueSourceEvent,
  KitchenQueueSourceFeed,
} from "../../contracts/kitchen-queue-projection.js";
import type {
  KitchenQueueLifecycleSourceFeed,
  KitchenQueueStoredGeneration,
} from "../../domain/kitchen-queue-projection.js";

export type KitchenQueueCheckpointComparison =
  "Initial" | "Exact" | "Successor" | "Gap" | "Regression" | "ChangedAsOf" | "Unknown";
export type KitchenQueueLifecycleCheckpointComparison = "Current" | "Successor" | "RetryRequired";

export type KitchenQueueStoredProjection =
  | { readonly status: "NotFound" }
  | {
      readonly status: "Found";
      readonly generation: unknown;
      readonly rows: unknown;
    };

export type KitchenQueueProjectionCommit =
  | {
      readonly status: "Activated";
      readonly generation: unknown;
      readonly rows: unknown;
    }
  | { readonly status: "Conflict" };

export type KitchenQueueStoredRebuild =
  | { readonly status: "NotFound" }
  | {
      readonly status: "Found";
      readonly generation: unknown;
      readonly rows: unknown;
    }
  | { readonly status: "Conflict" };

export type KitchenQueueListRead =
  | { readonly status: "NoActive" }
  | {
      readonly status: "Found";
      readonly generation: unknown;
      readonly rows: unknown;
      readonly returnedCount: unknown;
      readonly hasMore: unknown;
    };

export type KitchenQueueGetRead =
  | { readonly status: "NoActive" | "NotFound" }
  | {
      readonly status: "Found";
      readonly generation: unknown;
      readonly row: unknown;
    };

export interface KitchenQueueProjectionPorts {
  readonly authorization: {
    authorize(
      input:
        | {
            readonly action: "ProjectKitchenQueue";
            readonly purpose: "MaintainKitchenQueueProjection";
            readonly actorType: "System";
            readonly actorReference: null;
            readonly brandReference: string;
            readonly storeReference: string;
            readonly sourceEventReference: string;
            readonly observedAt: string;
          }
        | {
            readonly action: "RebuildKitchenQueueProjection";
            readonly purpose: "ProjectionRecovery";
            readonly actorType: "System";
            readonly actorReference: null;
            readonly brandReference: string;
            readonly storeReference: string;
            readonly rebuildReference: string;
            readonly observedAt: string;
          }
        | {
            readonly action: "ListKitchenQueue";
            readonly purpose: "KitchenQueueRead";
            readonly permission: "kitchen.operate";
            readonly actorReference: string;
            readonly brandReference: string;
            readonly storeReference: string;
            readonly observedAt: string;
          }
        | {
            readonly action: "GetKitchenQueueWorkItem";
            readonly purpose: "KitchenQueueRead";
            readonly permission: "kitchen.operate";
            readonly actorReference: string;
            readonly brandReference: string;
            readonly storeReference: string;
            readonly workItemReference: string;
            readonly observedAt: string;
          },
    ): Promise<boolean>;
  };
  readonly trustedContext: {
    resolveQueryAuthority(): Promise<unknown>;
  };
  readonly transactions: {
    withTransaction<T>(operation: (transaction: ConsumerTransaction) => Promise<T>): Promise<T>;
  };
  readonly tenantContext: {
    install(input: {
      readonly actorReference: string | null;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly purpose:
        "MaintainKitchenQueueProjection" | "ProjectionRecovery" | "KitchenQueueRead";
      readonly transaction: ConsumerTransaction;
    }): Promise<void>;
  };
  readonly locks: {
    acquireStoreProjection(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly projectionName: "kitchen_work_queue_v1";
      readonly transaction: ConsumerTransaction;
    }): Promise<void>;
  };
  readonly checkpoints: {
    compareIncremental(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly current: null | {
        readonly sourceCheckpointReference: string;
        readonly asOfUtc: string;
      };
      readonly candidate: {
        readonly sourceCheckpointReference: string;
        readonly asOfUtc: string;
        readonly sourceEventReference: string;
        readonly sourceEventSemanticDigest: string;
        readonly coverageStatus: "CompleteThroughCheckpoint";
        readonly sourceFeed: KitchenQueueSourceFeed;
      };
      readonly transaction: ConsumerTransaction;
    }): Promise<KitchenQueueCheckpointComparison>;
    compareRebuild(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly current: null | {
        readonly sourceCheckpointReference: string;
        readonly asOfUtc: string;
      };
      readonly candidate: {
        readonly sourceCheckpointReference: string;
        readonly asOfUtc: string;
        readonly coverageStatus: "CompleteThroughCheckpoint";
        readonly completeSourceFeed: KitchenQueueLifecycleSourceFeed;
      };
      readonly transaction: ConsumerTransaction;
    }): Promise<KitchenQueueCheckpointComparison>;
    compareLifecycleIncremental(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly current: {
        readonly sourceCheckpointReference: string;
        readonly asOfUtc: string;
        readonly generation: KitchenQueueStoredGeneration;
        readonly rows: readonly KitchenQueueRow[];
      };
      readonly candidate: {
        readonly sourceCheckpointReference: string;
        readonly asOfUtc: string;
        readonly sourceEventReference: string;
        readonly sourceEventSemanticDigest: string;
        readonly coverageStatus: "CompleteThroughCheckpoint";
        readonly lifecycleSource: KitchenQueueLifecycleSourceFeed;
      };
      readonly transaction: ConsumerTransaction;
    }): Promise<KitchenQueueLifecycleCheckpointComparison>;
  };
  readonly sources: {
    loadIncremental(input: {
      readonly event: KitchenQueueSourceEvent;
      readonly transaction: ConsumerTransaction;
    }): Promise<unknown>;
    loadRebuild(input: {
      readonly request: KitchenQueueRebuildRequest;
      readonly transaction: ConsumerTransaction;
    }): Promise<unknown>;
    loadLifecycleIncremental(input: {
      readonly event: KitchenWorkLifecycleEnvelope;
      readonly transaction: ConsumerTransaction;
    }): Promise<unknown>;
  };
  readonly projections: {
    loadActive(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly transaction: ConsumerTransaction;
    }): Promise<KitchenQueueStoredProjection>;
    loadByRebuildReference(input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly rebuildReference: string;
      readonly rebuildRequestDigest: string;
      readonly transaction: ConsumerTransaction;
    }): Promise<KitchenQueueStoredRebuild>;
    replaceActive(input: {
      readonly expectedActiveGenerationReference: string | null;
      readonly generation: KitchenQueueStoredGeneration;
      readonly rows: readonly KitchenQueueRow[];
      readonly transaction: ConsumerTransaction;
    }): Promise<KitchenQueueProjectionCommit>;
  };
  readonly queries: {
    list(input: {
      readonly query: KitchenQueueListQuery;
      readonly transaction: ConsumerTransaction;
    }): Promise<KitchenQueueListRead>;
    get(input: {
      readonly query: KitchenQueueGetQuery;
      readonly transaction: ConsumerTransaction;
    }): Promise<KitchenQueueGetRead>;
  };
  readonly references: {
    nextGenerationReference(): string;
  };
  readonly clock: {
    now(): string;
  };
  readonly digests: {
    sha256(canonicalValue: string): string;
  };
}

export type KitchenQueueQueryInput = KitchenQueueListQuery | KitchenQueueGetQuery;
