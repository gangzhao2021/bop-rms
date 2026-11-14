import { parseKitchenTicketReference } from "../domain/kitchen-ticket.js";
import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { describe, expect, it } from "vitest";
import { createKitchenQueueRebuildSource } from "../application/kitchen-queue-rebuild-source.js";
import {
  buildKitchenQueueStoredGeneration,
  parseKitchenQueueRebuildRequest,
  parseKitchenQueueLifecycleRebuildSourceFeed,
} from "../domain/kitchen-queue-projection.js";
const id = (n: number) => `0194a100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-19T12:00:00.000Z";
const sha256 = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
const transaction: ConsumerTransaction = { query: async () => ({ rows: [], rowCount: 0 }) };
const foreignTransaction: ConsumerTransaction = { query: async () => ({ rows: [], rowCount: 0 }) };
function fixture() {
  const feed = {
    brandReference: id(1),
    storeReference: id(2),
    sourceCheckpointReference: id(3),
    asOfUtc: at,
    coverageStatus: "CompleteThroughCheckpoint",
    tickets: [],
  };
  const source = createKitchenQueueRebuildSource({
    ...feed,
    readSnapshot: async () => feed,
    sha256,
  });
  const request = parseKitchenQueueRebuildRequest({
    action: "RebuildKitchenQueueProjection",
    purpose: "ProjectionRecovery",
    projectionName: "kitchen_work_queue_v1",
    projectionVersion: 1,
    brandReference: id(1),
    storeReference: id(2),
    rebuildReference: id(4),
    expectedActiveGenerationReference: null,
    requestedAt: at,
  });
  const candidate = {
    sourceCheckpointReference: id(3),
    asOfUtc: at,
    coverageStatus: "CompleteThroughCheckpoint" as const,
    completeSourceFeed: parseKitchenQueueLifecycleRebuildSourceFeed(feed, sha256),
  };
  const input = {
    brandReference: id(1),
    storeReference: id(2),
    transaction,
    candidate,
    current: null,
  };
  const generation = buildKitchenQueueStoredGeneration({
    generationReference: id(5),
    generationStatus: "Active",
    feed,
    rows: [],
    projectedAt: at,
    lastRebuiltAt: null,
    rebuildRequest: request,
    sha256,
  });
  return { source, feed, request, input, generation };
}
describe("Kitchen rebuild snapshot binding", () => {
  it("requires the original scoped read before accepting a checkpoint or activation", async () => {
    const f = fixture();
    expect(await f.source.checkpoints.compareRebuild(f.input)).toBe("Unknown");
    expect(
      await f.source.validateCurrentSource(transaction, { generation: f.generation, rows: [] }),
    ).toBe(false);
    await f.source.sources.loadRebuild({ request: f.request, transaction });
    expect(await f.source.checkpoints.compareRebuild(f.input)).toBe("Initial");
    expect(
      await f.source.validateCurrentSource(transaction, { generation: f.generation, rows: [] }),
    ).toBe(true);
    expect(
      await f.source.validateCurrentSource(foreignTransaction, {
        generation: f.generation,
        rows: [],
      }),
    ).toBe(false);
  });
  it("compares content across checkpoints without weakening exact activation binding", async () => {
    const f = fixture();
    await f.source.sources.loadRebuild({ request: f.request, transaction });
    const prior = {
      generation: {
        ...f.generation,
        sourceCheckpointReference: parseKitchenTicketReference(id(9)),
      },
      rows: [],
    };
    expect(await f.source.matchesCurrentContent(transaction, prior)).toBe(true);
    const newer = buildKitchenQueueStoredGeneration({
      generationReference: id(6),
      generationStatus: "Active",
      feed: { ...f.feed, asOfUtc: "2026-09-19T12:00:01.000Z" },
      rows: [],
      projectedAt: "2026-09-19T12:00:01.000Z",
      lastRebuiltAt: null,
      rebuildRequest: f.request,
      sha256,
    });
    expect(await f.source.matchesCurrentContent(transaction, { generation: newer, rows: [] })).toBe(
      false,
    );
    expect(await f.source.validateCurrentSource(transaction, prior)).toBe(false);
    expect(await f.source.matchesCurrentContent(foreignTransaction, prior)).toBe(false);
    expect(
      await f.source.matchesCurrentContent(transaction, {
        ...prior,
        generation: { ...prior.generation, workItemCount: 1 },
      }),
    ).toBe(false);
  });
  it("rejects mismatched transaction, scope and altered captured source", async () => {
    const f = fixture();
    await f.source.sources.loadRebuild({ request: f.request, transaction });
    expect(
      await f.source.checkpoints.compareRebuild({ ...f.input, transaction: foreignTransaction }),
    ).toBe("Unknown");
    expect(await f.source.checkpoints.compareRebuild({ ...f.input, storeReference: id(9) })).toBe(
      "Unknown",
    );
    expect(
      await f.source.checkpoints.compareRebuild({
        ...f.input,
        candidate: { ...f.input.candidate, asOfUtc: "2026-09-19T12:00:01.000Z" },
      }),
    ).toBe("Unknown");
    expect(
      await f.source.checkpoints.compareRebuild({
        ...f.input,
        candidate: {
          ...f.input.candidate,
          completeSourceFeed: {
            ...f.input.candidate.completeSourceFeed,
            proofBundles: [{} as never],
          },
        },
      }),
    ).toBe("Unknown");
  });
  it("compares complete snapshot time without pretending its reference is an event offset", async () => {
    const f = fixture();
    await f.source.sources.loadRebuild({ request: f.request, transaction });
    const compare = (sourceCheckpointReference: string, asOfUtc: string) =>
      f.source.checkpoints.compareRebuild({
        ...f.input,
        current: { sourceCheckpointReference, asOfUtc },
      });
    expect(await compare(id(3), at)).toBe("Exact");
    expect(await compare(id(3), "2026-09-19T11:59:59.000Z")).toBe("ChangedAsOf");
    expect(await compare(id(8), "2026-09-19T12:00:01.000Z")).toBe("Regression");
    expect(await compare(id(8), "2026-09-19T11:59:59.000Z")).toBe("Successor");
    expect(await compare(id(8), "invalid")).toBe("Unknown");
  });
  it("rejects changed activation contents and cross-store reads", async () => {
    const f = fixture();
    await f.source.sources.loadRebuild({ request: f.request, transaction });
    expect(
      await f.source.validateCurrentSource(transaction, {
        generation: { ...f.generation, workItemCount: 1 },
        rows: [],
      }),
    ).toBe(false);
    expect(
      await f.source.validateCurrentSource(transaction, {
        generation: {
          ...f.generation,
          sourceCheckpointReference: parseKitchenTicketReference(id(9)),
        },
        rows: [],
      }),
    ).toBe(false);
    await expect(
      f.source.sources.loadRebuild({
        request: { ...f.request, storeReference: id(9) as typeof f.request.storeReference },
        transaction,
      }),
    ).rejects.toMatchObject({ code: "KITCHEN_QUEUE_DEPENDENCY_UNAVAILABLE" });
    expect(await f.source.checkpoints.compareRebuild(f.input)).toBe("Unknown");
  });
});
