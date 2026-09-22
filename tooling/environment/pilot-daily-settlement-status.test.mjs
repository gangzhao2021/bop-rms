import { expect, it, vi } from "vitest";
import { readPilotDailySettlementStatus } from "./pilot-daily-settlement-status.mjs";
const scope = {
  brandReference: "0198a107-0000-7000-8000-000000000001",
  storeReference: "0198a107-0000-7000-8000-000000000002",
};
function fixture() {
  const first = {
    ...scope,
    businessDate: "2026-09-20",
    startsAt: "2026-09-20T08:00:00.000Z",
    endsAt: "2026-09-21T08:00:00.000Z",
  };
  const last = {
    ...scope,
    businessDate: "2026-09-21",
    startsAt: first.endsAt,
    endsAt: "2026-09-22T08:00:00.000Z",
  };
  return {
    coverage: { firstWindow: first },
    scope,
    now: () => "2026-09-22T09:00:00.000Z",
    readWindow: vi.fn(async (q) => (q?.endingAt === first.endsAt ? first : last)),
    readRun: vi.fn(async () => null),
  };
}
it("reports absent persisted days without financial execution or hiding coverage", async () => {
  const f = fixture();
  const result = await readPilotDailySettlementStatus(f);
  expect(result).toMatchObject({ coverageScanComplete: true, missingDays: 2, reviewDays: 0 });
  expect(result.days.map((d) => d.businessDate)).toEqual(["2026-09-21", "2026-09-20"]);
  expect(result.days.every((d) => d.state === "Missing" && d.outcome === null)).toBe(true);
  expect(f.readRun).toHaveBeenCalledTimes(2);
});
it("marks truncated coverage explicitly", async () => {
  const result = await readPilotDailySettlementStatus({ ...fixture(), limit: 1 });
  expect(result.coverageScanComplete).toBe(false);
  expect(result.days).toHaveLength(1);
});
it("rejects invalid limit, future or wrong-store windows and malformed results", async () => {
  await expect(readPilotDailySettlementStatus({ ...fixture(), limit: 32 })).rejects.toThrow();
  const f = fixture();
  f.now = () => "2026-09-21T09:00:00.000Z";
  await expect(readPilotDailySettlementStatus(f)).rejects.toThrow();
  const g = fixture();
  g.scope = { ...scope, storeReference: "0198a107-0000-7000-8000-000000000009" };
  await expect(readPilotDailySettlementStatus(g)).rejects.toThrow();
  const h = fixture();
  h.readRun.mockResolvedValue({ checks: [] });
  await expect(readPilotDailySettlementStatus(h)).rejects.toThrow();
});
