import { createOutboxWorkload } from "./outbox-workload.js";

export interface DueCartCandidate {
  readonly cartReference: string;
  readonly expectedAggregateVersion: number;
}

/** Only trusted owner composition can classify a concurrency race as Stale.
 * Other errors stop the workload; discovery never authorizes a transition.
 */
export function createCartExpiryWorkload(options: {
  discover(limit: number, after: string | null): Promise<readonly DueCartCandidate[]>;
  expire(candidate: DueCartCandidate): Promise<"Applied" | "Stale">;
  pageSize: number;
  pollIntervalMs: number;
  drainDeadlineMs: number;
  onSnapshot?: Parameters<typeof createOutboxWorkload>[0]["onSnapshot"];
}) {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100)
    throw new TypeError("CART_EXPIRY_CONFIG_INVALID");
  let cursor: string | null = null;
  let stopping = false;
  const workload = createOutboxWorkload({
    ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {}),
    pollIntervalMs: options.pollIntervalMs,
    drainDeadlineMs: options.drainDeadlineMs,
    dispatcher: {
      async runOnce() {
        if (stopping) return 0;
        const page = await options.discover(options.pageSize, cursor);
        if (!Array.isArray(page) || page.length > options.pageSize)
          throw new Error("CART_EXPIRY_DISCOVERY_INVALID");
        let previous = cursor;
        const candidates = page.map((candidate) => {
          if (
            !candidate ||
            typeof candidate !== "object" ||
            Object.keys(candidate).length !== 2 ||
            typeof candidate.cartReference !== "string" ||
            !candidate.cartReference ||
            !Number.isSafeInteger(candidate.expectedAggregateVersion) ||
            candidate.expectedAggregateVersion < 1 ||
            candidate.expectedAggregateVersion >= 2147483647 ||
            (previous !== null && candidate.cartReference <= previous)
          )
            throw new Error("CART_EXPIRY_DISCOVERY_INVALID");
          previous = candidate.cartReference;
          return Object.freeze({
            cartReference: candidate.cartReference,
            expectedAggregateVersion: candidate.expectedAggregateVersion,
          });
        });
        let processed = 0;
        for (const candidate of candidates) {
          if (stopping) break;
          const result = await options.expire(candidate);
          if (result !== "Applied" && result !== "Stale")
            throw new Error("CART_EXPIRY_RESULT_INVALID");
          processed++;
        }
        if (!stopping) cursor = candidates.length === options.pageSize ? previous : null;
        return processed;
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
