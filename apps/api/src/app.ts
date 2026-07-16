import express, { type ErrorRequestHandler, type Express } from "express";
import helmet from "helmet";

export interface AppOptions {
  now?: () => string;
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

export function createApp({ now = () => new Date().toISOString() }: AppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "64kb", strict: true }));
  app.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.get("/health", (_request, response) =>
    response.status(200).json({ service: "bop-rms-api", status: "healthy", checkedAt: now() }),
  );
  app.get("/ready", (_request, response) =>
    response.status(503).json({
      service: "bop-rms-api",
      status: "not_ready",
      checkedAt: now(),
      dependencies: { database: { status: "not_configured", required: true } },
    }),
  );
  app.use((_request, response) =>
    response
      .status(404)
      .json({ error: { code: "not_found", message: "The requested resource is unavailable." } }),
  );
  app.use(errorHandler);
  return app;
}
