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
