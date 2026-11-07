import { createOutboxWorkload } from "./outbox-workload.js";

/** Trusted configuration supplies actual owner discovery and System activation.
 * No jobs, schedules or permissions are synthesized. Failed dependencies stop
 * the workload; only the owner can classify a concurrent candidate as Stale. */
export function createProductPublicationWorkload<
  T extends { readonly publication: { readonly versionReference: string } },
>(options: {
  readonly discover: (input: { afterVersionReference: string | null; limit: number }) => Promise<{
    readonly candidates: readonly T[];
    readonly nextAfterVersionReference: string | null;
  }>;
  readonly activate: (candidate: T) => Promise<"Applied" | "Replayed" | "Stale">;
  readonly pageSize: number;
  readonly pollIntervalMs: number;
  readonly drainDeadlineMs: number;
}) {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100)
    throw new Error("PRODUCT_PUBLICATION_WORKLOAD_CONFIG_INVALID");
  let cursor: string | null = null,
    stopping = false;
  const workload = createOutboxWorkload({
    pollIntervalMs: options.pollIntervalMs,
    drainDeadlineMs: options.drainDeadlineMs,
    dispatcher: {
      async runOnce() {
        if (stopping) return 0;
        const page = await options.discover({
          afterVersionReference: cursor,
          limit: options.pageSize,
        });
        if (!page || !Array.isArray(page.candidates) || page.candidates.length > options.pageSize)
          throw new Error("PRODUCT_PUBLICATION_DISCOVERY_INVALID");
        let previous = cursor;
        // Validate a complete page before executing any candidate.
        for (const candidate of page.candidates) {
          const id = Object.getOwnPropertyDescriptor(
            Object.getOwnPropertyDescriptor(candidate, "publication")?.value ?? {},
            "versionReference",
          )?.value;
          if (
            typeof id !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id) ||
            (previous !== null && id <= previous)
          )
            throw new Error("PRODUCT_PUBLICATION_DISCOVERY_INVALID");
          previous = id;
        }
        if (
          page.nextAfterVersionReference !== null &&
          (page.candidates.length !== options.pageSize ||
            page.nextAfterVersionReference !== previous)
        )
          throw new Error("PRODUCT_PUBLICATION_DISCOVERY_INVALID");
        let count = 0;
        for (const candidate of page.candidates) {
          if (stopping) break;
          const result = await options.activate(candidate);
          if (!["Applied", "Replayed", "Stale"].includes(result))
            throw new Error("PRODUCT_PUBLICATION_ACTIVATION_INVALID");
          count++;
        }
        if (!stopping) cursor = page.nextAfterVersionReference;
        return count;
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
