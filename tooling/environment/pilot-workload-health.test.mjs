import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
      diningCheckoutExpiry: "business-dining-checkout-expiry.health.json",
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
