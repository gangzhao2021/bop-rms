import { createKitchenQueueProjectionService } from "../application/kitchen-queue-projection-service.js";
import { createKitchenQueueRebuildSource } from "../application/kitchen-queue-rebuild-source.js";
import type { KitchenQueueProjectionPorts } from "../application/ports/kitchen-queue-projection-ports.js";
import {
  parseKitchenQueueRebuildRequest,
  reconcileKitchenQueueStoredProjectionBundle,
  KitchenQueueProjectionError,
} from "../domain/kitchen-queue-projection.js";
import { createPostgresKitchenQueueSourceReader } from "./persistence/kitchen-queue-source-reader.js";
import { createPostgresKitchenQueueProjectionStore } from "./persistence/kitchen-queue-projection-store.js";
import { createPostgresKitchenQueueQueries } from "./persistence/kitchen-queue-queries.js";

/**
 * WP-2423 batch 52: the change an event consumer refreshes the board for. When the active board
 * already shows that ticket at or after the change, the refresh answers 0 without a rebuild.
 */
export type KitchenQueueRefreshChange =
  | { readonly ticketReference: string; readonly ticketVersion: bigint }
  | { readonly ticketReference: string; readonly readyResultReference: string };

/** Scoped PostgreSQL rebuild/read composition. Transactions must provide a bounded
 * consistent read snapshot; query authority and every authorization remain explicit.
 * Event consumers are deliberately not exposed until incremental sources are configured.
 */
export function createPostgresKitchenQueueReadModel(options: {
  source: Parameters<typeof createPostgresKitchenQueueSourceReader>[0];
  maxRows: number;
  nextRebuildReference(): string;
  authorizeProjection: Parameters<typeof createPostgresKitchenQueueProjectionStore>[0]["authorize"];
  authorizeQuery: Parameters<typeof createPostgresKitchenQueueQueries>[0]["authorize"];
  ports: Pick<
    KitchenQueueProjectionPorts,
    | "authorization"
    | "trustedContext"
    | "transactions"
    | "tenantContext"
    | "locks"
    | "references"
    | "clock"
  >;
}) {
  const scope = {
    brandReference: options.source.brandReference,
    storeReference: options.source.storeReference,
  };
  const sha256 = options.source.lifecycleValidation.digests.sha256;
  const reader = createPostgresKitchenQueueSourceReader(options.source);
  const source = createKitchenQueueRebuildSource({ ...scope, readSnapshot: reader.read, sha256 });
  const unavailable = async (): Promise<never> => {
    throw new KitchenQueueProjectionError("KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE");
  };
  const projections = createPostgresKitchenQueueProjectionStore({
    ...scope,
    maxRows: options.maxRows,
    sha256,
    authorize: options.authorizeProjection,
    validateCurrentSource: source.validateCurrentSource,
  });
  const ports: KitchenQueueProjectionPorts = {
    ...options.ports,
    digests: { sha256 },
    sources: {
      ...source.sources,
      loadIncremental: unavailable,
      loadLifecycleIncremental: unavailable,
    },
    checkpoints: {
      ...source.checkpoints,
      compareIncremental: unavailable,
      compareLifecycleIncremental: unavailable,
    },
    projections,
    queries: createPostgresKitchenQueueQueries({ ...scope, authorize: options.authorizeQuery }),
  };
  const service = createKitchenQueueProjectionService(ports);
  /**
   * Rebuilds the board from the owner snapshot when its content changed. With `change` (an
   * event consumer): one Kitchen tap records up to five events (accepted, started, completed,
   * item ready, order ready) and each refreshed the whole board, about 0.25 s apiece on v15, one
   * after another, so the order-ready event reached pickup 2-3 s after the tap. The first
   * refresh already shows the ticket at its new version; later ones now answer 0 at once.
   */
  async function refresh(change?: KitchenQueueRefreshChange): Promise<0 | 1> {
    const observedAt = ports.clock.now();
    const rebuildReference = options.nextRebuildReference();
    if (
      (await ports.authorization.authorize({
        ...scope,
        action: "RebuildKitchenQueueProjection",
        purpose: "ProjectionRecovery",
        actorType: "System",
        actorReference: null,
        rebuildReference,
        observedAt,
      })) !== true
    )
      throw new KitchenQueueProjectionError("KITCHEN_QUEUE_PERMISSION_DENIED");
    return ports.transactions.withTransaction(async (transaction) => {
      await ports.tenantContext.install({
        ...scope,
        actorReference: null,
        purpose: "ProjectionRecovery",
        transaction,
      });
      await ports.locks.acquireStoreProjection({
        ...scope,
        projectionName: "kitchen_work_queue_v1",
        transaction,
      });
      if (
        change !== undefined &&
        (await projections.reflectsTicket({
          transaction,
          ticketReference: change.ticketReference,
          ticketVersion: "ticketVersion" in change ? change.ticketVersion : null,
          readyResultReference:
            "readyResultReference" in change ? change.readyResultReference : null,
        }))
      )
        return 0;
      const loaded = await ports.projections.loadActive({ ...scope, transaction });
      const active =
        loaded.status === "NotFound"
          ? null
          : reconcileKitchenQueueStoredProjectionBundle(
              { generation: loaded.generation, rows: loaded.rows },
              sha256,
            );
      const request = parseKitchenQueueRebuildRequest({
        ...scope,
        action: "RebuildKitchenQueueProjection",
        purpose: "ProjectionRecovery",
        projectionName: "kitchen_work_queue_v1",
        projectionVersion: 1,
        rebuildReference,
        expectedActiveGenerationReference: active?.generation.projectionGenerationReference ?? null,
        requestedAt: observedAt,
      });
      const captured = await source.sources.loadRebuild({ request, transaction });
      if (
        active &&
        active.generation.freshnessStatus === "Fresh" &&
        (await source.matchesCurrentContent(transaction, active))
      )
        return 0;
      // Reuse the same locked transaction and captured snapshot. The normal service
      // performs authority, expected-generation, digest and persistence checks again.
      const bound = createKitchenQueueProjectionService({
        ...ports,
        transactions: { withTransaction: (work) => work(transaction) },
        sources: { ...ports.sources, loadRebuild: async () => captured },
      });
      await bound.rebuild(request);
      return 1;
    });
  }
  return Object.freeze({ rebuild: service.rebuild, list: service.list, get: service.get, refresh });
}
