import { MessageChannel } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import {
  createStructuredLogger,
  type LoggerEnvironment,
  type StructuredLogDestination,
} from "@bop-rms/observability";
import { WorkerLifecycle } from "./lifecycle.js";
import { installSignalHandlers } from "./signals.js";

const workerLogEvents = [
  "shutdown_complete",
  "shutdown_failed",
  "shutdown_started",
  "worker_start_failed",
  "worker_started",
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

export async function startWorkerRuntime(): Promise<void> {
  const logger = createWorkerRuntimeLogger();
  const lifecycle = new WorkerLifecycle();
  const runtimeLatch = new MessageChannel();
  runtimeLatch.port1.on("message", () => undefined);
  runtimeLatch.port1.ref();
  const closeRuntimeLatch = () => {
    runtimeLatch.port1.close();
    runtimeLatch.port2.close();
  };
  let removeHandlers: () => void = () => undefined;
  async function shutdown(signal: "SIGINT" | "SIGTERM") {
    logger.info({ event: "shutdown_started", signal });
    try {
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
      closeRuntimeLatch();
      removeHandlers();
    }
  }
  removeHandlers = installSignalHandlers(process, shutdown);
  try {
    await lifecycle.start();
    logger.info({ event: "worker_started", resultCode: "SUCCESS" });
  } catch (error) {
    logger.error({
      error: { code: "WORKER_START_FAILED", value: error },
      event: "worker_start_failed",
      resultCode: "WORKER_START_FAILED",
    });
    process.exitCode = 1;
    closeRuntimeLatch();
    removeHandlers();
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  await startWorkerRuntime();
}
