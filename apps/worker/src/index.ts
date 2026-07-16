import { MessageChannel } from "node:worker_threads";
import pino from "pino";
import { WorkerLifecycle } from "./lifecycle.js";
import { installSignalHandlers } from "./signals.js";
const logger = pino({ base: { service: "bop-rms-worker" } });
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
    logger.info({ event: "shutdown_complete" });
  } catch (error) {
    logger.error({
      event: "shutdown_failed",
      error: error instanceof Error ? error.message : "unknown",
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
  logger.info({ event: "worker_started", capabilities: [] });
} catch (error) {
  closeRuntimeLatch();
  removeHandlers();
  logger.error({
    event: "worker_start_failed",
    error: error instanceof Error ? error.message : "unknown",
  });
  process.exitCode = 1;
}
