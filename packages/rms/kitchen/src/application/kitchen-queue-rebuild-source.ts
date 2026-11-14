import type { ConsumerTransaction } from "@bop/eventing";
import type { KitchenQueueProjectionPorts } from "./ports/kitchen-queue-projection-ports.js";
import {
  buildKitchenQueueRows,
  computeKitchenQueueSnapshotDigest,
  computeKitchenQueueSourceEventBindingDigest,
  KitchenQueueProjectionError,
  parseKitchenQueueLifecycleRebuildSourceFeed,
  parseKitchenQueueSourceFeed,
  reconcileKitchenQueueStoredProjectionBundle,
  type KitchenQueueLifecycleSourceFeed,
  type KitchenQueueStoredProjectionBundle,
} from "../domain/kitchen-queue-projection.js";
import { parseKitchenTicketReference } from "../domain/kitchen-ticket.js";

const encode = (value: unknown) =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));

/** Binds full rebuilds to the owner's complete snapshot read in this transaction.
 * Incremental event offsets require a separate producer checkpoint implementation.
 */
interface KitchenQueueRebuildSource {
  sources: Pick<KitchenQueueProjectionPorts["sources"], "loadRebuild">;
  checkpoints: Pick<KitchenQueueProjectionPorts["checkpoints"], "compareRebuild">;
  matchesCurrentContent(
    transaction: ConsumerTransaction,
    bundle: KitchenQueueStoredProjectionBundle,
  ): Promise<boolean>;
  validateCurrentSource(
    transaction: ConsumerTransaction,
    bundle: KitchenQueueStoredProjectionBundle,
  ): Promise<boolean>;
}

export function createKitchenQueueRebuildSource(options: {
  brandReference: string;
  storeReference: string;
  readSnapshot(transaction: ConsumerTransaction): Promise<unknown>;
  sha256(value: string): string;
}): KitchenQueueRebuildSource {
  const brand = parseKitchenTicketReference(options.brandReference);
  const store = parseKitchenTicketReference(options.storeReference);
  const snapshots = new WeakMap<ConsumerTransaction, KitchenQueueLifecycleSourceFeed>();
  const inScope = (value: { brandReference: string; storeReference: string }) =>
    value.brandReference === brand && value.storeReference === store;
  const result: KitchenQueueRebuildSource = {
    sources: {
      async loadRebuild({ request, transaction }) {
        snapshots.delete(transaction);
        if (!inScope(request))
          throw new KitchenQueueProjectionError("KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE");
        const raw = await options.readSnapshot(transaction);
        const source = parseKitchenQueueLifecycleRebuildSourceFeed(raw, options.sha256);
        if (!inScope(source.queueFeed))
          throw new KitchenQueueProjectionError("KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE");
        snapshots.set(transaction, source);
        return raw;
      },
    },
    checkpoints: {
      async compareRebuild(input) {
        const captured = snapshots.get(input.transaction);
        if (
          !inScope(input) ||
          !captured ||
          input.candidate.coverageStatus !== "CompleteThroughCheckpoint" ||
          input.candidate.sourceCheckpointReference !==
            captured.queueFeed.sourceCheckpointReference ||
          input.candidate.asOfUtc !== captured.queueFeed.asOfUtc ||
          encode(input.candidate.completeSourceFeed) !== encode(captured)
        )
          return "Unknown";
        if (input.current === null) return "Initial";
        if (
          input.current.sourceCheckpointReference === captured.queueFeed.sourceCheckpointReference
        )
          return input.current.asOfUtc === captured.queueFeed.asOfUtc ? "Exact" : "ChangedAsOf";
        if (Date.parse(input.current.asOfUtc) > Date.parse(captured.queueFeed.asOfUtc))
          return "Regression";
        if (!Number.isFinite(Date.parse(input.current.asOfUtc))) return "Unknown";
        return "Successor";
      },
    },
    async validateCurrentSource(transaction, bundle) {
      const source = snapshots.get(transaction);
      return (
        source !== undefined &&
        bundle.generation.sourceCheckpointReference ===
          source.queueFeed.sourceCheckpointReference &&
        bundle.generation.asOfUtc === source.queueFeed.asOfUtc &&
        result.matchesCurrentContent(transaction, bundle)
      );
    },
    async matchesCurrentContent(transaction, bundle) {
      try {
        reconcileKitchenQueueStoredProjectionBundle(bundle, options.sha256);
      } catch {
        return false;
      }
      const source = snapshots.get(transaction);
      if (
        !source ||
        !inScope(bundle.generation) ||
        Date.parse(source.queueFeed.asOfUtc) < Date.parse(bundle.generation.asOfUtc) ||
        bundle.generation.ticketCount !== source.queueFeed.tickets.length
      )
        return false;
      const feed = parseKitchenQueueSourceFeed({
        ...source.queueFeed,
        tickets: source.queueFeed.tickets.map((ticket) => ({
          brandReference: ticket.brandReference,
          storeReference: ticket.storeReference,
          ticketReference: ticket.ticketReference,
          orderReference: ticket.orderReference,
          orderBatchReference: ticket.orderBatchReference,
          ticketAggregateVersion: ticket.ticketAggregateVersion,
          ticketStatus: ticket.ticketStatus,
          sourceEvent: ticket.sourceEvent,
          items: ticket.items,
        })),
      });
      const rows = buildKitchenQueueRows({
        generationReference: bundle.generation.projectionGenerationReference,
        feed,
        sha256: options.sha256,
      });
      return (
        bundle.rows.length === rows.length &&
        bundle.generation.sourceEventBindingDigest ===
          computeKitchenQueueSourceEventBindingDigest(rows, options.sha256) &&
        bundle.generation.queueSnapshotDigest ===
          computeKitchenQueueSnapshotDigest(
            { brandReference: brand, storeReference: store, rows },
            options.sha256,
          )
      );
    },
  };
  return result;
}
