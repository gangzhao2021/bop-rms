import { createOutboxWorkload, type OutboxWorkloadSnapshot } from "./outbox-workload.js";

/** Owner ports perform scoped discovery, durable execution and failure recording.
 * Cursors are scan progress only: restart/full-round reset replays durable owner work.
 * A candidate whose result did not change is re-executed with doubling delay (up to
 * `unchangedBackoffMaxMs`): an open case awaiting a person or the Provider is still rechecked, without
 * claiming a fresh lease on every poll. A changed result or a failure resets the delay.
 */
export function createPaymentCompensationWorkload<
  T extends { readonly dispositionReference: string },
>(options: {
  readonly discover: (input: {
    readonly afterDispositionReference: string | null;
    readonly limit: number;
  }) => Promise<{
    readonly candidates: readonly T[];
    readonly nextAfterDispositionReference: string | null;
  }>;
  readonly execute: (candidate: T) => Promise<unknown>;
  /** Refresh dependent projections after durable execution, including replay of Closed cases.
   * A failure is recorded and retried by the next owner scan; it cannot undo the refund.
   */
  readonly afterExecute?: (candidate: T, result: unknown) => Promise<void>;
  readonly recordFailure: (candidate: T, code: "COMPENSATION_EXECUTION_FAILED") => Promise<void>;
  readonly pageSize: number;
  readonly pollIntervalMs: number;
  readonly drainDeadlineMs: number;
  readonly onSnapshot?: (snapshot: OutboxWorkloadSnapshot) => void;
  /** Longest delay before an unchanged candidate is executed again; default five minutes. */
  readonly unchangedBackoffMaxMs?: number;
  /** Test seam: the clock (milliseconds). */
  readonly now?: () => number;
}) {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100)
    throw new TypeError("COMPENSATION_WORKLOAD_CONFIG_INVALID");
  const pageSize = options.pageSize;
  const backoffMax = options.unchangedBackoffMaxMs ?? 300_000;
  if (!Number.isInteger(backoffMax) || backoffMax < 0)
    throw new TypeError("COMPENSATION_WORKLOAD_CONFIG_INVALID");
  const now = options.now ?? Date.now;
  const resultKey = (value: unknown) =>
    JSON.stringify(value ?? null, (_key, item: unknown) =>
      typeof item === "bigint" ? String(item) : item,
    );
  /** Per candidate: the last result, its current delay and when it is due again. */
  const settled = new Map<string, { result: string; waitMs: number; dueAt: number }>();
  let seen = new Set<string>();
  let cursor: string | null = null,
    stopping = false;
  const workload = createOutboxWorkload({
    ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {}),
    pollIntervalMs: options.pollIntervalMs,
    drainDeadlineMs: options.drainDeadlineMs,
    dispatcher: {
      async runOnce() {
        if (stopping) return 0;
        const page = await options.discover({ afterDispositionReference: cursor, limit: pageSize });
        if (!Array.isArray(page.candidates) || page.candidates.length > pageSize)
          throw new Error("COMPENSATION_DISCOVERY_INVALID");
        let previous = cursor;
        for (const candidate of page.candidates) {
          if (
            !candidate ||
            typeof candidate.dispositionReference !== "string" ||
            candidate.dispositionReference.length === 0 ||
            (previous !== null && candidate.dispositionReference <= previous)
          )
            throw new Error("COMPENSATION_DISCOVERY_INVALID");
          previous = candidate.dispositionReference;
        }
        if (
          page.nextAfterDispositionReference !== null &&
          (page.candidates.length !== pageSize || page.nextAfterDispositionReference !== previous)
        )
          throw new Error("COMPENSATION_DISCOVERY_INVALID");
        let executed = 0;
        for (const candidate of page.candidates) {
          if (stopping) break;
          const reference = candidate.dispositionReference;
          seen.add(reference);
          const prior = settled.get(reference);
          if (prior !== undefined && now() < prior.dueAt) continue;
          try {
            const result = await options.execute(candidate);
            await options.afterExecute?.(candidate, result);
            const key = resultKey(result);
            const waitMs =
              prior?.result === key
                ? Math.min(Math.max(prior.waitMs * 2, options.pollIntervalMs), backoffMax)
                : 0;
            settled.set(reference, { result: key, waitMs, dueAt: now() + waitMs });
          } catch {
            settled.delete(reference);
            // Never forward raw Provider/errors to generic worker logging.
            await options.recordFailure(candidate, "COMPENSATION_EXECUTION_FAILED");
          }
          executed++;
        }
        if (!stopping) {
          cursor = page.nextAfterDispositionReference;
          // A full round ends: forget candidates discovery no longer returns.
          if (cursor === null) {
            for (const reference of settled.keys())
              if (!seen.has(reference)) settled.delete(reference);
            seen = new Set();
          }
        }
        return executed;
      },
      async stop() {
        return "drained" as const;
      },
    },
  });
  return Object.freeze({
    completion: workload.completion,
    snapshot: workload.snapshot,
    start: workload.start,
    stop() {
      stopping = true;
      return workload.stop();
    },
  });
}
