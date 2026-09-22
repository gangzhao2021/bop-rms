import type { OutboxDispatcher } from "./outbox-dispatcher.js";
import type { WorkerWorkload } from "./index.js";

export type CycleFailureCategory =
  | "SerializationConflict"
  | "Deadlock"
  | "LockUnavailable"
  | "QueryCancelled"
  | "DependencyUnavailable"
  | "Unclassified";
function failureCategory(error: unknown): CycleFailureCategory {
  try {
    if (!error || typeof error !== "object") return "Unclassified";
    const code = Object.getOwnPropertyDescriptor(error, "code")?.value as unknown;
    if (code === "40001") return "SerializationConflict";
    if (code === "40P01") return "Deadlock";
    if (code === "55P03") return "LockUnavailable";
    if (code === "57014") return "QueryCancelled";
    const message = Object.getOwnPropertyDescriptor(error, "message")?.value as unknown;
    if (
      typeof message === "string" &&
      [
        "INTERNAL_DINING_EXCEPTION_EPISODES_UNAVAILABLE",
        "INTERNAL_DINING_EXCEPTIONS_UNAVAILABLE",
        "INTERNAL_DINING_PROJECTION_UNAVAILABLE",
        "ORDER_EXCEPTION_STORE_UNAVAILABLE",
      ].includes(message)
    )
      return "DependencyUnavailable";
  } catch {
    /* Untrusted errors must never break failure reporting. */
  }
  return "Unclassified";
}
export interface OutboxWorkloadSnapshot {
  readonly state: "idle" | "running" | "stopping" | "stopped" | "failed";
  readonly cycleInFlight: boolean;
  readonly completedCycles: number;
  readonly lastCycleFailure: Readonly<{
    occurredAt: string;
    category: CycleFailureCategory;
  }> | null;
  readonly lastCycleStartedAt: string | null;
  readonly lastCycleCompletedAt: string | null;
}
/** Polls real supplied dispatcher work; intervals never overlap an active cycle. */
export function createOutboxWorkload(options: {
  readonly dispatcher: Pick<OutboxDispatcher, "runOnce" | "stop">;
  readonly pollIntervalMs: number;
  readonly drainDeadlineMs: number;
  /** Explicitly safe replay only; omitted retains fail-fast behavior. */
  readonly retry?: {
    readonly maxRetries: number;
    readonly shouldRetry: (error: unknown) => boolean;
  };
  /** Best-effort diagnostics only; observer errors never change business execution. */
  readonly onSnapshot?: (snapshot: OutboxWorkloadSnapshot) => void;
}): WorkerWorkload & {
  readonly completion: Promise<"stopped" | "failed">;
  snapshot(): OutboxWorkloadSnapshot;
} {
  if (
    !Number.isInteger(options.pollIntervalMs) ||
    options.pollIntervalMs < 1 ||
    options.pollIntervalMs > 60000 ||
    !Number.isInteger(options.drainDeadlineMs) ||
    options.drainDeadlineMs < 1 ||
    options.drainDeadlineMs > 25000 ||
    (options.retry !== undefined &&
      (!Number.isInteger(options.retry.maxRetries) ||
        options.retry.maxRetries < 1 ||
        options.retry.maxRetries > 5 ||
        typeof options.retry.shouldRetry !== "function"))
  )
    throw new TypeError("OUTBOX_WORKLOAD_CONFIG_INVALID");
  let state: "idle" | "running" | "stopping" | "stopped" | "failed" = "idle";
  let timer: NodeJS.Timeout | undefined;
  let cycle: Promise<number> | undefined;
  let stopping: Promise<void> | undefined;
  let cycleInFlight = false,
    completedCycles = 0;
  let consecutiveFailures = 0;
  let retryableFailure = false;
  let lastCycleFailure: OutboxWorkloadSnapshot["lastCycleFailure"] = null;
  let lastCycleStartedAt: string | null = null,
    lastCycleCompletedAt: string | null = null;
  const snapshot = (): OutboxWorkloadSnapshot =>
    Object.freeze({
      state,
      cycleInFlight,
      completedCycles,
      lastCycleFailure,
      lastCycleStartedAt,
      lastCycleCompletedAt,
    });
  const publish = () => {
    try {
      options.onSnapshot?.(snapshot());
    } catch {
      /* Diagnostics must not change dispatch outcome. */
    }
  };
  const runCycle = () => {
    cycleInFlight = true;
    lastCycleStartedAt = new Date().toISOString();
    publish();
    return Promise.resolve()
      .then(() => options.dispatcher.runOnce())
      .then((result) => {
        consecutiveFailures = 0;
        completedCycles = Math.min(Number.MAX_SAFE_INTEGER, completedCycles + 1);
        lastCycleCompletedAt = new Date().toISOString();
        return result;
      })
      .catch((error: unknown) => {
        retryableFailure = false;
        try {
          retryableFailure = options.retry?.shouldRetry(error) === true;
        } catch {
          /* Fail closed. */
        }
        lastCycleFailure = Object.freeze({
          occurredAt: new Date().toISOString(),
          category: failureCategory(error),
        });
        throw error;
      })
      .finally(() => {
        cycleInFlight = false;
        publish();
      });
  };
  let complete!: (result: "stopped" | "failed") => void;
  const completion = new Promise<"stopped" | "failed">((resolve) => {
    complete = resolve;
  });
  const fail = () => {
    state = "failed";
    publish();
    complete("failed");
  };
  const schedule = (delayMs = options.pollIntervalMs) => {
    if (state !== "running") return;
    timer = setTimeout(() => {
      timer = undefined;
      if (state !== "running") return;
      cycle = runCycle();
      void cycle.then(() => schedule(), handleFailure);
    }, delayMs);
  };
  const handleFailure = (): boolean => {
    if (state !== "running") return false;
    if (retryableFailure && consecutiveFailures < (options.retry?.maxRetries ?? 0)) {
      consecutiveFailures += 1;
      schedule(Math.min(60000, options.pollIntervalMs * 2 ** (consecutiveFailures - 1)));
      return true;
    }
    fail();
    return false;
  };
  return Object.freeze({
    completion,
    snapshot,
    async start() {
      if (state !== "idle") throw new Error("OUTBOX_WORKLOAD_ALREADY_STARTED");
      state = "running";
      cycle = runCycle();
      try {
        await cycle;
        schedule();
      } catch {
        if (!handleFailure()) throw new Error("OUTBOX_WORKLOAD_FAILED");
      }
    },
    stop() {
      if (stopping) return stopping;
      state = "stopping";
      publish();
      if (timer) clearTimeout(timer);
      timer = undefined;
      stopping = (async () => {
        let deadline: NodeJS.Timeout | undefined;
        const drained = (async () => {
          await cycle?.catch(() => undefined);
          if ((await options.dispatcher.stop()) !== "drained")
            throw new Error("OUTBOX_WORKLOAD_DRAIN_TIMEOUT");
        })();
        const timeout = new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(
            () => reject(new Error("OUTBOX_WORKLOAD_DRAIN_TIMEOUT")),
            options.drainDeadlineMs,
          );
        });
        try {
          await Promise.race([drained, timeout]);
          state = "stopped";
          publish();
          complete("stopped");
        } catch {
          fail();
          throw new Error("OUTBOX_WORKLOAD_DRAIN_TIMEOUT");
        } finally {
          if (deadline) clearTimeout(deadline);
        }
      })();
      return stopping;
    },
  });
}
