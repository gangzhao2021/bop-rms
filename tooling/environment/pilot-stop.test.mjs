import { expect, it, vi } from "vitest";
import { stopPilotRuntime, parsePilotStopArguments } from "./pilot-stop.mjs";
import { confirmPilotServiceStopped } from "./pilot-service.mjs";
it("stops ingress before producers/projections including disabled optional workers", async () => {
  const service = vi.fn(async (_action, name) => ({ service: name, state: "stopped", pid: null }));
  expect(
    (
      await stopPilotRuntime({
        maintenance: (_directory, work) => work(),
        runtimeDirectory: ".local/other",
        service,
      })
    ).state,
  ).toBe("stopped");
  expect(service.mock.calls.map(([, name]) => name)).toEqual([
    "customer",
    "api",
    "business-worker",
    "kitchen-queue-worker",
    "reconciliation-worker",
    "daily-settlement-worker",
    "dining-exception-worker",
  ]);
  expect(
    service.mock.calls.every(([action, , dir]) => action === "stop" && dir === ".local/other"),
  ).toBe(true);
});
it.each(["throw", "running", "wrong-service"])(
  "returns exact partial state without continuing or restarting on %s",
  async (mode) => {
    const service = vi.fn(async (_action, name) => {
      if (name === "api") {
        if (mode === "throw") throw Error("private failure");
        return {
          service: mode === "wrong-service" ? "customer" : name,
          state: mode === "running" ? "running" : "stopped",
        };
      }
      return { service: name, state: "stopped" };
    });
    const result = await stopPilotRuntime({ maintenance: (_directory, work) => work(), service });
    expect(result).toMatchObject({
      state: "incomplete",
      stage: "api",
      code: "PILOT_STOP_UNAVAILABLE",
    });
    expect(result.completed).toHaveLength(1);
    expect(service).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("private failure");
  },
);
it("confirms absent workers using process discovery and refuses orphan matches", async () => {
  const findWorkers = vi.fn(async () => []);
  expect(
    await confirmPilotServiceStopped({
      root: "/synthetic",
      service: "business-worker",
      pid: null,
      findWorkers,
    }),
  ).toBe(true);
  expect(findWorkers).toHaveBeenCalledWith("/synthetic", "business-worker", ".local/pilot-v14");
  expect(
    await confirmPilotServiceStopped({
      root: "/synthetic",
      service: "business-worker",
      pid: null,
      findWorkers: async () => [123],
    }),
  ).toBe(false);
});
it("does not treat unreadable or live PID as stopped and requires ports free after missing PID", async () => {
  const portFree = vi.fn(async () => undefined),
    base = { root: "/synthetic", service: "api", pid: 123, portFree };
  const stat = "123 (node) " + ["S", ...Array(18).fill("0"), "9876", "0"].join(" ");
  expect(await confirmPilotServiceStopped({ ...base, readStat: async () => stat })).toBe(false);
  expect(portFree).not.toHaveBeenCalled();
  await expect(
    confirmPilotServiceStopped({
      ...base,
      readStat: async () => {
        throw Object.assign(Error("private"), { code: "EACCES" });
      },
    }),
  ).rejects.toMatchObject({ code: "EACCES" });
  expect(
    await confirmPilotServiceStopped({
      ...base,
      readStat: async () => {
        throw Object.assign(Error(), { code: "ENOENT" });
      },
    }),
  ).toBe(true);
  expect(portFree).toHaveBeenCalledWith(4300);
  await expect(
    confirmPilotServiceStopped({
      ...base,
      pid: null,
      portFree: async () => {
        throw Error("occupied");
      },
    }),
  ).rejects.toThrow("occupied");
});
it("validates installation before invoking stop and permits no extra options", async () => {
  expect(parsePilotStopArguments([])).toEqual({ runtimeDirectory: ".local/pilot-v14" });
  const service = vi.fn();
  await expect(
    stopPilotRuntime({
      maintenance: (_directory, work) => work(),
      runtimeDirectory: "../other",
      service,
    }),
  ).rejects.toThrow();
  expect(service).not.toHaveBeenCalled();
  for (const args of [["../other"], [".local/pilot", "--force"], [null]])
    expect(() => parsePilotStopArguments(args)).toThrow();
});
