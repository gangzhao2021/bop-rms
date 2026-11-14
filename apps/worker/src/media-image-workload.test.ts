import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMediaImageWorkerWorkload } from "./media-image-workload.js";

const owner = vi.hoisted(() => ({ processNext: vi.fn(), close: vi.fn() }));
vi.mock("@bop/media/worker", () => ({
  createMediaImageWorker: vi.fn(() => owner),
  parseMediaImageWorkerConfiguration: (config: unknown) => config,
}));
const id = (n: number) => `019a2421-0021-7000-8000-${n.toString(16).padStart(12, "0")}`;
function fixture(overrides: Partial<Parameters<typeof createMediaImageWorkerWorkload>[0]> = {}) {
  const acquire = vi.fn(),
    close = vi.fn(async () => undefined);
  // Only lifecycle composition is controlled here. Actual Media, Permission,
  // SDK command handling and PostgreSQL have their owning/native acceptance.
  const workload = createMediaImageWorkerWorkload({
    config: {
      quarantineConfig: {
        tenantReference: id(1),
        scope: { kind: "Store", brandReference: id(2), storeReference: id(3) },
      },
    } as Parameters<typeof createMediaImageWorkerWorkload>[0]["config"],
    acquire,
    close,
    pollIntervalMs: 50,
    drainDeadlineMs: 1000,
    ...overrides,
  });
  return { workload, close, acquire };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  owner.processNext.mockReset();
  owner.close.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});
describe("real Media loop lifecycle composition", () => {
  it.each(["pollIntervalMs", "drainDeadlineMs"] as const)(
    "closes acquired SDK resources on invalid %s without claiming caller pool cleanup",
    (field) => {
      const close = vi.fn(async () => undefined),
        acquire = vi.fn();
      owner.close.mockImplementation(() => {
        throw new Error("controlled cleanup failure");
      });
      expect(() => fixture({ [field]: 0, close, acquire })).toThrow(
        "OUTBOX_WORKLOAD_CONFIG_INVALID",
      );
      expect(owner.close).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(owner.processNext).not.toHaveBeenCalled();
    },
  );
  it("installs the loop without making initial long-running work block process shutdown", async () => {
    let receivedSignal: AbortSignal | undefined;
    owner.processNext.mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          receivedSignal = signal;
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    );
    const h = fixture();
    await h.workload.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(receivedSignal?.aborted).toBe(false);
    expect(h.workload.snapshot().cycleInFlight).toBe(true);
    const first = h.workload.stop();
    expect(receivedSignal?.aborted).toBe(true);
    expect(h.workload.stop()).toBe(first);
    await first;
    expect(owner.close).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(await h.workload.completion).toBe("stopped");
    expect(h.acquire).not.toHaveBeenCalled();
  });
  it("does not overlap jobs and polls again only after the previous real result settles", async () => {
    let finish!: (value: 0 | 1) => void;
    owner.processNext
      .mockImplementationOnce(
        () =>
          new Promise<0 | 1>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(0);
    const h = fixture();
    await h.workload.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(owner.processNext).toHaveBeenCalledTimes(1);
    finish(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.workload.snapshot().completedCycles).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(owner.processNext).toHaveBeenCalledTimes(2);
    await h.workload.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(owner.processNext).toHaveBeenCalledTimes(2);
  });
  it("reports initial or later owner failure through the completion channel without claiming a completed job", async () => {
    owner.processNext.mockRejectedValue(
      Object.assign(new Error("controlled private detail"), {
        code: "MEDIA_COMMIT_OUTCOME_UNKNOWN",
      }),
    );
    const h = fixture();
    await h.workload.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.workload.completion).toBe("failed");
    expect(h.workload.snapshot()).toMatchObject({ state: "failed", completedCycles: 0 });
    expect(JSON.stringify(h.workload.snapshot())).not.toContain("controlled private detail");
    await h.workload.stop();
    expect(h.close).toHaveBeenCalledTimes(1);
  });
  it("closes resources even before start and refuses restart", async () => {
    const h = fixture();
    await h.workload.stop();
    await expect(h.workload.start()).rejects.toThrow("MEDIA_IMAGE_WORKLOAD_ALREADY_STARTED");
    expect(owner.processNext).not.toHaveBeenCalled();
    expect(owner.close).toHaveBeenCalledTimes(1);
    expect(h.close).toHaveBeenCalledTimes(1);
  });
  it("keeps database cleanup when SDK cleanup fails", async () => {
    owner.close.mockImplementation(() => {
      throw new Error("controlled SDK close failure");
    });
    const h = fixture();
    await expect(h.workload.stop()).rejects.toThrow("OUTBOX_WORKLOAD_DRAIN_TIMEOUT");
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(await h.workload.completion).toBe("failed");
  });
});
