import { describe, expect, it } from "vitest";
import { planStockAllocation, storeDayEndExpiryCutoff } from "../domain/stock-allocation.js";
const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T16:00:00.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  stockSiteReference: id(4),
  itemReference: id(5),
  currentItemVersion: 2,
};
const unit = {
  unitCode: "KG",
  dimension: "Mass",
  displayPrecision: 2,
  ledgerPrecision: 4,
  roundingMode: "HalfEven",
};
const candidate = (n: number, cutoff: string | null) => ({
  ...scope,
  accountReference: id(n),
  locationReference: id(9),
  ledgerVersion: 3,
  unitCode: "KG",
  ledgerPrecision: 4,
  available: "0.2",
  holdStatus: "Available",
  firstReceivedAt: "2026-09-10T16:00:00.000Z",
  observedAt: at,
  expiryDate: cutoff === null ? null : cutoff.slice(0, 10),
  expiryCutoff: cutoff,
});
const input = (candidates: unknown[]) => ({
  ...scope,
  unit,
  quantity: "0.3",
  issuePolicy: "FEFO",
  observedAt: at,
  candidates,
});
describe("stock allocation proposal", () => {
  it("allocates exact amounts by earliest expiry independent of query order", () => {
    const a = candidate(10, "2026-09-13T16:00:00.000Z"),
      b = candidate(11, "2026-09-12T16:00:00.000Z");
    const plan = planStockAllocation(input([a, b]));
    expect(plan.status).toBe("Ready");
    expect(plan.allocations).toEqual([
      {
        accountReference: id(11),
        locationReference: id(9),
        expectedLedgerVersion: 3,
        quantity: "0.2",
      },
      {
        accountReference: id(10),
        locationReference: id(9),
        expectedLedgerVersion: 3,
        quantity: "0.1",
      },
    ]);
    expect(planStockAllocation(input([b, a]))).toEqual(plan);
  });
  it("excludes exact-cutoff and quarantined stock without returning partial allocations", () => {
    const plan = planStockAllocation(
      input([
        candidate(10, at),
        { ...candidate(11, null), holdStatus: "Quarantined" },
        candidate(12, null),
      ]),
    );
    expect(plan).toMatchObject({ status: "Insufficient", shortage: "0.1", allocations: [] });
  });
  it("requires explicit expiry cutoff and rejects scope, duplicate and precision mismatches", () => {
    for (const c of [
      { ...candidate(10, null), expiryDate: "2026-09-12" },
      { ...candidate(10, null), storeReference: id(99) },
      { ...candidate(10, null), available: "0.00001" },
    ])
      expect(() => planStockAllocation(input([c]))).toThrow();
    expect(() => planStockAllocation(input([candidate(10, null), candidate(10, null)]))).toThrow();
  });
  it("accepts zero without a movement", () =>
    expect(planStockAllocation({ ...input([]), quantity: "0" })).toMatchObject({
      status: "Ready",
      allocations: [],
    }));
});

describe("WP-2423 lot expiry cutoff", () => {
  it("keeps a lot usable through the end of its expiry date in the Store's time zone", () => {
    expect(storeDayEndExpiryCutoff("2026-10-12", "America/Toronto")).toBe(
      "2026-10-13T04:00:00.000Z",
    );
    expect(storeDayEndExpiryCutoff("2026-12-31", "America/Toronto")).toBe(
      "2027-01-01T05:00:00.000Z",
    );
    // Daylight saving ends on 2026-11-01 in Toronto: midnight starting 11-01 is still EDT.
    expect(storeDayEndExpiryCutoff("2026-10-31", "America/Toronto")).toBe(
      "2026-11-01T04:00:00.000Z",
    );
    expect(storeDayEndExpiryCutoff("2026-11-01", "America/Toronto")).toBe(
      "2026-11-02T05:00:00.000Z",
    );
    expect(storeDayEndExpiryCutoff("2026-10-12", "UTC")).toBe("2026-10-13T00:00:00.000Z");
    expect(() => storeDayEndExpiryCutoff("2026-02-30", "UTC")).toThrow();
  });
});
