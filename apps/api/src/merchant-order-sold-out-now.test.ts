import { describe, expect, it, vi } from "vitest";

const status = new Map<string, string>();
vi.mock("@rms/catalog", () => ({
  listStoreAvailabilityRules: async () => [],
  listOptionsOffNow: async (_tx: unknown, input: { optionReferences: string[] }) =>
    new Map(input.optionReferences.filter((o) => o === "pearls").map((o) => [o, "SoldOut"])),
}));
vi.mock("./merchant-availability.js", () => ({
  itemAvailability: (_rules: unknown, _scope: unknown, sku: string) => ({
    status: status.get(sku) ?? "Available",
    soldOutUntil: null,
  }),
}));
const { orderLinesUnavailableNow } = await import("./merchant-order-sold-out-now.js");

describe("WP-2423 (M23): lines sold out or off the menu since they were ordered", () => {
  it("names a dish sold out, a dish off the menu and a choice sold out; leaves the rest", async () => {
    status.set("rice", "SoldOut").set("soup", "NotOffered").set("tea", "Available");
    const queries: string[] = [];
    const tx = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [{ brand: "b", store: "s" }] };
      },
    };
    const line = (
      orderItemReference: string,
      sellableReference: string,
      options: string[] = [],
    ) => ({
      orderItemReference,
      sellableReference,
      options: options.map((optionReference) => ({ optionReference })),
    });
    const found = await orderLinesUnavailableNow(
      tx,
      { brandReference: "b", storeReference: "s" },
      {
        orderType: "Pickup",
        at: "2026-11-10T20:00:00.000Z",
        lines: [
          line("1", "rice"),
          line("2", "soup"),
          line("3", "tea", ["pearls"]),
          line("4", "tea", ["ice"]),
        ],
      },
    );
    expect([...found]).toEqual([
      ["1", "SoldOut"],
      ["2", "Hidden"],
      ["3", "ChoiceSoldOut"],
    ]);
    // The caller's Store context is put back for the queue's own reads.
    expect(queries.at(-1)).toContain("set_config('bop.store_id'");
  });
});
