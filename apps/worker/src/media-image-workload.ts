import {
  createMediaImageWorker,
  parseMediaImageWorkerConfiguration,
  type MediaImageWorkerConfiguration,
} from "@bop/media/worker";
import {
  createMediaImageWorkerTransactions,
  type MediaImageWorkerConnection,
} from "./media-image-transactions.js";
import { createOutboxWorkload } from "./outbox-workload.js";

/** Compose real Media work with the existing process scheduler. Configuration is
 * supplied by the protected --configuration module; startup never creates grants
 * or queues, adopts old backlog, or supplies synthetic SDK/permission results. */
export function createMediaImageWorkerWorkload(options: {
  readonly config: MediaImageWorkerConfiguration;
  readonly acquire: () => Promise<MediaImageWorkerConnection>;
  readonly close: () => Promise<void>;
  readonly pollIntervalMs: number;
  readonly drainDeadlineMs: number;
  readonly onSnapshot?: Parameters<typeof createOutboxWorkload>[0]["onSnapshot"];
}) {
  const config = parseMediaImageWorkerConfiguration(options.config),
    acquire = options.acquire.bind(options),
    close = options.close.bind(options),
    host = createMediaImageWorkerTransactions({
      acquire,
      tenantReference: config.quarantineConfig.tenantReference,
      scope: config.quarantineConfig.scope,
    }),
    worker = createMediaImageWorker({
      config,
      transactions: host.transactions,
      registerBeforeCommit: host.registerBeforeCommit,
    }),
    controller = new AbortController();
  let cleanup: Promise<void> | undefined,
    started = false,
    stopping: Promise<void> | undefined;
  let workload: ReturnType<typeof createOutboxWorkload>;
  try {
    workload = createOutboxWorkload({
      pollIntervalMs: options.pollIntervalMs,
      drainDeadlineMs: options.drainDeadlineMs,
      ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {}),
      dispatcher: {
        runOnce: () => worker.processNext(controller.signal),
        async stop() {
          cleanup ??= (async () => {
            try {
              worker.close();
            } finally {
              await close();
            }
          })();
          await cleanup;
          return "drained";
        },
      },
    });
  } catch (error) {
    try {
      worker.close();
    } catch {
      // Preserve the scheduler configuration error. The caller still owns its
      // database pool; synchronous construction cannot await that cleanup.
    }
    throw error;
  }
  return Object.freeze({
    completion: workload.completion,
    snapshot: workload.snapshot,
    async start() {
      if (started || stopping) throw new Error("MEDIA_IMAGE_WORKLOAD_ALREADY_STARTED");
      started = true;
      // Startup installs the real loop; it does not wait for a potentially
      // 180-second image job. This lets process shutdown abort an initial job.
      // The scheduler's completion channel retains every background failure.
      void workload.start().catch(() => undefined);
    },
    stop() {
      if (stopping) return stopping;
      controller.abort();
      stopping = workload.stop();
      return stopping;
    },
  });
}
