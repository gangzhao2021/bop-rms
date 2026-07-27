import {
  continueTrustedCorrelationContext,
  createRootCorrelationContext,
  deriveCorrelationContextFromCommand,
  type CorrelationContext,
  type UuidV7Factory,
} from "@bop/eventing";
import type { Request, RequestHandler } from "express";
import { v7 as uuidV7 } from "uuid";

const requestContextKey = Symbol("bop.request-correlation");
const maximumDurationMs = 86_400_000;

type RequestWithCorrelation = Request & {
  [requestContextKey]?: RequestCorrelationContext;
};

export interface RequestCorrelationContext {
  readonly correlation: CorrelationContext;
  readonly requestId: string;
}

export interface RequestCommandCorrelation {
  readonly commandId: string;
  readonly correlation: CorrelationContext;
}

export interface RequestCompletionLogger {
  info(input: {
    readonly durationMs: number;
    readonly event: "http_request_completed";
    readonly requestId: string;
    readonly resultCode: "HTTP_CLIENT_ERROR" | "HTTP_SERVER_ERROR" | "HTTP_SUCCESS";
    readonly statusCode: number;
    readonly trustedContext: CorrelationContext;
  }): void;
}

export interface RequestCorrelationOptions {
  readonly logger?: RequestCompletionLogger;
  readonly nowMilliseconds?: () => number;
  readonly uuidV7Factory?: UuidV7Factory;
}

function durationBetween(startedAt: number, completedAt: number): number {
  const elapsed = completedAt - startedAt;
  if (!Number.isFinite(elapsed)) return 0;
  return Math.min(maximumDurationMs, Math.max(0, Math.trunc(elapsed)));
}

function resultCode(
  statusCode: number,
): "HTTP_CLIENT_ERROR" | "HTTP_SERVER_ERROR" | "HTTP_SUCCESS" {
  if (statusCode >= 500) return "HTTP_SERVER_ERROR";
  if (statusCode >= 400) return "HTTP_CLIENT_ERROR";
  return "HTTP_SUCCESS";
}

export function getRequestCorrelationContext(request: Request): RequestCorrelationContext {
  const context = (request as RequestWithCorrelation)[requestContextKey];
  if (context === undefined) throw new Error("REQUEST_CORRELATION_CONTEXT_UNAVAILABLE");
  return context;
}

export function createRequestCommandCorrelation(
  request: Request,
  factory: UuidV7Factory = uuidV7,
): RequestCommandCorrelation {
  const requestContext = getRequestCorrelationContext(request);
  const commandId = factory();
  const correlation = deriveCorrelationContextFromCommand(requestContext.correlation, commandId);
  return Object.freeze({ commandId, correlation });
}

export function correlationForEventEmittedByCommand(
  command: RequestCommandCorrelation,
): CorrelationContext {
  const trusted = continueTrustedCorrelationContext(command.correlation);
  return deriveCorrelationContextFromCommand(
    { correlationId: trusted.correlationId },
    command.commandId,
  );
}

export function createRequestCorrelationMiddleware({
  logger,
  nowMilliseconds = Date.now,
  uuidV7Factory = uuidV7,
}: RequestCorrelationOptions = {}): RequestHandler {
  return (request, response, next) => {
    const startedAt = nowMilliseconds();
    const requestId = continueTrustedCorrelationContext({
      correlationId: uuidV7Factory(),
    }).correlationId;
    const correlation = createRootCorrelationContext(uuidV7Factory);
    const context = Object.freeze({ correlation, requestId });
    const localRequest = request as RequestWithCorrelation;
    Object.defineProperty(localRequest, requestContextKey, {
      configurable: true,
      enumerable: false,
      value: context,
      writable: false,
    });

    response.setHeader("X-Request-ID", requestId);
    response.setHeader("X-Correlation-ID", correlation.correlationId);

    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      response.off("finish", complete);
      response.off("close", complete);
      Reflect.deleteProperty(localRequest, requestContextKey);
      if (logger === undefined) return;
      try {
        logger.info({
          durationMs: durationBetween(startedAt, nowMilliseconds()),
          event: "http_request_completed",
          requestId,
          resultCode: resultCode(response.statusCode),
          statusCode: response.statusCode,
          trustedContext: correlation,
        });
      } catch {
        // Request and business completion never depend on observability.
      }
    };
    response.once("finish", complete);
    response.once("close", complete);
    next();
  };
}
