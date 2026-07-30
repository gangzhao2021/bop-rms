import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import helmet from "helmet";
import type { CoreTelemetry } from "@bop-rms/observability";
import {
  sendInvalidCustomerEntryRequest,
  type CustomerEntryHandler,
  unavailableCustomerEntryHandler,
} from "./customer-entry.js";
import { HealthReadinessController } from "./health-readiness.js";
import { type RealtimeTransport, unavailableRealtimeHandler } from "./realtime.js";
import {
  createRequestCorrelationMiddleware,
  getRequestCorrelationContext,
  markRequestError,
  type RequestCompletionLogger,
} from "./request-correlation.js";

const routeTemplates = [
  "/__acceptance/request-command-event",
  "/bff/customer/entry",
  "/bff/realtime",
  "/health",
  "/ready",
  "unmatched",
] as const;

export interface RequestErrorLogger {
  error(input: {
    readonly error: { readonly code: "INTERNAL_ERROR"; readonly value: unknown };
    readonly event: "http_request_failed";
    readonly resultCode: "INTERNAL_ERROR";
    readonly trustedContext: { readonly correlationId: string };
  }): void;
}

export interface AppOptions {
  correlationAcceptanceHandler?: RequestHandler;
  customerEntry?: CustomerEntryHandler;
  errorLogger?: RequestErrorLogger;
  healthReadiness?: HealthReadinessController;
  now?: () => string;
  nowMilliseconds?: () => number;
  realtime?: RealtimeTransport;
  requestLogger?: RequestCompletionLogger;
  telemetry?: CoreTelemetry;
  uuidV7Factory?: () => string;
}

function createErrorHandler(errorLogger: RequestErrorLogger | undefined): ErrorRequestHandler {
  return (error, request, response, next) => {
    void next;
    const candidate = error as { status?: number; type?: string };
    if (
      request.originalUrl === "/bff/customer/entry" &&
      (candidate.type === "entity.too.large" || candidate.status === 400)
    ) {
      sendInvalidCustomerEntryRequest(response);
      return;
    }
    const status =
      candidate.type === "entity.too.large" ? 413 : candidate.status === 400 ? 400 : 500;
    if (status === 500) {
      markRequestError(request, "INTERNAL_ERROR");
      try {
        errorLogger?.error({
          error: { code: "INTERNAL_ERROR", value: error },
          event: "http_request_failed",
          resultCode: "INTERNAL_ERROR",
          trustedContext: getRequestCorrelationContext(request).correlation,
        });
      } catch {
        // Error response and business control flow never depend on observability.
      }
    }
    response.status(status).json({
      error: {
        code:
          status === 413 ? "payload_too_large" : status === 400 ? "invalid_json" : "internal_error",
        message:
          status >= 500 ? "The request could not be completed." : "The request was rejected.",
      },
    });
  };
}

export function createApp({
  correlationAcceptanceHandler,
  customerEntry,
  errorLogger,
  healthReadiness,
  now = () => new Date().toISOString(),
  nowMilliseconds,
  realtime,
  requestLogger,
  telemetry,
  uuidV7Factory,
}: AppOptions = {}): Express {
  const app = express();
  const health = healthReadiness ?? new HealthReadinessController({ now });
  app.disable("x-powered-by");
  app.use(
    createRequestCorrelationMiddleware({
      ...(nowMilliseconds === undefined ? {} : { nowMilliseconds }),
      ...(requestLogger === undefined ? {} : { logger: requestLogger }),
      routeTemplates,
      ...(telemetry === undefined ? {} : { telemetry }),
      ...(uuidV7Factory === undefined ? {} : { uuidV7Factory }),
    }),
  );
  app.use(helmet());
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/health", (_request, response) => response.status(200).json(health.healthSnapshot()));
  app.get("/ready", async (_request, response) => {
    const snapshot = await health.readinessSnapshot();
    response.status(snapshot.status === "ready" ? 200 : 503).json(snapshot);
  });
  app.get("/bff/realtime", realtime?.handler() ?? unavailableRealtimeHandler);
  app.post("/bff/customer/entry", customerEntry?.handler() ?? unavailableCustomerEntryHandler);
  if (correlationAcceptanceHandler !== undefined)
    app.post("/__acceptance/request-command-event", correlationAcceptanceHandler);
  app.use((_request, response) =>
    response
      .status(404)
      .json({ error: { code: "not_found", message: "The requested resource is unavailable." } }),
  );
  app.use(createErrorHandler(errorLogger));
  return app;
}
