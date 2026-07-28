import express, { type ErrorRequestHandler, type Express, type RequestHandler } from "express";
import helmet from "helmet";
import { HealthReadinessController } from "./health-readiness.js";
import { type RealtimeTransport, unavailableRealtimeHandler } from "./realtime.js";
import {
  createRequestCorrelationMiddleware,
  type RequestCompletionLogger,
} from "./request-correlation.js";

export interface AppOptions {
  correlationAcceptanceHandler?: RequestHandler;
  healthReadiness?: HealthReadinessController;
  now?: () => string;
  nowMilliseconds?: () => number;
  realtime?: RealtimeTransport;
  requestLogger?: RequestCompletionLogger;
  uuidV7Factory?: () => string;
}
const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  void next;
  const candidate = error as { status?: number; type?: string };
  const status = candidate.type === "entity.too.large" ? 413 : candidate.status === 400 ? 400 : 500;
  response.status(status).json({
    error: {
      code:
        status === 413 ? "payload_too_large" : status === 400 ? "invalid_json" : "internal_error",
      message: status >= 500 ? "The request could not be completed." : "The request was rejected.",
    },
  });
};

export function createApp({
  correlationAcceptanceHandler,
  healthReadiness,
  now = () => new Date().toISOString(),
  nowMilliseconds,
  realtime,
  requestLogger,
  uuidV7Factory,
}: AppOptions = {}): Express {
  const app = express();
  const health = healthReadiness ?? new HealthReadinessController({ now });
  app.disable("x-powered-by");
  app.use(
    createRequestCorrelationMiddleware({
      ...(nowMilliseconds === undefined ? {} : { nowMilliseconds }),
      ...(requestLogger === undefined ? {} : { logger: requestLogger }),
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
  if (correlationAcceptanceHandler !== undefined)
    app.post("/__acceptance/request-command-event", correlationAcceptanceHandler);
  app.use((_request, response) =>
    response
      .status(404)
      .json({ error: { code: "not_found", message: "The requested resource is unavailable." } }),
  );
  app.use(errorHandler);
  return app;
}
