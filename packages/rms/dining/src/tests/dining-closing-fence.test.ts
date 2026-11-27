import { expect, it, vi } from "vitest";
import { createPostgresDiningClosingFence } from "../index.js";
const id = (n: number) => "0190fad6-0000-7000-8000-" + String(n).padStart(12, "0");
function setup() {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    session = {
      diningSessionReference: id(4),
      brandReference: id(2),
      storeReference: id(3),
      tableReference: id(5),
      tableAssignmentVersion: 1,
      phase: "Closing",
      version: 2,
      startedByActorReference: id(6),
      startedAt: "2026-09-20T00:00:00.000Z",
      hostParticipantReference: null,
    };
  const current = { ...session };
  const authorize = vi.fn(async () => true);
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("session_snapshot")
      ? [{ session: sql.includes("FOR UPDATE") ? current : session }]
      : sql.includes("table_id::text")
        ? [{ reference: id(5) }]
        : [],
  }));
  const fence = createPostgresDiningClosingFence({ scope, authorize });
  return {
    session,
    current,
    authorize,
    query,
    run: () =>
      fence({ query }, { diningSessionReference: id(4), observedAt: "2026-09-20T01:00:00.000Z" }),
  };
}
it("locks table admission before table and session rows, retaining exact state", async () => {
  const f = setup();
  expect(await f.run()).toEqual(f.current);
  const sql = f.query.mock.calls.map((c) => c[0]);
  expect(sql.findIndex((s) => s.includes("advisory"))).toBeLessThan(
    sql.findIndex((s) => s.includes("table_id::text")),
  );
  expect(sql.findIndex((s) => s.includes("table_id::text"))).toBeLessThan(
    sql.findIndex((s) => s.includes("session_snapshot") && s.includes("FOR UPDATE")),
  );
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it.each(["tableReference", "tableAssignmentVersion", "version", "phase"] as const)(
  "denies changed %s",
  async (key) => {
    const f = setup();
    if (key === "tableReference") f.current.tableReference = id(8);
    else if (key === "phase") f.current.phase = "Closed";
    else f.current[key]++;
    // Batch 45: changed while this request waited for the table's lock is "the table changed"
    // (409, read again), never "unavailable" (503 and an ops alert).
    await expect(f.run()).rejects.toMatchObject({
      name: "DiningClosingError",
      code: "DINING_CLOSING_VERSION_CONFLICT",
    });
  },
);
it("denies before IO and after permission revocation", async () => {
  const f = setup();
  const unavailable = { code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE" };
  f.authorize.mockResolvedValueOnce(false);
  await expect(f.run()).rejects.toMatchObject(unavailable);
  expect(f.query).not.toHaveBeenCalled();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.run()).rejects.toMatchObject(unavailable);
});
it("refuses a session this Store has no record of as not found, locking no invented table", async () => {
  const f = setup();
  // v15 b44 live (2026-11-22 01:33:25 UTC): the session read at this Store finds no row.
  f.query.mockResolvedValue({ rows: [] });
  await expect(f.run()).rejects.toMatchObject({
    name: "DiningClosingError",
    code: "DINING_CLOSING_SESSION_NOT_FOUND",
  });
  expect(f.query.mock.calls.some((c) => c[0].includes("advisory"))).toBe(false);
});
it("keeps a broken read, a missing table row and a failed query as unavailable", async () => {
  const unavailable = { code: "DINING_CLOSING_DEPENDENCY_UNAVAILABLE" };
  const twoRows = setup();
  twoRows.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("session_snapshot")
      ? [{ session: twoRows.session }, { session: twoRows.session }]
      : [],
  }));
  await expect(twoRows.run()).rejects.toMatchObject(unavailable);
  const noTable = setup();
  noTable.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("session_snapshot") ? [{ session: noTable.session }] : [],
  }));
  await expect(noTable.run()).rejects.toMatchObject(unavailable);
  const down = setup();
  down.query.mockRejectedValue(Object.assign(new Error("connection lost"), { code: "08006" }));
  await expect(down.run()).rejects.toMatchObject(unavailable);
});
