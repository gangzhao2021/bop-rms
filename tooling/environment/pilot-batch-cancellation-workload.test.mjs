import { afterEach, expect, test, vi } from "vitest";
import { createOptionalBatchCancellationWorkloads } from "./pilot-batch-cancellation-workload.mjs";
afterEach(() => vi.unstubAllEnvs());
test("disabled configuration never constructs or reads cancellation resources", async () => {
  const createDispatcher = vi.fn();
  for (const enabled of [undefined, false, "true", 1])
    expect(await createOptionalBatchCancellationWorkloads({ enabled, createDispatcher })).toEqual(
      [],
    );
  expect(createDispatcher).not.toHaveBeenCalled();
});
test("enabled production rejects before dispatcher construction", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const createDispatcher = vi.fn();
  await expect(
    createOptionalBatchCancellationWorkloads({ enabled: true, createDispatcher }),
  ).rejects.toThrow("PILOT_BATCH_CANCELLATION_UNAVAILABLE");
  expect(createDispatcher).not.toHaveBeenCalled();
});
test("explicit development assembly defers work until start and drains on stop", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const runOnce = vi.fn(async () => 0),
    stop = vi.fn(async () => "drained"),
    onSnapshot = vi.fn(),
    resources = {};
  const createDispatcher = vi.fn(async () => ({ runOnce, stop }));
  const [workload] = await createOptionalBatchCancellationWorkloads({
    enabled: true,
    resources,
    createDispatcher,
    onSnapshot,
  });
  expect(createDispatcher).toHaveBeenCalledWith(resources);
  expect(runOnce).not.toHaveBeenCalled();
  try {
    await workload.start();
    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(workload.snapshot().completedCycles).toBe(1);
  } finally {
    await workload.stop();
  }
  expect(stop).toHaveBeenCalledTimes(1);
  expect(await workload.completion).toBe("stopped");
  expect(onSnapshot).toHaveBeenCalled();
});
