import { createOutboxWorkload } from "./outbox-workload.js";

/** First retry of a wait whose resume failed; doubled per failure up to the cap. */
export const PAYMENT_WAIT_RETRY_FIRST_MS = 5_000;
/**
 * WP-2423 M04: the longest a failing wait is left alone. A wait staff accepted after a transient
 * failure (a lock timeout, a database blip) still reaches the kitchen within half a minute; staff
 * are told at one minute (Orders "Not in the kitchen yet").
 */
export const PAYMENT_WAIT_RETRY_CAP_MS = 30_000;

/** Durable owner records are the queue; cursor is only fair scan progress.
 * One wait whose resume fails never holds up the others (WP-2423 M04: one stuck paid round stopped
 * every later paid order of the Store reaching the kitchen): the rest of the page is resumed in the
 * same cycle, the cursor moves on, and the failing wait is retried after a backoff.
 * Unsupervised, errors fail the workload (after the page) instead of silently retrying or
 * discarding paid work. Supervised (pilot), a failing wait is retried and counted
 * (`stuckCount`, for health); paid work is never dropped because discovery rescans the durable
 * owner records.
 */
export function createPaymentAcceptanceWaitWorkload(options: {
  discover(limit: number, after: string | null): Promise<readonly string[]>;
  resume(eventReference: string): Promise<unknown>;
  pageSize: number;
  pollIntervalMs: number;
  drainDeadlineMs: number;
  readonly onSnapshot?: Parameters<typeof createOutboxWorkload>[0]["onSnapshot"];
  /** Supervised cycle failures (pilot workers): one failure never stops sibling workloads. */
  readonly supervision?: Parameters<typeof createOutboxWorkload>[0]["supervision"];
  /** Each failed resume: how often this wait failed in a row and since when. Never its reference. */
  readonly onWaitFailure?: (
    failure: Readonly<{ failures: number; failingSince: string; stuckWaits: number }>,
    error: unknown,
  ) => void;
}) {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100)
    throw new TypeError("PAYMENT_WAIT_CONFIG_INVALID");
  let cursor: string | null = null;
  let stopping = false;
  /** Waits whose last resume failed, by event: kept in memory only (the records are the queue). */
  const stuck = new Map<string, { failures: number; failingSince: number; retryAt: number }>();
  /** Events discovery returned in the current full scan (to forget waits settled elsewhere). */
  let scanned = new Set<string>();
  const workload = createOutboxWorkload({
    ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {}),
    ...(options.supervision ? { supervision: options.supervision } : {}),
    pollIntervalMs: options.pollIntervalMs,
    drainDeadlineMs: options.drainDeadlineMs,
    dispatcher: {
      async runOnce() {
        if (stopping) return 0;
        if (cursor === null) scanned = new Set();
        const events = await options.discover(options.pageSize, cursor);
        if (!Array.isArray(events) || events.length > options.pageSize)
          throw new Error("PAYMENT_WAIT_DISCOVERY_INVALID");
        let previous = cursor;
        for (const event of events) {
          if (typeof event !== "string" || !event || (previous !== null && event <= previous))
            throw new Error("PAYMENT_WAIT_DISCOVERY_INVALID");
          previous = event;
        }
        let processed = 0;
        let firstError: { error: unknown } | null = null;
        for (const event of events) {
          if (stopping) break;
          scanned.add(event);
          const failing = stuck.get(event);
          if (failing !== undefined && failing.retryAt > Date.now()) continue;
          try {
            await options.resume(event);
            stuck.delete(event);
            processed++;
          } catch (error) {
            const at = Date.now();
            const failures = (failing?.failures ?? 0) + 1;
            const failingSince = failing?.failingSince ?? at;
            stuck.set(event, {
              failures,
              failingSince,
              retryAt:
                at +
                Math.min(
                  PAYMENT_WAIT_RETRY_CAP_MS,
                  PAYMENT_WAIT_RETRY_FIRST_MS * 2 ** Math.min(failures - 1, 16),
                ),
            });
            try {
              options.onWaitFailure?.(
                Object.freeze({
                  failures,
                  failingSince: new Date(failingSince).toISOString(),
                  stuckWaits: stuck.size,
                }),
                error,
              );
            } catch {
              /* Reporting must not change which waits are resumed. */
            }
            firstError ??= { error };
          }
        }
        if (!stopping) {
          const complete = events.length < options.pageSize;
          cursor = complete ? null : previous;
          // A full scan that no longer finds a wait: it was settled elsewhere (staff refunded it).
          if (complete)
            for (const event of [...stuck.keys()]) if (!scanned.has(event)) stuck.delete(event);
        }
        if (firstError !== null && options.supervision === undefined) throw firstError.error;
        return processed;
      },
      async stop() {
        return "drained" as const;
      },
    },
  });
  return Object.freeze({
    completion: workload.completion,
    start: workload.start,
    /** How many waits failed their last resume (a count only, never which). */
    stuckCount: () => stuck.size,
    stop() {
      stopping = true;
      return workload.stop();
    },
  });
}
