import { createOutboxWorkload } from "./outbox-workload.js";

/** Schedules actual expiry work with the existing nonoverlap/drain lifecycle.
 * cleanup must call the restricted shared expiry function; it owns no business
 * fact or retention policy. Caller supplies finite DB timeouts and owns close.
 */
export function createAbuseCleanupWorkload(options: {
  readonly cleanup: () => Promise<number>;
  readonly close: () => Promise<void>;
  readonly pollIntervalMs: number;
  readonly drainDeadlineMs: number;
}) {
  let closing: Promise<void> | undefined;
  return createOutboxWorkload({
    pollIntervalMs: options.pollIntervalMs,
    drainDeadlineMs: options.drainDeadlineMs,
    dispatcher: {
      async runOnce() {
        try {
          const count = await options.cleanup();
          if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid result");
          return count;
        } catch {
          throw new Error("ABUSE_CLEANUP_UNAVAILABLE");
        }
      },
      async stop() {
        closing ??= Promise.resolve().then(options.close);
        await closing;
        return "drained";
      },
    },
  });
}
