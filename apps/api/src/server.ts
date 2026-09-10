import type { CustomerDiningBindingHandler } from "./customer-dining-binding.js";
import type { CustomerCartBindingHandler } from "./customer-cart-binding.js";
import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import {
  createCoreTelemetry,
  createNodeTelemetryRuntime,
  createStructuredLogger,
  type CoreTelemetry,
  type CoreTelemetryOptions,
  type LoggerEnvironment,
  type NodeTelemetryRuntime,
  type StructuredLogDestination,
  type StructuredLogger,
} from "@bop-rms/observability";
import { createApp } from "./app.js";
import { apiRouteTemplates } from "./http-route-templates.js";
import type { CustomerCartHandler } from "./customer-cart.js";
import type { CustomerEntryHandler } from "./customer-entry.js";
import type { CustomerMenuHandler } from "./customer-menu.js";
import type { CustomerQuoteHandler } from "./customer-quote.js";
import { HealthReadinessController } from "./health-readiness.js";
import type { MerchantBffRouterOptions } from "./merchant-bff.js";
import type { MerchantCatalogRouterOptions } from "./merchant-catalog.js";
import type { RealtimeTransport } from "./realtime.js";

const apiLogEvents = [
  "http_request_completed",
  "http_request_failed",
  "listening",
  "startup_failed",
  "shutdown_complete",
  "shutdown_failed",
  "shutdown_started",
  "telemetry_shutdown_failed",
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
  coreTelemetry?: CoreTelemetry;
  customerCart?: CustomerCartHandler;
  customerCartBinding?: CustomerCartBindingHandler;
  customerDiningBinding?: CustomerDiningBindingHandler;
  customerEntry?: CustomerEntryHandler;
  customerMenu?: CustomerMenuHandler;
  customerQuote?: CustomerQuoteHandler;
  healthReadiness?: HealthReadinessController;
  host?: string;
  logger?: StructuredLogger;
  merchantCatalog?: MerchantCatalogRouterOptions;
  merchantBff?: MerchantBffRouterOptions;
  nodeTelemetry?: NodeTelemetryRuntime;
  nowMilliseconds?: () => number;
  port?: number;
  realtime?: RealtimeTransport;
}

export function createApiCoreTelemetry(options: CoreTelemetryOptions = {}): CoreTelemetry {
  return createCoreTelemetry(
    {
      allowedErrorCodes: ["API_SHUTDOWN_FAILED", "API_START_FAILED", "INTERNAL_ERROR"],
      allowedOperations: ["api_shutdown", "api_startup", "http_request"],
      allowedResultCodes: [
        "API_SHUTDOWN_FAILED",
        "API_START_FAILED",
        "HTTP_CLIENT_ERROR",
        "HTTP_SERVER_ERROR",
        "HTTP_SUCCESS",
        "SUCCESS",
      ],
      environment: runtimeEnvironment(),
      module: "api-runtime",
      routes: apiRouteTemplates,
      service: "bop-rms-api",
    },
    options,
  );
}

function runtimeDuration(startedAt: number, completedAt: number): number {
  const duration = completedAt - startedAt;
  if (!Number.isFinite(duration)) return 0;
  return Math.min(86_400_000, Math.max(0, Math.trunc(duration)));
}

export function createApiServerRuntime({
  coreTelemetry = createApiCoreTelemetry(),
  customerCart,
  customerCartBinding,
  customerDiningBinding,
  customerEntry,
  customerMenu,
  customerQuote,
  healthReadiness = new HealthReadinessController(),
  host = "127.0.0.1",
  logger = createApiRuntimeLogger(),
  merchantCatalog,
  merchantBff,
  nodeTelemetry = createNodeTelemetryRuntime({
    environment: runtimeEnvironment(),
    serviceName: "bop-rms-api",
  }),
  nowMilliseconds = Date.now,
  port = 3000,
  realtime,
}: ApiServerRuntimeOptions = {}): ApiServerRuntime {
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error("port must be an integer from 0 to 65535");
  const server = createServer(
    createApp({
      ...(customerCart === undefined ? {} : { customerCart }),
      ...(customerCartBinding === undefined ? {} : { customerCartBinding }),
      ...(customerDiningBinding === undefined ? {} : { customerDiningBinding }),
      ...(customerEntry === undefined ? {} : { customerEntry }),
      healthReadiness,
      ...(customerMenu === undefined ? {} : { customerMenu }),
      ...(customerQuote === undefined ? {} : { customerQuote }),
      deploymentEnvironment: runtimeEnvironment(),
      ...(merchantCatalog === undefined ? {} : { merchantCatalog }),
      ...(merchantBff === undefined ? {} : { merchantBff }),
      errorLogger: logger,
      nowMilliseconds,
      ...(realtime === undefined ? {} : { realtime }),
      requestLogger: logger,
      telemetry: coreTelemetry,
    }),
  );
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;

  let listenPromise: Promise<void> | undefined;
  const listen = (): Promise<void> => {
    if (listenPromise !== undefined) return listenPromise;
    listenPromise = Promise.resolve().then(
      () =>
        new Promise<void>((resolve, reject) => {
          try {
            nodeTelemetry.start();
          } catch (error) {
            logger.error({
              error: { code: "API_START_FAILED", value: error },
              event: "startup_failed",
              resultCode: "API_START_FAILED",
            });
            reject(error);
            return;
          }
          const startedAt = nowMilliseconds();
          const telemetryOperation = coreTelemetry.startOperation("api_startup");
          const onError = (error: Error) => {
            server.off("listening", onListening);
            telemetryOperation.complete({
              durationMs: runtimeDuration(startedAt, nowMilliseconds()),
              errorCode: "API_START_FAILED",
              resultCode: "API_START_FAILED",
            });
            logger.error({
              error: { code: "API_START_FAILED", value: error },
              event: "startup_failed",
              resultCode: "API_START_FAILED",
            });
            reject(error);
          };
          const onListening = () => {
            server.off("error", onError);
            healthReadiness.completeStartup();
            telemetryOperation.complete({
              durationMs: runtimeDuration(startedAt, nowMilliseconds()),
              resultCode: "SUCCESS",
            });
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
        }),
    );
    return listenPromise;
  };

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: "SIGINT" | "SIGTERM"): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    healthReadiness.beginDrain();
    logger.info({ event: "shutdown_started", signal });
    const startedAt = nowMilliseconds();
    const telemetryOperation = coreTelemetry.startOperation("api_shutdown");
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
        telemetryOperation.complete({
          durationMs: runtimeDuration(startedAt, nowMilliseconds()),
          resultCode: "SUCCESS",
        });
      } else {
        logger.error({
          error: { code: "API_SHUTDOWN_FAILED", value: shutdownError },
          event: "shutdown_failed",
          resultCode: "API_SHUTDOWN_FAILED",
        });
        telemetryOperation.complete({
          durationMs: runtimeDuration(startedAt, nowMilliseconds()),
          errorCode: "API_SHUTDOWN_FAILED",
          resultCode: "API_SHUTDOWN_FAILED",
        });
        process.exitCode = 1;
      }
      const telemetryShutdown = await nodeTelemetry.shutdown();
      if (telemetryShutdown === "failed" || telemetryShutdown === "timeout")
        logger.warn({
          event: "telemetry_shutdown_failed",
          resultCode: "TELEMETRY_SHUTDOWN_FAILED",
        });
      if (shutdownError !== undefined) throw shutdownError;
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
