import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getUnseatedTableWait,
  isUnseatedTableScan,
  restoreUnseatedTableWait,
  setCustomerCsrfCredential,
  setUnseatedTableScan,
  setUnseatedTableWait,
} from "./customer-transaction-context.js";
import { keptTableWaitMilliseconds, readKeptTableWait } from "./table-wait-tab.js";

// Batch 43 (v15 b42 verify): the wait for staff to open the table survives a reload in this tab.
// The data shape is the live one: TM2's "Test Merchant 2 Main - not production", table
// "L42V A (TEST)", the Store's public reference and its en-CA menu.
const storeReference = "018f8a00-0000-7000-8000-000000000004";
const key = "bop.customer.table-wait";

function fakeStorage() {
  const items = new Map<string, string>();
  return {
    items,
    storage: {
      getItem: (name: string) => items.get(name) ?? null,
      setItem: (name: string, value: string) => void items.set(name, value),
      removeItem: (name: string) => void items.delete(name),
    },
  };
}

const live = {
  kind: "NotOpen" as const,
  storeDisplayName: "Test Merchant 2 Main - not production",
  tableLabel: "L42V A (TEST)",
  check: null,
  context: {
    publicStoreReference: storeReference,
    brandDisplayName: "Test Merchant 2",
    locale: "en-CA",
  },
};

describe("the table wait kept in this tab", () => {
  let tab: ReturnType<typeof fakeStorage>;
  beforeEach(() => {
    tab = fakeStorage();
    vi.stubGlobal("window", { sessionStorage: tab.storage });
    setCustomerCsrfCredential(null);
  });
  afterEach(() => {
    setUnseatedTableWait(null);
    setUnseatedTableScan(false);
    setCustomerCsrfCredential(null);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps only what the screen shows, and a reload waits again with the waiting scan's check", async () => {
    setUnseatedTableWait({ ...live, check: async () => ({ kind: "Waiting" }) });
    const kept = tab.items.get(key) ?? "";
    expect(JSON.parse(kept)).toEqual({
      schemaVersion: 1,
      kind: "NotOpen",
      tableLabel: "L42V A (TEST)",
      publicStoreReference: storeReference,
      brandDisplayName: "Test Merchant 2",
      storeDisplayName: "Test Merchant 2 Main - not production",
      locale: "en-CA",
      until: expect.any(Number) as number,
    });
    expect(kept).not.toContain("check");

    // The page is loaded again: the wait comes back from the tab, with the waiting scan's check.
    const check = vi.fn(async () => ({ kind: "Changed" as const }));
    setUnseatedTableScan(false);
    expect(restoreUnseatedTableWait(check)).toEqual({
      publicStoreReference: storeReference,
      channel: "DineIn",
      locale: "en-CA",
      brandDisplayName: "Test Merchant 2",
      storeDisplayName: "Test Merchant 2 Main - not production",
    });
    expect(isUnseatedTableScan()).toBe(true);
    const wait = getUnseatedTableWait();
    expect(wait?.kind).toBe("NotOpen");
    expect(wait?.tableLabel).toBe("L42V A (TEST)");
    expect(await wait?.check?.()).toEqual({ kind: "Changed" });
    expect(check).toHaveBeenCalledOnce();
  });

  it("a table being cleaned is kept too, with nothing to check", () => {
    setUnseatedTableWait({ ...live, kind: "BeingCleaned", tableLabel: null });
    expect(restoreUnseatedTableWait(async () => ({ kind: "Waiting" }))).not.toBeNull();
    expect(getUnseatedTableWait()?.kind).toBe("BeingCleaned");
    expect(getUnseatedTableWait()?.check).toBeNull();
  });

  it("expires once the waiting checks would have stopped (15 minutes)", () => {
    expect(keptTableWaitMilliseconds).toBe(15 * 60 * 1000);
    vi.useFakeTimers({ now: Date.parse("2026-11-21T18:00:00.000Z") });
    setUnseatedTableWait(live);
    vi.setSystemTime(Date.parse("2026-11-21T18:14:59.000Z"));
    expect(readKeptTableWait()).not.toBeNull();
    vi.setSystemTime(Date.parse("2026-11-21T18:15:00.000Z"));
    expect(readKeptTableWait()).toBeNull();
    expect(tab.items.has(key)).toBe(false);
  });

  it("any other entry answer, or a visit on this phone, forgets it", () => {
    setUnseatedTableWait(live);
    setUnseatedTableWait(null);
    expect(tab.items.has(key)).toBe(false);

    setUnseatedTableWait(live);
    setCustomerCsrfCredential("N".repeat(43));
    expect(tab.items.has(key)).toBe(false);
    expect(getUnseatedTableWait()).toBeNull();
    // With a visit restored, a reload never waits for the table.
    tab.items.set(key, JSON.stringify({ schemaVersion: 1 }));
    expect(restoreUnseatedTableWait(null)).toBeNull();
    expect(tab.items.has(key)).toBe(false);
  });

  it("a kept value that doesn't read back exactly is dropped", () => {
    setUnseatedTableWait(live);
    const kept = JSON.parse(tab.items.get(key) ?? "{}") as Record<string, unknown>;
    for (const changed of [
      { ...kept, qrToken: "aaa.bbb.ccc" },
      { ...kept, storeDisplayName: "<script>" },
      { ...kept, publicStoreReference: "not-a-reference" },
      { ...kept, until: Date.now() + 2 * keptTableWaitMilliseconds },
      { ...kept, kind: "Open" },
    ]) {
      tab.items.set(key, JSON.stringify(changed));
      expect(readKeptTableWait()).toBeNull();
      expect(tab.items.has(key)).toBe(false);
    }
    tab.items.set(key, "{");
    expect(readKeptTableWait()).toBeNull();
  });

  it("storage that can't be used only means nothing is kept", () => {
    vi.stubGlobal("window", {
      get sessionStorage(): Storage {
        throw new Error("blocked");
      },
    });
    expect(() => setUnseatedTableWait(live)).not.toThrow();
    expect(restoreUnseatedTableWait(null)).toBeNull();
  });
});
