import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { createInternalReconciliationLease } from "./pilot-reconciliation-lease.mjs";
const id = (n) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0");
const run = {
  runReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: null,
  mode: "Operational",
  purpose: "ReconcilePayments",
  scheduledAt: "2026-09-22T00:00:00.000Z",
  cutoffAt: "2026-09-22T00:00:00.000Z",
  maxCandidates: 5,
};
const claim = {
    runReference: id(1),
    jobName: "payment-reconciliation:v1",
    scheduledAt: run.scheduledAt,
  },
  release = { runReference: id(1), jobName: claim.jobName };
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  vi.stubEnv("NODE_ENV", "development");
  const client = new EventEmitter();
  client.query = vi.fn(async () => ({ rows: [{ acquired: true, pid: 123 }] }));
  client.release = vi.fn();
  const database = { acquire: vi.fn(async () => client) },
    active = vi.fn(() => true);
  return {
    client,
    database,
    active,
    lease: createInternalReconciliationLease({ database, active, run }),
  };
}
it("holds one run-bound Store lock and destroys its dedicated connection on release", async () => {
  const f = fixture();
  expect(await f.lease.claim(claim)).toBe(true);
  expect(await f.lease.assertHeld()).toBe(true);
  expect(f.client.query).toHaveBeenCalledWith(expect.stringContaining("pg_try_advisory_lock"), [
    "PaymentReconciliationExecution:" + id(2) + ":" + id(3),
  ]);
  await f.lease.release(release);
  await f.lease.dispose();
  expect(f.client.release).toHaveBeenCalledExactlyOnceWith(true);
  expect(f.client.listenerCount("error")).toBe(0);
  await expect(f.lease.assertHeld()).rejects.toThrow();
});
it("refuses contention and does not retry the same lease instance", async () => {
  const f = fixture();
  f.client.query.mockResolvedValue({ rows: [{ acquired: false, pid: 123 }] });
  expect(await f.lease.claim(claim)).toBe(false);
  expect(await f.lease.claim(claim)).toBe(false);
  expect(f.database.acquire).toHaveBeenCalledTimes(1);
  expect(f.client.release).toHaveBeenCalledWith(true);
});
it("permits only one concurrent claim attempt", async () => {
  const f = fixture();
  const result = await Promise.all([f.lease.claim(claim), f.lease.claim(claim)]);
  expect(result).toEqual([true, false]);
  expect(f.database.acquire).toHaveBeenCalledTimes(1);
  await f.lease.dispose();
});
it.each(["error", "pid", "revoked", "query"])(
  "fails closed after %s without reconnecting",
  async (kind) => {
    const f = fixture();
    await f.lease.claim(claim);
    if (kind === "error") f.client.emit("error", Error("private"));
    if (kind === "pid") f.client.query.mockResolvedValue({ rows: [{ pid: 456 }] });
    if (kind === "revoked") f.active.mockReturnValue(false);
    if (kind === "query") f.client.query.mockRejectedValue(Error("private"));
    await expect(f.lease.assertHeld()).rejects.toThrow(
      "RECONCILIATION_EXECUTION_LEASE_UNAVAILABLE",
    );
    expect(f.database.acquire).toHaveBeenCalledTimes(1);
    await f.lease.dispose();
    expect(f.client.release).toHaveBeenCalledWith(true);
  },
);
it("does not release a lease for a different run", async () => {
  const f = fixture();
  await f.lease.claim(claim);
  await expect(f.lease.release({ ...release, runReference: id(9) })).rejects.toThrow();
  expect(f.client.release).not.toHaveBeenCalled();
  await f.lease.dispose();
});
it("destroys connection after uncertain acquisition", async () => {
  const f = fixture();
  f.client.query.mockRejectedValue(Error("private"));
  await expect(f.lease.claim(claim)).rejects.toThrow("RECONCILIATION_EXECUTION_LEASE_UNAVAILABLE");
  expect(f.client.release).toHaveBeenCalledWith(true);
});
it("rejects changed schedule without connecting", async () => {
  const f = fixture();
  expect(await f.lease.claim({ ...claim, scheduledAt: "2026-09-22T00:01:00.000Z" })).toBe(false);
  expect(f.database.acquire).not.toHaveBeenCalled();
});
