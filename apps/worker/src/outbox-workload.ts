import type { OutboxDispatcher } from "./outbox-dispatcher.js";
import type { WorkerWorkload } from "./index.js";
import {
  classifyCycleFailure,
  type CycleFailureDisposition,
} from "./cycle-failure-classification.js";

export type CycleFailureCategory =
  | "SerializationConflict"
  | "Deadlock"
  | "LockUnavailable"
  | "QueryCancelled"
  | "DependencyUnavailable"
  | "Unclassified";
const SAFE_CODE =
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:UNAVAILABLE|INVALID|DENIED|CONFLICT|FAILED|TIMEOUT|EXPIRED|REQUIRED|CHANGED|UNCONFIGURED|NOT_FOUND|MISMATCH|EXHAUSTED)$/u;
const SQLSTATE = /^[0-9A-Z]{5}$/u;
function failureCategory(error: unknown, causeSqlState: string | null): CycleFailureCategory {
  try {
    if (!error || typeof error !== "object") return "Unclassified";
    const own = Object.getOwnPropertyDescriptor(error, "code")?.value as unknown;
    // A Postgres error wrapped by an owner keeps its SQLSTATE on the cause chain.
    const code = typeof own === "string" && SQLSTATE.test(own) ? own : (causeSqlState ?? own);
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
/** A safe application error code (an allowlisted code shape, never free text) and the Postgres
 * SQLSTATE, read from the error and its cause chain. Neither carries values, rows or secrets. */
function failureDetail(error: unknown): { code: string | null; sqlState: string | null } {
  let code: string | null = null,
    sqlState: string | null = null;
  try {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
      const value: object = current;
      const ownCode = Object.getOwnPropertyDescriptor(value, "code")?.value as unknown,
        message = Object.getOwnPropertyDescriptor(value, "message")?.value as unknown,
        diagnostic = Object.getOwnPropertyDescriptor(value, "diagnostic")?.value as unknown;
      // A tenant transaction error keeps the driver SQLSTATE on its safe diagnostic.
      const diagnosticState =
        diagnostic !== null && typeof diagnostic === "object"
          ? (Object.getOwnPropertyDescriptor(diagnostic, "sqlState")?.value as unknown)
          : null;
      if (sqlState === null && typeof ownCode === "string" && SQLSTATE.test(ownCode))
        sqlState = ownCode;
      if (
        sqlState === null &&
        typeof diagnosticState === "string" &&
        SQLSTATE.test(diagnosticState)
      )
        sqlState = diagnosticState;
      if (code === null)
        for (const text of [ownCode, message])
          if (typeof text === "string" && text.length <= 80 && SAFE_CODE.test(text)) {
            code = text;
            break;
          }
      if (code !== null && sqlState !== null) break;
      current = Object.getOwnPropertyDescriptor(value, "cause")?.value as unknown;
    }
  } catch {
    /* Untrusted errors must never break failure reporting. */
  }
  return { code, sqlState };
}
export type OutboxWorkloadState =
  "idle" | "running" | "attention_required" | "stopping" | "stopped" | "failed";
export interface OutboxWorkloadSnapshot {
  /** `attention_required`: a supervised workload hit a non-transient failure; it keeps retrying
   * slowly and the rest of the worker keeps running, but a person must look. */
  readonly state: OutboxWorkloadState;
  readonly cycleInFlight: boolean;
  readonly completedCycles: number;
  readonly lastCycleFailure: Readonly<{
    occurredAt: string;
    category: CycleFailureCategory;
    /** Allowlisted application code shape, or null. */
    code: string | null;
    /** Postgres SQLSTATE from the error or its cause chain, or null. */
    sqlState: string | null;
  }> | null;
  readonly lastCycleStartedAt: string | null;
  readonly lastCycleCompletedAt: string | null;
  /** Cycles failed in a row since the last completed cycle. */
  readonly consecutiveFailures: number;
  /** When the current run of failed cycles began; null while cycles complete. */
  readonly failingSince: string | null;
}
/** Supervised failure handling: never completes "failed" because of a cycle error. */
export interface OutboxWorkloadSupervision {
  /** Defaults to the shared transient/attention classification. */
  readonly classify?: (error: unknown) => CycleFailureDisposition;
  /** Longest delay between retries of transient failures; default 30 s. */
  readonly maxBackoffMs?: number;
  /** Delay between retries while attention is required; default 5 minutes. */
  readonly attentionRetryMs?: number;
}
/** WP-2423 pilot resilience: retry transient failures with capped backoff; keep the workload alive
 * (attention_required, slow retry) on others, so one workload never stops its siblings. */
export const supervisedCycleFailures: OutboxWorkloadSupervision = Object.freeze({});
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
  /** Supervised failure handling (pilot workers); mutually exclusive with `retry`. */
  readonly supervision?: OutboxWorkloadSupervision;
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
        typeof options.retry.shouldRetry !== "function")) ||
    (options.supervision !== undefined &&
      (options.retry !== undefined ||
        (options.supervision.classify !== undefined &&
          typeof options.supervision.classify !== "function") ||
        !Number.isInteger(options.supervision.maxBackoffMs ?? 30_000) ||
        (options.supervision.maxBackoffMs ?? 30_000) < 1 ||
        (options.supervision.maxBackoffMs ?? 30_000) > 300_000 ||
        !Number.isInteger(options.supervision.attentionRetryMs ?? 300_000) ||
        (options.supervision.attentionRetryMs ?? 300_000) < 1 ||
        (options.supervision.attentionRetryMs ?? 300_000) > 3_600_000))
  )
    throw new TypeError("OUTBOX_WORKLOAD_CONFIG_INVALID");
  const supervision = options.supervision;
  const classify = supervision?.classify ?? classifyCycleFailure;
  // A slow poll (for example a daily job) never retries more slowly than it polls.
  const maxBackoffMs = Math.max(supervision?.maxBackoffMs ?? 30_000, options.pollIntervalMs);
  const attentionRetryMs = supervision?.attentionRetryMs ?? 300_000;
  let state: OutboxWorkloadState = "idle";
  let timer: NodeJS.Timeout | undefined;
  let cycle: Promise<number> | undefined;
  let stopping: Promise<void> | undefined;
  let cycleInFlight = false,
    completedCycles = 0;
  let consecutiveFailures = 0;
  let retryableFailure = false;
  let disposition: CycleFailureDisposition = "Attention";
  let failingSince: string | null = null;
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
      consecutiveFailures,
      failingSince,
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
        failingSince = null;
        // A completed cycle clears attention: the condition was repaired.
        if (state === "attention_required") state = "running";
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
        disposition = "Attention";
        if (supervision)
          try {
            disposition = classify(error) === "Transient" ? "Transient" : "Attention";
          } catch {
            /* Fail closed. */
          }
        const detail = failureDetail(error);
        const occurredAt = new Date().toISOString();
        if (supervision) {
          consecutiveFailures = Math.min(Number.MAX_SAFE_INTEGER, consecutiveFailures + 1);
          failingSince ??= occurredAt;
          if (disposition === "Attention" && state === "running") state = "attention_required";
        }
        lastCycleFailure = Object.freeze({
          occurredAt,
          category: failureCategory(error, detail.sqlState),
          ...detail,
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
  const active = () => state === "running" || state === "attention_required";
  const schedule = (delayMs = options.pollIntervalMs) => {
    if (!active()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!active()) return;
      cycle = runCycle();
      void cycle.then(() => schedule(), handleFailure);
    }, delayMs);
  };
  const handleFailure = (): boolean => {
    if (!active()) return false;
    if (supervision) {
      // Never fail the workload (and so its whole worker) because of one cycle.
      schedule(
        disposition === "Transient"
          ? Math.min(
              maxBackoffMs,
              options.pollIntervalMs * 2 ** Math.min(consecutiveFailures - 1, 20),
            )
          : attentionRetryMs,
      );
      return true;
    }
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
