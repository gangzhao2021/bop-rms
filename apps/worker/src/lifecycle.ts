import type { CoreTelemetry } from "@bop-rms/observability";

export type WorkerState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";
export interface LifecycleHooks {
  nowMilliseconds?: () => number;
  onStart?: () => void | Promise<void>;
  onStop?: () => void | Promise<void>;
  telemetry?: CoreTelemetry;
}

function durationBetween(startedAt: number, completedAt: number): number {
  const duration = completedAt - startedAt;
  if (!Number.isFinite(duration)) return 0;
  return Math.min(86_400_000, Math.max(0, Math.trunc(duration)));
}

export class WorkerLifecycle {
  #state: WorkerState = "idle";
  #stopPromise?: Promise<void>;
  constructor(private readonly hooks: LifecycleHooks = {}) {}
  get state() {
    return this.#state;
  }
  async start() {
    if (this.#state !== "idle") throw new Error(`worker cannot start from ${this.#state}`);
    this.#state = "starting";
    const now = this.hooks.nowMilliseconds ?? Date.now;
    const startedAt = now();
    const telemetryOperation = this.hooks.telemetry?.startOperation("worker_startup");
    try {
      await (telemetryOperation === undefined
        ? this.hooks.onStart?.()
        : telemetryOperation.run(() => this.hooks.onStart?.()));
      this.#state = "running";
      telemetryOperation?.complete({
        durationMs: durationBetween(startedAt, now()),
        resultCode: "SUCCESS",
      });
    } catch (error) {
      this.#state = "failed";
      telemetryOperation?.complete({
        durationMs: durationBetween(startedAt, now()),
        errorCode: "WORKER_START_FAILED",
        resultCode: "WORKER_START_FAILED",
      });
      throw error;
    }
  }
  stop() {
    if (this.#stopPromise) return this.#stopPromise;
    if (this.#state === "stopped") return Promise.resolve();
    const now = this.hooks.nowMilliseconds ?? Date.now;
    const startedAt = now();
    const telemetryOperation = this.hooks.telemetry?.startOperation("worker_shutdown");
    if (this.#state === "idle") {
      this.#state = "stopped";
      telemetryOperation?.complete({
        durationMs: durationBetween(startedAt, now()),
        resultCode: "SUCCESS",
      });
      this.#stopPromise = Promise.resolve();
      return this.#stopPromise;
    }
    this.#state = "stopping";
    this.#stopPromise = (async () => {
      try {
        await (telemetryOperation === undefined
          ? this.hooks.onStop?.()
          : telemetryOperation.run(() => this.hooks.onStop?.()));
        this.#state = "stopped";
        telemetryOperation?.complete({
          durationMs: durationBetween(startedAt, now()),
          resultCode: "SUCCESS",
        });
      } catch (error) {
        this.#state = "failed";
        telemetryOperation?.complete({
          durationMs: durationBetween(startedAt, now()),
          errorCode: "WORKER_SHUTDOWN_FAILED",
          resultCode: "WORKER_SHUTDOWN_FAILED",
        });
        throw error;
      }
    })();
    return this.#stopPromise;
  }
}
