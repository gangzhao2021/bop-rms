import { describe, expect, it, vi } from "vitest";
import {
  executeProjectionRebuild,
  ProjectionRebuildError,
  type ProjectionRebuildPorts,
  type ProjectionRebuildResult,
} from "../index.js";

const r = (n: number) => `018f0f58-767a-7f3b-a1d0-${String(n).padStart(12, "0")}`;
const command = () => ({
  commandReference: r(1),
  idempotencyKey: "projection-rebuild:1904:one",
  permission: "projection.rebuild",
  tenantReference: r(2),
  brandReference: r(3),
  storeReference: r(4),
  businessDate: "2026-08-12",
  projectionName: "merchant_order_queue_v1",
  targetProjectionVersion: 1,
  expectedActiveGenerationReference: r(5),
  sourceCheckpoint: r(6),
  sourceCutoffAt: "2026-08-12T20:00:00.000Z",
  requestedAt: "2026-08-12T20:00:01.000Z",
  requestedByActorReference: r(7),
  purpose: "Repair",
  batchSize: 2,
});

function ports(overrides: Partial<ProjectionRebuildPorts> = {}): ProjectionRebuildPorts {
  let page = 0;
  return {
    authorize: vi.fn().mockResolvedValue(true),
    findCompleted: vi.fn().mockResolvedValue(null),
    openShadow: vi.fn().mockResolvedValue(r(8)),
    loadSourceBatch: vi.fn().mockImplementation(async () => {
      page += 1;
      return page === 1
        ? { records: [{ source: 1 }], nextCursor: r(9), sourceCheckpoint: r(6) }
        : { records: [{ source: 2 }], nextCursor: null, sourceCheckpoint: r(6) };
    }),
    writeShadowBatch: vi.fn().mockResolvedValue(undefined),
    validateShadow: vi.fn().mockResolvedValue({
      rowCount: 2,
      summaryDigest: `sha256:${"a".repeat(64)}`,
      sourceCheckpoint: r(6),
    }),
    activateShadow: vi.fn().mockResolvedValue({
      replacedGenerationReference: r(5),
      rebuiltAt: "2026-08-12T20:00:02.000Z",
      auditReference: r(10),
    }),
    abandonShadow: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("WP-1904 projection rebuild command", () => {
  it("builds a shadow generation and switches it only after validation", async () => {
    const adapter = ports();
    await expect(executeProjectionRebuild(command(), adapter)).resolves.toMatchObject({
      projectionName: "merchant_order_queue_v1",
      shadowGenerationReference: r(8),
      replacedGenerationReference: r(5),
      sourceCheckpoint: r(6),
      rowCount: 2,
      status: "Completed",
    });
    expect(adapter.writeShadowBatch).toHaveBeenCalledTimes(2);
    expect(adapter.activateShadow).toHaveBeenCalledTimes(1);
    expect(adapter.abandonShadow).not.toHaveBeenCalled();
  });

  it("returns an authorized idempotent completion without opening another shadow", async () => {
    const completed = {
      projectionName: "merchant_order_queue_v1" as const,
      projectionVersion: 1 as const,
      commandReference: r(1),
      tenantReference: r(2),
      brandReference: r(3),
      storeReference: r(4),
      businessDate: "2026-08-12",
      shadowGenerationReference: r(8),
      replacedGenerationReference: r(5),
      sourceCheckpoint: r(6),
      sourceCutoffAt: "2026-08-12T20:00:00.000Z",
      rowCount: 2,
      summaryDigest: `sha256:${"a".repeat(64)}`,
      rebuiltAt: "2026-08-12T20:00:02.000Z",
      auditReference: r(10),
      status: "Completed" as const,
    };
    const adapter = ports({ findCompleted: vi.fn().mockResolvedValue(completed) });
    await expect(executeProjectionRebuild(command(), adapter)).resolves.toEqual(completed);
    expect(adapter.openShadow).not.toHaveBeenCalled();
  });

  it("fails closed before source access when authorization is absent", async () => {
    const adapter = ports({ authorize: vi.fn().mockResolvedValue(false) });
    await expect(executeProjectionRebuild(command(), adapter)).rejects.toEqual(
      new ProjectionRebuildError("NOT_AUTHORIZED"),
    );
    expect(adapter.findCompleted).not.toHaveBeenCalled();
    expect(adapter.openShadow).not.toHaveBeenCalled();
  });

  it("requires the exact rebuild permission in the closed command", async () => {
    const adapter = ports();
    await expect(
      executeProjectionRebuild({ ...command(), permission: "report.read" }, adapter),
    ).rejects.toEqual(new ProjectionRebuildError("COMMAND_INVALID"));
    expect(adapter.authorize).not.toHaveBeenCalled();
  });

  it("abandons an incomplete shadow on checkpoint drift", async () => {
    const adapter = ports({
      loadSourceBatch: vi.fn().mockResolvedValue({
        records: [],
        nextCursor: null,
        sourceCheckpoint: r(99),
      }),
    });
    await expect(executeProjectionRebuild(command(), adapter)).rejects.toEqual(
      new ProjectionRebuildError("SOURCE_CHECKPOINT_MISMATCH"),
    );
    expect(adapter.activateShadow).not.toHaveBeenCalled();
    expect(adapter.abandonShadow).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "SOURCE_CHECKPOINT_MISMATCH" }),
    );
  });

  it("rejects an advancing cursor without an observed source row", async () => {
    const adapter = ports({
      loadSourceBatch: vi.fn().mockResolvedValue({
        records: [],
        nextCursor: r(9),
        sourceCheckpoint: r(6),
      }),
    });
    await expect(executeProjectionRebuild(command(), adapter)).rejects.toEqual(
      new ProjectionRebuildError("SOURCE_PAGINATION_INVALID"),
    );
    expect(adapter.abandonShadow).toHaveBeenCalledTimes(1);
  });
});

describe("WP-2025 projection rebuild failure and recovery scenario", () => {
  it("retains the active generation, recovers with a fresh shadow and replays completion", async () => {
    const digest = `sha256:${"b".repeat(64)}`;
    let activeGenerationReference: string | null = r(5);
    let completed: ProjectionRebuildResult | null = null;
    let nextShadow = 20;
    let validationAttempt = 0;
    const shadowStates = new Map<string, "Open" | "Abandoned" | "Active">();

    const adapter: ProjectionRebuildPorts = {
      authorize: vi.fn().mockResolvedValue(true),
      findCompleted: vi.fn().mockImplementation(async () => completed),
      openShadow: vi.fn().mockImplementation(async () => {
        const reference = r(nextShadow);
        nextShadow += 1;
        shadowStates.set(reference, "Open");
        return reference;
      }),
      loadSourceBatch: vi.fn().mockResolvedValue({
        records: [{ source: 1 }, { source: 2 }],
        nextCursor: null,
        sourceCheckpoint: r(6),
      }),
      writeShadowBatch: vi.fn().mockResolvedValue(undefined),
      validateShadow: vi.fn().mockImplementation(async () => {
        validationAttempt += 1;
        return {
          rowCount: 2,
          summaryDigest: digest,
          sourceCheckpoint: validationAttempt === 1 ? r(99) : r(6),
        };
      }),
      activateShadow: vi.fn().mockImplementation(async (input) => {
        if (activeGenerationReference !== input.command.expectedActiveGenerationReference)
          throw new Error("synthetic active generation conflict");
        const replacedGenerationReference = activeGenerationReference;
        activeGenerationReference = input.shadowGenerationReference;
        shadowStates.set(input.shadowGenerationReference, "Active");
        const activation = {
          replacedGenerationReference,
          rebuiltAt: "2026-08-12T20:00:02.000Z",
          auditReference: r(10),
        };
        completed = {
          projectionName: input.command.projectionName,
          projectionVersion: input.command.targetProjectionVersion,
          commandReference: input.command.commandReference,
          tenantReference: input.command.tenantReference,
          brandReference: input.command.brandReference,
          storeReference: input.command.storeReference,
          businessDate: input.command.businessDate,
          shadowGenerationReference: input.shadowGenerationReference,
          replacedGenerationReference,
          sourceCheckpoint: input.command.sourceCheckpoint,
          sourceCutoffAt: input.command.sourceCutoffAt,
          rowCount: input.rowCount,
          summaryDigest: input.summaryDigest,
          rebuiltAt: activation.rebuiltAt,
          auditReference: activation.auditReference,
          status: "Completed",
        };
        return activation;
      }),
      abandonShadow: vi.fn().mockImplementation(async ({ shadowGenerationReference }) => {
        shadowStates.set(shadowGenerationReference, "Abandoned");
      }),
    };

    await expect(executeProjectionRebuild(command(), adapter)).rejects.toEqual(
      new ProjectionRebuildError("SHADOW_VALIDATION_FAILED"),
    );
    expect(activeGenerationReference).toBe(r(5));
    expect(shadowStates.get(r(20))).toBe("Abandoned");
    expect(adapter.activateShadow).not.toHaveBeenCalled();

    const recovered = await executeProjectionRebuild(command(), adapter);
    expect(recovered).toMatchObject({
      shadowGenerationReference: r(21),
      replacedGenerationReference: r(5),
      sourceCheckpoint: r(6),
      rowCount: 2,
      summaryDigest: digest,
      status: "Completed",
    });
    expect(activeGenerationReference).toBe(r(21));
    expect(shadowStates.get(r(21))).toBe("Active");

    await expect(executeProjectionRebuild(command(), adapter)).resolves.toEqual(recovered);
    expect(adapter.openShadow).toHaveBeenCalledTimes(2);
    expect(adapter.activateShadow).toHaveBeenCalledTimes(1);
    expect(adapter.abandonShadow).toHaveBeenCalledTimes(1);
  });
});
