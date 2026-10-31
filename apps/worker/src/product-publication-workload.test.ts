import { afterEach, expect, it, vi } from "vitest";
import { createProductPublicationWorkload } from "./product-publication-workload.js";
afterEach(() => vi.useRealTimers());
const id = (n: number) => `01902421-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const candidate = (n: number) => ({ publication: { versionReference: id(n) } }),
  config = { pageSize: 2, pollIntervalMs: 10, drainDeadlineMs: 100 };
it("scans durable due candidates, wraps after a complete round and accepts owning replay", async () => {
  vi.useFakeTimers();
  const discover = vi.fn(
    async ({ afterVersionReference }: { afterVersionReference: string | null }) =>
      afterVersionReference === null
        ? { candidates: [candidate(1), candidate(2)], nextAfterVersionReference: id(2) }
        : { candidates: [], nextAfterVersionReference: null },
  );
  const activate = vi.fn(async () => "Replayed" as const),
    work = createProductPublicationWorkload({ ...config, discover, activate });
  await work.start();
  await vi.advanceTimersByTimeAsync(20);
  await work.stop();
  expect(discover).toHaveBeenCalledTimes(3);
  expect(activate).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
});
it.each([
  [[candidate(2), candidate(1)], null],
  [[candidate(1), candidate(1)], null],
  [[candidate(1)], id(1)],
  [[candidate(1), candidate(2)], id(3)],
] as const)(
  "refuses bad order, duplicates and invented cursor before any activation",
  async (candidates, nextAfterVersionReference) => {
    const activate = vi.fn(),
      work = createProductPublicationWorkload({
        ...config,
        discover: async () => ({ candidates, nextAfterVersionReference }),
        activate,
      });
    await expect(work.start()).rejects.toThrow("OUTBOX_WORKLOAD_FAILED");
    expect(activate).not.toHaveBeenCalled();
    await work.stop();
  },
);
it("stops on actual activation/source failure and does not treat it as a successful or stale schedule", async () => {
  const activate = vi.fn().mockRejectedValue(Error("private dependency failure")),
    work = createProductPublicationWorkload({
      ...config,
      discover: async () => ({
        candidates: [candidate(1), candidate(2)],
        nextAfterVersionReference: id(2),
      }),
      activate,
    });
  await expect(work.start()).rejects.toThrow("OUTBOX_WORKLOAD_FAILED");
  expect(activate).toHaveBeenCalledTimes(1);
  await expect(work.completion).resolves.toBe("failed");
  await work.stop();
});
it("drains the in-flight owning transaction before stopping and leaves later candidates for restart", async () => {
  vi.useFakeTimers();
  let release: () => void = () => undefined;
  const held = new Promise<void>((r) => {
      release = r;
    }),
    activate = vi.fn(async () => {
      await held;
      return "Applied" as const;
    }),
    work = createProductPublicationWorkload({
      ...config,
      discover: async () => ({
        candidates: [candidate(1), candidate(2)],
        nextAfterVersionReference: id(2),
      }),
      activate,
    });
  const start = work.start();
  await vi.advanceTimersByTimeAsync(100);
  const stop = work.stop();
  release();
  await start;
  await stop;
  expect(activate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
