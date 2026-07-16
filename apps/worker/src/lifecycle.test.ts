import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WorkerLifecycle } from "./lifecycle.js";
import { installSignalHandlers } from "./signals.js";
describe("worker lifecycle", () => {
  it("starts and stops once deterministically", async () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const worker = new WorkerLifecycle({ onStart, onStop });
    await worker.start();
    expect(worker.state).toBe("running");
    await Promise.all([worker.stop(), worker.stop()]);
    expect(worker.state).toBe("stopped");
    expect(onStart).toHaveBeenCalledOnce();
    expect(onStop).toHaveBeenCalledOnce();
  });
  it("handles one signal and removes both listeners", async () => {
    const emitter = new EventEmitter();
    const shutdown = vi.fn();
    const cleanup = installSignalHandlers(emitter, shutdown);
    emitter.emit("SIGTERM");
    expect(shutdown).toHaveBeenCalledWith("SIGTERM");
    cleanup();
    expect(emitter.listenerCount("SIGINT")).toBe(0);
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
  });
  it("surfaces startup failure without fake running state", async () => {
    const worker = new WorkerLifecycle({
      onStart: () => {
        throw new Error("start failed");
      },
    });
    await expect(worker.start()).rejects.toThrow("start failed");
    expect(worker.state).toBe("failed");
  });
});
