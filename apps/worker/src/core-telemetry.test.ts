import type { CoreTelemetry, CoreTelemetryCompletion } from "@bop-rms/observability";
import { describe, expect, it } from "vitest";
import { WorkerLifecycle } from "./lifecycle.js";

function recorder() {
  const completions: { completion: CoreTelemetryCompletion; operation: string }[] = [];
  const telemetry: CoreTelemetry = {
    startOperation(operation) {
      return {
        complete(completion) {
          completions.push({ completion, operation });
        },
        run: (callback) => callback(),
      };
    },
  };
  return { completions, telemetry };
}

function clock(values: readonly number[]) {
  const remaining = [...values];
  return () => {
    const value = remaining.shift();
    if (value === undefined) throw new Error("clock exhausted");
    return value;
  };
}

describe("WP-0044 Worker core telemetry", () => {
  it("records startup/shutdown once with bounded results", async () => {
    const output = recorder();
    const lifecycle = new WorkerLifecycle({
      nowMilliseconds: clock([100, 107, 200, 211]),
      telemetry: output.telemetry,
    });

    await lifecycle.start();
    await Promise.all([lifecycle.stop(), lifecycle.stop()]);

    expect(output.completions).toEqual([
      {
        completion: { durationMs: 7, resultCode: "SUCCESS" },
        operation: "worker_startup",
      },
      {
        completion: { durationMs: 11, resultCode: "SUCCESS" },
        operation: "worker_shutdown",
      },
    ]);
  });

  it("records only stable failure codes and preserves thrown control flow", async () => {
    const startOutput = recorder();
    const startFailure = new WorkerLifecycle({
      nowMilliseconds: clock([10, 14]),
      onStart: () => {
        throw new Error("Bearer raw-secret person@example.test SELECT * FROM customer");
      },
      telemetry: startOutput.telemetry,
    });
    await expect(startFailure.start()).rejects.toThrow("raw-secret");
    expect(startOutput.completions).toEqual([
      {
        completion: {
          durationMs: 4,
          errorCode: "WORKER_START_FAILED",
          resultCode: "WORKER_START_FAILED",
        },
        operation: "worker_startup",
      },
    ]);

    const stopOutput = recorder();
    const stopFailure = new WorkerLifecycle({
      nowMilliseconds: clock([20, 21, 30, 35]),
      onStop: () => {
        throw new Error("Cookie=session raw shutdown payload");
      },
      telemetry: stopOutput.telemetry,
    });
    await stopFailure.start();
    await expect(stopFailure.stop()).rejects.toThrow("raw shutdown");
    expect(stopOutput.completions).toEqual([
      {
        completion: { durationMs: 1, resultCode: "SUCCESS" },
        operation: "worker_startup",
      },
      {
        completion: {
          durationMs: 5,
          errorCode: "WORKER_SHUTDOWN_FAILED",
          resultCode: "WORKER_SHUTDOWN_FAILED",
        },
        operation: "worker_shutdown",
      },
    ]);
    expect(JSON.stringify([...startOutput.completions, ...stopOutput.completions])).not.toContain(
      "raw-secret",
    );
  });
});
