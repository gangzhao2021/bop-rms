import {
  continueTrustedCorrelationContext,
  createRootCorrelationContext,
  deriveCorrelationContextFromCommand,
  type CorrelationContext,
  type UuidV7Factory,
} from "@bop/eventing";
import type { CoreTelemetry } from "@bop-rms/observability";
import type { Request, RequestHandler } from "express";
import { v7 as uuidV7 } from "uuid";

const requestContextKey = Symbol("bop.request-correlation");
const requestErrorCodeKey = Symbol("bop.request-error-code");
const requestFailureCodeKey = Symbol("bop.request-failure-code");
const safeFailureCode = /^[A-Z][A-Z0-9_]{0,63}$/u;
const maximumDurationMs = 86_400_000;

type RequestWithCorrelation = Request & {
  [requestContextKey]?: RequestCorrelationContext;
  [requestErrorCodeKey]?: "INTERNAL_ERROR";
  [requestFailureCodeKey]?: string;
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
    /** A server error's safe cause code (and SQLSTATE), when the route recorded one. */
    readonly error?: { readonly code: string; readonly value: undefined };
  }): void;
}

export interface RequestCorrelationOptions {
  readonly logger?: RequestCompletionLogger;
  readonly nowMilliseconds?: () => number;
  readonly routeTemplates?: readonly string[];
  readonly telemetry?: CoreTelemetry;
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

function routeTemplate(request: Request, registered: ReadonlySet<string>): string {
  const route = (request.route as { path?: unknown } | undefined)?.path;
  if (typeof route !== "string") return "unmatched";
  const template = `${request.baseUrl}${route}`;
  return registered.has(template) ? template : "unmatched";
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

export function markRequestError(request: Request, errorCode: "INTERNAL_ERROR"): void {
  const localRequest = request as RequestWithCorrelation;
  Object.defineProperty(localRequest, requestErrorCodeKey, {
    configurable: true,
    enumerable: false,
    value: errorCode,
    writable: false,
  });
}

/**
 * v15 2026-10-16: a route answering 503 records why, as a safe upper-case code (for example
 * `TENANT_DATABASE_TRANSACTION_CONFLICT_SQL_40P01`), so `HTTP_SERVER_ERROR` lines are diagnosable.
 * Anything that is not a safe code is ignored; nothing else from the error is logged.
 */
export function markRequestFailure(request: Request, code: string | undefined): void {
  if (code === undefined || !safeFailureCode.test(code)) return;
  Object.defineProperty(request as RequestWithCorrelation, requestFailureCodeKey, {
    configurable: true,
    enumerable: false,
    value: code,
    writable: false,
  });
}

export function createRequestCorrelationMiddleware({
  logger,
  nowMilliseconds = Date.now,
  routeTemplates = [],
  telemetry,
  uuidV7Factory = uuidV7,
}: RequestCorrelationOptions = {}): RequestHandler {
  const registeredRoutes = new Set(routeTemplates);
  return (request, response, next) => {
    const startedAt = nowMilliseconds();
    const telemetryOperation = telemetry?.startOperation("http_request");
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
      const durationMs = durationBetween(startedAt, nowMilliseconds());
      const completionResult = resultCode(response.statusCode);
      telemetryOperation?.complete({
        durationMs,
        ...(localRequest[requestErrorCodeKey] === undefined
          ? {}
          : { errorCode: localRequest[requestErrorCodeKey] }),
        resultCode: completionResult,
        routeTemplate: routeTemplate(request, registeredRoutes),
      });
      const failureCode =
        completionResult === "HTTP_SERVER_ERROR" ? localRequest[requestFailureCodeKey] : undefined;
      Reflect.deleteProperty(localRequest, requestContextKey);
      Reflect.deleteProperty(localRequest, requestErrorCodeKey);
      Reflect.deleteProperty(localRequest, requestFailureCodeKey);
      if (logger === undefined) return;
      try {
        logger.info({
          durationMs,
          event: "http_request_completed",
          requestId,
          resultCode: completionResult,
          statusCode: response.statusCode,
          trustedContext: correlation,
          ...(failureCode === undefined ? {} : { error: { code: failureCode, value: undefined } }),
        });
      } catch {
        // Request and business completion never depend on observability.
      }
    };
    response.once("finish", complete);
    response.once("close", complete);
    if (telemetryOperation === undefined) next();
    else telemetryOperation.run(next);
  };
}
