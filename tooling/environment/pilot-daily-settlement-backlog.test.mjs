import { expect, it, vi } from "vitest";
import {
  DAILY_SETTLEMENT_STEPS_PER_CYCLE,
  createDailySettlementBacklog,
} from "./pilot-daily-settlement-backlog.mjs";
function fixture(count = 3) {
  const scope = { brandReference: "brand", storeReference: "store" };
  const instant = (n) => new Date(Date.UTC(2026, 8, 20 + n, 8)).toISOString();
  const windows = Array.from({ length: count }, (_, n) => ({
    ...scope,
    businessDate: instant(n).slice(0, 10),
    startsAt: instant(n),
    endsAt: instant(n + 1),
    configurationReference: "config",
    configurationVersion: 1,
    contentDigest: "digest",
  }));
  const persisted = new Set(),
    calls = [],
    prepare = vi.fn();
  let latest = windows[count - 1],
    failed = false;
  let at = Date.parse(windows[count - 1].endsAt) + 4 * 3_600_000;
  const ports = {
    scope,
    now: () => new Date(at).toISOString(),
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
    advance: (ms) => {
      at += ms;
    },
  };
}
it("discovers the covered days in one cycle then records one day per cycle, oldest first", async () => {
  const f = fixture(),
    tick = f.make();
  for (let i = 0; i < 3; i++) expect((await tick()).status).toBe("Created");
  expect(f.calls).toEqual(["2026-09-20", "2026-09-21", "2026-09-22"]);
  expect((await tick()).status).toBe("Idle");
});
it("restarts across a partially finished backlog without preparing completed days", async () => {
  const f = fixture(),
    tick = f.make();
  expect((await tick()).status).toBe("Created");
  const resumed = f.make();
  // 2026-09-20 passes as Duplicate; the same cycle records 2026-09-21.
  expect((await resumed()).status).toBe("Created");
  expect((await resumed()).status).toBe("Created");
  expect((await resumed()).status).toBe("Idle");
  expect(f.calls).toEqual(["2026-09-20", "2026-09-20", "2026-09-21", "2026-09-22"]);
  expect(f.prepare).toHaveBeenCalledTimes(3);
});
it("retains the oldest pending day through a failure", async () => {
  const f = fixture(),
    tick = f.make();
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

// WP-2423 v15: one day that cannot be settled (its window refused) must not stop the others.
it("lets later days settle while a failing day is retried on its own", async () => {
  const f = fixture();
  let broken = true;
  const failures = [];
  const readWindow = f.ports.readWindow;
  f.ports.readBounds = vi.fn(async (input) => readWindow(input));
  f.ports.readWindow = vi.fn(async (input) => {
    if (broken && input?.endingAt === f.windows[1].endsAt)
      throw Error("STORE_BUSINESS_DATE_UNAVAILABLE");
    return readWindow(input);
  });
  f.ports.onDayFailure = (entry) => failures.push([entry.businessDate, entry.failures]);
  const tick = f.make();
  expect((await tick()).status).toBe("Created"); // 2026-09-20
  // In place first (a passing outage), then the day steps aside.
  await expect(tick()).rejects.toThrow("STORE_BUSINESS_DATE_UNAVAILABLE");
  await expect(tick()).rejects.toThrow("STORE_BUSINESS_DATE_UNAVAILABLE");
  const aside = await tick();
  expect(aside).toMatchObject({ status: "Idle", checkCount: 0 });
  expect(aside.failure.message).toBe("STORE_BUSINESS_DATE_UNAVAILABLE");
  // The next day still settles; the failure stays reported.
  const next = await tick();
  expect(next).toEqual({ status: "Created", checkCount: 1 });
  expect([...f.persisted]).toEqual(["2026-09-20", "2026-09-22"]);
  // Not due yet: still reported, nothing retried.
  expect((await tick()).failure.message).toBe("STORE_BUSINESS_DATE_UNAVAILABLE");
  // Due but still failing: retried, delay grows.
  f.advance(60_000);
  expect((await tick()).failure).toBeDefined();
  expect(failures).toEqual([
    ["2026-09-21", 1],
    ["2026-09-21", 2],
    ["2026-09-21", 3],
    ["2026-09-21", 4],
  ]);
  f.advance(60_000);
  expect((await tick()).failure).toBeDefined(); // next retry after 2 minutes
  expect(failures).toHaveLength(4);
  // Repaired: the day settles on its next retry and the failure clears.
  broken = false;
  f.advance(60_000);
  const repaired = await tick();
  expect(repaired.status).toBe("Created");
  expect(repaired.failure).toBeUndefined();
  expect([...f.persisted].sort()).toEqual(["2026-09-20", "2026-09-21", "2026-09-22"]);
  expect(await tick()).toEqual({ status: "Idle", checkCount: 0 });
});
it("finds days before and after a day whose window is refused", async () => {
  const f = fixture();
  const readWindow = f.ports.readWindow;
  f.ports.readBounds = vi.fn(async (input) => readWindow(input));
  f.ports.readWindow = vi.fn(async (input) => {
    if (input?.endingAt === f.windows[1].endsAt) throw Error("STORE_BUSINESS_DATE_UNAVAILABLE");
    return readWindow(input);
  });
  const tick = f.make();
  for (let n = 0; n < 8; n++) await tick().catch(() => undefined);
  expect([...f.persisted]).toEqual(["2026-09-20", "2026-09-22"]);
});

// WP-2423 v15 (2026-10-16): a restart loses the in-process cursor and the stepped-aside list; the
// whole coverage window is walked again, so the missed day is settled and nothing is skipped.
it("settles after a restart a day that failed and stepped aside before it", async () => {
  const f = fixture();
  let broken = true;
  const readWindow = f.ports.readWindow;
  f.ports.readBounds = vi.fn(async (input) => readWindow(input));
  f.ports.readWindow = vi.fn(async (input) => {
    if (broken && input?.endingAt === f.windows[1].endsAt)
      throw Error("STORE_BUSINESS_DATE_UNAVAILABLE");
    return readWindow(input);
  });
  const before = f.make();
  for (let n = 0; n < 6; n++) await before().catch(() => undefined);
  expect([...f.persisted]).toEqual(["2026-09-20", "2026-09-22"]);
  expect((await before()).failure.message).toBe("STORE_BUSINESS_DATE_UNAVAILABLE");
  // Fixed and restarted before the stepped-aside retry was due.
  broken = false;
  const after = f.make();
  expect(await after()).toEqual({ status: "Created", checkCount: 1 });
  expect([...f.persisted].sort()).toEqual(["2026-09-20", "2026-09-21", "2026-09-22"]);
  expect(await after()).toEqual({ status: "Duplicate", checkCount: 1 }); // 2026-09-22
  expect(await after()).toEqual({ status: "Idle", checkCount: 0 });
  expect(f.prepare).toHaveBeenCalledTimes(3);
});
it("catches up after a restart in a few cycles however many days are already recorded", async () => {
  const days = 2 * DAILY_SETTLEMENT_STEPS_PER_CYCLE + 5,
    f = fixture(days);
  for (const w of f.windows.slice(0, -1)) f.persisted.add(w.businessDate);
  const tick = f.make();
  let cycles = 0,
    result;
  do result = await tick();
  while (result.status !== "Created" && ++cycles < days);
  expect(cycles).toBeLessThanOrEqual(5);
  expect(f.persisted.has(f.windows[days - 1].businessDate)).toBe(true);
  expect(f.prepare).toHaveBeenCalledTimes(1);
  expect(await tick()).toEqual({ status: "Idle", checkCount: 0 });
});
