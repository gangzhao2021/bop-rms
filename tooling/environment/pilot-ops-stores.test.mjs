import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyAlertState } from "./pilot-alerts.mjs";
import { parsePilotOpsConfig } from "./pilot-ops-config.mjs";
import { observeProbes } from "./pilot-ops-observe.mjs";
import {
  STORE_BOARD_STALE_MS,
  createStoreMonitors,
  readStoresStatus,
} from "./pilot-ops-stores.mjs";
import { runMonitorCycle } from "./pilot-ops.mjs";

/**
 * DEC-PILOT-ALERTS-BACKUP correction 2: does each Store see only its own facts, with no false alarm,
 * and does one Store failing leave the others alone? Real files in a private directory; only the
 * database reads behind readBusinessSignals are stood in for.
 */
const T0 = Date.parse("2026-11-05T04:20:00.000Z");
const MIN = 60_000;
const config = parsePilotOpsConfig({ schemaVersion: 1, siteLabel: "Main St" }, ".local/pilot-test");
const healthyProbes = { api: { ok: true }, customer: { ok: true }, merchant: { ok: true } };
const healthySupervisor = { maintenance: false, reportAgeMs: 1000, attention: [] };
const directories = [];
/** A flag on a Store's work that has held: six samples, a minute apart. */
const HELD_FIVE_MINUTES = [0, 1, 2, 3, 4, 5];

/** What one Store's database would say; tests change it between cycles. */
const fact = (change = {}) => ({
  dead: 0,
  differences: 0,
  opened: true,
  covered: true,
  closedDay: false,
  receipt: { ready: true },
  quoteTax: { ready: true },
  ...change,
});

/** A fact given as an Error is a read that fails with it. */
const answer = (value) => {
  if (value instanceof Error) throw value;
  return value;
};

function businessOf(facts, closes) {
  return vi.fn(async (directory) => {
    const name = path.basename(directory);
    const current = () => facts[name];
    if (current().loadFails) throw Error("LOCAL_DATABASE_UNAVAILABLE");
    const rows = (sql) => {
      answer(current().updatesRead);
      return sql.includes("dead_letter_item")
        ? [{ count: current().dead, oldest: current().dead > 0 ? new Date(T0 - 5 * MIN) : null }]
        : [{ count: 0, oldest: null, oldest_deadline: null }];
    };
    const run = { run: async (work) => work({ query: async (sql) => ({ rows: rows(sql) }) }) };
    return {
      resources: {
        scope: { brandReference: "b", storeReference: name },
        transactions: run,
        database: {
          transactions: () => ({
            run: async (work) =>
              work({ query: async () => ({ rows: [{ count: 0, oldest: null }] }) }),
          }),
        },
        close: async () => closes?.push(name),
      },
      installation: {},
      dependencies: {
        createReconciliationExceptions: () => async () => {
          if (current().hangs) await new Promise(() => undefined);
          answer(current().differencesRead);
          return {
            items: Array.from({ length: current().differences }, () => ({
              state: "Open",
              openedAt: new Date(T0 - 60 * MIN).toISOString(),
            })),
            nextAfterExceptionReference: null,
          };
        },
        readSettlementStatus: async () => {
          current().scans = (current().scans ?? 0) + 1;
          return { days: answer(current().days ?? []) };
        },
        readOwnerPublishedSetup: async () => answer(current().opened),
        isSettlementCovered: async () => answer(current().covered),
        readClosedBusinessDay: async () => answer(current().closedDay),
        readReceiptTemplate: async () => answer(current().receipt),
        readQuoteTaxConfiguration: async () => answer(current().quoteTax),
        readHeldStockOrders: async () =>
          answer(current().held ?? { openCount: 0, endedCount: 0, oldestAt: null }),
        readPickupCapacityHorizon: async () =>
          current().pickupOffered === false
            ? null
            : { coveredMs: answer(current().pickup ?? 14 * 86400_000) },
      },
    };
  });
}

async function runtime(facts, { validUntil = "2026-12-30T00:00:00.000Z", profiles = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ops-stores-"));
  directories.push(directory);
  await fs.chmod(directory, 0o700);
  const write = (names) =>
    fs.writeFile(
      path.join(directory, "stores.json"),
      JSON.stringify({ schemaVersion: 1, stores: names.map((name) => `stores/${name}`) }),
    );
  await write(Object.keys(facts));
  for (const name of Object.keys(facts)) {
    await fs.mkdir(path.join(directory, "stores", name), { recursive: true, mode: 0o700 });
    if (profiles)
      await fs.writeFile(
        path.join(directory, "stores", name, "internal-test-profile.json"),
        JSON.stringify({ binding: { validUntil } }),
      );
  }
  return { directory, write };
}
const stateOf = async (directory, name, file) =>
  JSON.parse(await fs.readFile(path.join(directory, "stores", name, "ops", file), "utf8"));
const boardOf = (directory, name) => stateOf(directory, name, "alert-board.json");
const keysOf = (board) => board.active.map((item) => item.key).sort();

async function monitorsFor(facts, options = {}) {
  const { directory, write } = await runtime(facts, options);
  const logs = [];
  const closes = [];
  const report = vi.fn();
  const monitors = createStoreMonitors({
    runtimeDirectory: directory,
    load: businessOf(facts, closes),
    log: async (entry) => logs.push(entry),
    report,
    clock: () => 0,
    ...(options.readLimitMs ? { readLimitMs: options.readLimitMs } : {}),
  });
  const cycle = (minute, change = {}) =>
    monitors.run({
      now: T0 + minute * MIN,
      probes: healthyProbes,
      supervisor: healthySupervisor,
      maintenance: null,
      config,
      ...change,
    });
  return { directory, write, logs, closes, report, monitors, cycle };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("one alert board per served Store", () => {
  it("each Store gets a board from its own signals", async () => {
    const facts = { tea: fact({ dead: 2, differences: 1 }), hotpot: fact() };
    const { directory, cycle } = await monitorsFor(facts);
    await cycle(0);
    const tea = await boardOf(directory, "tea");
    expect(keysOf(tea)).toEqual(["payment.updates", "reconciliation.differences"]);
    expect(tea.active.find((item) => item.key === "payment.updates").summary).toContain(
      "2 updates",
    );
    expect(tea.observedAt).toBe(new Date(T0).toISOString());
    // The other merchant's board does not carry them, and says nothing about the installation.
    const hotpot = await boardOf(directory, "hotpot");
    expect(hotpot.active).toEqual([]);
    expect(hotpot.outboundChannels).toEqual({ email: false, webhooks: 0, heartbeat: false });
    expect(hotpot.lastSuccessfulBackupAt).toBe(null);
  });
  it("each board says when it was really written, however long the Stores before it took", async () => {
    const facts = { tea: fact(), hotpot: fact() };
    const { directory } = await runtime(facts);
    let elapsed = 0;
    const monitors = createStoreMonitors({
      runtimeDirectory: directory,
      load: businessOf(facts),
      log: async () => undefined,
      report: () => undefined,
      clock: () => elapsed,
      observeValidity: async () => {
        elapsed += 2 * MIN;
        return { validUntil: "2026-12-30T00:00:00.000Z" };
      },
    });
    await monitors.run({
      now: T0,
      probes: healthyProbes,
      supervisor: healthySupervisor,
      maintenance: null,
      config,
    });
    expect((await boardOf(directory, "tea")).observedAt).toBe(new Date(T0).toISOString());
    expect((await boardOf(directory, "hotpot")).observedAt).toBe(
      new Date(T0 + 2 * MIN).toISOString(),
    );
  });
  it("a damaged state file starts that Store's alerts again, and is logged", async () => {
    const { directory, cycle, logs } = await monitorsFor({ tea: fact({ dead: 1 }) });
    await cycle(0);
    await fs.writeFile(path.join(directory, "stores", "tea", "ops", "alert-state.json"), "{}", {
      mode: 0o600,
    });
    await cycle(1);
    expect(keysOf(await boardOf(directory, "tea"))).toEqual(["payment.updates"]);
    expect(logs).toContainEqual({ event: "store_state_unreadable", store: "tea" });
  });
  it("keeps its files private", async () => {
    const { directory, cycle } = await monitorsFor({ tea: fact() });
    await cycle(0);
    const ops = path.join(directory, "stores", "tea", "ops");
    expect((await fs.stat(ops)).mode & 0o777).toBe(0o700);
    for (const file of ["alert-board.json", "alert-state.json"])
      expect((await fs.stat(path.join(ops, file))).mode & 0o777).toBe(0o600);
  });
  it("one Store's failure leaves the other's board fresh and is logged by name", async () => {
    const facts = { tea: fact({ loadFails: true }), broken: fact(), hotpot: fact() };
    const { directory, cycle, logs, report } = await monitorsFor(facts);
    // A Store whose ops directory cannot be used at all.
    await fs.writeFile(path.join(directory, "stores", "broken", "ops"), "not a directory");
    await cycle(0);
    await cycle(1);
    expect((await boardOf(directory, "hotpot")).observedAt).toBe(new Date(T0 + MIN).toISOString());
    expect(logs).toContainEqual({ event: "store_monitor_failed", store: "tea", stage: "read" });
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "store_monitor_failed", store: "broken" }),
    );
    expect(report).toHaveBeenCalledWith("PILOT_OPS_STORE_READ_UNAVAILABLE", expect.any(Error), {
      store: "stores/tea",
    });
    // Its database read failed, but the entry probes it shares are still on its own board.
    expect((await boardOf(directory, "tea")).observedAt).toBe(new Date(T0 + MIN).toISOString());
    expect(JSON.stringify(logs)).not.toContain(directory);
  });
  it("a Store whose read does not finish does not stop the next one, or itself next time", async () => {
    const facts = { tea: fact({ hangs: true }), hotpot: fact({ dead: 1 }) };
    const { directory, cycle } = await monitorsFor(facts, { readLimitMs: 20 });
    await cycle(0);
    expect(keysOf(await boardOf(directory, "hotpot"))).toEqual(["payment.updates"]);
    expect((await boardOf(directory, "tea")).active).toEqual([]);
    await cycle(1);
    await cycle(6);
    // Still going: its checks read as unable to run, not as healthy.
    expect(keysOf(await boardOf(directory, "tea"))).toEqual(["monitor.source"]);
  });
  it("a new Store joins within a cycle and a retired one stops being written", async () => {
    const facts = { tea: fact(), hotpot: fact(), dessert: fact() };
    const { directory, write, cycle, closes, logs } = await monitorsFor(facts);
    await write(["tea", "hotpot"]);
    await cycle(0);
    await expect(boardOf(directory, "dessert")).rejects.toThrow();
    await write(["tea", "hotpot", "dessert"]);
    await cycle(1);
    expect((await boardOf(directory, "dessert")).observedAt).toBe(new Date(T0 + MIN).toISOString());
    await write(["tea", "dessert"]);
    await cycle(2);
    expect((await boardOf(directory, "hotpot")).observedAt).toBe(new Date(T0 + MIN).toISOString());
    expect((await boardOf(directory, "tea")).observedAt).toBe(new Date(T0 + 2 * MIN).toISOString());
    // Its share of the connections is given back.
    expect(closes).toEqual(["hotpot"]);
    expect(logs).toContainEqual({ event: "store_monitor_retired", store: "hotpot" });
  });
  it("an unreadable Store list leaves the boards alone and is logged", async () => {
    const { directory, cycle, logs } = await monitorsFor({ tea: fact() });
    await cycle(0);
    await fs.writeFile(path.join(directory, "stores.json"), "{not json");
    await cycle(1);
    expect((await boardOf(directory, "tea")).observedAt).toBe(new Date(T0).toISOString());
    expect(logs).toContainEqual({ event: "store_monitors_list_unreadable" });
  });
});

describe("a new Store must not cry wolf", () => {
  it("a Store not yet owner-published raises no receipt, pricing or pickup alert", async () => {
    const facts = {
      tea: fact({
        opened: false,
        receipt: { ready: false, reason: "TemplateNotProven" },
        quoteTax: { ready: false, reason: "TaxConfigurationMismatch" },
        pickup: 0,
      }),
    };
    const { directory, cycle } = await monitorsFor(facts);
    for (const minute of [0, 2, 3, 6]) await cycle(minute);
    expect((await boardOf(directory, "tea")).active).toEqual([]);
    // Once it opens, the same facts are real problems.
    facts.tea.opened = true;
    for (const minute of [7, 9]) await cycle(minute);
    expect(keysOf(await boardOf(directory, "tea"))).toEqual([
      "pickup.capacity_horizon",
      "pricing.tax_configuration",
      "receipts.template",
    ]);
  });
  it("a Store that does not offer pickup is not told pickup orders cannot be taken", async () => {
    const { directory, cycle } = await monitorsFor({ hotpot: fact({ pickupOffered: false }) });
    await cycle(0);
    expect((await boardOf(directory, "hotpot")).active).toEqual([]);
  });
  it("a Store with no settlement coverage is not unreadable, and only BOP is told, once a day has closed", async () => {
    const facts = { tea: fact({ covered: false, closedDay: false }) };
    const { directory, cycle, monitors, logs } = await monitorsFor(facts);
    for (const minute of [0, 1, 6]) await cycle(minute);
    // Not "some checks could not run": there is nothing to check yet.
    expect((await boardOf(directory, "tea")).active).toEqual([]);
    expect(monitors.summary(T0 + 6 * MIN).settlementNotCovered).toEqual([]);
    facts.tea.closedDay = true;
    await cycle(7);
    const board = await boardOf(directory, "tea");
    expect(keysOf(board)).toEqual(["settlement.not_covered"]);
    expect(monitors.summary(T0 + 7 * MIN).settlementNotCovered).toEqual(["tea"]);
    expect(monitors.pending().map((item) => [item.key, item.store])).toEqual([
      ["settlement.not_covered", "tea"],
    ]);
    expect(logs).toContainEqual({ event: "store_settlement_not_covered", store: "tea" });
    // Coverage recorded: it clears, and settlement problems are read from then on.
    Object.assign(facts.tea, {
      covered: true,
      days: [
        { state: "Recorded", endsAt: new Date(T0 - 60 * MIN).toISOString(), outcome: "Difference" },
      ],
    });
    for (const minute of [8, 10]) await cycle(minute);
    expect(keysOf(await boardOf(directory, "tea"))).toEqual(["settlement.exceptions"]);
  });
  it("a settings read held up by another merchant's listing raises nothing on a Store board", async () => {
    const held = { ready: false, reason: "StoreConfigurationUnavailable" };
    const facts = { tea: fact({ receipt: held, quoteTax: held }) };
    const { directory, cycle } = await monitorsFor(facts);
    for (const minute of [0, 1, 2, 3]) await cycle(minute);
    // At the root this reads "Receipts are not being issued" after 2 minutes.
    expect((await boardOf(directory, "tea")).active).toEqual([]);
    // If it never ends BOP hears, in the words that are true: the checks could not run.
    for (const minute of [4, 5]) await cycle(minute);
    const board = await boardOf(directory, "tea");
    expect(keysOf(board)).toEqual(["monitor.source"]);
    expect(board.active[0].summary).toContain("the receipt template check");
    // And it clears the moment the listing is over.
    Object.assign(facts.tea, { receipt: { ready: true }, quoteTax: { ready: true } });
    for (const minute of [6, 8]) await cycle(minute);
    expect((await boardOf(directory, "tea")).active).toEqual([]);
  });
  it("a raised alert stays while its read cannot run: no read is not an all-clear", async () => {
    const facts = { tea: fact({ dead: 1, differences: 1 }) };
    const { directory, cycle } = await monitorsFor(facts);
    await cycle(0);
    // The database goes away; a restarted monitor must not read that as resolved either.
    facts.tea.loadFails = true;
    const failing = restartedMonitor(directory, facts);
    for (const minute of [1, 3, 5, 7]) await failing(minute);
    expect(keysOf(await boardOf(directory, "tea"))).toEqual([
      "monitor.source",
      "payment.updates",
      "reconciliation.differences",
    ]);
    // Readable again and resolved: then it clears.
    Object.assign(facts.tea, { loadFails: false, dead: 0, differences: 0 });
    for (const minute of [8, 10]) await failing(minute);
    expect((await boardOf(directory, "tea")).active).toEqual([]);
  });
});

// The merchant is told nothing of a check that could not run, so this is BOP's only way to a fix.
describe("BOP can find out why a Store's check could not run", () => {
  const refused = () => Object.assign(Error("permission denied"), { code: "42501" });
  const failedChecks = (logs) => logs.filter((entry) => entry.event === "store_check_failed");
  it.each([
    ["receipts", "receipt"],
    ["quoteTax", "quoteTax"],
    ["heldStock", "held"],
    ["pickupCapacity", "pickup"],
    ["openingSetup", "opened"],
  ])("a %s read refused gives one line naming the check, and its code", async (check, field) => {
    const error = refused();
    const facts = { tea: fact({ [field]: error }), hotpot: fact() };
    const { cycle, logs, report } = await monitorsFor(facts);
    for (const minute of [0, 1, 2]) await cycle(minute);
    // When it turned unreadable, not every minute that it stays so.
    expect(failedChecks(logs)).toEqual([{ event: "store_check_failed", store: "tea", check }]);
    expect(report.mock.calls).toEqual([
      ["PILOT_OPS_STORE_READ_UNAVAILABLE", error, { store: "stores/tea", step: check }],
    ]);
  });
  it.each([
    ["receipts", "receipt"],
    ["quoteTax", "quoteTax"],
  ])("a %s answer that the settings could not be read gives its cause", async (check, field) => {
    const cause = refused();
    const reason = "StoreConfigurationUnavailable";
    const facts = { tea: fact({ [field]: { ready: false, reason, cause } }) };
    const { directory, cycle, logs, report } = await monitorsFor(facts);
    for (const minute of [0, 1, 2, 3, 4, 5]) await cycle(minute);
    expect(failedChecks(logs)).toEqual([{ event: "store_check_failed", store: "tea", check }]);
    expect(report.mock.calls).toEqual([
      ["PILOT_OPS_STORE_READ_UNAVAILABLE", cause, { store: "stores/tea", step: check }],
    ]);
    // The cause stays out of what anyone reads: the board has only the catalog's words.
    expect(JSON.stringify(await boardOf(directory, "tea"))).not.toContain("42501");
    expect(await stateOf(directory, "tea", "alert-state.json")).not.toHaveProperty("cause");
    expect(JSON.stringify(await stateOf(directory, "tea", "alert-state.json"))).not.toContain(
      "42501",
    );
  });
  it("an answer with no cause still names the check", async () => {
    const receipt = { ready: false, reason: "StoreConfigurationUnavailable" };
    const { cycle, report } = await monitorsFor({ tea: fact({ receipt }) });
    await cycle(0);
    expect(report.mock.calls[0][1].message).toBe("STORE_CONFIGURATION_UNAVAILABLE");
    expect(report.mock.calls[0][2]).toEqual({ store: "stores/tea", step: "receipts" });
  });
  it("says so again when a check that recovered fails again, and only for that check", async () => {
    const facts = { tea: fact({ held: refused() }) };
    const { cycle, logs } = await monitorsFor(facts);
    await cycle(0);
    facts.tea.held = undefined;
    await cycle(1);
    expect(failedChecks(logs)).toHaveLength(1);
    facts.tea.held = refused();
    await cycle(2);
    expect(failedChecks(logs)).toHaveLength(2);
    facts.tea.receipt = refused();
    await cycle(3);
    expect(failedChecks(logs).map((entry) => entry.check)).toEqual([
      "heldStock",
      "heldStock",
      "receipts",
    ]);
  });
  it("a whole read that fails between checks does not repeat the line for a check still failing", async () => {
    const facts = { tea: fact({ held: refused() }) };
    const { cycle, logs } = await monitorsFor(facts);
    await cycle(0);
    // The stuck updates, read before the checks, fail the read as a whole.
    facts.tea.updatesRead = refused();
    await cycle(6);
    await cycle(7);
    facts.tea.updatesRead = undefined;
    await cycle(8);
    expect(failedChecks(logs)).toHaveLength(1);
    expect(logs).toContainEqual({ event: "store_monitor_failed", store: "tea", stage: "read" });
  });
  it("a read past the time limit is logged by name, once for each time it fires", async () => {
    const facts = { tea: fact({ hangs: true }), hotpot: fact() };
    const { cycle, logs } = await monitorsFor(facts, { readLimitMs: 20 });
    const timedOut = () =>
      logs.filter((entry) => entry.event === "store_monitor_failed" && entry.stage === "timeout");
    await cycle(0);
    expect(timedOut()).toEqual([{ event: "store_monitor_failed", store: "tea", stage: "timeout" }]);
    // Still going a minute later: nothing new to say, and no new read started.
    await cycle(1);
    expect(timedOut()).toHaveLength(1);
  });
  it("a healthy Store writes no such line", async () => {
    const { cycle, logs, report } = await monitorsFor({ tea: fact() });
    await cycle(0);
    await cycle(1);
    expect(logs).toEqual([]);
    expect(report).not.toHaveBeenCalled();
  });
});

/** A fresh monitor over the same files, as after a restart. */
function restartedMonitor(directory, facts) {
  const monitors = createStoreMonitors({
    runtimeDirectory: directory,
    load: businessOf(facts),
    log: async () => undefined,
    report: () => undefined,
    clock: () => 0,
  });
  return (minute) =>
    monitors.run({
      now: T0 + minute * MIN,
      probes: healthyProbes,
      supervisor: healthySupervisor,
      maintenance: null,
      config,
    });
}

describe("one part of a Store's read failing leaves the rest standing", () => {
  const refused = () => Object.assign(Error("permission denied"), { code: "42501" });
  const failedChecks = (logs) => logs.filter((entry) => entry.event === "store_check_failed");
  it("stuck updates still say so while the settlement scan cannot run, and BOP can find out why", async () => {
    const error = refused();
    const facts = { "demo-2": fact({ days: error }) };
    const { directory, cycle, logs, report, monitors } = await monitorsFor(facts);
    for (let minute = 0; minute <= 30; minute += 1) {
      facts["demo-2"].dead = minute >= 2 ? 3 : 0;
      await cycle(minute);
    }
    const board = await boardOf(directory, "demo-2");
    // "Do not take a second payment" on the merchant's Home; "could not run" for BOP.
    expect(keysOf(board)).toEqual(["monitor.source", "payment.updates"]);
    expect(board.active.find((item) => item.key === "monitor.source").summary).toContain(
      "the day-end settlement check",
    );
    expect(failedChecks(logs)).toEqual([
      { event: "store_check_failed", store: "demo-2", check: "settlement" },
    ]);
    expect(report.mock.calls).toEqual([
      ["PILOT_OPS_STORE_READ_UNAVAILABLE", error, { store: "stores/demo-2", step: "settlement" }],
    ]);
    expect(monitors.summary(T0 + 30 * MIN).checksFailing).toEqual(["demo-2"]);
    // Its costliest read is not run every minute only to fail again: every 5 minutes, as if clean.
    expect(facts["demo-2"].scans).toBe(7);
    // The read as a whole never failed: its connections were not thrown away either.
    expect(logs.filter((entry) => entry.event === "store_monitor_failed")).toEqual([]);
  });
  it("stays quiet about a scan that failed once and came back within five minutes", async () => {
    const facts = { tea: fact({ days: refused() }) };
    const { directory, cycle } = await monitorsFor(facts);
    for (const minute of [0, 1, 2, 3, 4]) await cycle(minute);
    facts.tea.days = [];
    await cycle(5);
    expect((await boardOf(directory, "tea")).active).toEqual([]);
  });
  it("a settlement problem already raised stays while the scan cannot run, and clears after it can", async () => {
    const day = { state: "Recorded", endsAt: new Date(T0 - 60 * MIN).toISOString() };
    const facts = { tea: fact({ days: [{ ...day, outcome: "Difference" }] }) };
    const { directory, cycle } = await monitorsFor(facts);
    await cycle(0);
    expect(keysOf(await boardOf(directory, "tea"))).toEqual(["settlement.exceptions"]);
    facts.tea.days = refused();
    for (const minute of [1, 3, 5, 6, 7]) await cycle(minute);
    expect(keysOf(await boardOf(directory, "tea"))).toEqual([
      "monitor.source",
      "settlement.exceptions",
    ]);
    facts.tea.days = [];
    for (const minute of [8, 9, 11, 13]) await cycle(minute);
    expect((await boardOf(directory, "tea")).active).toEqual([]);
  });
  it("no coverage already told to BOP is not forgotten while coverage cannot be read", async () => {
    const facts = { tea: fact({ covered: false, closedDay: true, dead: 1 }) };
    const { directory, cycle, logs } = await monitorsFor(facts);
    await cycle(0);
    expect(keysOf(await boardOf(directory, "tea"))).toEqual([
      "payment.updates",
      "settlement.not_covered",
    ]);
    facts.tea.covered = refused();
    for (const minute of [1, 3, 5, 6]) await cycle(minute);
    expect(keysOf(await boardOf(directory, "tea"))).toEqual([
      "monitor.source",
      "payment.updates",
      "settlement.not_covered",
    ]);
    expect(failedChecks(logs).map((entry) => entry.check)).toEqual(["settlement"]);
  });
  it("a closed business day that cannot be read is not 'none yet': BOP still hears there is no settlement", async () => {
    const error = refused();
    const facts = { tea: fact({ covered: false, closedDay: true }) };
    const { directory, cycle, logs, report } = await monitorsFor(facts);
    await cycle(0);
    expect(keysOf(await boardOf(directory, "tea"))).toEqual(["settlement.not_covered"]);
    facts.tea.closedDay = error;
    for (const minute of [1, 3, 5, 6]) await cycle(minute);
    const board = await boardOf(directory, "tea");
    expect(keysOf(board)).toEqual(["monitor.source", "settlement.not_covered"]);
    expect(board.active.find((item) => item.key === "monitor.source").summary).toContain(
      "the check for closed business days",
    );
    expect(failedChecks(logs)).toEqual([
      { event: "store_check_failed", store: "tea", check: "closedDay" },
    ]);
    expect(report).toHaveBeenCalledWith("PILOT_OPS_STORE_READ_UNAVAILABLE", error, {
      store: "stores/tea",
      step: "closedDay",
    });
    // Read again: once there is an answer, the board says only what it says.
    facts.tea.closedDay = false;
    for (const minute of [7, 8, 10, 12]) await cycle(minute);
    expect((await boardOf(directory, "tea")).active).toEqual([]);
  });
  it("a payment difference already raised stays while its read cannot run, and the rest still rises", async () => {
    const error = refused();
    const facts = { tea: fact({ differences: 2 }) };
    const { directory, cycle, logs, report } = await monitorsFor(facts);
    await cycle(0);
    Object.assign(facts.tea, { differencesRead: error, dead: 1 });
    for (const minute of [1, 3, 5, 6]) await cycle(minute);
    const board = await boardOf(directory, "tea");
    expect(keysOf(board)).toEqual([
      "monitor.source",
      "payment.updates",
      "reconciliation.differences",
    ]);
    expect(board.active.find((item) => item.key === "monitor.source").summary).toContain(
      "the check for payment differences",
    );
    expect(failedChecks(logs).map((entry) => entry.check)).toEqual(["reconciliation"]);
    expect(report).toHaveBeenCalledWith("PILOT_OPS_STORE_READ_UNAVAILABLE", error, {
      store: "stores/tea",
      step: "reconciliation",
    });
  });
});

describe("a flag on a Store's work that clears by itself is no alarm", () => {
  const flagged = { ...healthySupervisor, attention: ["stores/hotpot:business-worker:events"] };
  it("one sampled cycle gives no row and no outbound message", async () => {
    const { directory, cycle, monitors, logs } = await monitorsFor({ hotpot: fact() });
    await cycle(0, { supervisor: flagged });
    expect((await boardOf(directory, "hotpot")).active).toEqual([]);
    for (const minute of [1, 2, 3, 4, 5, 6]) {
      await cycle(minute);
      expect((await boardOf(directory, "hotpot")).active).toEqual([]);
    }
    expect(monitors.pending()).toEqual([]);
    expect((await boardOf(directory, "hotpot")).recentlyCleared).toEqual([]);
    expect(logs).toEqual([]);
  });
  it("six consecutive cycles give the Urgent row and one outbound message", async () => {
    const { directory, cycle, monitors, logs } = await monitorsFor({ hotpot: fact() });
    for (const minute of [0, 1, 2, 3, 4]) {
      await cycle(minute, { supervisor: flagged });
      expect((await boardOf(directory, "hotpot")).active).toEqual([]);
    }
    await cycle(5, { supervisor: flagged });
    const [row] = (await boardOf(directory, "hotpot")).active;
    expect(row.key).toBe("service.attention");
    expect(row.severity).toBe("critical");
    expect(row.summary).toBe(
      "Order processing (order updates) has kept failing and will not fix itself.",
    );
    expect(monitors.pending().map((item) => [item.kind, item.key, item.store])).toEqual([
      ["raised", "service.attention", "hotpot"],
    ]);
    monitors.acknowledge(monitors.pending());
    await cycle(6, { supervisor: flagged });
    expect(monitors.pending()).toEqual([]);
    expect(logs).toEqual([
      { event: "alert_raised", store: "hotpot", key: "service.attention", severity: "critical" },
    ]);
  });
  it("a sample without it starts the wait again", async () => {
    const { directory, cycle } = await monitorsFor({ hotpot: fact() });
    for (const minute of [0, 1, 2, 3, 4]) await cycle(minute, { supervisor: flagged });
    await cycle(5);
    for (const minute of [6, 7, 8, 9, 10]) await cycle(minute, { supervisor: flagged });
    expect((await boardOf(directory, "hotpot")).active).toEqual([]);
    await cycle(11, { supervisor: flagged });
    expect(keysOf(await boardOf(directory, "hotpot"))).toEqual(["service.attention"]);
  });
  it("a planned update does not start the wait again, and nothing rises until it ends", async () => {
    const { directory, cycle } = await monitorsFor({ hotpot: fact() });
    const window = {
      startedAt: new Date(T0).toISOString(),
      expiresAt: new Date(T0 + 15 * MIN).toISOString(),
    };
    for (const minute of [0, 1, 2, 3, 4, 5, 6])
      await cycle(minute, { supervisor: flagged, maintenance: window });
    expect((await boardOf(directory, "hotpot")).active).toEqual([]);
    await cycle(7, { supervisor: flagged });
    expect(keysOf(await boardOf(directory, "hotpot"))).toEqual(["service.attention"]);
  });
});

describe("what the installation shares with every Store", () => {
  it("an entry probe failure and a planned window reach every Store's board", async () => {
    const facts = { tea: fact(), hotpot: fact() };
    const { directory, cycle } = await monitorsFor(facts);
    const probes = {
      api: { ok: true },
      customer: { ok: false, failingForMs: 3 * MIN },
      merchant: { ok: true },
    };
    const window = {
      startedAt: new Date(T0).toISOString(),
      expiresAt: new Date(T0 + 15 * MIN).toISOString(),
    };
    // Held during the planned window, with the window on each board.
    await cycle(0, { probes, maintenance: window });
    await cycle(3, { probes, maintenance: window });
    for (const name of ["tea", "hotpot"]) {
      const board = await boardOf(directory, name);
      expect(board.active).toEqual([]);
      expect(board.maintenance).toEqual(window);
    }
    // Still failing once it ends: raised at once, in words a restaurant can act on.
    await cycle(4, { probes });
    for (const name of ["tea", "hotpot"]) {
      const board = await boardOf(directory, name);
      expect(keysOf(board)).toEqual(["entry.customer"]);
      expect(board.active[0].action).toContain("your own POS or on paper");
      expect(board.active[0].action).toContain("card machine");
      expect(board.active[0].action).not.toContain("store outage procedure");
      expect(board.maintenance).toBe(null);
    }
  });
  it("only that Store's background work appears, named in plain words", async () => {
    const facts = { tea: fact(), "tea-2": fact(), hotpot: fact(), refused: fact() };
    const { directory, cycle } = await monitorsFor(facts);
    const supervisor = {
      ...healthySupervisor,
      attention: [
        "business-worker:events",
        "kitchen-queue-worker",
        "stores/hotpot:business-worker:paymentWait",
        "stores/refused",
        "stores/tea-2:daily-settlement-worker",
      ],
    };
    for (const minute of HELD_FIVE_MINUTES) await cycle(minute, { supervisor });
    expect((await boardOf(directory, "tea")).active).toEqual([]);
    const hotpot = await boardOf(directory, "hotpot");
    expect(keysOf(hotpot)).toEqual(["service.attention"]);
    expect(hotpot.active[0].summary).toBe(
      "Order processing (waiting for payment results) has kept failing and will not fix itself.",
    );
    expect(hotpot.active[0].action).toBe(
      "Some background work has stopped. Check Orders and Exceptions for waiting work; BOP support has to restart it.",
    );
    expect((await boardOf(directory, "tea-2")).active[0].summary).toContain("Day-end settlement");
    // A whole Store: its workers aren't running, and the board says so rather than "all good".
    expect((await boardOf(directory, "refused")).active[0].summary).toBe(
      "Background work has kept failing and will not fix itself.",
    );
  });
  it("the shared worker process needing a person shows on every board, and BOP hears it once", async () => {
    const facts = { tea: fact(), hotpot: fact() };
    const { directory, cycle, monitors } = await monitorsFor(facts);
    for (const minute of HELD_FIVE_MINUTES)
      await cycle(minute, {
        supervisor: {
          ...healthySupervisor,
          attention: ["store-workers", "stores/hotpot", "stores/tea"],
        },
      });
    for (const name of ["tea", "hotpot"])
      expect((await boardOf(directory, name)).active[0].summary).toBe(
        "Background work has kept failing and will not fix itself.",
      );
    expect(monitors.pending()).toEqual([]);
    // Nor is it named Store by Store on the root board: the root says "the other Stores" itself.
    expect(monitors.summary(T0 + 5 * MIN).background).toEqual([]);
  });
  it("a supervisor that stopped reporting clears nothing and is not told to the merchant as all good", async () => {
    const { directory, cycle } = await monitorsFor({ hotpot: fact() });
    const attention = {
      ...healthySupervisor,
      attention: ["stores/hotpot:business-worker:events"],
    };
    for (const minute of HELD_FIVE_MINUTES) await cycle(minute, { supervisor: attention });
    for (const minute of [6, 8, 10, 12]) await cycle(minute, { supervisor: null });
    expect(keysOf(await boardOf(directory, "hotpot"))).toEqual([
      "monitor.source",
      "service.attention",
    ]);
  });
  it("a planned update stopping the supervisor is no failed check, and clears nothing", async () => {
    const { directory, cycle } = await monitorsFor({ hotpot: fact() });
    const attention = {
      ...healthySupervisor,
      attention: ["stores/hotpot:business-worker:events"],
    };
    for (const minute of HELD_FIVE_MINUTES) await cycle(minute, { supervisor: attention });
    const window = {
      startedAt: new Date(T0 + 6 * MIN).toISOString(),
      expiresAt: new Date(T0 + 21 * MIN).toISOString(),
    };
    for (const minute of [6, 8, 10, 12, 14, 16])
      await cycle(minute, { supervisor: null, maintenance: window });
    expect(keysOf(await boardOf(directory, "hotpot"))).toEqual(["service.attention"]);
  });
  it("carries the support contact the operator configured", async () => {
    const support = { phone: "+14165550100", testOnly: true };
    const { directory, cycle } = await monitorsFor({ tea: fact() });
    await cycle(0, { config: { ...config, support } });
    expect((await boardOf(directory, "tea")).support).toEqual(support);
    await cycle(1);
    expect(await boardOf(directory, "tea")).not.toHaveProperty("support");
  });
});

// AGENTS.md "Warn before timeouts": the renewal is BOP's, but staff must not learn from guests.
describe("a merchant hears before ordering stops", () => {
  const inHours = (hours) => new Date(T0 + hours * 3600_000).toISOString();
  const orderingEnding = (board) => board.active.find((item) => item.key === "ordering.ending");
  const renew = (directory, name, validUntil) =>
    fs.writeFile(
      path.join(directory, "stores", name, "internal-test-profile.json"),
      JSON.stringify({ binding: { validUntil } }),
    );
  it("25 hours left is only BOP's, 23 hours left is on the merchant's board", async () => {
    const early = await monitorsFor({ tea: fact() }, { validUntil: inHours(25) });
    await early.cycle(0);
    expect(keysOf(await boardOf(early.directory, "tea"))).toEqual(["installation.validity"]);
    const late = await monitorsFor({ tea: fact() }, { validUntil: inHours(23) });
    await late.cycle(0);
    const board = await boardOf(late.directory, "tea");
    expect(keysOf(board)).toEqual(["installation.validity", "ordering.ending"]);
    expect(orderingEnding(board).severity).toBe("critical");
    expect(orderingEnding(board).action).toBe(
      "Ordering at this Store stops in 23 hours unless BOP support renews it. Call BOP support now. If it stops, keep taking orders on your own POS or on paper, and take payment on the card machine.",
    );
    // BOP has been told since two weeks out: this row is for the merchant and sends nothing more.
    expect(late.monitors.pending().map((item) => item.key)).toEqual(["installation.validity"]);
  });
  it("counts down, and clears once BOP renews", async () => {
    const { directory, cycle } = await monitorsFor({ tea: fact() }, { validUntil: inHours(1) });
    await cycle(0);
    expect(orderingEnding(await boardOf(directory, "tea")).action).toContain("stops in 1 hour ");
    await cycle(50);
    expect(orderingEnding(await boardOf(directory, "tea")).action).toContain("stops in 10 minutes");
    await renew(directory, "tea", inHours(24 * 30));
    await cycle(51);
    await cycle(53);
    expect((await boardOf(directory, "tea")).active).toEqual([]);
    expect((await boardOf(directory, "tea")).recentlyCleared.map((item) => item.title)).toEqual([
      "The store's ordering setup expires soon",
      "Ordering at this Store is about to stop",
    ]);
  });
  it("past the end it says ordering has stopped", async () => {
    const { directory, cycle } = await monitorsFor({ tea: fact() }, { validUntil: inHours(-1) });
    await cycle(0);
    const row = orderingEnding(await boardOf(directory, "tea"));
    expect(row.title).toBe("Ordering at this Store has stopped");
    expect(row.action).toBe(
      "Call BOP support now. Keep taking orders on your own POS or on paper, and take payment on the card machine.",
    );
  });
  it("the certificate is covered the same way, from what the root cycle saw", async () => {
    const { directory, cycle } = await monitorsFor({ tea: fact(), hotpot: fact() });
    await cycle(0, { certificate: { validTo: inHours(25) } });
    expect((await boardOf(directory, "tea")).active).toEqual([]);
    await cycle(1, { certificate: { validTo: inHours(23) } });
    for (const name of ["tea", "hotpot"]) {
      const board = await boardOf(directory, name);
      expect(keysOf(board)).toEqual(["ordering.ending"]);
      expect(orderingEnding(board).action).toContain("stops in 22 hours");
    }
  });
  it("a profile that can no longer be read does not take the warning away", async () => {
    const { directory, cycle } = await monitorsFor({ tea: fact() }, { validUntil: inHours(5) });
    await cycle(0);
    await fs.rm(path.join(directory, "stores", "tea", "internal-test-profile.json"));
    for (const minute of [60, 62, 64]) await cycle(minute);
    expect(orderingEnding(await boardOf(directory, "tea")).action).toContain("stops in 3 hours");
  });
});

/** The whole monitor: the root cycle, its channels, and the Stores beside it. */
function rootCycle({
  directory,
  monitors,
  send,
  probe = async () => ({ ok: true }),
  supervisor = () => healthySupervisor,
  configured = config,
}) {
  let state = { schemaVersion: 1, alert: emptyAlertState(), probes: {}, channels: {} };
  const boards = [];
  const io = {
    observeProbes: async (previous, now) =>
      observeProbes(previous, now, {
        targets: { api: { url: "a" }, customer: { url: "c" }, merchant: { url: "m" } },
        probe,
      }),
    observeSupervisor: async () => supervisor(),
    observeBusiness: async () => ({
      stuckUpdates: { count: 0, oldestAgeMs: 0 },
      retryingUpdates: { count: 0, oldestAgeMs: 0 },
      reconciliationDifferences: { count: 0, oldestAgeMs: 0 },
      settlementExceptions: { count: 0, oldestAgeMs: 0 },
    }),
    observeBackup: async () => ({ lastSuccessAt: new Date(T0).toISOString() }),
    observeCertificate: async () => ({ validTo: "2027-12-01T00:00:00.000Z" }),
    observeDisks: async () => [],
    channels: [{ id: "email", kind: "email", send }],
    log: async () => undefined,
    writeState: async () => undefined,
    writeBoard: async (value) => boards.push(value),
    stores: monitors,
    onCycle: (cycle) => {
      io.run = monitors.run({ ...cycle, config: configured });
    },
  };
  return {
    directory,
    boards,
    run: async (minute) => {
      state = await runMonitorCycle({ now: T0 + minute * MIN, state, config: configured, io });
      // As in the real loop the Stores finish beside the cycle; the next cycle sends their items.
      await io.run;
      return state;
    },
  };
}

describe("BOP hears one clear message", () => {
  it("one outage gives one message, from the root, however many Stores it touches", async () => {
    const facts = Object.fromEntries(
      ["tea", "hotpot", "dessert", "demo-2", "merchant-2", "demo-3"].map((name) => [name, fact()]),
    );
    const { directory, monitors } = await monitorsFor(facts);
    const send = vi.fn(async () => undefined);
    const root = rootCycle({
      directory,
      monitors,
      send,
      probe: async (target) => ({ ok: target.url === "m" }),
    });
    for (const minute of [0, 1, 2, 3, 4]) await root.run(minute);
    // API and customer entries down: two alerts of one outage, in one message, from the root.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].subject).toBe("Main St: 2 problems (urgent)");
    expect(send.mock.calls[0][0].text).not.toMatch(/tea|hotpot|dessert/u);
    // Every Store's own board shows it.
    for (const name of Object.keys(facts))
      expect(keysOf(await boardOf(directory, name))).toEqual(["entry.api", "entry.customer"]);
  });
  it("a cycle's Store problems go out as one message, each line naming its Store", async () => {
    const facts = { tea: fact({ dead: 1 }), hotpot: fact({ differences: 1 }), dessert: fact() };
    const { directory, monitors } = await monitorsFor(facts);
    const send = vi.fn(async () => undefined);
    const root = rootCycle({ directory, monitors, send });
    await root.run(0);
    await root.run(1);
    await root.run(2);
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0];
    expect(message.subject).toBe("Main St: 2 problems (urgent)");
    expect(message.text).toMatch(/^tea - Problem \(urgent\): Order or payment updates are stuck/mu);
    expect(message.text).toMatch(
      /^hotpot - Problem \(today\): Payment differences need checking/mu,
    );
    expect(message.text).not.toContain("dessert");
    // Sent once: nothing waits any more.
    expect(monitors.pending()).toEqual([]);
  });
  it("the hourly cap holds with six Stores failing, and they cannot hold back a site outage", async () => {
    const names = ["tea", "hotpot", "dessert", "demo-2", "merchant-2", "demo-3"];
    const facts = Object.fromEntries(names.map((name) => [name, fact({ dead: 1 })]));
    const { directory, monitors } = await monitorsFor(facts);
    const send = vi.fn(async () => undefined);
    let apiDown = false;
    const root = rootCycle({
      directory,
      monitors,
      send,
      probe: async (target) => ({ ok: !(apiDown && target.url === "a") }),
    });
    const minutes = async (from, to) => {
      for (let minute = from; minute <= to; minute += 1) {
        // Every Store flaps every 4 minutes, so each has something new to say all hour.
        for (const name of names) facts[name].dead = Math.floor(minute / 4) % 2 === 0 ? 1 : 0;
        apiDown = minute >= 30;
        await root.run(minute);
      }
    };
    // The Stores' routine alerts have the first four messages of the hour and no more.
    await minutes(0, 31);
    expect(send).toHaveBeenCalledTimes(4);
    // The entry has failed for two minutes: the message saying so leaves in that very cycle, and
    // takes along what the Stores were waiting to say.
    await minutes(32, 32);
    expect(send).toHaveBeenCalledTimes(5);
    const outage = send.mock.calls[4][0];
    expect(outage.severity).toBe("critical");
    expect(outage.text).toMatch(/^Problem \(urgent\): Store system is not responding/mu);
    expect(outage.text).toMatch(/^tea - /mu);
    // The hour's limit still holds, whatever else happens in it.
    await minutes(33, 59);
    expect(send.mock.calls.length).toBeLessThanOrEqual(6);
    // What waited is merged into the next message, not lost.
    expect(root.boards.length).toBe(60);
    const lastHour = send.mock.calls.map(([message]) => message.text).join("\n");
    for (const name of names) expect(lastHour).toContain(`${name} - `);
  });
  it("a restart loses nothing and repeats nothing that was already handed over", async () => {
    const facts = { tea: fact({ dead: 1 }) };
    const { directory, monitors, cycle } = await monitorsFor(facts);
    await cycle(0);
    expect(monitors.pending().map((item) => item.key)).toEqual(["payment.updates"]);
    // The monitor restarts before the root cycle could send it.
    const after = createStoreMonitors({
      runtimeDirectory: directory,
      load: businessOf(facts),
      log: async () => undefined,
      report: () => undefined,
      clock: () => 0,
    });
    expect(after.pending()).toEqual([]);
    const run = (minute) =>
      after.run({
        now: T0 + minute * MIN,
        probes: healthyProbes,
        supervisor: healthySupervisor,
        maintenance: null,
        config,
      });
    await run(1);
    const pending = after.pending();
    expect(pending.map((item) => item.key)).toEqual(["payment.updates"]);
    after.acknowledge(pending);
    expect(after.pending()).toEqual([]);
    await run(2);
    expect(after.pending()).toEqual([]);
    expect((await stateOf(directory, "tea", "alert-state.json")).unsent).toEqual([]);
  });
  it("names what only BOP can act on, on the root board", async () => {
    const facts = {
      tea: fact(),
      hotpot: fact({ covered: false, closedDay: true }),
      dessert: fact({ loadFails: true }),
    };
    const { directory, monitors } = await monitorsFor(facts, {
      validUntil: new Date(T0 + 10 * 86400_000).toISOString(),
    });
    const send = vi.fn(async () => undefined);
    const root = rootCycle({
      directory,
      monitors,
      send,
      supervisor: () => ({
        ...healthySupervisor,
        attention: ["stores/hotpot:business-worker:events"],
      }),
    });
    // A Store that cannot be written at all is noticed once its board is 5 minutes old.
    await fs.writeFile(path.join(directory, "stores", "tea", "ops"), "not a directory");
    for (let minute = 0; minute <= 7; minute += 1) await root.run(minute);
    const board = root.boards.at(-1);
    const unchecked = board.active.find((item) => item.key === "stores.unchecked");
    expect(unchecked.severity).toBe("critical");
    expect(unchecked.summary).toBe("Not being checked: tea.");
    const row = board.active.find((item) => item.key === "stores.attention");
    expect(row.severity).toBe("warning");
    expect(row.summary).toContain("Some checks could not run: dessert.");
    expect(row.summary).toContain("Background work needs a person: hotpot.");
    expect(row.summary).toContain("Closed business days with no day-end settlement: hotpot.");
    expect(row.summary).toContain("Ordering setup ending soon: hotpot, dessert.");
    expect(row.summary).toContain("No support number to call: tea, hotpot, dessert.");
    expect(row.summary.length).toBeLessThanOrEqual(600);
    // Each cause it names has its step.
    for (const step of [
      "find out why the checks named here are not running",
      "restart the background work named here",
      "record the first closed business day",
      "renew those named as ending soon",
      "set the support number",
    ])
      expect(row.action).toContain(step);
    // The Store's own work is not said again at the root, nameless.
    expect(board.active.map((item) => item.key)).not.toContain("service.attention");
    // Nothing of this on a merchant's own actions.
    const hotpot = await boardOf(directory, "hotpot");
    expect(keysOf(hotpot)).toEqual([
      "installation.validity",
      "service.attention",
      "settlement.not_covered",
    ]);
  });
  it("names no missing support number once one is set, and none for a site with no other Store", async () => {
    const { directory, monitors } = await monitorsFor({ tea: fact() });
    const support = { phone: "+14165550100", testOnly: true };
    const root = rootCycle({
      directory,
      monitors,
      send: async () => undefined,
      configured: { ...config, support },
    });
    await root.run(0);
    await root.run(1);
    expect(root.boards.at(-1).active).toEqual([]);
    expect(monitors.summary(T0 + MIN, { support }).noSupportNumber).toEqual([]);
    expect(monitors.summary(T0 + MIN, { support: null }).noSupportNumber).toEqual(["tea"]);
    // A single-Store site's monitor has no Store to list, so nothing is raised.
    const alone = (await monitorsFor({})).monitors;
    expect(alone.summary(T0, { support: null }).noSupportNumber).toEqual([]);
  });
  it("one Store's work failing on and off: one message for each change, naming it, and the site-down message still leaves at once", async () => {
    const facts = { tea: fact(), hotpot: fact() };
    const { directory, monitors } = await monitorsFor(facts);
    const sent = [];
    let current = 0;
    let flagged = false;
    let apiDown = false;
    const root = rootCycle({
      directory,
      monitors,
      send: async (message) => sent.push({ minute: current, ...message }),
      supervisor: () => ({
        ...healthySupervisor,
        attention: flagged ? ["stores/tea:business-worker:events"] : [],
      }),
      probe: async (target) => ({ ok: !(apiDown && target.url === "a") }),
    });
    for (current = 0; current <= 33; current += 1) {
      // Six minutes failing, three well, until minute 28. Then the whole site from minute 30.
      flagged = current < 28 && current % 9 < 6;
      apiDown = current >= 30;
      await root.run(current);
    }
    expect(sent.map((message) => [message.minute, message.subject])).toEqual([
      [6, "Main St · tea: URGENT - A background service needs a person"],
      [9, "Main St · tea: Resolved - A background service needs a person"],
      [15, "Main St · tea: URGENT - A background service needs a person"],
      [18, "Main St · tea: Resolved - A background service needs a person"],
      // The Stores' four are spent: its next change waits, and the outage does not.
      [32, "Main St: 2 problems (urgent)"],
    ]);
    const outage = sent.at(-1);
    expect(outage.text).toMatch(/^Problem \(urgent\): Store system is not responding/u);
    // What waited goes with it, each line naming its Store.
    expect(outage.text).toMatch(/^tea - Problem \(urgent\): A background service/mu);
    expect(outage.text).toMatch(/^tea - Resolved: A background service/mu);
    // The root board said it too while it lasted, by name, with no message of its own.
    expect(root.boards[6].active.find((item) => item.key === "stores.attention").summary).toContain(
      "Background work needs a person: tea.",
    );
  });
  it("BOP hears when a Store stops being checked and when that is over, however long the rest has been said", async () => {
    const facts = { tea: fact(), hotpot: fact() };
    const { directory, monitors } = await monitorsFor(facts);
    const send = vi.fn(async () => undefined);
    // No support number: the rest of the roll-up stays up all along, and sends nothing.
    const root = rootCycle({ directory, monitors, send });
    const ops = path.join(directory, "stores", "tea", "ops");
    await fs.writeFile(ops, "not a directory");
    for (let minute = 0; minute <= 5; minute += 1) await root.run(minute);
    expect(send).not.toHaveBeenCalled();
    // Older than the Home's limit: no Store can say this for itself.
    await root.run(6);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].subject).toBe(
      "Main St: URGENT - Some Stores are not being checked",
    );
    await fs.rm(ops);
    for (let minute = 7; minute <= 10; minute += 1) await root.run(minute);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].subject).toBe(
      "Main St: Resolved - Some Stores are not being checked",
    );
    // Another Store, later the same hour: told again, not lost in a row that never cleared.
    const other = path.join(directory, "stores", "hotpot", "ops");
    await fs.rm(other, { recursive: true });
    await fs.writeFile(other, "not a directory");
    for (let minute = 11; minute <= 17; minute += 1) await root.run(minute);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][0].subject).toBe(
      "Main St: URGENT - Some Stores are not being checked",
    );
  });
  it("calls a Store unchecked only once its board is older than the Home's limit", async () => {
    const { monitors, cycle } = await monitorsFor({ tea: fact() });
    await cycle(0);
    expect(monitors.summary(T0 + STORE_BOARD_STALE_MS).unchecked).toEqual([]);
    expect(monitors.summary(T0 + STORE_BOARD_STALE_MS + 1).unchecked).toEqual(["tea"]);
  });
});

describe("the status command", () => {
  it("prints each Store's keys, severities and instants only", async () => {
    const facts = { tea: fact({ dead: 1 }), hotpot: fact(), never: fact() };
    const { directory, write, cycle } = await monitorsFor(facts);
    await write(["tea", "hotpot"]);
    await cycle(0);
    await write(["tea", "hotpot", "never"]);
    const status = await readStoresStatus(directory);
    expect(status).toEqual({
      tea: {
        observedAt: new Date(T0).toISOString(),
        active: [
          {
            key: "payment.updates",
            severity: "critical",
            raisedAt: new Date(T0).toISOString(),
          },
        ],
      },
      hotpot: { observedAt: new Date(T0).toISOString(), active: [] },
      never: { monitor: "NotRunning" },
    });
    expect(await readStoresStatus(directory, async () => [])).toEqual({});
  });
});
