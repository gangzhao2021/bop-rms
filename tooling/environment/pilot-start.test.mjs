import { expect, it, vi } from "vitest";
import { parsePilotStartArguments, startPilotRuntime } from "./pilot-start.mjs";
function fixture() {
  const names = ["api", "business-worker", "kitchen-queue-worker", "customer"];
  const cycle = {
    state: "running",
    completedCycles: 1,
    lastCycleCompletedAt: "2026-09-20T12:00:00.000Z",
  };
  const service = vi.fn(async (action, name) => ({
    service: name,
    pid: names.indexOf(name) + 100,
    state: "running",
    ...(action === "health"
      ? name === "business-worker"
        ? { workloads: { events: cycle, paymentWait: cycle, diningCheckoutExpiry: cycle } }
        : cycle
      : {}),
  }));
  return {
    service,
    api: vi.fn(async () => true),
    customer: vi.fn(async () => true),
    wait: vi.fn(async () => undefined),
  };
}
it("starts dependencies in order and preserves already-running identities", async () => {
  const f = fixture();
  const result = await startPilotRuntime(f);
  expect(result.state).toBe("started");
  expect(f.service.mock.calls.filter(([a]) => a === "start").map(([, s]) => s)).toEqual([
    "api",
    "business-worker",
    "kitchen-queue-worker",
    "customer",
  ]);
  expect(f.service.mock.calls.some(([a]) => a === "restart" || a === "stop")).toBe(false);
});
it("waits for startup observations without launching duplicates", async () => {
  const f = fixture();
  f.api.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("not yet"));
  expect((await startPilotRuntime(f)).state).toBe("started");
  expect(f.wait).toHaveBeenCalledTimes(2);
  expect(f.service.mock.calls.filter(([a, s]) => a === "start" && s === "api")).toHaveLength(1);
});
it("reports failed dependency and never starts downstream services", async () => {
  const f = fixture();
  f.api.mockResolvedValue(false);
  expect(await startPilotRuntime(f)).toEqual({
    state: "incomplete",
    stage: "api",
    completed: [],
    code: "PILOT_STARTUP_OBSERVATION_UNAVAILABLE",
  });
  expect(f.service).toHaveBeenCalledTimes(1);
});
it.each([
  ["events", { state: "failed" }],
  ["paymentWait", { state: "failed" }],
  ["diningCheckoutExpiry", { state: "failed" }],
  ["diningCheckoutExpiry", undefined],
  ["diningCheckoutExpiry", { state: "running", completedCycles: 0, lastCycleCompletedAt: null }],
])("does not hide an unhealthy required %s loop", async (component, health) => {
  const f = fixture();
  const original = f.service.getMockImplementation();
  f.service.mockImplementation(async (a, n) => {
    const result = await original(a, n);
    return a === "health" && n === "business-worker"
      ? { ...result, workloads: { ...result.workloads, [component]: health } }
      : result;
  });
  const result = await startPilotRuntime(f);
  expect(result.state).toBe("incomplete");
  expect(result.stage).toBe("business-worker");
  expect(result.completed).toHaveLength(1);
  expect(f.customer).not.toHaveBeenCalled();
});

it("uses the selected installation for every process operation and TLS readiness probe", async () => {
  const f = fixture();
  const runtimeDirectory = ".local/pilot-installation";
  expect((await startPilotRuntime({ ...f, runtimeDirectory })).state).toBe("started");
  expect(f.service.mock.calls.every(([, , directory]) => directory === runtimeDirectory)).toBe(
    true,
  );
  expect(f.customer).toHaveBeenCalledWith(runtimeDirectory);
});
it("rejects invalid directory before invoking any process operation", async () => {
  const f = fixture();
  await expect(startPilotRuntime({ ...f, runtimeDirectory: ".local/../other" })).rejects.toThrow();
  expect(f.service).not.toHaveBeenCalled();
  expect(f.api).not.toHaveBeenCalled();
  expect(f.customer).not.toHaveBeenCalled();
});

it.each([
  undefined,
  { state: "failed" },
  { state: "running", completedCycles: 0, lastCycleCompletedAt: null },
])("required cancellation blocks readiness without completed running cycle", async (health) => {
  const f = fixture(),
    original = f.service.getMockImplementation();
  f.service.mockImplementation(async (a, n) => {
    const result = await original(a, n);
    return a === "health" && n === "business-worker"
      ? { ...result, workloads: { ...result.workloads, batchCancellation: health } }
      : result;
  });
  const result = await startPilotRuntime({ ...f, requireBatchCancellation: true });
  expect(result.state).toBe("incomplete");
  expect(result.stage).toBe("business-worker");
  expect(f.customer).not.toHaveBeenCalled();
  expect(f.service.mock.calls.some(([a]) => a === "restart" || a === "stop")).toBe(false);
  expect(f.service.mock.calls.find(([a]) => a === "health")[3]).toEqual({
    requireBatchCancellation: true,
    requireCompensation: false,
  });
});
it("accepts a completed cancellation cycle only when reported with the running worker", async () => {
  const f = fixture(),
    original = f.service.getMockImplementation();
  f.service.mockImplementation(async (a, n) => {
    const result = await original(a, n);
    return a === "health" && n === "business-worker"
      ? {
          ...result,
          workloads: {
            ...result.workloads,
            batchCancellation: {
              ...result.workloads.events,
              reportAgeMs: 0,
              lastCompletionAgeMs: 0,
            },
          },
        }
      : result;
  });
  expect((await startPilotRuntime({ ...f, requireBatchCancellation: true })).state).toBe("started");
});

it.each([
  { reportAgeMs: 35001, lastCompletionAgeMs: 1 },
  { reportAgeMs: 1, lastCompletionAgeMs: 35001 },
  { reportAgeMs: undefined, lastCompletionAgeMs: 1 },
])("required cancellation rejects stale or absent age evidence", async (ages) => {
  const f = fixture(),
    original = f.service.getMockImplementation();
  f.service.mockImplementation(async (a, n) => {
    const result = await original(a, n);
    return a === "health" && n === "business-worker"
      ? {
          ...result,
          workloads: {
            ...result.workloads,
            batchCancellation: { ...result.workloads.events, ...ages },
          },
        }
      : result;
  });
  expect((await startPilotRuntime({ ...f, requireBatchCancellation: true })).state).toBe(
    "incomplete",
  );
});

it.each([
  undefined,
  { state: "failed" },
  { state: "running", completedCycles: 0, lastCycleCompletedAt: null },
  {
    state: "running",
    completedCycles: 1,
    lastCycleCompletedAt: "2026-09-21T00:00:00.000Z",
    reportAgeMs: 35001,
    lastCompletionAgeMs: 0,
  },
  {
    state: "running",
    completedCycles: 1,
    lastCycleCompletedAt: "2026-09-21T00:00:00.000Z",
    reportAgeMs: 0,
    lastCompletionAgeMs: 35001,
  },
])("required compensation rejects absent/failed/stalled evidence", async (health) => {
  const f = fixture(),
    original = f.service.getMockImplementation();
  f.service.mockImplementation(async (a, n) => {
    const result = await original(a, n);
    return a === "health" && n === "business-worker"
      ? { ...result, workloads: { ...result.workloads, compensation: health } }
      : result;
  });
  const result = await startPilotRuntime({ ...f, requireCompensation: true });
  expect(result.state).toBe("incomplete");
  expect(result.stage).toBe("business-worker");
  expect(f.service.mock.calls.some(([action]) => action === "restart" || action === "stop")).toBe(
    false,
  );
});
it("requires both opt-in loops when both are selected", async () => {
  const f = fixture(),
    original = f.service.getMockImplementation();
  f.service.mockImplementation(async (a, n) => {
    const result = await original(a, n);
    if (a !== "health" || n !== "business-worker") return result;
    const healthy = { ...result.workloads.events, reportAgeMs: 0, lastCompletionAgeMs: 0 };
    return {
      ...result,
      workloads: { ...result.workloads, compensation: healthy, batchCancellation: healthy },
    };
  });
  expect(
    (await startPilotRuntime({ ...f, requireCompensation: true, requireBatchCancellation: true }))
      .state,
  ).toBe("started");
  expect(f.service.mock.calls.find(([a]) => a === "health")[3]).toEqual({
    requireCompensation: true,
    requireBatchCancellation: true,
  });
});
it("parses only explicit supported readiness flags without enabling workloads", () => {
  expect(
    parsePilotStartArguments([
      ".local/pilot-v12",
      "--require-compensation",
      "--require-batch-cancellation",
    ]),
  ).toEqual({
    runtimeDirectory: ".local/pilot-v12",
    requireCompensation: true,
    requireBatchCancellation: true,
  });
  expect(parsePilotStartArguments([]).requireCompensation).toBe(false);
  for (const args of [
    ["--require-compensation"],
    [".local/pilot-v12", "--enable-compensation"],
    [".local/pilot-v12", "--require-compensation", "--require-compensation"],
  ])
    expect(() => parsePilotStartArguments(args)).toThrow();
});

it.each([
  undefined,
  { state: "failed" },
  { state: "running", completedCycles: 0, lastCycleCompletedAt: null },
  {
    state: "running",
    completedCycles: 1,
    lastCycleCompletedAt: "2026-09-21T00:00:00.000Z",
    reportAgeMs: 35001,
    lastCompletionAgeMs: 0,
  },
])("requires fresh isolated reconciliation worker when explicitly selected", async (health) => {
  const f = fixture(),
    original = f.service.getMockImplementation();
  f.service.mockImplementation(async (a, n) =>
    n === "reconciliation-worker"
      ? { service: n, pid: 199, state: "running", ...(a === "health" ? health : {}) }
      : original(a, n),
  );
  expect((await startPilotRuntime({ ...f, requireReconciliationProjection: true })).state).toBe(
    "incomplete",
  );
  expect(f.service.mock.calls.some(([a]) => a === "restart" || a === "stop")).toBe(false);
});
it("accepts healthy isolated reconciliation without changing default startup", async () => {
  const f = fixture(),
    original = f.service.getMockImplementation();
  f.service.mockImplementation(async (a, n) =>
    n === "reconciliation-worker"
      ? {
          service: n,
          pid: 199,
          state: "running",
          ...(a === "health"
            ? {
                completedCycles: 1,
                lastCycleCompletedAt: "2026-09-21T00:00:00.000Z",
                reportAgeMs: 0,
                lastCompletionAgeMs: 0,
              }
            : {}),
        }
      : original(a, n),
  );
  expect((await startPilotRuntime({ ...f, requireReconciliationProjection: true })).state).toBe(
    "started",
  );
  expect(
    parsePilotStartArguments([".local/pilot-v12", "--require-reconciliation-projection"])
      .requireReconciliationProjection,
  ).toBe(true);
});

it.each([
  undefined,
  { state: "failed" },
  { state: "running", completedCycles: 0, lastCycleCompletedAt: null },
])("required cancellation blocks readiness without completed running cycle", async (health) => {
  const f = fixture(),
    original = f.service.getMockImplementation();
  f.service.mockImplementation(async (a, n) => {
    const result = await original(a, n);
    return a === "health" && n === "business-worker"
      ? { ...result, workloads: { ...result.workloads, batchCancellation: health } }
      : result;
  });
  const result = await startPilotRuntime({ ...f, requireBatchCancellation: true });
  expect(result.state).toBe("incomplete");
  expect(result.stage).toBe("business-worker");
  expect(f.customer).not.toHaveBeenCalled();
  expect(f.service.mock.calls.some(([a]) => a === "restart" || a === "stop")).toBe(false);
  expect(f.service.mock.calls.find(([a]) => a === "health")[3]).toEqual({
    requireBatchCancellation: true,
    requireCompensation: false,
  });
});
it("accepts a completed cancellation cycle only when reported with the running worker", async () => {
  const f = fixture(),
    original = f.service.getMockImplementation();
  f.service.mockImplementation(async (a, n) => {
    const result = await original(a, n);
    return a === "health" && n === "business-worker"
      ? {
          ...result,
          workloads: {
            ...result.workloads,
            batchCancellation: {
              ...result.workloads.events,
              reportAgeMs: 0,
              lastCompletionAgeMs: 0,
            },
          },
        }
      : result;
  });
  expect((await startPilotRuntime({ ...f, requireBatchCancellation: true })).state).toBe("started");
});

it.each([
  { reportAgeMs: 35001, lastCompletionAgeMs: 1 },
  { reportAgeMs: 1, lastCompletionAgeMs: 35001 },
  { reportAgeMs: undefined, lastCompletionAgeMs: 1 },
])("required cancellation rejects stale or absent age evidence", async (ages) => {
  const f = fixture(),
    original = f.service.getMockImplementation();
  f.service.mockImplementation(async (a, n) => {
    const result = await original(a, n);
    return a === "health" && n === "business-worker"
      ? {
          ...result,
          workloads: {
            ...result.workloads,
            batchCancellation: { ...result.workloads.events, ...ages },
          },
        }
      : result;
  });
  expect((await startPilotRuntime({ ...f, requireBatchCancellation: true })).state).toBe(
    "incomplete",
  );
});

it.each([
  undefined,
  { state: "failed" },
  { state: "running", completedCycles: 0, lastCycleCompletedAt: null },
  {
    state: "running",
    completedCycles: 1,
    lastCycleCompletedAt: "2026-09-21T00:00:00.000Z",
    reportAgeMs: 35001,
    lastCompletionAgeMs: 0,
  },
  {
    state: "running",
    completedCycles: 1,
    lastCycleCompletedAt: "2026-09-21T00:00:00.000Z",
    reportAgeMs: 0,
    lastCompletionAgeMs: 35001,
  },
])("required compensation rejects absent/failed/stalled evidence", async (health) => {
  const f = fixture(),
    original = f.service.getMockImplementation();
  f.service.mockImplementation(async (a, n) => {
    const result = await original(a, n);
    return a === "health" && n === "business-worker"
      ? { ...result, workloads: { ...result.workloads, compensation: health } }
      : result;
  });
  const result = await startPilotRuntime({ ...f, requireCompensation: true });
  expect(result.state).toBe("incomplete");
  expect(result.stage).toBe("business-worker");
  expect(f.service.mock.calls.some(([action]) => action === "restart" || action === "stop")).toBe(
    false,
  );
});
it("requires both opt-in loops when both are selected", async () => {
  const f = fixture(),
    original = f.service.getMockImplementation();
  f.service.mockImplementation(async (a, n) => {
    const result = await original(a, n);
    if (a !== "health" || n !== "business-worker") return result;
    const healthy = { ...result.workloads.events, reportAgeMs: 0, lastCompletionAgeMs: 0 };
    return {
      ...result,
      workloads: { ...result.workloads, compensation: healthy, batchCancellation: healthy },
    };
  });
  expect(
    (await startPilotRuntime({ ...f, requireCompensation: true, requireBatchCancellation: true }))
      .state,
  ).toBe("started");
  expect(f.service.mock.calls.find(([a]) => a === "health")[3]).toEqual({
    requireCompensation: true,
    requireBatchCancellation: true,
  });
});
it("parses only explicit supported readiness flags without enabling workloads", () => {
  expect(
    parsePilotStartArguments([
      ".local/pilot-v12",
      "--require-compensation",
      "--require-batch-cancellation",
    ]),
  ).toEqual({
    runtimeDirectory: ".local/pilot-v12",
    requireCompensation: true,
    requireBatchCancellation: true,
  });
  expect(parsePilotStartArguments([]).requireCompensation).toBe(false);
  for (const args of [
    ["--require-compensation"],
    [".local/pilot-v12", "--enable-compensation"],
    [".local/pilot-v12", "--require-compensation", "--require-compensation"],
  ])
    expect(() => parsePilotStartArguments(args)).toThrow();
});

it.each([
  undefined,
  { state: "failed" },
  { state: "running", completedCycles: 0, lastCycleCompletedAt: null },
  {
    state: "running",
    completedCycles: 1,
    lastCycleCompletedAt: "2026-09-21T00:00:00.000Z",
    reportAgeMs: 35001,
    lastCompletionAgeMs: 0,
  },
])("requires fresh isolated dining-exception worker when explicitly selected", async (health) => {
  const f = fixture(),
    original = f.service.getMockImplementation();
  f.service.mockImplementation(async (a, n) =>
    n === "dining-exception-worker"
      ? { service: n, pid: 199, state: "running", ...(a === "health" ? health : {}) }
      : original(a, n),
  );
  expect((await startPilotRuntime({ ...f, requireDiningExceptionProjection: true })).state).toBe(
    "incomplete",
  );
  expect(f.service.mock.calls.some(([a]) => a === "restart" || a === "stop")).toBe(false);
});
it("accepts healthy isolated dining-exception without changing default startup", async () => {
  const f = fixture(),
    original = f.service.getMockImplementation();
  f.service.mockImplementation(async (a, n) =>
    n === "dining-exception-worker"
      ? {
          service: n,
          pid: 199,
          state: "running",
          ...(a === "health"
            ? {
                completedCycles: 1,
                lastCycleCompletedAt: "2026-09-21T00:00:00.000Z",
                reportAgeMs: 0,
                lastCompletionAgeMs: 0,
              }
            : {}),
        }
      : original(a, n),
  );
  expect((await startPilotRuntime({ ...f, requireDiningExceptionProjection: true })).state).toBe(
    "started",
  );
  expect(
    parsePilotStartArguments([".local/pilot-v12", "--require-dining-exception-projection"])
      .requireDiningExceptionProjection,
  ).toBe(true);
});

it("accepts all independent startup gates together and rejects duplicate Dining flags", () => {
  const args = [
    ".local/pilot-v12",
    "--require-batch-cancellation",
    "--require-compensation",
    "--require-reconciliation-projection",
    "--require-dining-exception-projection",
  ];
  expect(parsePilotStartArguments(args)).toMatchObject({
    requireBatchCancellation: true,
    requireCompensation: true,
    requireReconciliationProjection: true,
    requireDiningExceptionProjection: true,
  });
  expect(() =>
    parsePilotStartArguments([
      ".local/pilot-v12",
      "--require-dining-exception-projection",
      "--require-dining-exception-projection",
    ]),
  ).toThrow();
  expect(parsePilotStartArguments([])).not.toHaveProperty("requireDiningExceptionProjection");
});

it("parses explicit independent daily readiness", () => {
  expect(
    parsePilotStartArguments([".local/pilot-v13", "--require-daily-settlement"]),
  ).toMatchObject({ runtimeDirectory: ".local/pilot-v13", requireDailySettlement: true });
});
