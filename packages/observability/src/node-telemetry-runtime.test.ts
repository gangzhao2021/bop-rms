import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeTelemetryRuntime, type NodeTelemetrySdk } from "./index.js";

afterEach(() => {
  vi.useRealTimers();
});

function sdk() {
  const value: NodeTelemetrySdk = {
    shutdown: vi.fn(() => Promise.resolve()),
    start: vi.fn(),
  };
  return value;
}

const enabledEnvironment = {
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
  OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
  OTEL_LOGS_EXPORTER: "none",
  OTEL_METRICS_EXPORTER: "otlp",
  OTEL_SDK_DISABLED: "false",
  OTEL_TRACES_EXPORTER: "otlp",
  OTEL_TRACES_SAMPLER: "always_on",
} as const;

describe("WP-0044 Node telemetry runtime", () => {
  it("keeps development/test export disabled by default", async () => {
    const factory = vi.fn(() => sdk());
    const runtime = createNodeTelemetryRuntime({
      environment: "development",
      environmentVariables: {},
      sdkFactory: factory,
      serviceName: "bop-rms-api",
    });

    runtime.start();
    runtime.start();

    expect(runtime.enabled).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    await expect(runtime.shutdown()).resolves.toBe("disabled");
  });

  it("validates staging/production OTLP-to-sidecar configuration", () => {
    const valid = createNodeTelemetryRuntime({
      environment: "production",
      environmentVariables: enabledEnvironment,
      sdkFactory: () => sdk(),
      serviceName: "bop-rms-api",
    });
    expect(valid.enabled).toBe(true);

    for (const environmentVariables of [
      {},
      { ...enabledEnvironment, OTEL_SDK_DISABLED: "true" },
      { ...enabledEnvironment, OTEL_METRICS_EXPORTER: "none" },
      { ...enabledEnvironment, OTEL_TRACES_EXPORTER: "console" },
      { ...enabledEnvironment, OTEL_LOGS_EXPORTER: "otlp" },
      { ...enabledEnvironment, OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" },
      { ...enabledEnvironment, OTEL_TRACES_SAMPLER: "parentbased_traceidratio" },
      { ...enabledEnvironment, OTEL_TRACES_SAMPLER_ARG: "0.1" },
      {
        ...enabledEnvironment,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://unreviewed.example.test",
      },
      { ...enabledEnvironment, OTEL_RESOURCE_ATTRIBUTES: "customer.id=raw-secret" },
      { ...enabledEnvironment, OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example.test:4318" },
      { ...enabledEnvironment, OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:secret@example.test" },
      { ...enabledEnvironment, OTEL_EXPORTER_OTLP_ENDPOINT: "https://example.test?token=secret" },
      { ...enabledEnvironment, OTEL_EXPORTER_OTLP_HEADERS: "authorization=raw-secret" },
    ])
      expect(() =>
        createNodeTelemetryRuntime({
          environment: "staging",
          environmentVariables,
          sdkFactory: () => sdk(),
          serviceName: "bop-rms-worker",
        }),
      ).toThrow();
  });

  it("starts once and shares a successful shutdown", async () => {
    const instance = sdk();
    const factory = vi.fn(() => instance);
    const runtime = createNodeTelemetryRuntime({
      environment: "test",
      environmentVariables: enabledEnvironment,
      sdkFactory: factory,
      serviceName: "bop-rms-worker",
    });

    runtime.start();
    runtime.start();
    const first = runtime.shutdown();
    const second = runtime.shutdown();

    expect(first).toBe(second);
    await expect(first).resolves.toBe("success");
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith({
      autoDetectResources: false,
      serviceName: "bop-rms-worker",
      textMapPropagator: null,
    });
    expect(instance.start).toHaveBeenCalledOnce();
    expect(instance.shutdown).toHaveBeenCalledOnce();
  });

  it("bounds shutdown and classifies SDK rejection", async () => {
    vi.useFakeTimers();
    const never = sdk();
    never.shutdown = vi.fn(() => new Promise<void>(() => undefined));
    const runtime = createNodeTelemetryRuntime({
      environment: "test",
      environmentVariables: enabledEnvironment,
      sdkFactory: () => never,
      serviceName: "bop-rms-worker",
      shutdownTimeoutMilliseconds: 25,
    });
    runtime.start();

    const result = runtime.shutdown();
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toBe("timeout");

    const rejected = sdk();
    rejected.shutdown = vi.fn(() => Promise.reject(new Error("raw exporter secret")));
    const rejectedRuntime = createNodeTelemetryRuntime({
      environment: "test",
      environmentVariables: enabledEnvironment,
      sdkFactory: () => rejected,
      serviceName: "bop-rms-api",
    });
    rejectedRuntime.start();
    await expect(rejectedRuntime.shutdown()).resolves.toBe("failed");
  });

  it("fails invalid identity and shutdown bounds before SDK creation", () => {
    expect(() =>
      createNodeTelemetryRuntime({
        environment: "production",
        environmentVariables: enabledEnvironment,
        serviceName: "BOP RAW SERVICE",
      }),
    ).toThrow("invalid telemetry runtime identity");
    expect(() =>
      createNodeTelemetryRuntime({
        environment: "production",
        environmentVariables: enabledEnvironment,
        serviceName: "bop-rms-api",
        shutdownTimeoutMilliseconds: 5_001,
      }),
    ).toThrow("invalid telemetry shutdown timeout");
  });
});
