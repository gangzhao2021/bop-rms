import { describe, expect, it, vi } from "vitest";
import {
  createCoreTelemetry,
  type CoreTelemetryBackend,
  type CoreTelemetryFailure,
} from "./index.js";

function recorder() {
  const records: unknown[] = [];
  const discarded: string[] = [];
  const started: unknown[] = [];
  const backend: CoreTelemetryBackend = {
    start(operation, attributes) {
      started.push({ attributes, operation });
      return {
        complete: (record) => records.push(record),
        discard: () => discarded.push(operation),
        run: (callback) => callback(),
      };
    },
  };
  return { backend, discarded, records, started };
}

const config = {
  allowedErrorCodes: ["INTERNAL_ERROR", "WORKER_START_FAILED"],
  allowedOperations: ["http_request", "worker_startup"],
  allowedResultCodes: ["HTTP_SERVER_ERROR", "HTTP_SUCCESS", "SUCCESS"],
  environment: "test" as const,
  module: "acceptance",
  routes: ["/health", "/ready", "unmatched"],
  service: "bop-rms-test",
};

describe("WP-0044 core telemetry", () => {
  it("emits the exact bounded instruments record and completes only once", () => {
    const output = recorder();
    const telemetry = createCoreTelemetry(config, { backend: output.backend });
    const operation = telemetry.startOperation("http_request");

    operation.complete({
      durationMs: 17,
      resultCode: "HTTP_SUCCESS",
      routeTemplate: "/health",
    });
    operation.complete({
      durationMs: 999,
      resultCode: "HTTP_SERVER_ERROR",
      routeTemplate: "/ready",
    });

    expect(output.started).toEqual([
      {
        attributes: {
          "bop.module": "acceptance",
          "bop.operation": "http_request",
          "deployment.environment.name": "test",
          "service.name": "bop-rms-test",
        },
        operation: "http_request",
      },
    ]);
    expect(output.records).toEqual([
      {
        attributes: {
          "bop.module": "acceptance",
          "bop.operation": "http_request",
          "bop.result_code": "HTTP_SUCCESS",
          "deployment.environment.name": "test",
          "http.route": "/health",
          "service.name": "bop-rms-test",
        },
        durationMs: 17,
        operation: "http_request",
      },
    ]);
  });

  it("tracks an error with a stable code and no raw value", () => {
    const output = recorder();
    const telemetry = createCoreTelemetry(config, { backend: output.backend });

    telemetry.startOperation("http_request").complete({
      durationMs: 5,
      errorCode: "INTERNAL_ERROR",
      resultCode: "HTTP_SERVER_ERROR",
      routeTemplate: "unmatched",
    });

    const serialized = JSON.stringify(output.records);
    expect(output.records).toEqual([
      expect.objectContaining({
        durationMs: 5,
        errorCode: "INTERNAL_ERROR",
        operation: "http_request",
      }),
    ]);
    for (const canary of [
      "raw-secret",
      "Bearer",
      "Cookie",
      "person@example.test",
      "SELECT",
      "customer",
      "session",
    ])
      expect(serialized).not.toContain(canary);
  });

  it("keeps cardinality finite under adversarial input", () => {
    const output = recorder();
    const failures: CoreTelemetryFailure[] = [];
    const telemetry = createCoreTelemetry(config, {
      backend: output.backend,
      onSafeFailure: (failure) => failures.push(failure),
    });

    for (let index = 0; index < 10_000; index += 1)
      telemetry.startOperation("http_request").complete({
        durationMs: index % 100,
        resultCode: "HTTP_SUCCESS",
        routeTemplate: index % 2 === 0 ? "/health" : "unmatched",
      });
    telemetry.startOperation("http_request").complete({
      durationMs: 1,
      resultCode: "HTTP_SUCCESS",
      routeTemplate: "/tenant/018f1f48-7b5d-7a01-8a1b-123456789abc?token=raw-secret",
    });
    telemetry.startOperation("tenant-018f1f48-7b5d-7a01-8a1b-123456789abc");

    const series = new Set(
      output.records.map((record) =>
        JSON.stringify((record as { attributes: Record<string, string> }).attributes),
      ),
    );
    expect(series.size).toBe(2);
    expect(output.records).toHaveLength(10_000);
    expect(output.discarded).toEqual(["http_request"]);
    expect(failures).toEqual(["TELEMETRY_SCHEMA_FAILED", "TELEMETRY_SCHEMA_FAILED"]);
    expect(JSON.stringify(output.records)).not.toContain("raw-secret");
    expect(JSON.stringify(output.records)).not.toContain("018f1f48");
  });

  it("isolates backend failures from caller control flow", () => {
    const failures: CoreTelemetryFailure[] = [];
    const telemetry = createCoreTelemetry(config, {
      backend: {
        start() {
          return {
            complete() {
              throw new Error("exporter unavailable with raw-secret");
            },
            discard() {
              throw new Error("discard unavailable");
            },
            run: (callback) => callback(),
          };
        },
      },
      onSafeFailure: (failure) => failures.push(failure),
    });

    expect(() =>
      telemetry.startOperation("worker_startup").complete({
        durationMs: 1,
        resultCode: "SUCCESS",
      }),
    ).not.toThrow();
    expect(failures).toEqual(["TELEMETRY_WRITE_FAILED"]);

    const startFailures: CoreTelemetryFailure[] = [];
    const startFailure = createCoreTelemetry(config, {
      backend: {
        start() {
          throw new Error("startup exporter failure");
        },
      },
      onSafeFailure: (failure) => startFailures.push(failure),
    });
    expect(() => startFailure.startOperation("worker_startup")).not.toThrow();
    expect(startFailures).toEqual(["TELEMETRY_WRITE_FAILED"]);
  });

  it("never retries business work when context activation fails", () => {
    for (const mode of ["before", "after"] as const) {
      const failures: CoreTelemetryFailure[] = [];
      const work = vi.fn(() => "business-result");
      const telemetry = createCoreTelemetry(config, {
        backend: {
          start() {
            return {
              complete: () => undefined,
              discard: () => undefined,
              run(callback) {
                if (mode === "before") throw new Error("context unavailable");
                callback();
                throw new Error("context cleanup unavailable");
              },
            };
          },
        },
        onSafeFailure: (failure) => failures.push(failure),
      });

      expect(telemetry.startOperation("worker_startup").run(work)).toBe("business-result");
      expect(work).toHaveBeenCalledOnce();
      expect(failures).toEqual(["TELEMETRY_WRITE_FAILED"]);
    }

    const output = recorder();
    const failure = new Error("business failure");
    const telemetry = createCoreTelemetry(config, { backend: output.backend });
    expect(() =>
      telemetry.startOperation("worker_startup").run(() => {
        throw failure;
      }),
    ).toThrow(failure);
  });

  it("fails configuration closed", () => {
    expect(() =>
      createCoreTelemetry({ ...config, allowedOperations: ["http_request", "http_request"] }),
    ).toThrow("invalid telemetry");
    expect(() => createCoreTelemetry({ ...config, routes: ["/health?token=raw-secret"] })).toThrow(
      "invalid telemetry",
    );
    expect(() =>
      createCoreTelemetry(config, {
        backend: recorder().backend,
        onSafeFailure: vi.fn(),
        token: "raw-secret",
      } as never),
    ).toThrow("invalid telemetry test options");
    expect(() =>
      createCoreTelemetry(
        { ...config, environment: "production" },
        { backend: recorder().backend },
      ),
    ).toThrow("invalid telemetry test options");
  });
});
