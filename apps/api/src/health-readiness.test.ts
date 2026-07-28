import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthReadinessController } from "./health-readiness.js";

afterEach(() => {
  vi.useRealTimers();
});

const now = () => "2026-07-28T00:00:00.000Z";

describe("WP-0043 health and readiness contract", () => {
  it("keeps liveness dependency-free with the closed public representation", () => {
    const controller = new HealthReadinessController({
      databaseProbe: () => {
        throw new Error("liveness must not probe");
      },
      now,
    });

    expect(controller.healthSnapshot()).toEqual({
      checkedAt: "2026-07-28T00:00:00.000Z",
      service: "bop-rms-api",
      status: "healthy",
    });
    expect(controller.resourceSnapshot().probeInFlight).toBe(false);
  });

  it("fails closed during startup and remains not configured without a database adapter", async () => {
    const probe = vi.fn(() => "ready" as const);
    const starting = new HealthReadinessController({ databaseProbe: probe, now });
    const unconfigured = new HealthReadinessController({ now });

    expect(await starting.readinessSnapshot()).toEqual({
      checkedAt: "2026-07-28T00:00:00.000Z",
      dependencies: { database: { required: true, status: "not_ready" } },
      service: "bop-rms-api",
      status: "not_ready",
    });
    expect(probe).not.toHaveBeenCalled();

    unconfigured.completeStartup();
    expect(await unconfigured.readinessSnapshot()).toEqual({
      checkedAt: "2026-07-28T00:00:00.000Z",
      dependencies: { database: { required: true, status: "not_configured" } },
      service: "bop-rms-api",
      status: "not_ready",
    });
  });

  it("becomes ready only after startup and a required dependency success", async () => {
    const controller = new HealthReadinessController({ databaseProbe: () => "ready", now });

    controller.completeStartup();

    expect(await controller.readinessSnapshot()).toEqual({
      checkedAt: "2026-07-28T00:00:00.000Z",
      dependencies: { database: { required: true, status: "ready" } },
      service: "bop-rms-api",
      status: "ready",
    });
  });

  it.each([
    ["throw", () => Promise.reject(new Error("postgresql://secret-host/raw-secret"))],
    ["invalid result", () => Promise.resolve("raw-secret" as never)],
    ["explicit failure", () => Promise.resolve("not_ready" as const)],
  ])("maps %s to a bounded not-ready result", async (_name, databaseProbe) => {
    const controller = new HealthReadinessController({ databaseProbe, now });
    controller.completeStartup();

    const serialized = JSON.stringify(await controller.readinessSnapshot());

    expect(JSON.parse(serialized)).toMatchObject({
      dependencies: { database: { required: true, status: "not_ready" } },
      status: "not_ready",
    });
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("postgresql");
  });

  it("bounds probe time, clears its timer and ignores a late result", async () => {
    vi.useFakeTimers();
    let resolveProbe: ((value: "ready") => void) | undefined;
    const controller = new HealthReadinessController({
      databaseProbe: () =>
        new Promise<"ready">((resolve) => {
          resolveProbe = resolve;
        }),
      now,
    });
    controller.completeStartup();

    const snapshot = controller.readinessSnapshot();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await snapshot).toMatchObject({
      dependencies: { database: { status: "timeout" } },
      status: "not_ready",
    });
    expect(controller.resourceSnapshot().ownedTimers).toBe(0);
    resolveProbe?.("ready");
    await Promise.resolve();
    expect(controller.resourceSnapshot().cachedStatus).toBe("timeout");
  });

  it("shares an in-flight probe and applies the accepted positive cache bound", async () => {
    let milliseconds = 10_000;
    let resolveProbe: ((value: "ready") => void) | undefined;
    const probe = vi.fn(
      () =>
        new Promise<"ready">((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const controller = new HealthReadinessController({
      databaseProbe: probe,
      now,
      nowMilliseconds: () => milliseconds,
    });
    controller.completeStartup();

    const first = controller.readinessSnapshot();
    const second = controller.readinessSnapshot();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1);
    resolveProbe?.("ready");
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "ready" }),
      expect.objectContaining({ status: "ready" }),
    ]);

    milliseconds = 10_999;
    await expect(controller.readinessSnapshot()).resolves.toMatchObject({ status: "ready" });
    expect(probe).toHaveBeenCalledTimes(1);

    milliseconds = 11_000;
    const expired = controller.readinessSnapshot();
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(2);
    resolveProbe?.("ready");
    await expect(expired).resolves.toMatchObject({ status: "ready" });
    expect(controller.resourceSnapshot().ownedTimers).toBe(0);
  });

  it("uses the shorter failure cache and makes drain immediately override cached readiness", async () => {
    let milliseconds = 20_000;
    const probe = vi.fn(() => "not_ready" as const);
    const controller = new HealthReadinessController({
      databaseProbe: probe,
      now,
      nowMilliseconds: () => milliseconds,
    });
    controller.completeStartup();

    await controller.readinessSnapshot();
    milliseconds = 20_249;
    await controller.readinessSnapshot();
    expect(probe).toHaveBeenCalledTimes(1);
    milliseconds = 20_250;
    await controller.readinessSnapshot();
    expect(probe).toHaveBeenCalledTimes(2);

    const readyController = new HealthReadinessController({
      databaseProbe: () => "ready",
      now,
    });
    readyController.completeStartup();
    expect((await readyController.readinessSnapshot()).status).toBe("ready");
    readyController.beginDrain();
    readyController.beginDrain();
    expect(await readyController.readinessSnapshot()).toMatchObject({
      dependencies: { database: { status: "not_ready" } },
      status: "not_ready",
    });
    expect(readyController.resourceSnapshot()).toMatchObject({
      cachedStatus: undefined,
      lifecycleState: "draining",
      ownedTimers: 0,
      probeInFlight: false,
    });
  });

  it("does not retain a late successful probe after drain begins", async () => {
    let resolveProbe: ((value: "ready") => void) | undefined;
    const controller = new HealthReadinessController({
      databaseProbe: () =>
        new Promise<"ready">((resolve) => {
          resolveProbe = resolve;
        }),
      now,
    });
    controller.completeStartup();

    const inFlight = controller.readinessSnapshot();
    await Promise.resolve();
    controller.beginDrain();
    resolveProbe?.("ready");

    await expect(inFlight).resolves.toMatchObject({ status: "not_ready" });
    expect(controller.resourceSnapshot()).toMatchObject({
      cachedStatus: undefined,
      lifecycleState: "draining",
      ownedTimers: 0,
      probeInFlight: false,
    });
  });

  it("rejects cache and timeout values beyond the accepted bounds", () => {
    expect(() => new HealthReadinessController({ positiveCacheMilliseconds: 1_001 })).toThrowError(
      "positiveCacheMilliseconds must be an integer from 0 to 1000",
    );
    expect(() => new HealthReadinessController({ negativeCacheMilliseconds: 251 })).toThrowError(
      "negativeCacheMilliseconds must be an integer from 0 to 250",
    );
    expect(() => new HealthReadinessController({ probeTimeoutMilliseconds: 1_001 })).toThrowError(
      "probeTimeoutMilliseconds must be an integer from 0 to 1000",
    );
  });
});
