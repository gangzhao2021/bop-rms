import { expect, it, vi } from "vitest";
import { createDailySettlementBacklog } from "./pilot-daily-settlement-backlog.mjs";
function fixture() {
  const scope = { brandReference: "brand", storeReference: "store" };
  const windows = [0, 1, 2].map((n) => ({
    ...scope,
    businessDate: "2026-09-" + (20 + n),
    startsAt: "2026-09-" + (20 + n) + "T08:00:00.000Z",
    endsAt: "2026-09-" + (21 + n) + "T08:00:00.000Z",
    configurationReference: "config",
    configurationVersion: 1,
    contentDigest: "digest",
  }));
  const persisted = new Set(),
    calls = [],
    prepare = vi.fn();
  let latest = windows[2],
    failed = false;
  const ports = {
    scope,
    coverage: {
      firstWindow: Object.fromEntries(
        Object.entries(windows[0]).filter(([k]) => !Object.hasOwn(scope, k)),
      ),
    },
    readWindow: vi.fn(async (input) =>
      input ? windows.find((w) => w.endsAt === input.endingAt) : latest,
    ),
    prepare,
    createScheduler: (options) => async () => {
      const w = await options.readWindow();
      calls.push(w.businessDate);
      if (failed) {
        failed = false;
        throw Error("dependency");
      }
      if (persisted.has(w.businessDate)) return { status: "Duplicate", checkCount: 1 };
      await options.prepare();
      persisted.add(w.businessDate);
      return { status: "Created", checkCount: 1 };
    },
  };
  return {
    ports,
    windows,
    persisted,
    calls,
    prepare,
    make: () => createDailySettlementBacklog(ports),
    fail: () => {
      failed = true;
    },
    setLatest: (w) => {
      latest = w;
    },
  };
}
it("discovers one historical window per tick then fills oldest first", async () => {
  const f = fixture(),
    tick = f.make();
  expect((await tick()).status).toBe("Idle");
  expect((await tick()).status).toBe("Idle");
  for (let i = 0; i < 3; i++) expect((await tick()).status).toBe("Created");
  expect(f.calls).toEqual(["2026-09-20", "2026-09-21", "2026-09-22"]);
  expect((await tick()).status).toBe("Idle");
});
it("restarts across a partially finished backlog without preparing completed days", async () => {
  const f = fixture(),
    tick = f.make();
  await tick();
  await tick();
  await tick();
  const resumed = f.make();
  await resumed();
  await resumed();
  expect((await resumed()).status).toBe("Duplicate");
  expect((await resumed()).status).toBe("Created");
  expect((await resumed()).status).toBe("Created");
  expect(f.prepare).toHaveBeenCalledTimes(3);
});
it("retains the oldest pending day through a failure", async () => {
  const f = fixture(),
    tick = f.make();
  await tick();
  await tick();
  f.fail();
  await expect(tick()).rejects.toThrow();
  expect((await tick()).status).toBe("Created");
  expect(f.calls).toEqual(["2026-09-20", "2026-09-20"]);
});
it("rejects changed first-window authority and gaps instead of skipping", async () => {
  const f = fixture();
  f.ports.coverage.firstWindow.configurationVersion = 2;
  await expect(f.make()()).rejects.toThrow();
  const g = fixture();
  g.windows[1].endsAt = "2026-09-22T09:00:00.000Z";
  await expect(g.make()()).rejects.toThrow();
});
it("advances from completed boundary when a new day closes", async () => {
  const f = fixture();
  f.setLatest(f.windows[0]);
  const tick = f.make();
  await tick();
  f.setLatest(f.windows[1]);
  expect((await tick()).status).toBe("Created");
  expect(f.calls).toEqual(["2026-09-20", "2026-09-21"]);
});
