import pino, { type DestinationStream, type Logger } from "pino";

const safeName = /^[a-z][a-z0-9-]{0,62}$/u;
const safeEvent = /^[a-z][a-z0-9_]{0,62}$/u;
const safeCode = /^[A-Z][A-Z0-9_]{0,63}$/u;
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const inputFields = new Set(["error", "event", "port", "resultCode", "signal", "trustedContext"]);
const contextFields = new Set(["causationId", "correlationId"]);
const errorFields = new Set(["code", "value"]);
const environments = new Set(["development", "production", "staging", "test"]);
const levels = new Set(["debug", "error", "info", "warn"]);
const signals = new Set(["SIGINT", "SIGTERM"]);

export type LoggerEnvironment = "development" | "production" | "staging" | "test";
export type StructuredLogFailure = "LOG_REDACTION_FAILED" | "LOG_WRITE_FAILED";

export interface StructuredLogDestination {
  write(message: string): void;
}

export interface TrustedCorrelationContext {
  readonly correlationId: string;
  readonly causationId?: string;
}

export interface StructuredLoggerConfig<EventName extends string = string> {
  readonly allowedEvents: readonly EventName[];
  readonly environment: LoggerEnvironment;
  readonly level?: "debug" | "error" | "info" | "warn";
  readonly module: string;
  readonly service: string;
}

export interface StructuredLoggerOptions {
  /**
   * Synthetic/local/CI evidence only. Production composition roots omit this
   * option and therefore emit Structured JSON to stdout.
   */
  readonly destination?: StructuredLogDestination;
  /** Bounded synthetic failure signal; callback failures are also isolated. */
  readonly onSafeFailure?: (failure: StructuredLogFailure) => void;
}

export interface StructuredLogInput<EventName extends string = string> {
  readonly error?: {
    readonly code: string;
    readonly value: unknown;
  };
  readonly event: EventName;
  readonly port?: number;
  readonly resultCode?: string;
  readonly signal?: "SIGINT" | "SIGTERM";
  /**
   * Only a context already validated by the WP-0034 trusted in-process
   * boundary may be supplied. Never pass header/query/body/Provider input.
   */
  readonly trustedContext?: TrustedCorrelationContext;
}

export interface StructuredLogger<EventName extends string = string> {
  debug(input: StructuredLogInput<EventName>): void;
  error(input: StructuredLogInput<EventName>): void;
  info(input: StructuredLogInput<EventName>): void;
  warn(input: StructuredLogInput<EventName>): void;
}

interface SerializedRecord {
  causationId?: string;
  correlationId?: string;
  error?: {
    readonly code: string;
    readonly stack?: string;
  };
  event: string;
  port?: number;
  resultCode?: string;
  signal?: "SIGINT" | "SIGTERM";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertExactFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(record).some((field) => !allowed.has(field)))
    throw new TypeError("structured log schema rejected");
}

function requireSafeCode(value: unknown): asserts value is string {
  if (typeof value !== "string" || !safeCode.test(value))
    throw new TypeError("structured log code rejected");
}

function serializeContext(value: unknown): TrustedCorrelationContext {
  if (!isPlainRecord(value)) throw new TypeError("trusted correlation context rejected");
  assertExactFields(value, contextFields);
  if (typeof value.correlationId !== "string" || !uuidV7.test(value.correlationId))
    throw new TypeError("trusted correlation context rejected");
  const causationId = value.causationId;
  if (
    Object.hasOwn(value, "causationId") &&
    (typeof causationId !== "string" || !uuidV7.test(causationId))
  )
    throw new TypeError("trusted causation context rejected");
  return Object.freeze({
    correlationId: value.correlationId,
    ...(typeof causationId === "string" ? { causationId } : {}),
  });
}

function sanitizeStack(value: unknown): string | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function"))
    return undefined;

  const stack = Reflect.get(value, "stack");
  if (typeof stack !== "string") return undefined;

  const framePositions = stack
    .split(/\r?\n/u)
    .slice(1, 21)
    .map((line) => {
      const position = /:(\d{1,7}):(\d{1,7})\)?\s*$/u.exec(line);
      return position ? `    at [REDACTED_FRAME]:${position[1]}:${position[2]}` : null;
    })
    .filter((line): line is string => line !== null);

  return [
    "Error",
    ...(framePositions.length === 0 ? ["    at [REDACTED_FRAME]"] : framePositions),
  ].join("\n");
}

function serializeError(value: unknown): SerializedRecord["error"] {
  if (!isPlainRecord(value)) throw new TypeError("structured error schema rejected");
  assertExactFields(value, errorFields);
  requireSafeCode(value.code);
  const stack = sanitizeStack(value.value);
  return Object.freeze({
    code: value.code,
    ...(stack === undefined ? {} : { stack }),
  });
}

function serializeRecord(input: unknown, allowedEvents: ReadonlySet<string>): SerializedRecord {
  if (!isPlainRecord(input)) throw new TypeError("structured log record rejected");
  assertExactFields(input, inputFields);
  const event = input.event;
  if (typeof event !== "string" || !allowedEvents.has(event))
    throw new TypeError("structured log event rejected");

  const record: SerializedRecord = { event };
  const resultCode = input.resultCode;
  if (resultCode !== undefined) {
    requireSafeCode(resultCode);
    record.resultCode = resultCode;
  }
  const signal = input.signal;
  if (signal !== undefined) {
    if (typeof signal !== "string" || !signals.has(signal))
      throw new TypeError("structured log signal rejected");
    record.signal = signal as "SIGINT" | "SIGTERM";
  }
  const port = input.port;
  if (port !== undefined) {
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535)
      throw new TypeError("structured log port rejected");
    record.port = port;
  }

  if (input.trustedContext !== undefined) {
    const context = serializeContext(input.trustedContext);
    Object.assign(record, {
      correlationId: context.correlationId,
      ...(context.causationId === undefined ? {} : { causationId: context.causationId }),
    });
  }
  if (input.error !== undefined) Object.assign(record, { error: serializeError(input.error) });
  return Object.freeze(record);
}

function validateConfig<EventName extends string>(
  config: StructuredLoggerConfig<EventName>,
): ReadonlySet<string> {
  if (
    !isPlainRecord(config) ||
    Object.keys(config).some(
      (field) => !["allowedEvents", "environment", "level", "module", "service"].includes(field),
    ) ||
    !safeName.test(config.service) ||
    !safeName.test(config.module) ||
    !environments.has(config.environment) ||
    (config.level !== undefined && !levels.has(config.level)) ||
    !Array.isArray(config.allowedEvents) ||
    config.allowedEvents.length === 0
  )
    throw new TypeError("invalid structured logger configuration");

  const allowedEvents = new Set<string>();
  for (const event of config.allowedEvents) {
    if (
      typeof event !== "string" ||
      !safeEvent.test(event) ||
      event === "observability_redaction_failed" ||
      allowedEvents.has(event)
    )
      throw new TypeError("invalid structured logger event allowlist");
    allowedEvents.add(event);
  }
  return allowedEvents;
}

export function createStructuredLogger<const EventName extends string>(
  config: StructuredLoggerConfig<EventName>,
  options: StructuredLoggerOptions = {},
): StructuredLogger<EventName> {
  const allowedEvents = validateConfig(config);
  const rawOptions: unknown = options;
  if (
    !isPlainRecord(rawOptions) ||
    Object.keys(rawOptions).some((field) => !["destination", "onSafeFailure"].includes(field)) ||
    ((options.destination !== undefined || options.onSafeFailure !== undefined) &&
      config.environment !== "test")
  )
    throw new TypeError("invalid structured logger test options");
  const destination = options.destination as DestinationStream | undefined;
  const logger: Logger = pino(
    {
      base: {
        environment: config.environment,
        module: config.module,
        service: config.service,
      },
      level: config.level ?? "info",
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
  let disabled = false;

  const notify = (failure: StructuredLogFailure): void => {
    try {
      options.onSafeFailure?.(failure);
    } catch {
      // Observability failure is isolated from business control flow.
    }
  };

  const disableForRedactionFailure = (): void => {
    disabled = true;
    notify("LOG_REDACTION_FAILED");
    try {
      logger.error({
        event: "observability_redaction_failed",
        resultCode: "LOG_REDACTION_FAILED",
      });
    } catch {
      notify("LOG_WRITE_FAILED");
    }
  };

  const write = (
    level: "debug" | "error" | "info" | "warn",
    input: StructuredLogInput<EventName>,
  ): void => {
    if (disabled) return;
    let record: SerializedRecord;
    try {
      record = serializeRecord(input, allowedEvents);
    } catch {
      disableForRedactionFailure();
      return;
    }
    try {
      logger[level](record);
    } catch {
      disabled = true;
      notify("LOG_WRITE_FAILED");
    }
  };

  return Object.freeze({
    debug: (input: StructuredLogInput<EventName>) => write("debug", input),
    error: (input: StructuredLogInput<EventName>) => write("error", input),
    info: (input: StructuredLogInput<EventName>) => write("info", input),
    warn: (input: StructuredLogInput<EventName>) => write("warn", input),
  });
}
