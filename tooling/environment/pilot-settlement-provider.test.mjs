import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createInternalSettlementWindowSource } from "./pilot-settlement-provider.mjs";
const databases = [];
const id = (n) => "0190fa71-0000-7000-8000-" + String(n).padStart(12, "0");
const input = {
  brandReference: id(1),
  storeReference: id(2),
  environment: "Test",
  startsAt: "2026-09-20T08:00:00.000Z",
  endsAt: "2026-09-21T08:00:00.000Z",
};
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllEnvs();
});
function fixture() {
  vi.stubEnv("NODE_ENV", "development");
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`CREATE TABLE intent(reference TEXT,brand TEXT,store TEXT,amount TEXT);
    CREATE TABLE outcome(reference TEXT,transaction_reference TEXT,status TEXT,occurred_at TEXT);
    CREATE TABLE refund(reference TEXT,intent_reference TEXT,amount TEXT,created_at TEXT);`);
  db.prepare("INSERT INTO intent VALUES (?,?,?,?)").run("pi_prior", id(1), id(2), "1250");
  db.prepare("INSERT INTO outcome VALUES (?,?,?,?)").run(
    "pi_prior",
    "ch_prior",
    "Captured",
    "2026-09-19T08:00:00.000Z",
  );
  db.prepare("INSERT INTO refund VALUES (?,?,?,?)").run(
    "re_today",
    "pi_prior",
    "1250",
    input.startsAt,
  );
  const authorize = vi.fn(async () => true);
  const read = createInternalSettlementWindowSource(db, {
    authorize,
    now: () => "2026-09-22T00:00:00.000Z",
  });
  return { db, read, authorize };
}
it("reads prior-capture refunds at the inclusive start without fabricating today's captures", async () => {
  const f = fixture(),
    before = f.db.prepare("SELECT total_changes() AS n").get().n;
  const first = await f.read(input);
  expect(first).toMatchObject({
    source: "InternalTestSimulator",
    capturedAmountMinor: 0n,
    refundedAmountMinor: 1250n,
    captureCount: 0,
    refundCount: 1,
  });
  expect(await f.read(input)).toEqual(first);
  expect(f.db.prepare("SELECT total_changes() AS n").get().n).toBe(before);
});
it("excludes the end boundary and other stores, using occurrence rather than creation time", async () => {
  const f = fixture();
  f.db.prepare("INSERT INTO intent VALUES (?,?,?,?)").run("pi_end", id(1), id(2), "2000");
  f.db
    .prepare("INSERT INTO outcome VALUES (?,?,?,?)")
    .run("pi_end", "ch_end", "Captured", input.endsAt);
  f.db.prepare("INSERT INTO intent VALUES (?,?,?,?)").run("pi_other", id(1), id(3), "3000");
  f.db
    .prepare("INSERT INTO outcome VALUES (?,?,?,?)")
    .run("pi_other", "ch_other", "Captured", input.startsAt);
  expect((await f.read(input)).capturedAmountMinor).toBe(0n);
});
it("binds the digest to scope/window and exact journal content", async () => {
  const f = fixture(),
    first = await f.read(input);
  f.db.prepare("INSERT INTO intent VALUES (?,?,?,?)").run("pi_new", id(1), id(2), "99999999");
  f.db
    .prepare("INSERT INTO outcome VALUES (?,?,?,?)")
    .run("pi_new", "ch_new", "Captured", input.startsAt);
  const next = await f.read(input);
  expect(next.capturedAmountMinor).toBe(99999999n);
  expect(next.evidenceDigest).not.toBe(first.evidenceDigest);
  expect(
    (await f.read({ ...input, startsAt: "2026-09-20T07:00:00.000Z" })).evidenceDigest,
  ).not.toBe(next.evidenceDigest);
});
it.each([
  { endsAt: "2026-09-23T08:00:00.000Z" },
  { startsAt: input.endsAt },
  { startsAt: "2026-02-30T08:00:00.000Z" },
  { environment: "Live" },
])("rejects incomplete or invalid windows and live mode %j", async (change) => {
  await expect(fixture().read({ ...input, ...change })).rejects.toThrow(
    "SIMULATION_SETTLEMENT_UNAVAILABLE",
  );
});
it("rejects revoked authority before returning journal evidence", async () => {
  const f = fixture();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.read(input)).rejects.toThrow("SIMULATION_SETTLEMENT_UNAVAILABLE");
});
it("rejects malformed journal money without exposing its raw value", async () => {
  const f = fixture();
  f.db.prepare("UPDATE refund SET amount=?").run("private-malformed");
  await expect(f.read(input)).rejects.toThrow(/^SIMULATION_SETTLEMENT_UNAVAILABLE$/);
});
it("rejects source overflow instead of reporting a truncated match", async () => {
  const db = { prepare: () => ({ all: () => Array(100001).fill(null) }) };
  vi.stubEnv("NODE_ENV", "development");
  const read = createInternalSettlementWindowSource(db, {
    authorize: async () => true,
    now: () => input.endsAt,
  });
  await expect(read(input)).rejects.toThrow("SIMULATION_SETTLEMENT_UNAVAILABLE");
});
