import { loadWorkerProcessConfiguration } from "./process-configuration.js";
import { pathToFileURL } from "node:url";
import {
  createCoreTelemetry,
  createNodeTelemetryRuntime,
  createStructuredLogger,
  type CoreTelemetry,
  type LoggerEnvironment,
  type StructuredLogDestination,
} from "@bop-rms/observability";
import { createCompositeWorkerWorkload } from "./composite-workload.js";
import { WorkerLifecycle } from "./lifecycle.js";
import { installSignalHandlers } from "./signals.js";

const workerLogEvents = [
  "shutdown_complete",
  "shutdown_failed",
  "shutdown_started",
  "worker_start_failed",
  "worker_started",
  "worker_failed",
  "telemetry_shutdown_failed",
] as const;

function runtimeEnvironment(): LoggerEnvironment {
  return (process.env.NODE_ENV ?? "development") as LoggerEnvironment;
}

export function createWorkerRuntimeLogger(destination?: StructuredLogDestination) {
  return createStructuredLogger(
    {
      allowedEvents: workerLogEvents,
      environment: runtimeEnvironment(),
      module: "worker-runtime",
      service: "bop-rms-worker",
    },
    destination === undefined ? {} : { destination },
  );
}

export function createWorkerCoreTelemetry(): CoreTelemetry {
  return createCoreTelemetry({
    allowedErrorCodes: ["WORKER_SHUTDOWN_FAILED", "WORKER_START_FAILED"],
    allowedOperations: ["worker_shutdown", "worker_startup"],
    allowedResultCodes: ["SUCCESS", "WORKER_SHUTDOWN_FAILED", "WORKER_START_FAILED"],
    environment: runtimeEnvironment(),
    module: "worker-runtime",
    service: "bop-rms-worker",
  });
}

export interface WorkerWorkload {
  readonly completion?: Promise<"stopped" | "failed">;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function startWorkerRuntime(
  options: {
    readonly workload?: WorkerWorkload;
    readonly workloads?: readonly WorkerWorkload[];
  } = {},
): Promise<void> {
  if (options.workload && options.workloads)
    throw new Error("WORKER_WORKLOAD_CONFIGURATION_CONFLICT");
  const workload = options.workloads
    ? createCompositeWorkerWorkload(options.workloads)
    : options.workload;
  const logger = createWorkerRuntimeLogger();
  const coreTelemetry = createWorkerCoreTelemetry();
  const nodeTelemetry = createNodeTelemetryRuntime({
    environment: runtimeEnvironment(),
    serviceName: "bop-rms-worker",
  });
  const lifecycle = new WorkerLifecycle({
    telemetry: coreTelemetry,
    onStart: async () => {
      if (!workload) throw new Error("WORKER_WORKLOAD_UNCONFIGURED");
      await workload.start();
    },
    onStop: async () => {
      await workload?.stop();
    },
  });
  let removeHandlers: () => void = () => undefined;
  const shutdownTelemetry = async () => {
    const result = await nodeTelemetry.shutdown();
    if (result === "failed" || result === "timeout")
      logger.warn({
        event: "telemetry_shutdown_failed",
        resultCode: "TELEMETRY_SHUTDOWN_FAILED",
      });
  };
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      try {
        await shutdownTelemetry();
      } finally {
        removeHandlers();
      }
    })();
    return cleanupPromise;
  };
  let startup: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  function shutdown(signal?: "SIGINT" | "SIGTERM"): Promise<void> {
    shutdownPromise ??= performShutdown(signal);
    return shutdownPromise;
  }
  async function performShutdown(signal?: "SIGINT" | "SIGTERM") {
    logger.info({ event: "shutdown_started", ...(signal ? { signal } : {}) });
    try {
      await startup?.catch(() => undefined);
      await lifecycle.stop();
      logger.info({ event: "shutdown_complete", resultCode: "SUCCESS" });
    } catch (error) {
      logger.error({
        error: { code: "WORKER_SHUTDOWN_FAILED", value: error },
        event: "shutdown_failed",
        resultCode: "WORKER_SHUTDOWN_FAILED",
      });
      process.exitCode = 1;
    } finally {
      await cleanup();
    }
  }
  const workloadCompletion = workload?.completion?.catch(() => "failed" as const);
  removeHandlers = installSignalHandlers(process, shutdown);
  try {
    nodeTelemetry.start();
    startup = lifecycle.start();
    await startup;
    if (shutdownPromise) await shutdownPromise;
    else {
      logger.info({ event: "worker_started", resultCode: "SUCCESS" });
      void workloadCompletion
        ?.then(async (result) => {
          if (result === "failed") {
            process.exitCode = 1;
            logger.error({ event: "worker_failed", resultCode: "WORKER_EXECUTION_FAILED" });
          }
          await shutdown();
        })
        .catch(() => {
          process.exitCode = 1;
        });
    }
  } catch (error) {
    logger.error({
      error: { code: "WORKER_START_FAILED", value: error },
      event: "worker_start_failed",
      resultCode: "WORKER_START_FAILED",
    });
    process.exitCode = 1;
    try {
      await lifecycle.stop();
    } catch (cleanupError) {
      logger.error({
        error: { code: "WORKER_SHUTDOWN_FAILED", value: cleanupError },
        event: "shutdown_failed",
        resultCode: "WORKER_SHUTDOWN_FAILED",
      });
    }
    await cleanup();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  void loadWorkerProcessConfiguration(process.argv.slice(2))
    .then((options) => startWorkerRuntime(options))
    .catch(() => {
      createWorkerRuntimeLogger().error({
        event: "worker_start_failed",
        resultCode: "WORKER_START_FAILED",
      });
      process.exitCode = 1;
    });
}
