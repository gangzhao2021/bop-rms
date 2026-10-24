import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { emptyAlertState } from "./pilot-alerts.mjs";
import { parsePilotOpsConfig } from "./pilot-ops-config.mjs";
import {
  activePlannedMaintenance,
  endPlannedMaintenance,
  readPlannedMaintenance,
  startPlannedMaintenance,
} from "./pilot-ops-maintenance.mjs";
import { observeProbes } from "./pilot-ops-observe.mjs";
import { runMonitorCycle } from "./pilot-ops.mjs";

/** WP-2423 (2026-10-18): a planned update must not page staff; a real outage still must. */
const T0 = Date.parse("2026-10-18T01:40:00.000Z");
const MIN = 60_000;
const at = (ms) => new Date(ms).toISOString();
const config = parsePilotOpsConfig({ schemaVersion: 1, siteLabel: "Main St" }, ".local/pilot-test");
const marker = (startMs, minutes = 15, extra = {}) => ({
  schemaVersion: 1,
  startedBy: "pilot operator",
  reason: "deploy abc123",
  startedAt: at(startMs),
  expiresAt: at(startMs + minutes * MIN),
  ...extra,
});

function monitor({ customerUp, maintenance, business }) {
  const sent = [];
  const io = {
    boards: [],
    logs: [],
    observeProbes: async (previous, now) =>
      observeProbes(previous, now, {
        targets: { api: { url: "a" }, customer: { url: "c" }, merchant: { url: "m" } },
        probe: async (target) => ({ ok: target.url !== "c" || customerUp(now) }),
      }),
    observeSupervisor: async () => ({ maintenance: false, reportAgeMs: 1000, attention: [] }),
    observeBusiness: async (now) =>
      business?.(now) ?? {
        stuckUpdates: { count: 0, oldestAgeMs: 0 },
        retryingUpdates: { count: 0, oldestAgeMs: 0 },
        reconciliationDifferences: { count: 0, oldestAgeMs: 0 },
        settlementExceptions: { count: 0, oldestAgeMs: 0 },
      },
    observeBackup: async () => ({ lastSuccessAt: at(T0 - 3600_000) }),
    observeCertificate: async () => ({ validTo: "2026-12-01T00:00:00.000Z" }),
    observeDisks: async () => [],
    observeMaintenance: async () => maintenance.current,
    channels: [{ id: "email", kind: "email", send: async (message) => sent.push(message) }],
    log: async (entry) => io.logs.push(entry),
    writeState: async () => undefined,
    writeBoard: async (value) => io.boards.push(value),
  };
  let state = { schemaVersion: 1, alert: emptyAlertState(), probes: {}, channels: {} };
  return {
    io,
    sent,
    run: async (minute) => {
      state = await runMonitorCycle({ now: T0 + minute * MIN, state, config, io });
      // Every cycle's state survives a restart of the monitor (the deploy recreates it too).
      state = JSON.parse(JSON.stringify(state));
      return io.boards.at(-1);
    },
  };
}

describe("WP-2423 planned update window", () => {
  it("honours only a well-formed marker of at most 15 minutes while it is in force", () => {
    expect(activePlannedMaintenance(marker(T0), T0 + MIN)).toEqual({
      startedAt: at(T0),
      expiresAt: at(T0 + 15 * MIN),
    });
    expect(activePlannedMaintenance(marker(T0), T0 + 15 * MIN)).toBe(null);
    expect(activePlannedMaintenance(marker(T0, 16), T0 + MIN)).toBe(null);
    expect(activePlannedMaintenance(marker(T0 + 5 * MIN), T0)).toBe(null);
    expect(activePlannedMaintenance(marker(T0, 0), T0)).toBe(null);
    expect(activePlannedMaintenance({ ...marker(T0), schemaVersion: 2 }, T0 + MIN)).toBe(null);
    expect(activePlannedMaintenance({ ...marker(T0), expiresAt: "soon" }, T0 + MIN)).toBe(null);
    expect(activePlannedMaintenance(null, T0)).toBe(null);
    expect(activePlannedMaintenance("unreadable", T0)).toBe(null);
  });

  it("a deploy that takes a few minutes sends nothing and shows the calm notice instead", async () => {
    const maintenance = { current: marker(T0) };
    const m = monitor({ customerUp: (now) => now >= T0 + 6 * MIN, maintenance });
    for (const minute of [0, 1, 2, 3, 4, 5]) {
      const board = await m.run(minute);
      expect(board.active).toEqual([]);
      expect(board.maintenance).toEqual({ startedAt: at(T0), expiresAt: at(T0 + 15 * MIN) });
    }
    await m.run(6);
    maintenance.current = null; // the deploy ends the window once the pages load
    for (const minute of [7, 8, 9, 10]) expect((await m.run(minute)).maintenance).toBe(null);
    expect(m.sent).toEqual([]);
    expect(m.io.boards.at(-1).active).toEqual([]);
    expect(m.io.boards.at(-1).recentlyCleared).toEqual([]);
    expect(m.io.logs.map((entry) => entry.event)).toEqual([
      "maintenance_active",
      "maintenance_ended",
    ]);
    // The board carries the window only, never the operator's note.
    expect(JSON.stringify(m.io.boards)).not.toContain("abc123");
  });

  it("a failure that outlasts the window alerts at once when the window expires", async () => {
    const maintenance = { current: marker(T0, 10) };
    const m = monitor({ customerUp: () => false, maintenance });
    for (let minute = 0; minute < 10; minute += 1) expect((await m.run(minute)).active).toEqual([]);
    expect(m.sent).toEqual([]);
    const board = await m.run(10);
    expect(board.maintenance).toBe(null);
    expect(board.active.map((item) => [item.key, item.severity])).toEqual([
      ["entry.customer", "critical"],
    ]);
    expect(m.sent.map((message) => message.subject)).toEqual([
      "Main St: URGENT - Customer ordering page is not loading",
    ]);
    expect(m.io.logs.map((entry) => entry.event)).toContain("maintenance_expired");
  });

  it("ending the window while the page is still down alerts at once, not 2 minutes later", async () => {
    const maintenance = { current: marker(T0) };
    const m = monitor({ customerUp: () => false, maintenance });
    for (const minute of [0, 1, 2, 3, 4]) await m.run(minute);
    expect(m.sent).toEqual([]);
    maintenance.current = null;
    expect((await m.run(5)).active.map((item) => item.key)).toEqual(["entry.customer"]);
    expect(m.sent).toHaveLength(1);
  });

  it("without a marker (or with a marker that is not honoured) a down page alerts after 2 minutes", async () => {
    for (const current of [null, marker(T0, 30), "unreadable"]) {
      const m = monitor({ customerUp: () => false, maintenance: { current } });
      expect((await m.run(0)).active).toEqual([]);
      expect((await m.run(1)).active).toEqual([]);
      expect((await m.run(2)).active.map((item) => item.key)).toEqual(["entry.customer"]);
      expect(m.sent).toHaveLength(1);
    }
  });

  it("never holds payment alerts, and keeps an outage raised before the window", async () => {
    const maintenance = { current: null };
    const m = monitor({
      customerUp: () => false,
      maintenance,
      business: (now) => ({
        stuckUpdates: now >= T0 + 4 * MIN ? { count: 2, oldestAgeMs: MIN } : { count: 0 },
        retryingUpdates: { count: 0, oldestAgeMs: 0 },
        reconciliationDifferences: { count: 0, oldestAgeMs: 0 },
        settlementExceptions: { count: 0, oldestAgeMs: 0 },
      }),
    });
    for (const minute of [0, 1, 2]) await m.run(minute);
    expect(m.sent).toHaveLength(1);
    // Someone starts an update during a real outage: it is not cleared or hidden.
    maintenance.current = marker(T0 + 3 * MIN);
    for (const minute of [3, 4, 5, 6]) {
      const board = await m.run(minute);
      expect(board.active.map((item) => item.key)).toContain("entry.customer");
    }
    expect(
      m.io.boards
        .at(-1)
        .active.map((item) => item.key)
        .sort(),
    ).toEqual(["entry.customer", "payment.updates"]);
    expect(m.sent.map((message) => message.subject)).toEqual([
      "Main St: URGENT - Customer ordering page is not loading",
      "Main St: URGENT - Order or payment updates are stuck",
    ]);
  });
});

describe("WP-2423 planned update marker file", () => {
  const dirs = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });
  const runtime = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ops-maint-"));
    dirs.push(dir);
    await fs.chmod(dir, 0o700);
    return dir;
  };

  it("writes a private marker of at most 15 minutes and removes it again", async () => {
    const dir = await runtime();
    expect(await readPlannedMaintenance(dir)).toBe(null);
    const written = await startPlannedMaintenance(dir, { reason: "deploy f5ae43a5", now: T0 });
    expect(written).toEqual(marker(T0, 15, { reason: "deploy f5ae43a5" }));
    const file = path.join(dir, "ops", "maintenance.json");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await readPlannedMaintenance(dir)).toEqual(written);
    await startPlannedMaintenance(dir, {
      reason: "restart",
      minutes: 5,
      startedBy: "Ryan",
      now: T0,
    });
    expect(await readPlannedMaintenance(dir)).toMatchObject({
      startedBy: "Ryan",
      expiresAt: at(T0 + 5 * MIN),
    });
    expect(await endPlannedMaintenance(dir)).toBe(true);
    expect(await endPlannedMaintenance(dir)).toBe(false);
    expect(await readPlannedMaintenance(dir)).toBe(null);
  });

  it("refuses a missing or unsafe note and a window longer than 15 minutes", async () => {
    const dir = await runtime();
    for (const options of [
      { reason: "" },
      { reason: "<script>" },
      { reason: "line\nbreak" },
      { reason: "x".repeat(81) },
      { reason: "deploy", startedBy: "" },
      { reason: "deploy", minutes: 16 },
      { reason: "deploy", minutes: 0 },
      { reason: "deploy", minutes: 1.5 },
    ])
      await expect(startPlannedMaintenance(dir, options)).rejects.toThrow(/^PILOT_MAINTENANCE_/u);
    expect(await readPlannedMaintenance(dir)).toBe(null);
  });

  it("reports a marker another user may have written as unreadable (it is then not honoured)", async () => {
    const dir = await runtime();
    await fs.mkdir(path.join(dir, "ops"), { mode: 0o700 });
    await fs.writeFile(path.join(dir, "ops", "maintenance.json"), JSON.stringify(marker(T0)), {
      mode: 0o644,
    });
    expect(await readPlannedMaintenance(dir)).toBe("unreadable");
  });
});

describe("WP-2423 pilot-ops maintenance command", () => {
  const exec = promisify(execFile);
  const script = fileURLToPath(new URL("./pilot-ops.mjs", import.meta.url));
  let cwd;
  afterEach(async () => {
    if (cwd) await fs.rm(cwd, { recursive: true, force: true });
  });
  const ops = (...args) => exec(process.execPath, [script, ...args], { cwd, timeout: 20_000 });

  it("starts, reports and ends a planned update from the command line", async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ops-cli-"));
    await fs.mkdir(path.join(cwd, ".local", "pilot-cli"), { recursive: true, mode: 0o700 });
    const started = await ops(
      "maintenance",
      "start",
      ".local/pilot-cli",
      "--reason",
      "deploy f5ae43a5",
      "--minutes",
      "10",
    );
    expect(started.stdout).toMatch(/^PILOT_MAINTENANCE_STARTED until \d{4}-/u);
    const status = JSON.parse((await ops("status", ".local/pilot-cli")).stdout);
    expect(status.monitor).toBe("NotRunning");
    expect(status.plannedUpdate).toMatchObject({ reason: "deploy f5ae43a5", inForce: true });
    const log = await fs.readFile(path.join(cwd, ".local/pilot-cli/ops/alerts.log"), "utf8");
    expect(log).toContain("maintenance_started");
    expect(log).not.toContain("f5ae43a5");
    expect((await ops("maintenance", "end", ".local/pilot-cli")).stdout).toMatch(
      /^PILOT_MAINTENANCE_ENDED/u,
    );
    expect((await ops("maintenance", "end", ".local/pilot-cli")).stdout).toMatch(
      /^PILOT_MAINTENANCE_NOT_ACTIVE/u,
    );
    for (const args of [
      ["maintenance", "start", ".local/pilot-cli"],
      ["maintenance", "start", ".local/pilot-cli", "--reason", "deploy", "--minutes", "20"],
      ["maintenance", "start", ".local/pilot-cli", "--reason", "deploy", "--force", "1"],
      ["maintenance", "pause", ".local/pilot-cli"],
    ])
      await expect(ops(...args)).rejects.toMatchObject({
        stderr: expect.stringMatching(/^PILOT_(?:MAINTENANCE|OPS)_[A-Z_]+\n$/u),
      });
  });
});
