import { context, metrics, SpanStatusCode, trace, type Attributes } from "@opentelemetry/api";

const safeName = /^[a-z][a-z0-9-]{0,62}$/u;
const safeOperation = /^[a-z][a-z0-9_]{0,62}$/u;
const safeCode = /^[A-Z][A-Z0-9_]{0,63}$/u;
const safeRoute = /^(?:unmatched|\/(?:[a-z0-9_:-]+(?:\/[a-z0-9_:-]+)*)?)$/u;
const maximumDurationMilliseconds = 86_400_000;

export type CoreTelemetryFailure = "TELEMETRY_SCHEMA_FAILED" | "TELEMETRY_WRITE_FAILED";
export type TelemetryEnvironment = "development" | "production" | "staging" | "test";

export interface CoreTelemetryConfig {
  readonly allowedErrorCodes: readonly string[];
  readonly allowedOperations: readonly string[];
  readonly allowedResultCodes: readonly string[];
  readonly environment: TelemetryEnvironment;
  readonly module: string;
  readonly routes?: readonly string[];
  readonly service: string;
}

export interface CoreTelemetryCompletion {
  readonly durationMs: number;
  readonly errorCode?: string;
  readonly resultCode: string;
  readonly routeTemplate?: string;
}

export interface CoreTelemetryOperation {
  complete(completion: CoreTelemetryCompletion): void;
  run<T>(callback: () => T): T;
}

export interface CoreTelemetry {
  startOperation(operation: string): CoreTelemetryOperation;
}

interface TelemetryRecord {
  readonly attributes: Readonly<{
    "bop.module": string;
    "bop.operation": string;
    "bop.result_code": string;
    "deployment.environment.name": TelemetryEnvironment;
    "http.route"?: string;
    "service.name": string;
  }>;
  readonly durationMs: number;
  readonly errorCode?: string;
  readonly operation: string;
}

export interface CoreTelemetryBackendOperation {
  complete(record: TelemetryRecord): void;
  discard(): void;
  run<T>(callback: () => T): T;
}

export interface CoreTelemetryBackend {
  start(operation: string, attributes: Attributes): CoreTelemetryBackendOperation;
}

export interface CoreTelemetryOptions {
  /** Synthetic/local/CI evidence only. */
  readonly backend?: CoreTelemetryBackend;
  /** Bounded synthetic failure signal; callback failures are isolated. */
  readonly onSafeFailure?: (failure: CoreTelemetryFailure) => void;
}

function exactFiniteSet(
  values: readonly string[] | undefined,
  pattern: RegExp,
  minimumSize: number,
): ReadonlySet<string> {
  if (!Array.isArray(values) || values.length < minimumSize)
    throw new TypeError("invalid telemetry");
  const output = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !pattern.test(value) || output.has(value))
      throw new TypeError("invalid telemetry");
    output.add(value);
  }
  return output;
}

function defaultBackend(): CoreTelemetryBackend {
  const meter = metrics.getMeter("@bop-rms/observability", "0.0.0");
  const tracer = trace.getTracer("@bop-rms/observability", "0.0.0");
  const operationCounter = meter.createCounter("bop.operation.count", {
    description: "Completed bounded runtime operations",
    unit: "{operation}",
  });
  const operationDuration = meter.createHistogram("bop.operation.duration", {
    description: "Completed bounded runtime operation duration",
    unit: "ms",
  });
  const errorCounter = meter.createCounter("bop.error.count", {
    description: "Completed bounded runtime errors",
    unit: "{error}",
  });

  return {
    start(operation, initialAttributes) {
      const span = tracer.startSpan(`bop.${operation}`, { attributes: initialAttributes });
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        span.end();
      };
      return {
        complete(record) {
          try {
            operationCounter.add(1, record.attributes);
            operationDuration.record(record.durationMs, record.attributes);
            for (const [key, value] of Object.entries(record.attributes))
              span.setAttribute(key, value);
            if (record.attributes["http.route"] !== undefined)
              span.updateName(`bop.${record.operation} ${record.attributes["http.route"]}`);
            if (record.errorCode === undefined) {
              span.setStatus({ code: SpanStatusCode.OK });
            } else {
              errorCounter.add(1, record.attributes);
              span.addEvent("bop.error", { "error.code": record.errorCode });
              span.setStatus({ code: SpanStatusCode.ERROR });
            }
          } finally {
            end();
          }
        },
        discard: end,
        run: (callback) => context.with(trace.setSpan(context.active(), span), callback),
      };
    },
  };
}

function validateConfig(config: CoreTelemetryConfig): {
  errorCodes: ReadonlySet<string>;
  operations: ReadonlySet<string>;
  results: ReadonlySet<string>;
  routes: ReadonlySet<string>;
} {
  if (
    config === null ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).some(
      (field) =>
        ![
          "allowedOperations",
          "allowedErrorCodes",
          "allowedResultCodes",
          "environment",
          "module",
          "routes",
          "service",
        ].includes(field),
    ) ||
    !safeName.test(config.service) ||
    !safeName.test(config.module) ||
    !["development", "production", "staging", "test"].includes(config.environment)
  )
    throw new TypeError("invalid telemetry configuration");

  return {
    errorCodes: exactFiniteSet(config.allowedErrorCodes, safeCode, 1),
    operations: exactFiniteSet(config.allowedOperations, safeOperation, 1),
    results: exactFiniteSet(config.allowedResultCodes, safeCode, 1),
    routes: exactFiniteSet(config.routes ?? ["unmatched"], safeRoute, 1),
  };
}

export function createCoreTelemetry(
  config: CoreTelemetryConfig,
  options: CoreTelemetryOptions = {},
): CoreTelemetry {
  const registry = validateConfig(config);
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((field) => !["backend", "onSafeFailure"].includes(field)) ||
    ((options.backend !== undefined || options.onSafeFailure !== undefined) &&
      config.environment !== "test")
  )
    throw new TypeError("invalid telemetry test options");

  const backend = options.backend ?? defaultBackend();
  const notify = (failure: CoreTelemetryFailure): void => {
    try {
      options.onSafeFailure?.(failure);
    } catch {
      // Telemetry failure is isolated from caller control flow.
    }
  };

  return Object.freeze({
    startOperation(operation: string): CoreTelemetryOperation {
      if (typeof operation !== "string" || !registry.operations.has(operation)) {
        notify("TELEMETRY_SCHEMA_FAILED");
        return Object.freeze({
          complete: () => undefined,
          run: <T>(callback: () => T): T => callback(),
        });
      }

      let backendOperation: CoreTelemetryBackendOperation;
      try {
        backendOperation = backend.start(operation, {
          "bop.module": config.module,
          "bop.operation": operation,
          "deployment.environment.name": config.environment,
          "service.name": config.service,
        });
      } catch {
        notify("TELEMETRY_WRITE_FAILED");
        return Object.freeze({
          complete: () => undefined,
          run: <T>(callback: () => T): T => callback(),
        });
      }

      let completed = false;
      return Object.freeze({
        complete(completion: CoreTelemetryCompletion): void {
          if (completed) return;
          completed = true;
          const routeTemplate = completion?.routeTemplate;
          if (
            completion === null ||
            typeof completion !== "object" ||
            Array.isArray(completion) ||
            Object.keys(completion).some(
              (field) =>
                !["durationMs", "errorCode", "resultCode", "routeTemplate"].includes(field),
            ) ||
            !Number.isInteger(completion.durationMs) ||
            completion.durationMs < 0 ||
            completion.durationMs > maximumDurationMilliseconds ||
            !registry.results.has(completion.resultCode) ||
            (routeTemplate !== undefined && !registry.routes.has(routeTemplate)) ||
            (completion.errorCode !== undefined &&
              (typeof completion.errorCode !== "string" ||
                !registry.errorCodes.has(completion.errorCode)))
          ) {
            try {
              backendOperation.discard();
            } catch {
              notify("TELEMETRY_WRITE_FAILED");
            }
            notify("TELEMETRY_SCHEMA_FAILED");
            return;
          }

          const record: TelemetryRecord = Object.freeze({
            attributes: Object.freeze({
              "bop.module": config.module,
              "bop.operation": operation,
              "bop.result_code": completion.resultCode,
              "deployment.environment.name": config.environment,
              ...(routeTemplate === undefined ? {} : { "http.route": routeTemplate }),
              "service.name": config.service,
            }),
            durationMs: completion.durationMs,
            ...(completion.errorCode === undefined ? {} : { errorCode: completion.errorCode }),
            operation,
          });
          try {
            backendOperation.complete(record);
          } catch {
            try {
              backendOperation.discard();
            } catch {
              // The bounded failure signal below is sufficient.
            }
            notify("TELEMETRY_WRITE_FAILED");
          }
        },
        run<T>(callback: () => T): T {
          const callbackState: { value: "completed" | "not_started" | "threw" } = {
            value: "not_started",
          };
          let callbackResult: T | undefined;
          let callbackError: unknown;
          try {
            return backendOperation.run(() => {
              try {
                callbackResult = callback();
                callbackState.value = "completed";
                return callbackResult;
              } catch (error) {
                callbackState.value = "threw";
                callbackError = error;
                throw error;
              }
            });
          } catch {
            if (callbackState.value === "threw") throw callbackError;
            notify("TELEMETRY_WRITE_FAILED");
            if (callbackState.value === "completed") return callbackResult as T;
            return callback();
          }
        },
      });
    },
  });
}
