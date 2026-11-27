import { describe, expect, it, vi } from "vitest";
import { createCompositeWorkerWorkload } from "./composite-workload.js";

function child() {
  let complete!: (result: "stopped" | "failed") => void;
  const completion = new Promise<"stopped" | "failed">((resolve) => {
    complete = resolve;
  });
  return {
    start: vi.fn(async (): Promise<void> => undefined),
    stop: vi.fn(async (): Promise<void> => undefined),
    completion,
    complete,
  };
}

describe("composite worker workload", () => {
  it("cleans both started and partially started children after startup failure", async () => {
    const a = child(),
      b = child(),
      c = child();
    b.start.mockRejectedValue(new Error("private failure"));
    const group = createCompositeWorkerWorkload([a, b, c]);
    await expect(group.start()).rejects.toThrow("WORKER_WORKLOAD_GROUP_START_FAILED");
    await group.stop();
    expect(a.stop).toHaveBeenCalledOnce();
    expect(b.stop).toHaveBeenCalledOnce();
    expect(c.start).not.toHaveBeenCalled();
    await expect(group.completion).resolves.toBe("failed");
  });
  it("propagates unexpected child completion and drains all children despite a stop error", async () => {
    const a = child(),
      b = child();
    const group = createCompositeWorkerWorkload([a, b]);
    await group.start();
    b.complete("stopped");
    await expect(group.completion).resolves.toBe("failed");
    a.stop.mockRejectedValue(new Error("private failure"));
    const stopping = group.stop();
    expect(group.stop()).toBe(stopping);
    await expect(stopping).rejects.toThrow("WORKER_WORKLOAD_GROUP_STOP_FAILED");
    expect(b.stop).toHaveBeenCalledOnce();
  });
  it("waits for in-flight startup and does not start another child after stop", async () => {
    const a = child(),
      b = child();
    let release!: () => void;
    a.start.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const group = createCompositeWorkerWorkload([a, b]);
    const starting = group.start();
    const stopping = group.stop();
    release();
    await starting;
    await stopping;
    expect(b.start).not.toHaveBeenCalled();
    expect(a.stop).toHaveBeenCalledOnce();
    await expect(group.completion).resolves.toBe("stopped");
  });
});
