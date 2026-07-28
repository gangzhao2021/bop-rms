import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import {
  createStructuredLogger,
  type LoggerEnvironment,
  type StructuredLogDestination,
  type StructuredLogger,
} from "@bop-rms/observability";
import { createApp } from "./app.js";
import { HealthReadinessController } from "./health-readiness.js";
import type { RealtimeTransport } from "./realtime.js";

const apiLogEvents = [
  "http_request_completed",
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

export interface ApiServerRuntime {
  healthReadiness: HealthReadinessController;
  listen: () => Promise<void>;
  server: Server;
  shutdown: (signal: "SIGINT" | "SIGTERM") => Promise<void>;
}

export interface ApiServerRuntimeOptions {
  healthReadiness?: HealthReadinessController;
  host?: string;
  logger?: StructuredLogger;
  port?: number;
  realtime?: RealtimeTransport;
}

export function createApiServerRuntime({
  healthReadiness = new HealthReadinessController(),
  host = "127.0.0.1",
  logger = createApiRuntimeLogger(),
  port = 3000,
  realtime,
}: ApiServerRuntimeOptions = {}): ApiServerRuntime {
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("port must be an integer from 0 to 65535");
  const server = createServer(
    createApp({
      healthReadiness,
      ...(realtime === undefined ? {} : { realtime }),
      requestLogger: logger,
    }),
  );
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  let listenPromise: Promise<void> | undefined;
  const listen = (): Promise<void> => {
    if (listenPromise !== undefined) return listenPromise;
    listenPromise = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        healthReadiness.completeStartup();
        const address = server.address();
        logger.info({
          event: "listening",
          ...(address !== null && typeof address !== "string" ? { port: address.port } : {}),
          resultCode: "SUCCESS",
        });
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
    return listenPromise;
  };

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    healthReadiness.beginDrain();
    logger.info({ event: "shutdown_started", signal });
    shutdownPromise = (async () => {
      let shutdownError: unknown;
      try {
        await realtime?.beginDrain();
      } catch (error) {
        shutdownError = error;
      }
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
      } catch (error) {
        shutdownError ??= error;
      }
      if (shutdownError === undefined) {
        logger.info({ event: "shutdown_complete", resultCode: "SUCCESS" });
      } else {
        logger.error({
          error: { code: "API_SHUTDOWN_FAILED", value: shutdownError },
          event: "shutdown_failed",
          resultCode: "API_SHUTDOWN_FAILED",
        });
        process.exitCode = 1;
        throw shutdownError;
      }
    })();
    return shutdownPromise;
  };

  return { healthReadiness, listen, server, shutdown };
}

export function startApiRuntime(): void {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("PORT must be an integer from 1 to 65535");
  const runtime = createApiServerRuntime({ port });
  process.once("SIGINT", () => void runtime.shutdown("SIGINT").catch(() => undefined));
  process.once("SIGTERM", () => void runtime.shutdown("SIGTERM").catch(() => undefined));
  void runtime.listen();
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(entryPath).href) {
  startApiRuntime();
}
