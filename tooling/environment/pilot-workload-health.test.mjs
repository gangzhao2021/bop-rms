import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  parsePilotWorkloadHealth,
  createPilotKitchenHealthObserver,
  createPilotWorkloadHealthObserver,
  pilotHealthComponents,
  readHostedStoreHealth,
  readHostedStoreLiveness,
  parseHostedLiveness,
  createHostedLivenessWriter,
  HOSTED_LIVENESS_FILE,
  HOSTED_WORKER_SERVICES,
  PILOT_WORKLOAD_HEALTH_STALE_MS,
} from "./pilot-workload-health.mjs";
import { storeWorkerServices } from "./pilot-recovery-sweep.mjs";
const identity = { pid: 123, started: "456" };
const at = "2026-09-20T12:00:00.000Z";
const snapshot = {
  state: "running",
  cycleInFlight: true,
  completedCycles: 1,
  lastCycleStartedAt: at,
  lastCycleCompletedAt: "2026-09-20T11:59:59.000Z",
};
const value = { ...identity, observedAt: at, snapshot };
it("reports age of real cycle without asserting overall health", () => {
  const result = parsePilotWorkloadHealth(value, identity, Date.parse(at) + 60000);
  expect(result.cycleAgeMs).toBe(60000);
  expect(result.lastCompletionAgeMs).toBe(61000);
  expect(result.reportAgeMs).toBe(60000);
  expect(result).not.toHaveProperty("healthy");
});
it.each([
  { pid: 999 },
  { started: "other" },
  { observedAt: "invalid" },
  { observedAt: "2026-09-21T00:00:00.000Z" },
  { extra: "private" },
])("rejects stale identity or invalid record %j", (change) => {
  expect(() =>
    parsePilotWorkloadHealth({ ...value, ...change }, identity, Date.parse(at)),
  ).toThrow();
});
it.each([
  { completedCycles: -1 },
  { completedCycles: 0 },
  { lastCycleStartedAt: null },
  { lastCycleCompletedAt: "invalid" },
  { cycleInFlight: "yes" },
  { payload: "private" },
])("rejects inconsistent snapshot %j", (change) => {
  expect(() =>
    parsePilotWorkloadHealth(
      { ...value, snapshot: { ...snapshot, ...change } },
      identity,
      Date.parse(at),
    ),
  ).toThrow();
});
it("publishes only bounded owned private diagnostics atomically", () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pilot-health-")));
  fs.chmodSync(directory, 0o700);
  try {
    const observer = createPilotKitchenHealthObserver(directory);
    const file = path.join(directory, "kitchen-queue-worker.health.json");
    observer({
      state: "idle",
      cycleInFlight: false,
      completedCycles: 0,
      lastCycleStartedAt: null,
      lastCycleCompletedAt: null,
    });
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(
      parsePilotWorkloadHealth(record, { pid: record.pid, started: record.started })
        .completedCycles,
    ).toBe(0);
    expect(fs.readdirSync(directory)).toEqual(["kitchen-queue-worker.health.json"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps business loop reports separate and refuses arbitrary file targets", () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pilot-business-health-")),
  );
  fs.chmodSync(directory, 0o700);
  try {
    const events = createPilotWorkloadHealthObserver(directory, "business-events"),
      waiting = createPilotWorkloadHealthObserver(directory, "business-payment-wait"),
      expiry = createPilotWorkloadHealthObserver(directory, "business-dining-checkout-expiry");
    const empty = {
      state: "running",
      cycleInFlight: false,
      completedCycles: 0,
      lastCycleStartedAt: null,
      lastCycleCompletedAt: null,
    };
    events(empty);
    const eventFile = path.join(directory, "business-events.health.json"),
      before = fs.readFileSync(eventFile, "utf8");
    waiting(empty);
    expiry(empty);
    const expiryRecord = JSON.parse(
      fs.readFileSync(path.join(directory, "business-dining-checkout-expiry.health.json"), "utf8"),
    );
    expect(
      parsePilotWorkloadHealth(expiryRecord, {
        pid: expiryRecord.pid,
        started: expiryRecord.started,
      }).completedCycles,
    ).toBe(0);
    expect(fs.readFileSync(eventFile, "utf8")).toBe(before);
    expect(pilotHealthComponents("business-worker")).toEqual({
      events: "business-events.health.json",
      paymentWait: "business-payment-wait.health.json",
      inventoryRelease: "business-inventory-release.health.json",
      pickupPaymentExpiry: "business-pickup-payment-expiry.health.json",
      diningCheckoutExpiry: "business-dining-checkout-expiry.health.json",
      tableOnlineRefund: "business-table-online-refund.health.json",
      guestTableClose: "business-guest-table-close.health.json",
      ordinaryRefundFollowThrough: "business-ordinary-refund-follow-through.health.json",
      contactRetention: "business-contact-retention.health.json",
      webhookEvidenceRetention: "business-webhook-evidence-retention.health.json",
      pickupCapacitySchedule: "business-pickup-capacity-schedule.health.json",
    });
    expect(() => createPilotWorkloadHealthObserver(directory, "../other")).toThrow();
    expect(() => pilotHealthComponents("api")).toThrow();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("required cancellation selects its own identity-checked health file", () => {
  expect(
    pilotHealthComponents("business-worker", { requireBatchCancellation: true }).batchCancellation,
  ).toBe("business-batch-cancellation.health.json");
  expect(pilotHealthComponents("business-worker").batchCancellation).toBeUndefined();
  expect(pilotHealthComponents("kitchen-queue-worker", { requireBatchCancellation: true })).toEqual(
    { kitchen: "kitchen-queue-worker.health.json" },
  );
});

it("compensation health is required only by explicit selection", () => {
  expect(pilotHealthComponents("business-worker")).not.toHaveProperty("compensation");
  expect(pilotHealthComponents("business-worker", { requireCompensation: true })).toHaveProperty(
    "compensation",
    "business-compensation.health.json",
  );
});

it("retains failure category through stopped state without claiming health", () => {
  const result = parsePilotWorkloadHealth(
    {
      ...value,
      snapshot: {
        ...snapshot,
        state: "stopped",
        cycleInFlight: false,
        lastCycleFailure: { occurredAt: at, category: "Deadlock" },
      },
    },
    identity,
    Date.parse(at),
  );
  expect(result.lastCycleFailure).toEqual({ occurredAt: at, category: "Deadlock" });
});
it.each([
  { occurredAt: at, category: "PRIVATE" },
  { occurredAt: at, category: "Deadlock", message: "PRIVATE" },
])("rejects unbounded or inconsistent failure metadata %j", (lastCycleFailure) => {
  expect(() =>
    parsePilotWorkloadHealth(
      { ...value, snapshot: { ...snapshot, lastCycleFailure } },
      identity,
      Date.parse(at),
    ),
  ).toThrow();
});

it("retains a previous failed-cycle timestamp during a later retry", () => {
  const lastCycleFailure = { occurredAt: "2026-09-19T00:00:00.000Z", category: "Deadlock" };
  expect(
    parsePilotWorkloadHealth(
      { ...value, snapshot: { ...snapshot, lastCycleFailure } },
      identity,
      Date.parse(at),
    ).lastCycleFailure,
  ).toEqual(lastCycleFailure);
});

it("keeps the safe failure code and SQLSTATE, and refuses free text in them", () => {
  const detailed = {
    occurredAt: at,
    category: "Unclassified",
    code: "COMPENSATION_DISCOVERY_INVALID",
    sqlState: "25P03",
  };
  expect(
    parsePilotWorkloadHealth(
      { ...value, snapshot: { ...snapshot, lastCycleFailure: detailed } },
      identity,
      Date.parse(at),
    ).lastCycleFailure,
  ).toEqual(detailed);
  for (const change of [{ code: "permission denied for table x" }, { sqlState: "private" }])
    expect(() =>
      parsePilotWorkloadHealth(
        { ...value, snapshot: { ...snapshot, lastCycleFailure: { ...detailed, ...change } } },
        identity,
        Date.parse(at),
      ),
    ).toThrow();
});

it("writes one service log line per failed cycle with category, code and SQLSTATE only", () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pilot-health-")));
  fs.chmodSync(directory, 0o700);
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (line) => lines.push(String(line)) > 0;
  try {
    const observer = createPilotWorkloadHealthObserver(directory, "business-compensation");
    const failed = {
      state: "failed",
      cycleInFlight: false,
      completedCycles: 3,
      lastCycleStartedAt: new Date(Date.now() - 1000).toISOString(),
      lastCycleCompletedAt: new Date(Date.now() - 2000).toISOString(),
      lastCycleFailure: {
        occurredAt: new Date(Date.now() - 500).toISOString(),
        category: "Unclassified",
        code: "COMPENSATION_DISCOVERY_INVALID",
        sqlState: null,
      },
    };
    observer(failed);
    observer({ ...failed, state: "stopped" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      event: "workload_cycle_failed",
      component: "business-compensation",
      category: "Unclassified",
      code: "COMPENSATION_DISCOVERY_INVALID",
      sqlState: null,
    });
  } finally {
    process.stderr.write = write;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// WP-2423 pilot resilience: a supervised workload stays alive; health must still say when a person
// is needed (attention_required, or transient failures persisting two minutes).
it("surfaces attention for attention_required and persistent failure, not a single retry", () => {
  const failing = (state, failingSince, consecutiveFailures) => ({
    ...value,
    snapshot: {
      ...snapshot,
      state,
      cycleInFlight: false,
      consecutiveFailures,
      failingSince,
      lastCycleFailure: {
        occurredAt: at,
        category: "Unclassified",
        code: "PAYMENT_RECEIPT_COVERAGE_UNAVAILABLE",
        sqlState: null,
      },
    },
  });
  const now = Date.parse(at);
  const brief = parsePilotWorkloadHealth(failing("running", at, 3), identity, now + 60_000);
  expect(brief).toMatchObject({ attention: false, consecutiveFailures: 3, failingForMs: 60_000 });
  const persistent = parsePilotWorkloadHealth(failing("running", at, 9), identity, now + 120_000);
  expect(persistent.attention).toBe(true);
  expect(
    parsePilotWorkloadHealth(failing("attention_required", at, 1), identity, now),
  ).toMatchObject({ attention: true, state: "attention_required" });
  expect(parsePilotWorkloadHealth(value, identity, now)).toMatchObject({
    attention: false,
    consecutiveFailures: 0,
    failingForMs: null,
  });
  for (const bad of [
    failing("running", null, 2),
    failing("running", at, 0),
    failing("running", "2026-09-21T00:00:00.000Z", 1),
    failing("running", at, -1),
  ])
    expect(() => parsePilotWorkloadHealth(bad, identity, now)).toThrow();
});
it("logs retried failures of a workload without a health file, once per failed cycle", async () => {
  const { createPilotWorkloadFailureLogger } = await import("./pilot-workload-health.mjs");
  expect(() => createPilotWorkloadFailureLogger("../x")).toThrow();
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (line) => lines.push(String(line)) > 0;
  try {
    const log = createPilotWorkloadFailureLogger("business-cart-expiry");
    const failure = {
      occurredAt: at,
      category: "Deadlock",
      code: "CART_EXPIRY_UNAVAILABLE",
      sqlState: "40P01",
    };
    log({
      ...snapshot,
      state: "running",
      consecutiveFailures: 1,
      failingSince: at,
      lastCycleFailure: failure,
    });
    log({
      ...snapshot,
      state: "running",
      consecutiveFailures: 1,
      failingSince: at,
      lastCycleFailure: failure,
    });
    log({ ...snapshot, lastCycleFailure: null });
  } finally {
    process.stderr.write = write;
  }
  expect(lines.map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({
      event: "workload_cycle_failed",
      component: "business-cart-expiry",
      state: "running",
      consecutiveFailures: 1,
      code: "CART_EXPIRY_UNAVAILABLE",
      sqlState: "40P01",
    }),
  ]);
});

// v15 2026-11-06 (points-sweep): the dining-exception worker's points sweep has its own health; a
// Store whose sweep needs a person is reported so, though its recovery is healthy.
it("reads a Store's dining-exception worker with its member points workload, and raises a failing sweep", async () => {
  expect(pilotHealthComponents("dining-exception-worker")).toEqual({
    diningException: "dining-exception-worker.health.json",
    memberPoints: "dining-exception-member-points.health.json",
  });
  const now = new Date().toISOString();
  const record = (state, failures) => ({
    pid: 77,
    started: "900",
    observedAt: now,
    snapshot: {
      state,
      cycleInFlight: false,
      completedCycles: 1,
      lastCycleStartedAt: now,
      lastCycleCompletedAt: now,
      lastCycleFailure:
        failures === 0
          ? null
          : {
              occurredAt: now,
              category: "Unclassified",
              code: "MEMBER_POINTS_LEDGER_MISMATCH",
              sqlState: null,
            },
      consecutiveFailures: failures,
      failingSince: failures === 0 ? null : now,
    },
  });
  const files = {
    "/proc/77/stat":
      "77 (node) S " + Array.from({ length: 19 }, (_, i) => (i === 18 ? "900" : "0")).join(" "),
    "/s/dining-exception-worker.health.json": JSON.stringify(record("running", 0)),
    "/s/dining-exception-member-points.health.json": JSON.stringify(
      record("attention_required", 1),
    ),
  };
  const read = async (file) => {
    if (!Object.hasOwn(files, file)) throw Object.assign(new Error("absent"), { code: "ENOENT" });
    return files[file];
  };
  expect(await readHostedStoreHealth("/s", "dining-exception-worker", 77, read)).toEqual({
    attention: ["memberPoints"],
  });
  files["/s/dining-exception-member-points.health.json"] = JSON.stringify(record("running", 0));
  expect(await readHostedStoreHealth("/s", "dining-exception-worker", 77, read)).toEqual({});
});

// DEC-WORKER-HEALTH-TRUTH: every health file a business worker writes is one the observer accepts;
// before, the refund follow-through's was refused and the whole worker refused to start.
it("accepts every business-worker health file it is asked to write", () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pilot-allow-")));
  fs.chmodSync(directory, 0o700);
  try {
    const all = pilotHealthComponents("business-worker", {
      requireBatchCancellation: true,
      requireCompensation: true,
    });
    for (const file of Object.values(all)) {
      const component = file.replace(/\.health\.json$/u, "");
      let refused = null;
      try {
        createPilotWorkloadHealthObserver(directory, component);
      } catch (error) {
        // Off Linux the observer stops at /proc; the closed list must still have let it through.
        refused = error.message;
      }
      expect(refused, component).not.toBe("PILOT_WORKLOAD_HEALTH_UNAVAILABLE");
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// DEC-WORKER-HEALTH-TRUTH: a report nobody has refreshed for 10 minutes is no heartbeat.
it("a health report with no heartbeat for 10 minutes needs a person", () => {
  const idle = { ...value, snapshot: { ...snapshot, cycleInFlight: false } };
  const now = Date.parse(at);
  expect(PILOT_WORKLOAD_HEALTH_STALE_MS).toBe(10 * 60_000);
  expect(parsePilotWorkloadHealth(idle, identity, now + 9 * 60_000).attention).toBe(false);
  expect(parsePilotWorkloadHealth(idle, identity, now + 10 * 60_000).attention).toBe(true);
});

const statOf = (pid, started) =>
  pid + " (node) S " + Array.from({ length: 19 }, (_, i) => (i === 18 ? started : "0")).join(" ");
const reader = (files) => async (file) => {
  if (!Object.hasOwn(files, file)) throw Object.assign(new Error("absent"), { code: "ENOENT" });
  return files[file];
};
const fresh = (pid, started, state = "running", observedAt = new Date().toISOString()) =>
  JSON.stringify({
    pid,
    started,
    observedAt,
    snapshot: {
      state,
      cycleInFlight: false,
      completedCycles: 1,
      lastCycleStartedAt: observedAt,
      lastCycleCompletedAt: observedAt,
    },
  });

// DEC-WORKER-HEALTH-TRUTH (v15 bc7e2965): a Store's worker whose health files are missing, from an
// earlier process, or unreadable is no running worker: each such part is named, never "running".
it("names each part of a Store's worker without a current health file", async () => {
  const files = {
    "/proc/77/stat": statOf(77, "900"),
    "/s/dining-exception-worker.health.json": fresh(77, "900"),
  };
  // The points sweep wrote nothing in this process.
  expect(await readHostedStoreHealth("/s", "dining-exception-worker", 77, reader(files))).toEqual({
    attention: ["memberPoints"],
  });
  // Left by the process before (another start instant).
  files["/s/dining-exception-member-points.health.json"] = fresh(77, "100");
  expect(await readHostedStoreHealth("/s", "dining-exception-worker", 77, reader(files))).toEqual({
    attention: ["memberPoints"],
  });
  files["/s/dining-exception-member-points.health.json"] = "{not json";
  expect(await readHostedStoreHealth("/s", "dining-exception-worker", 77, reader(files))).toEqual({
    attention: ["memberPoints"],
  });
  files["/s/dining-exception-member-points.health.json"] = fresh(77, "900");
  expect(await readHostedStoreHealth("/s", "dining-exception-worker", 77, reader(files))).toEqual(
    {},
  );
  // The process itself cannot be read: nothing of it can be vouched for.
  delete files["/proc/77/stat"];
  expect(await readHostedStoreHealth("/s", "dining-exception-worker", 77, reader(files))).toEqual({
    attention: ["diningException", "memberPoints"],
  });
});

it("a business worker's parts that depend on the Store's settings may be absent", async () => {
  const files = { "/proc/5/stat": statOf(5, "9") };
  for (const [component, file] of Object.entries(pilotHealthComponents("business-worker")))
    if (component !== "events") files["/s/" + file] = fresh(5, "9");
  expect(await readHostedStoreHealth("/s", "business-worker", 5, reader(files))).toEqual({
    attention: ["events"],
  });
});

const livenessRecord = (overrides = {}) => ({
  pid: 42,
  started: "700",
  observedAt: new Date(Date.parse(at)).toISOString(),
  services: {
    "business-worker": { state: "running", since: "2026-09-20T11:00:00.000Z" },
    "dining-exception-worker": { state: "down", since: "2026-09-20T11:30:00.000Z" },
    "daily-settlement-worker": { state: "starting", since: "2026-09-20T11:00:00.000Z" },
  },
  ...overrides,
});

it("reads which of a Store's workers the shared process has really started", () => {
  expect([...HOSTED_WORKER_SERVICES]).toEqual([...storeWorkerServices]);
  const now = Date.parse(at) + 60_000;
  expect(parseHostedLiveness(livenessRecord(), { pid: 42, started: "700" }, now)).toEqual({
    "business-worker": { state: "running", sinceMs: Date.parse("2026-09-20T11:00:00.000Z") },
    "dining-exception-worker": { state: "down", sinceMs: Date.parse("2026-09-20T11:30:00.000Z") },
    "daily-settlement-worker": {
      state: "starting",
      sinceMs: Date.parse("2026-09-20T11:00:00.000Z"),
    },
  });
  for (const [change, when] of [
    [{ pid: 43 }, now],
    [{ started: "701" }, now],
    // No heartbeat for two minutes: the process is not saying anything.
    [{}, Date.parse(at) + 2 * 60_000],
    [{ services: { api: { state: "running", since: at } } }, now],
    [{ services: { "business-worker": { state: "fine", since: at } } }, now],
    [{ services: { "business-worker": { state: "running", since: at, note: "x" } } }, now],
    [{ extra: 1 }, now],
  ])
    expect(() =>
      parseHostedLiveness(livenessRecord(change), { pid: 42, started: "700" }, when),
    ).toThrow();
});

it("a missing liveness file is no word yet; a foreign, stale or broken one is unreadable", async () => {
  const now = Date.parse(at) + 1000;
  const files = { "/proc/42/stat": statOf(42, "700") };
  expect(await readHostedStoreLiveness("/s", 42, reader(files), now)).toBeNull();
  files["/s/" + HOSTED_LIVENESS_FILE] = JSON.stringify(livenessRecord());
  expect((await readHostedStoreLiveness("/s", 42, reader(files), now))["business-worker"]).toEqual({
    state: "running",
    sinceMs: Date.parse("2026-09-20T11:00:00.000Z"),
  });
  files["/proc/42/stat"] = statOf(42, "999");
  expect(await readHostedStoreLiveness("/s", 42, reader(files), now)).toBe("unavailable");
  files["/proc/42/stat"] = statOf(42, "700");
  files["/s/" + HOSTED_LIVENESS_FILE] = "{";
  expect(await readHostedStoreLiveness("/s", 42, reader(files), now)).toBe("unavailable");
});

it("writes a Store's liveness privately and atomically, and never throws", () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pilot-liveness-")));
  fs.chmodSync(directory, 0o700);
  const lines = [];
  try {
    const write = createHostedLivenessWriter(directory, {
      identity: () => ({ pid: process.pid, started: "123" }),
      report: (line) => lines.push(line),
      now: () => Date.parse(at),
    });
    write({ "kitchen-queue-worker": { state: "running", since: at } });
    const file = path.join(directory, HOSTED_LIVENESS_FILE);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(
      parseHostedLiveness(
        JSON.parse(fs.readFileSync(file, "utf8")),
        { pid: process.pid, started: "123" },
        Date.parse(at),
      ),
    ).toEqual({ "kitchen-queue-worker": { state: "running", sinceMs: Date.parse(at) } });
    expect(fs.readdirSync(directory)).toEqual([HOSTED_LIVENESS_FILE]);
    // A directory that is not the Store's own private one: reported once, nothing thrown.
    const broken = createHostedLivenessWriter(path.join(directory, "missing"), {
      identity: () => ({ pid: process.pid, started: "123" }),
      report: (line) => lines.push(line),
    });
    broken({});
    broken({});
    expect(lines).toEqual(["PILOT_HOSTED_LIVENESS_WRITE_UNAVAILABLE\n"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
