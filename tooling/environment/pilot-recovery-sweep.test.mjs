import { expect, it, vi } from "vitest";
import { createPilotRecoverySweep } from "./pilot-recovery-sweep.mjs";
const runtimeDirectory = ".local/pilot-v14";
it("adopts verified running processes and never uses restart or health as death evidence", async () => {
  const service = vi.fn(async (action, name, directory) => {
    expect(directory).toBe(runtimeDirectory);
    return { service: name, state: "running", pid: 10 };
  });
  const sweep = createPilotRecoverySweep({ runtimeDirectory, service, now: () => 100 });
  expect(await sweep.sweep()).toHaveLength(7);
  expect(service.mock.calls.every((c) => c[0] === "status")).toBe(true);
});
it("delegates ambiguous status to safe start and bounds failures with backoff", async () => {
  let at = 0;
  const service = vi.fn(async (action, name) => {
    if (name !== "business-worker") return { service: name, state: "running", pid: 10 };
    throw Error("private-canary");
  });
  const sweep = createPilotRecoverySweep({ runtimeDirectory, service, now: () => at });
  await sweep.sweep();
  at = 1;
  expect((await sweep.sweep())[1].state).toBe("backoff");
  at = 5000;
  await sweep.sweep();
  at = 15000;
  await sweep.sweep();
  at = 40000;
  expect((await sweep.sweep())[1].state).toBe("attention_required");
  expect(service.mock.calls.filter((c) => c[0] === "start")).toHaveLength(3);
});
it("shares in-flight sweep and recovers terminal processes through start only", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const service = vi.fn(async (action, name) => {
    if (action === "status") {
      await gate;
      throw Error("missing");
    }
    return { service: name, state: "started", pid: 10 };
  });
  const sweep = createPilotRecoverySweep({ runtimeDirectory, service, now: () => 100 });
  const one = sweep.sweep(),
    two = sweep.sweep();
  expect(one).toBe(two);
  release();
  expect((await one).every((v) => v.state === "started")).toBe(true);
  expect(service).toHaveBeenCalledTimes(14);
});
it("requires sustained same-process running before resetting exhausted recovery budget", async () => {
  let at = 0,
    running = false,
    pid = 10;
  const service = vi.fn(async (action, name) => {
    if (name !== "api" || running) return { service: name, state: "running", pid };
    throw Error("missing");
  });
  const sweep = createPilotRecoverySweep({ runtimeDirectory, service, now: () => at });
  for (at of [0, 5000, 15000]) await sweep.sweep();
  running = true;
  at = 20000;
  await sweep.sweep();
  pid = 11;
  at = 75000;
  await sweep.sweep();
  running = false;
  at = 80000;
  expect((await sweep.sweep())[0].state).toBe("attention_required");
  running = true;
  at = 90000;
  await sweep.sweep();
  at = 150000;
  await sweep.sweep();
  running = false;
  at = 150001;
  expect((await sweep.sweep())[0].state).toBe("unavailable");
});
it("rejects backward clocks without inspecting or starting processes", async () => {
  let at = 100;
  const service = vi.fn(async (_a, name) => ({ service: name, state: "running", pid: 10 }));
  const sweep = createPilotRecoverySweep({ runtimeDirectory, service, now: () => at });
  await sweep.sweep();
  service.mockClear();
  at = 99;
  await expect(sweep.sweep()).rejects.toThrow("PILOT_RECOVERY_CLOCK_INVALID");
  expect(service).not.toHaveBeenCalled();
});

it("does not start after cancellation arrives during status inspection", async () => {
  const controller = new globalThis.AbortController();
  const service = vi.fn(async () => {
    controller.abort();
    throw Error("missing");
  });
  const sweep = createPilotRecoverySweep({ runtimeDirectory, service, now: () => 100 });
  expect(await sweep.sweep({ signal: controller.signal })).toEqual([]);
  expect(service).toHaveBeenCalledTimes(1);
  expect(service.mock.calls[0][0]).toBe("status");
});

// WP-2423 pilot resilience (2026-10-15).
it("reports alert-worthy workloads of a running worker without restarting it", async () => {
  const service = vi.fn(async (action, name, _directory, options) => {
    if (action === "status") return { service: name, state: "running", pid: 10 };
    if (action !== "health") throw Error("unexpected " + action);
    if (name === "business-worker") {
      expect(options).toEqual({ requireCompensation: true });
      return {
        service: name,
        pid: 10,
        workloads: {
          paymentWait: { attention: false },
          compensation: { attention: true },
          events: { attention: true },
        },
      };
    }
    if (name === "kitchen-queue-worker") throw Error("PILOT_PROCESS_UNAVAILABLE");
    return { service: name, pid: 10, attention: name === "reconciliation-worker" };
  });
  const workloadHealth = vi.fn(async (name) =>
    name === "business-worker" ? { requireCompensation: true } : {},
  );
  const sweep = createPilotRecoverySweep({
    runtimeDirectory,
    service,
    now: () => 1,
    workloadHealth,
  });
  const result = await sweep.sweep();
  expect(result.find((r) => r.service === "business-worker")).toEqual({
    service: "business-worker",
    state: "running",
    pid: 10,
    attention: ["compensation", "events"],
  });
  expect(result.find((r) => r.service === "kitchen-queue-worker")).toMatchObject({
    state: "running",
    health: "unavailable",
  });
  expect(result.find((r) => r.service === "reconciliation-worker").attention).toEqual(["workload"]);
  expect(result.find((r) => r.service === "api")).toEqual({
    service: "api",
    state: "running",
    pid: 10,
  });
  expect(service.mock.calls.some((c) => ["start", "restart", "stop"].includes(c[0]))).toBe(false);
  expect(service.mock.calls.filter((c) => c[0] === "health").map((c) => c[1])).toEqual([
    "business-worker",
    "kitchen-queue-worker",
    "reconciliation-worker",
    "daily-settlement-worker",
    "dining-exception-worker",
  ]);
});
it("keeps trying to start an exhausted service every minute while reporting attention", async () => {
  let at = 0,
    up = false;
  const service = vi.fn(async (action, name) => {
    if (name !== "customer") return { service: name, state: "running", pid: 10 };
    if (action === "start" && up) return { service: name, state: "started", pid: 11 };
    throw Error("down");
  });
  const sweep = createPilotRecoverySweep({ runtimeDirectory, service, now: () => at });
  const customer = async () => (await sweep.sweep()).find((r) => r.service === "customer");
  for (at of [0, 5000, 15000]) await customer();
  at = 40000;
  expect((await customer()).state).toBe("attention_required");
  at = 99_999;
  expect((await customer()).state).toBe("attention_required");
  const starts = () => service.mock.calls.filter((c) => c[0] === "start").length;
  expect(starts()).toBe(3);
  at = 100_000;
  expect((await customer()).state).toBe("attention_required");
  expect(starts()).toBe(4);
  up = true;
  at = 160_000;
  expect(await customer()).toEqual({ service: "customer", state: "started", pid: 11 });
});
