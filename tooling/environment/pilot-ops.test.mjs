import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyAlertState } from "./pilot-alerts.mjs";
import { parsePilotOpsConfig } from "./pilot-ops-config.mjs";
import { runMonitorCycle } from "./pilot-ops.mjs";
import {
  createBusinessObserver,
  observeDisks,
  observeInstallationValidity,
  observeProbes,
  observeSupervisor,
  readBusinessSignals,
} from "./pilot-ops-observe.mjs";
import { createPilotSupervisorHealthWriter } from "./pilot-supervisor.mjs";

const T0 = Date.parse("2026-10-15T03:00:00.000Z");
const MIN = 60_000;
const config = parsePilotOpsConfig({ schemaVersion: 1, siteLabel: "Main St" }, ".local/pilot-test");

function fakeIo({ apiUp = () => true, channels = [] } = {}) {
  const io = {
    boards: [],
    states: [],
    logs: [],
    observeProbes: async (previous, now) =>
      observeProbes(previous, now, {
        targets: { api: {}, customer: {}, merchant: {} },
        probe: async (_target) => ({ ok: _target === undefined ? true : apiUp(now) }),
      }),
    observeSupervisor: async () => ({ maintenance: false, reportAgeMs: 1000, attention: [] }),
    observeBusiness: async () => ({
      stuckUpdates: { count: 0, oldestAgeMs: 0 },
      retryingUpdates: { count: 0, oldestAgeMs: 0 },
      reconciliationDifferences: { count: 0, oldestAgeMs: 0 },
      settlementExceptions: { count: 0, oldestAgeMs: 0 },
    }),
    observeBackup: async () => ({ lastSuccessAt: new Date(T0 - 3600_000).toISOString() }),
    observeCertificate: async () => ({ validTo: "2026-12-01T00:00:00.000Z" }),
    observeDisks: async () => [],
    channels,
    log: async (entry) => io.logs.push(entry),
    writeState: async (value) => io.states.push(value),
    writeBoard: async (value) => io.boards.push(value),
  };
  return io;
}
const fresh = () => ({ schemaVersion: 1, alert: emptyAlertState(), probes: {}, channels: {} });

describe("WP-2423 Q13 monitor cycle", () => {
  it("WP-2423 item 9: names what refused and the rule in BOP's log, and only there", async () => {
    const sent = [];
    const channel = { id: "email", kind: "email", send: vi.fn(async (m) => sent.push(m)) };
    const io = fakeIo({ apiUp: () => true, channels: [channel] });
    const observeBusiness = io.observeBusiness;
    io.observeBusiness = async () => ({
      ...(await observeBusiness()),
      workflow: {
        ready: false,
        refusals: [
          { binding: "Pickup", rule: "TwoBrandVersions" },
          { binding: "DineIn", rule: "TwoBrandVersions" },
          { binding: "Cancellation", rule: "TwoBrandVersions" },
        ],
        orderTypes: ["DineIn", "Pickup"],
      },
    });
    const config = parsePilotOpsConfig(null, ".local/pilot-test");
    let state = fresh();
    for (const m of [0, 1, 2, 3])
      state = await runMonitorCycle({ now: T0 + m * MIN, state, config, io });
    const raised = io.logs.filter((line) => line.event === "alert_raised");
    expect(raised).toEqual([
      {
        event: "alert_raised",
        key: "orders.workflow",
        severity: "critical",
        refused: "Pickup:TwoBrandVersions DineIn:TwoBrandVersions",
      },
      {
        event: "alert_raised",
        key: "orders.unpaid_rounds",
        severity: "critical",
        refused: "Cancellation:TwoBrandVersions",
      },
    ]);
    expect(JSON.stringify(io.boards.at(-1))).not.toContain("TwoBrandVersions");
    expect(
      io.boards
        .at(-1)
        .active.map(({ key }) => key)
        .sort(),
    ).toEqual(["orders.unpaid_rounds", "orders.workflow"]);
    expect(JSON.stringify(sent)).not.toContain("TwoBrandVersions");
  });
  it("WP-2423 item 9: an order rules check that times out never tells the owner it passes", async () => {
    const sent = [];
    const channel = { id: "email", kind: "email", send: vi.fn(async (m) => sent.push(m)) };
    const io = fakeIo({ channels: [channel] });
    const observeBusiness = io.observeBusiness;
    let workflow = {
      ready: false,
      refusals: [{ binding: "Pickup", rule: "TwoBrandVersions" }],
      orderTypes: ["DineIn", "Pickup"],
    };
    io.observeBusiness = async () => ({ ...(await observeBusiness()), workflow });
    let state = fresh();
    for (const m of [0, 1, 2, 3])
      state = await runMonitorCycle({ now: T0 + m * MIN, state, config, io });
    workflow = "unreadable";
    for (const m of [4, 5, 6, 7, 8])
      state = await runMonitorCycle({ now: T0 + m * MIN, state, config, io });
    expect(io.logs.filter((line) => line.event === "alert_cleared")).toEqual([]);
    expect(JSON.stringify(sent)).not.toContain("passes again");
    expect(io.boards.at(-1).active.map(({ key }) => key)).toContain("orders.workflow");
    expect(io.boards.at(-1).recentlyCleared).toEqual([]);
  });
  it("WP-2423 item 9: the wait-for-BOP line goes when the planned update BOP fixed it in ends", async () => {
    const io = fakeIo();
    const observeBusiness = io.observeBusiness;
    let workflow = {
      ready: false,
      refusals: [{ binding: "Pickup", rule: "TwoBrandVersions" }],
      orderTypes: ["DineIn", "Pickup"],
    };
    io.observeBusiness = async () => ({ ...(await observeBusiness()), workflow });
    let marker = null;
    io.observeMaintenance = async () => marker;
    let state = fresh();
    for (const m of [0, 1, 2])
      state = await runMonitorCycle({ now: T0 + m * MIN, state, config, io });
    marker = {
      schemaVersion: 1,
      startedAt: new Date(T0 + 3 * MIN).toISOString(),
      expiresAt: new Date(T0 + 15 * MIN).toISOString(),
    };
    workflow = { ready: true, refusals: [], orderTypes: ["DineIn", "Pickup"] };
    for (const m of [3, 4, 5, 6])
      state = await runMonitorCycle({ now: T0 + m * MIN, state, config, io });
    expect(io.boards.at(-1).maintenance).not.toBeNull();
    expect(io.boards.at(-1).recentlyCleared.map(({ key }) => key)).toEqual(["orders.workflow"]);
    marker = null;
    await runMonitorCycle({ now: T0 + 7 * MIN, state, config, io });
    expect(io.boards.at(-1).recentlyCleared).toEqual([]);
  });
  it("raises a down entry once on each channel, survives a restart without re-sending and clears", async () => {
    let down = true;
    const sent = [];
    const channel = {
      id: "email",
      kind: "email",
      send: vi.fn(async (message) => sent.push(message)),
    };
    const io = fakeIo({ apiUp: () => !down, channels: [channel] });
    io.observeProbes = async (previous, now) =>
      observeProbes(previous, now, {
        targets: { api: { url: "a" }, customer: { url: "c" }, merchant: { url: "m" } },
        probe: async (target) => ({ ok: target.url !== "a" || !down }),
      });
    let state = fresh();
    for (const m of [0, 1, 2, 3])
      state = await runMonitorCycle({ now: T0 + m * MIN, state, config, io });
    expect(sent.map((m) => m.subject)).toEqual([
      "Main St: URGENT - Store system is not responding",
    ]);
    expect(io.boards.at(-1).active.map((a) => a.key)).toEqual(["entry.api"]);
    // Restart: the persisted state (as JSON) carries on without a second message.
    state = JSON.parse(JSON.stringify(state));
    state = await runMonitorCycle({ now: T0 + 4 * MIN, state, config, io });
    expect(sent).toHaveLength(1);
    down = false;
    for (const m of [5, 6, 7])
      state = await runMonitorCycle({ now: T0 + m * MIN, state, config, io });
    expect(sent.map((m) => m.subject).at(-1)).toBe(
      "Main St: Resolved - Store system is not responding",
    );
    expect(io.boards.at(-1).active).toEqual([]);
    expect(io.boards.at(-1).recentlyCleared.map((c) => c.key)).toEqual(["entry.api"]);
    expect(io.logs.filter((l) => l.event.startsWith("alert_")).map((l) => l.event)).toEqual([
      "alert_raised",
      "alert_delivered",
      "alert_cleared",
      "alert_delivered",
    ]);
  });
  it("keeps undelivered alerts for the next cycle and raises its own alert when a channel keeps failing", async () => {
    const channel = {
      id: "webhook-1",
      kind: "webhook",
      send: vi.fn(async () => {
        throw Error("PILOT_ALERT_WEBHOOK_REJECTED");
      }),
    };
    const io = fakeIo({ channels: [channel] });
    io.observeBackup = async () => ({ lastSuccessAt: null });
    let state = fresh();
    for (let m = 0; m <= 31; m++)
      state = await runMonitorCycle({ now: T0 + m * MIN, state, config, io });
    expect(state.channels["webhook-1"].pending.length).toBeGreaterThan(0);
    expect(
      io.boards
        .at(-1)
        .active.map((a) => a.key)
        .sort(),
    ).toEqual(["backup.stale", "channel.delivery"]);
    expect(io.logs.some((l) => l.code === "PILOT_ALERT_WEBHOOK_REJECTED")).toBe(true);
    // Failed attempts count toward the hourly cap too: six attempts, not one a minute.
    expect(channel.send).toHaveBeenCalledTimes(6);
  });
  it("DEC-PILOT-ALERTS-BACKUP correction 2: tells the other Stores what it saw, without waiting for them, and its own results are unchanged", async () => {
    const run = async (extra) => {
      const io = fakeIo({ apiUp: () => false });
      io.observeSupervisor = async () => ({
        maintenance: false,
        reportAgeMs: 1000,
        attention: ["stores/tea:business-worker:events"],
      });
      Object.assign(io, extra);
      let state = fresh();
      for (const m of [0, 1, 2])
        state = await runMonitorCycle({ now: T0 + m * MIN, state, config, io });
      return { state, board: io.boards.at(-1), logs: io.logs };
    };
    const seen = [];
    let finished = false;
    const beside = await run({
      // The Stores' run takes as long as it takes: the cycle does not wait for it.
      onCycle: (cycle) => {
        seen.push(cycle);
        globalThis.setTimeout(() => {
          finished = true;
        }, 200);
      },
      observeMaintenance: async () => null,
    });
    expect(finished).toBe(false);
    expect(seen).toHaveLength(3);
    expect(seen[2]).toEqual({
      now: T0 + 2 * MIN,
      probes: {
        api: { ok: false, failingForMs: 2 * MIN },
        customer: { ok: false, failingForMs: 2 * MIN },
        merchant: { ok: false, failingForMs: 2 * MIN },
      },
      supervisor: {
        maintenance: false,
        reportAgeMs: 1000,
        attention: ["stores/tea:business-worker:events"],
      },
      certificate: { validTo: "2026-12-01T00:00:00.000Z" },
      maintenance: null,
    });
    // With no other Store composed, the very same state, board and log lines.
    const alone = await run({});
    expect(beside.state).toEqual(alone.state);
    expect(beside.board).toEqual(alone.board);
    expect(beside.logs).toEqual(alone.logs);
    expect(alone.board.active.map((item) => item.key)).toContain("service.attention");
    expect(alone.board).not.toHaveProperty("support");
  });
  it("DEC-PILOT-ALERTS-BACKUP correction 2: writes the support contact on its own board, and an empty Store summary raises nothing", async () => {
    const io = fakeIo();
    io.stores = {
      summary: () => ({
        unchecked: [],
        checksFailing: [],
        settlementNotCovered: [],
        setupEnding: [],
      }),
      pending: () => [],
      acknowledge: () => undefined,
    };
    const support = { phone: "+14165550100", testOnly: false };
    await runMonitorCycle({ now: T0, state: fresh(), config: { ...config, support }, io });
    expect(io.boards.at(-1).support).toEqual(support);
    expect(io.boards.at(-1).active).toEqual([]);
  });
  it("WP-2423: an order pricing problem raises while settlement is clean (it was left out of the reused answer)", async () => {
    let cycles = 0;
    const resources = {
      scope: { brandReference: "b", storeReference: "s" },
      transactions: { run: async (work) => work({ query: async () => ({ rows: [] }) }) },
      database: {
        transactions: () => ({
          run: async (work) => work({ query: async () => ({ rows: [] }) }),
        }),
      },
    };
    const observeBusiness = createBusinessObserver({
      runtimeDirectory: ".local/pilot-test",
      load: async () => ({
        resources,
        installation: {},
        dependencies: {
          createReconciliationExceptions: () => async () => ({
            items: [],
            nextAfterExceptionReference: null,
          }),
          // Every day settled: the settlement scan is reused for 5 minutes.
          readSettlementStatus: async () => ({ days: [] }),
          readQuoteTaxConfiguration: async () => {
            cycles += 1;
            return { ready: false, reason: "TaxConfigurationMismatch" };
          },
        },
      }),
    });
    const io = fakeIo();
    io.observeBusiness = observeBusiness;
    let state = fresh();
    for (const m of [0, 1, 2])
      state = await runMonitorCycle({ now: T0 + m * MIN, state, config, io });
    expect(cycles).toBe(3);
    expect(io.boards.at(-1).active.map((item) => item.key)).toEqual(["pricing.tax_configuration"]);
  });
});

describe("WP-2423 Q13 observations", () => {
  const servers = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });
  it("probes over HTTP and tracks since when an entry fails", async () => {
    const server = http.createServer((req, res) => {
      res.statusCode = req.url === "/ready" ? 200 : 503;
      res.end();
    });
    servers.push(server);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const targets = { api: { url: `${base}/ready` }, customer: { url: `${base}/down` } };
    const first = await observeProbes({}, T0, { targets });
    expect(first.probes.api).toEqual({ ok: true });
    expect(first.probes.customer).toEqual({ ok: false, failingForMs: 0 });
    const second = await observeProbes(first.failingSince, T0 + 3 * MIN, { targets });
    expect(second.probes.customer.failingForMs).toBe(3 * MIN);
  });
  it("reads the supervisor report written by the supervisor, and maintenance as quiet", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ops-sup-"));
    await fs.chmod(dir, 0o700);
    const writes = [];
    const write = createPilotSupervisorHealthWriter(".local/pilot-test", async (file, value) => {
      writes.push(file);
      await fs.writeFile(path.join(dir, "supervisor.health.json"), JSON.stringify(value), {
        mode: 0o600,
      });
    });
    await write({
      observedAt: new Date(T0).toISOString(),
      services: [
        { service: "api", state: "running", pid: 10 },
        { service: "business-worker", state: "running", pid: 11, attention: ["paymentWait"] },
        { service: "kitchen-queue-worker", state: "attention_required" },
      ],
    });
    expect(writes).toEqual([".local/pilot-test/supervisor.health.json"]);
    const saved = JSON.parse(await fs.readFile(path.join(dir, "supervisor.health.json"), "utf8"));
    expect(JSON.stringify(saved)).not.toContain("pid");
    expect(await observeSupervisor(dir, T0 + 30_000)).toEqual({
      maintenance: false,
      reportAgeMs: 30_000,
      attention: ["business-worker:paymentWait", "kitchen-queue-worker"],
    });
    await fs.writeFile(path.join(dir, "maintenance.lock"), "");
    expect((await observeSupervisor(dir, T0)).maintenance).toBe(true);
    await fs.rm(dir, { recursive: true });
    expect(await observeSupervisor(path.join(dir, "gone"), T0)).toBe(null);
  });
  it("reports disk space, and a failing statfs as unreadable", async () => {
    expect(
      await observeDisks({ runtime: "/a", offsite: null }, async () => ({
        bavail: 10n,
        bsize: 4096,
        blocks: 100n,
      })),
    ).toEqual([{ name: "runtime", freeBytes: 40960, totalBytes: 409600 }]);
    expect(
      await observeDisks({ runtime: "/a" }, async () => {
        throw Error("x");
      }),
    ).toBe("unreadable");
  });
  it("summarises stuck updates, open differences and settlement problems as counts and ages only", async () => {
    const now = Date.parse("2026-10-15T16:00:00.000Z");
    // Each scope answers by statement: dead letters, consumer retries, outbox events.
    const queries = [];
    const run = (answers) => ({
      run: async (work) =>
        work({
          query: async (sql, parameters) => {
            queries.push([sql, parameters]);
            if (sql.includes("dead_letter_item")) return { rows: answers.dead };
            if (sql.includes("consumer_retry_schedule")) return { rows: answers.consumer };
            if (sql.includes("outbox_event")) return { rows: answers.outbox };
            throw Error("unexpected query");
          },
        }),
    });
    const resources = {
      scope: { brandReference: "b", storeReference: "s" },
      transactions: run({
        dead: [{ count: 2, oldest: new Date("2026-10-15T15:00:00.000Z") }],
        // Store retry first failed at 15:40 (deadline = first failure + 24 h).
        consumer: [{ count: 1, oldest_deadline: new Date("2026-10-16T15:40:00.000Z") }],
        outbox: [{ count: 1, oldest: new Date("2026-10-15T15:45:00.000Z") }],
      }),
      database: {
        transactions: (scope) => (
          expect(scope).toEqual({ brandId: "b" }),
          run({
            dead: [{ count: 1, oldest: null }],
            consumer: [{ count: 0, oldest_deadline: null }],
            outbox: [{ count: 99, oldest: new Date("2026-10-01T00:00:00.000Z") }],
          })
        ),
      },
    };
    const pages = [
      {
        items: [
          { state: "Open", openedAt: "2026-10-14T16:00:00.000Z" },
          { state: "Closed", openedAt: "2026-10-01T00:00:00.000Z" },
        ],
        nextAfterExceptionReference: "x",
      },
      {
        items: [{ state: "Open", openedAt: "2026-10-15T10:00:00.000Z" }],
        nextAfterExceptionReference: null,
      },
    ];
    const value = await readBusinessSignals({
      resources,
      installation: {},
      now,
      dependencies: {
        createReconciliationExceptions: () => async () => pages.shift(),
        readSettlementStatus: async () => ({
          days: [
            { state: "Missing", endsAt: "2026-10-15T08:00:00.000Z", outcome: null },
            { state: "Missing", endsAt: "2026-10-15T14:00:00.000Z", outcome: null },
            { state: "Recorded", endsAt: "2026-10-14T08:00:00.000Z", outcome: "Difference" },
            { state: "Recorded", endsAt: "2026-10-13T08:00:00.000Z", outcome: "Matched" },
          ],
        }),
      },
    });
    expect(value).toEqual({
      stuckUpdates: { count: 3, oldestAgeMs: 3600_000 },
      // WP-2423: retries still running (4 tries or failing 10+ minutes), oldest failing 20 minutes.
      retryingUpdates: { count: 2, oldestAgeMs: 20 * 60_000 },
      // No receipt template check composed: not checked (never reported as fine or failing).
      receiptTemplate: null,
      // No order pricing check composed: not checked.
      quoteTax: null,
      // No order rules check composed: not checked.
      workflow: null,
      // No held-stock check composed: not checked.
      heldStock: null,
      // No pickup time check composed: not checked.
      pickupCapacity: null,
      reconciliationDifferences: { count: 2, oldestAgeMs: 24 * 3600_000 },
      settlementExceptions: { count: 2, oldestAgeMs: 32 * 3600_000 },
    });
    // The outbox is read in the Store scope only (Brand-wide events are visible there too).
    expect(queries.filter(([sql]) => sql.includes("outbox_event"))).toEqual([
      [expect.any(String), [4, "2026-10-15T15:50:00.000Z"]],
    ]);
    expect(queries.filter(([sql]) => sql.includes("consumer_retry_schedule"))).toEqual([
      [expect.any(String), [4, "2026-10-16T15:50:00.000Z"]],
      [expect.any(String), [4, "2026-10-16T15:50:00.000Z"]],
    ]);
  });
  it("WP-2423 item 9: reports whether orders can move through the Store's Workflows, on every read", async () => {
    const now = Date.parse("2026-10-15T16:00:00.000Z");
    const empty = { run: async (work) => work({ query: async () => ({ rows: [] }) }) };
    const resources = {
      scope: { brandReference: "b", storeReference: "s" },
      transactions: empty,
      database: { transactions: () => empty },
    };
    const read = (readWorkflowReadiness, settlementExceptions) =>
      readBusinessSignals({
        resources,
        installation: {},
        now,
        settlementExceptions,
        dependencies: {
          createReconciliationExceptions: () => async () => ({
            items: [],
            nextAfterExceptionReference: null,
          }),
          readSettlementStatus: async () => ({ days: [] }),
          readWorkflowReadiness,
        },
      });
    const clean = { count: 0, oldestAgeMs: 0 };
    const orderTypes = ["DineIn"];
    for (const settlement of [clean, null]) {
      expect(
        (
          await read(async (r) => {
            expect(r).toBe(resources);
            return { ready: true };
          }, settlement)
        ).workflow,
      ).toEqual({ ready: true });
      for (const refusals of [
        [{ binding: "Pickup", rule: "NoBrandVersion" }],
        [{ binding: "AdditionalRelease", rule: "ExpectedVersionChanged" }],
        [
          { binding: "DineIn", rule: "TwoBrandVersions" },
          { binding: "Cancellation", rule: "BrandVersionNotActive" },
        ],
      ])
        expect(
          (await read(async () => ({ ready: false, refusals, orderTypes }), settlement)).workflow,
        ).toEqual({ ready: false, refusals, orderTypes });
      // Nothing installed yet: not checked, which is not the same as all good.
      expect((await read(async () => null, settlement)).workflow).toBeNull();
      expect(
        (
          await read(async () => {
            throw Error("PILOT_WORKFLOW_BINDING_UNAVAILABLE");
          }, settlement)
        ).workflow,
      ).toBe("unreadable");
    }
    // Only the closed shape goes on: anything else could not be checked, never all good.
    for (const answer of [
      undefined,
      {},
      { ready: false },
      { ready: false, refusals: [], orderTypes },
      { ready: false, refusals: [{ binding: "Pickup", rule: "NoBrandVersion" }] },
      { ready: false, refusals: [{ binding: "Sam", rule: "NoBrandVersion" }], orderTypes },
    ])
      expect((await read(async () => answer, clean)).workflow).toBe("unreadable");
    // Extra fields stop here.
    expect(
      (
        await read(
          async () => ({
            ready: false,
            refusals: [{ binding: "Pickup", rule: "NoBrandVersion", detail: "table 4" }],
            orderTypes,
            detail: "table 4",
          }),
          clean,
        )
      ).workflow,
    ).toEqual({
      ready: false,
      refusals: [{ binding: "Pickup", rule: "NoBrandVersion" }],
      orderTypes,
    });
  });
  it("WP-2423: reports whether a receipt can be issued with the Store's published template", async () => {
    const now = Date.parse("2026-10-15T16:00:00.000Z");
    const resources = {
      scope: { brandReference: "b", storeReference: "s" },
      transactions: { run: async (work) => work({ query: async () => ({ rows: [] }) }) },
      database: {
        transactions: () => ({
          run: async (work) => work({ query: async () => ({ rows: [] }) }),
        }),
      },
    };
    const read = (readReceiptTemplate) =>
      readBusinessSignals({
        resources,
        installation: {},
        now,
        settlementExceptions: { count: 0, oldestAgeMs: 0 },
        dependencies: {
          createReconciliationExceptions: () => async () => ({
            items: [],
            nextAfterExceptionReference: null,
          }),
          readReceiptTemplate,
        },
      });
    const ready = await read(async (r) => {
      expect(r).toBe(resources);
      return { ready: true, templateReference: "t", versionReference: "v", versionCode: "X" };
    });
    // Only the outcome leaves the check (no references).
    expect(ready.receiptTemplate).toEqual({ ready: true });
    expect(
      (await read(async () => ({ ready: false, reason: "TemplateNotProven" }))).receiptTemplate,
    ).toEqual({ ready: false, reason: "TemplateNotProven" });
    expect(
      (
        await read(async () => {
          throw Error("DIGITAL_RECEIPT_PERMISSION_DENIED");
        })
      ).receiptTemplate,
    ).toBe("unreadable");
  });
  it("WP-2423: reports orders of earlier days still holding stock (counts and age only)", async () => {
    const now = Date.parse("2026-10-16T06:00:00.000Z");
    const resources = {
      scope: { brandReference: "b", storeReference: "s" },
      transactions: { run: async (work) => work({ query: async () => ({ rows: [] }) }) },
      database: {
        transactions: () => ({
          run: async (work) => work({ query: async () => ({ rows: [] }) }),
        }),
      },
    };
    const read = (readHeldStockOrders) =>
      readBusinessSignals({
        resources,
        installation: {},
        now,
        settlementExceptions: { count: 0, oldestAgeMs: 0 },
        dependencies: {
          createReconciliationExceptions: () => async () => ({
            items: [],
            nextAfterExceptionReference: null,
          }),
          readHeldStockOrders,
        },
      });
    expect(
      (
        await read(async () => ({
          openCount: 10,
          endedCount: 1,
          oldestAt: "2026-10-15T06:00:00.000Z",
        }))
      ).heldStock,
    ).toEqual({ count: 11, openCount: 10, oldestAgeMs: 24 * 3600_000 });
    expect(
      (
        await read(async () => {
          throw Error("MERCHANT_BUSINESS_DAY_WINDOW_UNAVAILABLE");
        })
      ).heldStock,
    ).toBe("unreadable");
    const horizon = (readPickupCapacityHorizon) =>
      readBusinessSignals({
        resources,
        installation: {},
        now,
        settlementExceptions: { count: 0, oldestAgeMs: 0 },
        dependencies: {
          createReconciliationExceptions: () => async () => ({
            items: [],
            nextAfterExceptionReference: null,
          }),
          readPickupCapacityHorizon,
        },
      });
    // DEC-PICKUP-CAPACITY-SCHEDULE: how far ahead pickup times are set up.
    expect((await horizon(async () => ({ coveredMs: 3_600_000 }))).pickupCapacity).toEqual({
      coveredMs: 3_600_000,
    });
    expect((await horizon(async () => ({ coveredMs: "soon" }))).pickupCapacity).toBe("unreadable");
    expect(
      (
        await horizon(async () => {
          throw Error("database");
        })
      ).pickupCapacity,
    ).toBe("unreadable");
  });
  it("reports business signals as unreadable when the database cannot be reached, and retries", async () => {
    const load = vi.fn(async () => {
      throw Error("LOCAL_DATABASE_UNAVAILABLE");
    });
    const report = vi.fn();
    const observe = createBusinessObserver({ runtimeDirectory: ".local/pilot-test", load, report });
    expect(await observe(T0)).toBe("unreadable");
    expect(await observe(T0 + MIN)).toBe("unreadable");
    expect(load).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[0][0].message).toBe("LOCAL_DATABASE_UNAVAILABLE");
  });
  it("DEC-PILOT-ALERTS-BACKUP correction 2: waits on a Store's readiness checks until its Owner has published, and reads no settlement it does not have", async () => {
    const now = Date.parse("2026-10-15T16:00:00.000Z");
    const resources = {
      scope: { brandReference: "b", storeReference: "s" },
      transactions: { run: async (work) => work({ query: async () => ({ rows: [] }) }) },
      database: {
        transactions: () => ({
          run: async (work) => work({ query: async () => ({ rows: [] }) }),
        }),
      },
    };
    const readiness = vi.fn(async () => ({ ready: false, reason: "TemplateNotProven" }));
    const read = (change) =>
      readBusinessSignals({
        resources,
        installation: {},
        now,
        dependencies: {
          createReconciliationExceptions: () => async () => ({
            items: [],
            nextAfterExceptionReference: null,
          }),
          readReceiptTemplate: readiness,
          readQuoteTaxConfiguration: readiness,
          readPickupCapacityHorizon: async () => ({ coveredMs: 0 }),
          readHeldStockOrders: async () => ({ openCount: 1, endedCount: 0, oldestAt: null }),
          readSettlementStatus: async () => {
            throw Error("DAILY_SETTLEMENT_COVERAGE_MISSING");
          },
          isSettlementCovered: async () => false,
          readClosedBusinessDay: async () => true,
          ...change,
        },
      });
    const before = await read({ readOwnerPublishedSetup: async () => false });
    expect(before).toMatchObject({
      receiptTemplate: null,
      quoteTax: null,
      pickupCapacity: null,
      // Stock held by real orders is real before and after opening.
      heldStock: { count: 1 },
      settlementExceptions: null,
      settlementCovered: false,
      closedBusinessDay: false,
    });
    expect(readiness).not.toHaveBeenCalled();
    // The gate itself could not be read: not checked is not fine, and not a guess that it failed.
    const unknown = await read({
      readOwnerPublishedSetup: async () => {
        throw Error("LOCK_TIMEOUT");
      },
    });
    expect(unknown).toMatchObject({
      receiptTemplate: "unreadable",
      quoteTax: "unreadable",
      pickupCapacity: "unreadable",
      closedBusinessDay: false,
    });
    const after = await read({ readOwnerPublishedSetup: async () => true });
    expect(after).toMatchObject({
      receiptTemplate: { ready: false, reason: "TemplateNotProven" },
      pickupCapacity: { coveredMs: 0 },
      closedBusinessDay: true,
    });
    // A Store that does not offer pickup: not checked rather than unreadable.
    expect(
      (
        await read({
          readOwnerPublishedSetup: async () => true,
          readPickupCapacityHorizon: async () => null,
        })
      ).pickupCapacity,
    ).toBe(null);
    // Covered: its settlement is read, and a failure there is a failed read, not a clean one.
    await expect(
      read({ readOwnerPublishedSetup: async () => true, isSettlementCovered: async () => true }),
    ).rejects.toThrow("DAILY_SETTLEMENT_COVERAGE_MISSING");
  });
  it("gives a Store's connections back when it is no longer served", async () => {
    const close = vi.fn(async () => undefined);
    const observe = createBusinessObserver({
      runtimeDirectory: ".local/pilot-test",
      load: async () => ({
        resources: {
          close,
          scope: { brandReference: "b", storeReference: "s" },
          transactions: { run: async (work) => work({ query: async () => ({ rows: [] }) }) },
          database: {
            transactions: () => ({
              run: async (work) => work({ query: async () => ({ rows: [] }) }),
            }),
          },
        },
        installation: {},
        dependencies: {
          createReconciliationExceptions: () => async () => ({
            items: [],
            nextAfterExceptionReference: null,
          }),
          readSettlementStatus: async () => ({ days: [] }),
        },
      }),
    });
    await observe(T0);
    await observe.close();
    expect(close).toHaveBeenCalledOnce();
    await observe.close();
    expect(close).toHaveBeenCalledOnce();
  });
  it("WP-2423: reads payment signals every minute and rescans settlement every minute only while it has a problem", async () => {
    const counts = { settlement: 0, exceptions: 0 };
    let settlementProblem = true,
      openDifferences = 1;
    const resources = {
      scope: { brandReference: "b", storeReference: "s" },
      transactions: { run: async (work) => work({ query: async () => ({ rows: [] }) }) },
      database: {
        transactions: () => ({
          run: async (work) => work({ query: async () => ({ rows: [] }) }),
        }),
      },
    };
    const load = vi.fn(async () => ({
      resources,
      installation: {},
      dependencies: {
        createReconciliationExceptions: () => async () => {
          counts.exceptions++;
          return {
            items: Array.from({ length: openDifferences }, () => ({
              state: "Open",
              openedAt: new Date(T0 - MIN).toISOString(),
            })),
            nextAfterExceptionReference: null,
          };
        },
        readSettlementStatus: async () => {
          counts.settlement++;
          return {
            days: [
              {
                state: "Recorded",
                endsAt: new Date(T0 - 60 * MIN).toISOString(),
                outcome: settlementProblem ? "Difference" : "Matched",
              },
            ],
          };
        },
      },
    }));
    const observe = createBusinessObserver({ runtimeDirectory: ".local/pilot-test", load });
    expect((await observe(T0)).settlementExceptions.count).toBe(1);
    expect(await observe(T0 + 30_000)).toMatchObject({ reconciliationDifferences: { count: 1 } });
    expect(counts).toEqual({ settlement: 1, exceptions: 1 });
    // Staff resolve the difference: both signals clear on the next minute's read.
    settlementProblem = false;
    openDifferences = 0;
    expect(await observe(T0 + MIN)).toMatchObject({
      reconciliationDifferences: { count: 0 },
      settlementExceptions: { count: 0 },
    });
    expect(counts).toEqual({ settlement: 2, exceptions: 2 });
    // While every day is settled, the settlement scan waits 5 minutes; payment signals do not.
    await observe(T0 + 2 * MIN);
    await observe(T0 + 3 * MIN);
    expect(counts).toEqual({ settlement: 2, exceptions: 4 });
    await observe(T0 + 6 * MIN);
    expect(counts).toEqual({ settlement: 3, exceptions: 5 });
  });
});

describe("WP-2423 Q13 test alert command", () => {
  it("sends one test message per channel and reports each result without details", async () => {
    const { sendTestAlert } = await import("./pilot-ops.mjs");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ops-test-alert-"));
    await fs.chmod(dir, 0o700);
    await fs.writeFile(
      path.join(dir, "ops.json"),
      JSON.stringify({ schemaVersion: 1, siteLabel: "Main St" }),
      { mode: 0o600 },
    );
    const good = { id: "email", kind: "email", send: vi.fn(async () => undefined) };
    const bad = {
      id: "webhook-1",
      kind: "webhook",
      send: vi.fn(async () => {
        throw Error("https://hooks.test/secret-path refused");
      }),
    };
    const result = await sendTestAlert(dir, { channels: [good, bad] });
    expect(result.channels).toEqual([
      { channel: "email", result: "Delivered" },
      { channel: "webhook-1", result: "Failed", code: "PILOT_ALERT_DELIVERY_FAILED" },
    ]);
    expect(good.send.mock.calls[0][0].subject).toBe("Main St: test alert");
    const log = await fs.readFile(path.join(dir, "ops", "alerts.log"), "utf8");
    expect(log).toContain("test_alert");
    expect(log).not.toContain("secret-path");
    expect((await sendTestAlert(dir, { channels: [] })).note).toBe("NoOutboundChannels");
    await fs.rm(dir, { recursive: true });
  });
  it("DEC-PILOT-INSTALLATION: reads only the installation's end instant and alerts two weeks ahead", async () => {
    const profile = (validUntil) => async () =>
      JSON.stringify({ environment: "Pilot", binding: { validUntil, storeReference: "x" } });
    expect(await observeInstallationValidity("/r", profile("2026-11-14T02:26:31.598Z"))).toEqual({
      validUntil: "2026-11-14T02:26:31.598Z",
    });
    expect(await observeInstallationValidity("/r", profile("tomorrow"))).toBe("unreadable");
    expect(
      await observeInstallationValidity("/r", async () => {
        throw Error("ENOENT");
      }),
    ).toBe("unreadable");
    const io = fakeIo({ apiUp: () => true, channels: [] });
    io.observeInstallation = async () => ({
      validUntil: new Date(T0 + 5 * 86400_000).toISOString(),
    });
    await runMonitorCycle({ now: T0, state: fresh(), config, io });
    expect(io.boards.at(-1).active.map((item) => item.key)).toContain("installation.validity");
  });
});
