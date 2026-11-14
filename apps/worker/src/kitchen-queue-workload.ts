import { createOutboxWorkload } from "./outbox-workload.js";

/** Kitchen owner diagnostic codes that mean the source breaks an invariant (needs a person). */
const SOURCE_FAULT = /^KITCHEN_[A-Z0-9_]+_(?:MISMATCH|INVALID)$/u;
/** The most specific source-fault code on the cause chain, else the generic refresh code. */
function refreshFailureCode(error: unknown): string {
  try {
    let current: unknown = error;
    for (let depth = 0; depth < 6 && current !== null && typeof current === "object"; depth++) {
      for (const key of ["code", "message"]) {
        const value = Object.getOwnPropertyDescriptor(current, key)?.value as unknown;
        if (typeof value === "string" && value.length <= 80 && SOURCE_FAULT.test(value))
          return value;
      }
      current = Object.getOwnPropertyDescriptor(current, "cause")?.value as unknown;
    }
  } catch {
    /* Untrusted errors must never break failure reporting. */
  }
  return "KITCHEN_QUEUE_REFRESH_UNAVAILABLE";
}

/** Schedules real bounded owner snapshot comparison/activation. Owner refresh
 * returns zero for unchanged source and one only after durable activation.
 */
export function createKitchenQueueWorkload(options: {
  readonly refresh: () => Promise<0 | 1>;
  readonly close: () => Promise<void>;
  readonly pollIntervalMs: number;
  readonly drainDeadlineMs: number;
  readonly onSnapshot?: Parameters<typeof createOutboxWorkload>[0]["onSnapshot"];
  /** Supervised cycle failures (pilot workers): one failure never stops sibling workloads. */
  readonly supervision?: Parameters<typeof createOutboxWorkload>[0]["supervision"];
}) {
  let closing: Promise<void> | undefined;
  return createOutboxWorkload({
    ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {}),
    ...(options.supervision ? { supervision: options.supervision } : {}),
    pollIntervalMs: options.pollIntervalMs,
    drainDeadlineMs: options.drainDeadlineMs,
    dispatcher: {
      async runOnce() {
        try {
          const result = await options.refresh();
          if (result !== 0 && result !== 1) throw new Error("invalid refresh result");
          return result;
        } catch (error) {
          // The cause keeps only what classification and safe logging read (code, SQLSTATE). A
          // source that breaks a Kitchen invariant is named (and needs a person: retrying cannot
          // change the snapshot); a database failure keeps its SQLSTATE on the cause chain.
          throw new Error(refreshFailureCode(error), { cause: error });
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
