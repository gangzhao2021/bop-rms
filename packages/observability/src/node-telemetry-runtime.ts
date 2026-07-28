import { NodeSDK } from "@opentelemetry/sdk-node";
import type { TelemetryEnvironment } from "./core-telemetry.js";

const maximumEndpointLength = 2_048;
const maximumShutdownMilliseconds = 5_000;
const allowedEnvironmentVariables = new Set([
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_EXPORTER",
  "OTEL_TRACES_SAMPLER",
  "OTEL_TRACES_SAMPLER_ARG",
]);

export type TelemetryShutdownResult = "disabled" | "failed" | "success" | "timeout";

export interface NodeTelemetryRuntime {
  readonly enabled: boolean;
  shutdown(): Promise<TelemetryShutdownResult>;
  start(): void;
}

export interface NodeTelemetryEnvironment {
  readonly OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  readonly OTEL_EXPORTER_OTLP_HEADERS?: string;
  readonly OTEL_EXPORTER_OTLP_PROTOCOL?: string;
  readonly OTEL_LOGS_EXPORTER?: string;
  readonly OTEL_METRICS_EXPORTER?: string;
  readonly OTEL_SDK_DISABLED?: string;
  readonly OTEL_TRACES_EXPORTER?: string;
  readonly OTEL_TRACES_SAMPLER?: string;
  readonly OTEL_TRACES_SAMPLER_ARG?: string;
}

export interface NodeTelemetrySdk {
  shutdown(): Promise<void>;
  start(): void;
}

export interface NodeTelemetrySdkConfiguration {
  readonly autoDetectResources: false;
  readonly serviceName: string;
  readonly textMapPropagator: null;
}

export interface NodeTelemetryRuntimeOptions {
  readonly environment: TelemetryEnvironment;
  readonly environmentVariables?: NodeTelemetryEnvironment;
  readonly sdkFactory?: (configuration: NodeTelemetrySdkConfiguration) => NodeTelemetrySdk;
  readonly serviceName: string;
  readonly shutdownTimeoutMilliseconds?: number;
}

function requireShutdownTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximumShutdownMilliseconds)
    throw new TypeError("invalid telemetry shutdown timeout");
  return value;
}

function validateEndpoint(value: string): void {
  if (value.length === 0 || value.length > maximumEndpointLength)
    throw new TypeError("invalid OTLP endpoint");
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("invalid OTLP endpoint");
  }
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  )
    throw new TypeError("invalid OTLP endpoint");
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(loopback && endpoint.protocol === "http:"))
    throw new TypeError("invalid OTLP endpoint");
}

function enabledConfiguration(
  environment: TelemetryEnvironment,
  variables: NodeTelemetryEnvironment,
): boolean {
  const productionLike = environment === "production" || environment === "staging";
  if (!productionLike && variables.OTEL_SDK_DISABLED !== "false") return false;
  if (
    Object.keys(variables).some(
      (name) => name.startsWith("OTEL_") && !allowedEnvironmentVariables.has(name),
    ) ||
    variables.OTEL_SDK_DISABLED !== "false" ||
    variables.OTEL_EXPORTER_OTLP_PROTOCOL !== "http/protobuf" ||
    variables.OTEL_LOGS_EXPORTER !== "none" ||
    variables.OTEL_METRICS_EXPORTER !== "otlp" ||
    variables.OTEL_TRACES_EXPORTER !== "otlp" ||
    variables.OTEL_TRACES_SAMPLER !== "always_on" ||
    (variables.OTEL_TRACES_SAMPLER_ARG ?? "") !== "" ||
    typeof variables.OTEL_EXPORTER_OTLP_ENDPOINT !== "string" ||
    (variables.OTEL_EXPORTER_OTLP_HEADERS ?? "") !== ""
  )
    throw new TypeError("invalid telemetry runtime configuration");
  validateEndpoint(variables.OTEL_EXPORTER_OTLP_ENDPOINT);
  return true;
}

export function createNodeTelemetryRuntime({
  environment,
  environmentVariables = process.env,
  sdkFactory = (configuration) => new NodeSDK(configuration),
  serviceName,
  shutdownTimeoutMilliseconds = 2_000,
}: NodeTelemetryRuntimeOptions): NodeTelemetryRuntime {
  if (
    !["development", "production", "staging", "test"].includes(environment) ||
    !/^[a-z][a-z0-9-]{0,62}$/u.test(serviceName)
  )
    throw new TypeError("invalid telemetry runtime identity");
  const shutdownTimeout = requireShutdownTimeout(shutdownTimeoutMilliseconds);
  const enabled = enabledConfiguration(environment, environmentVariables);
  const sdk = enabled
    ? sdkFactory({
        autoDetectResources: false,
        serviceName,
        textMapPropagator: null,
      })
    : undefined;
  let started = false;
  let shutdownPromise: Promise<TelemetryShutdownResult> | undefined;

  const shutdown = (): Promise<TelemetryShutdownResult> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    if (sdk === undefined || !started) {
      shutdownPromise = Promise.resolve("disabled");
      return shutdownPromise;
    }
    shutdownPromise = new Promise<TelemetryShutdownResult>((resolve) => {
      let settled = false;
      const finish = (result: TelemetryShutdownResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish("timeout"), shutdownTimeout);
      timer.unref();
      void sdk.shutdown().then(
        () => finish("success"),
        () => finish("failed"),
      );
    });
    return shutdownPromise;
  };

  return Object.freeze({
    enabled,
    shutdown,
    start(): void {
      if (started || sdk === undefined) return;
      started = true;
      sdk.start();
    },
  });
}
