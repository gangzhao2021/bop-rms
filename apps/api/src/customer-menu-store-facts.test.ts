import { beforeEach, expect, it, vi } from "vitest";
import { createCustomerMenuStoreFacts } from "./customer-menu-store-facts.js";
import type {
  CustomerInventoryEvidence,
  CustomerInventoryEvidenceSource,
} from "./customer-menu-inventory-evidence.js";

const f = vi.hoisted(() => ({ rules: [] as unknown[] }));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  listStoreAvailabilityRules: async () => f.rules,
  // No combos at this store (WP-2423 item 8 ⑥ part 4).
  listBundleComboRecords: async () => ({ dishes: [], choices: [], listedVersions: [] }),
}));
vi.mock("@rms/pricing", async (original) => ({
  ...(await original<typeof import("@rms/pricing")>()),
  currentStorePriceBook: async () => null,
  createPostgresCurrentOptionPriceStore: () => ({ load: async () => [] }),
}));

const id = (n: number) => "01902408-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-11T09:00:00.000Z";
const rule = (sellable: number, decision: "Available" | "Unavailable", reasonCode: string) => ({
  ruleReference: id(sellable + 500),
  brandReference: id(2),
  internalCode: "RULE_" + sellable,
  aggregateVersion: 1,
  lifecycle: "Active",
  sellableReference: id(sellable),
  sellableType: "Sku",
  storeReference: id(3),
  channelCodes: [],
  orderTypeCodes: [],
  effectiveFrom: "2026-10-01T00:00:00.000Z",
  effectiveUntil: null,
  decision,
  priority: decision === "Unavailable" ? 900 : 100,
  reasonCode,
  createdAt: "2026-10-01T00:00:00.000Z",
  createdByActorReference: id(9),
  updatedAt: "2026-10-01T00:00:00.000Z",
});
const evidence = (
  sellable: number,
  status: CustomerInventoryEvidence["status"],
): CustomerInventoryEvidence => ({
  kind: "Inventory",
  brandReference: id(2),
  storeReference: id(3),
  sellableReference: id(sellable),
  status,
  observedAt: at,
  expiresAt: "2026-10-11T09:01:00.000Z",
  reasonCode:
    status === "Available"
      ? "STOCK_AVAILABLE"
      : status === "Unavailable"
        ? "STOCK_DEPLETED"
        : "STOCK_UNOBSERVED",
});
beforeEach(() => {
  f.rules = [
    rule(10, "Available", "STORE_OFFERED"),
    rule(11, "Available", "STORE_OFFERED"),
    rule(12, "Available", "STORE_OFFERED"),
    rule(13, "Available", "STORE_OFFERED"),
    { ...rule(13, "Unavailable", "SOLD_OUT"), ruleReference: id(999) },
  ];
});
async function load(inventory?: CustomerInventoryEvidenceSource, sellables = [10, 11, 12, 13, 14]) {
  const tx = { query: vi.fn() };
  return createCustomerMenuStoreFacts({
    transactions: { run: async (work) => work(tx as never) },
    currencyMetadata: { currencyCode: "CAD", minorUnitExponent: 2 } as never,
    priceChannelCode: "CUSTOMER_WEB",
    ...(inventory === undefined ? {} : { inventory }),
  }).load({
    brandReference: id(2) as never,
    storeReference: id(3) as never,
    channelCode: "CUSTOMER_PWA" as never,
    orderTypeCode: "PICKUP" as never,
    requestedAt: at as never,
    sellableReferences: sellables.map((n) => id(n) as never),
    items: sellables.map((n) => ({
      sellableReference: id(n) as never,
      productVersionReference: id(n + 100) as never,
      defaultOptionSelections: [],
    })),
  });
}

it("WP-2423 Q12: an offered item whose stock has run out shows sold out; unknown stock does not", async () => {
  const observe = vi.fn<CustomerInventoryEvidenceSource["observe"]>(async () => {
    return new Map([
      [id(10), evidence(10, "Available")],
      [id(11), evidence(11, "Unavailable")],
      [id(12), evidence(12, "Indeterminate")],
      [id(13), evidence(13, "Available")],
      [id(14), evidence(14, "Unavailable")],
    ]);
  });
  const facts = await load({ observe });
  expect(facts.get(id(10))?.availability).toBe("Available");
  // Out of stock: shown sold out, not hidden.
  expect(facts.get(id(11))?.availability).toBe("SoldOut");
  // Unknown stock never hides or sells out an item.
  expect(facts.get(id(12))?.availability).toBe("Available");
  // A manual sold out is unchanged by stock.
  expect(facts.get(id(13))?.availability).toBe("SoldOut");
  // Not offered at the Store stays off the menu even when stock is out.
  expect(facts.get(id(14))?.availability).toBe("NotOffered");
  expect(observe).toHaveBeenCalledOnce();
  expect(observe.mock.calls[0]?.[1]).toMatchObject({
    brandReference: id(2),
    storeReference: id(3),
    observedAt: at,
  });
  expect(observe.mock.calls[0]?.[1].items.map((i) => i.sellableReference)).toEqual([
    id(10),
    id(11),
    id(12),
  ]);
});

it("WP-2423 Q12: expired stock evidence or no stock source leaves availability to the Store's rules", async () => {
  const stale = await load({
    observe: async () => new Map([[id(11), { ...evidence(11, "Unavailable"), expiresAt: at }]]),
  });
  expect(stale.get(id(11))?.availability).toBe("Available");
  const failed = await load({
    observe: async () => {
      throw new Error("stock read failed");
    },
  });
  expect(failed.get(id(11))?.availability).toBe("Available");
  expect(failed.get(id(13))?.availability).toBe("SoldOut");
  const without = await load();
  expect(without.get(id(11))?.availability).toBe("Available");
  expect(without.get(id(13))?.availability).toBe("SoldOut");
});
