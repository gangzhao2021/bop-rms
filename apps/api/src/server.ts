import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import {
  createStructuredLogger,
  type LoggerEnvironment,
  type StructuredLogDestination,
} from "@bop-rms/observability";
import { createApp } from "./app.js";

const apiLogEvents = [
  "listening",
  "shutdown_complete",
  "shutdown_failed",
  "shutdown_started",
] as const;

function runtimeEnvironment(): LoggerEnvironment {
  return (process.env.NODE_ENV ?? "development") as LoggerEnvironment;
}

export function createApiRuntimeLogger(destination?: StructuredLogDestination) {
  return createStructuredLogger(
    {
      allowedEvents: apiLogEvents,
      environment: runtimeEnvironment(),
      module: "api-runtime",
      service: "bop-rms-api",
    },
    destination === undefined ? {} : { destination },
  );
}

export function startApiRuntime(): void {
  const logger = createApiRuntimeLogger();
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer from 1 to 65535");
  const server = createServer(createApp());
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  let closing = false;
  const shutdown = (signal: "SIGINT" | "SIGTERM") => {
    if (closing) return;
    closing = true;
    logger.info({ event: "shutdown_started", signal });
    server.close((error) => {
      if (error) {
        logger.error({
          error: { code: "API_SHUTDOWN_FAILED", value: error },
          event: "shutdown_failed",
          resultCode: "API_SHUTDOWN_FAILED",
        });
        process.exitCode = 1;
      } else logger.info({ event: "shutdown_complete", resultCode: "SUCCESS" });
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.listen(port, "127.0.0.1", () =>
    logger.info({ event: "listening", port, resultCode: "SUCCESS" }),
  );
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  startApiRuntime();
}
