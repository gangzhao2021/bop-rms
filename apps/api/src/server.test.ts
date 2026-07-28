import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CoreTelemetry,
  NodeTelemetryRuntime,
  StructuredLogDestination,
} from "@bop-rms/observability";
import { HealthReadinessController } from "./health-readiness.js";
import { createApiRuntimeLogger, createApiServerRuntime } from "./server.js";

const runtimes: ReturnType<typeof createApiServerRuntime>[] = [];

afterEach(async () => {
  await Promise.all(
    runtimes.splice(0).map(async (runtime) => {
      if (runtime.server.listening) await runtime.shutdown("SIGTERM");
    }),
  );
});

function logger() {
  const records: string[] = [];
  const destination: StructuredLogDestination = {
    write: (message) => records.push(String(message)),
  };
  return { logger: createApiRuntimeLogger(destination), records };
}

function origin(runtime: ReturnType<typeof createApiServerRuntime>): string {
  const address = runtime.server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("WP-0043 API runtime lifecycle", () => {
  it("stays not ready until listening completes and the database probe succeeds", async () => {
    const healthReadiness = new HealthReadinessController({
      databaseProbe: () => "ready",
      now: () => "2026-07-28T00:00:00.000Z",
    });
    const output = logger();
    const runtime = createApiServerRuntime({
      healthReadiness,
      logger: output.logger,
      port: 0,
    });
    runtimes.push(runtime);

    expect(await healthReadiness.readinessSnapshot()).toMatchObject({ status: "not_ready" });

    await runtime.listen();
    const response = await fetch(`${origin(runtime)}/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      checkedAt: "2026-07-28T00:00:00.000Z",
      dependencies: { database: { required: true, status: "ready" } },
      service: "bop-rms-api",
      status: "ready",
    });
    expect(output.records.join("")).toContain('"event":"listening"');
  });

  it("enters drain synchronously before close and makes repeated shutdown idempotent", async () => {
    const healthReadiness = new HealthReadinessController({
      databaseProbe: () => "ready",
      now: () => "2026-07-28T00:00:00.000Z",
    });
    const output = logger();
    const runtime = createApiServerRuntime({
      healthReadiness,
      logger: output.logger,
      port: 0,
    });
    runtimes.push(runtime);
    await runtime.listen();

    const first = runtime.shutdown("SIGTERM");
    const second = runtime.shutdown("SIGINT");

    expect(second).toBe(first);
    expect(healthReadiness.resourceSnapshot().lifecycleState).toBe("draining");
    expect(await healthReadiness.readinessSnapshot()).toMatchObject({ status: "not_ready" });
    await expect(first).resolves.toBeUndefined();
    expect(runtime.server.listening).toBe(false);

    const records = output.records.join("");
    expect(records.match(/"event":"shutdown_started"/gu)).toHaveLength(1);
    expect(records.match(/"event":"shutdown_complete"/gu)).toHaveLength(1);
    expect(records).not.toContain("shutdown_failed");
  });

  it("preserves the truthful unconfigured database state in the real composition root", async () => {
    const output = logger();
    const runtime = createApiServerRuntime({ logger: output.logger, port: 0 });
    runtimes.push(runtime);

    await runtime.listen();
    const response = await fetch(`${origin(runtime)}/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      dependencies: { database: { required: true, status: "not_configured" } },
      status: "not_ready",
    });
  });

  it("orders WP-0044 telemetry startup and bounded shutdown around runtime intake", async () => {
    const order: string[] = [];
    const completions: unknown[] = [];
    const coreTelemetry: CoreTelemetry = {
      startOperation(operation) {
        order.push(`core-start:${operation}`);
        return {
          complete(completion) {
            completions.push({ completion, operation });
            order.push(`core-complete:${operation}`);
          },
          run: (callback) => callback(),
        };
      },
    };
    const nodeTelemetry: NodeTelemetryRuntime = {
      enabled: true,
      shutdown: async () => {
        order.push("node-shutdown");
        return "success";
      },
      start: () => order.push("node-start"),
    };
    const milliseconds = [100, 107, 200, 211];
    const runtime = createApiServerRuntime({
      coreTelemetry,
      logger: logger().logger,
      nodeTelemetry,
      nowMilliseconds: () => milliseconds.shift() ?? 211,
      port: 0,
    });
    runtimes.push(runtime);

    await runtime.listen();
    await runtime.shutdown("SIGTERM");

    expect(order).toEqual([
      "node-start",
      "core-start:api_startup",
      "core-complete:api_startup",
      "core-start:api_shutdown",
      "core-complete:api_shutdown",
      "node-shutdown",
    ]);
    expect(completions).toEqual([
      {
        completion: { durationMs: 7, resultCode: "SUCCESS" },
        operation: "api_startup",
      },
      {
        completion: { durationMs: 11, resultCode: "SUCCESS" },
        operation: "api_shutdown",
      },
    ]);
  });

  it("isolates telemetry flush timeout from completed API shutdown", async () => {
    const output = logger();
    const nodeTelemetry: NodeTelemetryRuntime = {
      enabled: true,
      shutdown: async () => "timeout",
      start: () => undefined,
    };
    const runtime = createApiServerRuntime({
      logger: output.logger,
      nodeTelemetry,
      port: 0,
    });
    runtimes.push(runtime);
    await runtime.listen();

    await expect(runtime.shutdown("SIGTERM")).resolves.toBeUndefined();

    expect(output.records.join("")).toContain('"event":"telemetry_shutdown_failed"');
    expect(output.records.join("")).toContain('"resultCode":"TELEMETRY_SHUTDOWN_FAILED"');
  });
});
