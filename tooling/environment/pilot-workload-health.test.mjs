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
} from "./pilot-workload-health.mjs";
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
      contactRetention: "business-contact-retention.health.json",
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
