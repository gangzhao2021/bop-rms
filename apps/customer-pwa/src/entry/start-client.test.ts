import { describe, expect, it, vi } from "vitest";
import { codeNames, createCustomerStartClient, isRestoredVisitCode } from "./start-client.js";
import type {
  CustomerEntryClient,
  CustomerEntryResumedContext,
  CustomerEntryScreenState,
} from "./types.js";

// M02 (v15 07b7a1b7): a reloaded Lane Dessert page opened DEMO Café (the installation's first
// Store) and emptied the guest's cart. A phone now stays at the Store and table it scanned.
const STORE_B = "0190aa21-0000-7000-8000-00000000000b";
const TABLE_T = "0190aa21-0000-7000-8000-0000000000a1";
const code = (payload: object) =>
  "h." + Buffer.from(JSON.stringify(payload)).toString("base64url") + ".s";
const pickupB = code({ publicStoreReference: STORE_B, publicTableReference: null });
const tableT = code({ publicStoreReference: STORE_B, publicTableReference: TABLE_T });
const restoredPickup: CustomerEntryResumedContext = Object.freeze({
  publicStoreReference: STORE_B,
  channel: "Pickup",
  locale: "en-CA",
  brandDisplayName: "Lane Brand",
  storeDisplayName: "Lane Dessert",
  publicTableReference: null,
  joined: false,
});
const restoredTable: CustomerEntryResumedContext = Object.freeze({
  ...restoredPickup,
  channel: "DineIn",
  publicTableReference: TABLE_T,
  joined: true,
});
const answer = (state: CustomerEntryScreenState): CustomerEntryClient => ({
  hasEntry: true,
  start: vi.fn(async () => state),
  retry: vi.fn(async () => state),
  enter: vi.fn(async () => state),
});
const established = { kind: "Established" } as unknown as CustomerEntryScreenState;
const missing: CustomerEntryScreenState = { kind: "Missing" };
const tableNotOpen = { kind: "TableNotOpen" } as unknown as CustomerEntryScreenState;

function setup(
  options: {
    source?: Parameters<typeof createCustomerStartClient>[0]["source"];
    restored?: CustomerEntryResumedContext;
    replay?: CustomerEntryScreenState;
    pickup?: string | undefined;
  } = {},
) {
  const forCode = vi.fn((token: string) => (token === "" ? answer(missing) : answer(established)));
  const replay = answer(options.replay ?? missing);
  const forReplay = vi.fn(() => replay);
  const pickupCode = vi.fn(async (store?: string) => (store === "" ? undefined : options.pickup));
  const client = createCustomerStartClient({
    source: options.source ?? { kind: "None" },
    restored: options.restored,
    forCode,
    forReplay,
    pickupCode,
  });
  return { client, forCode, forReplay, replay, pickupCode };
}

describe("M02 the start page stays at this phone's own Store and table", () => {
  it("reads which Store and table a code names, and compares it with the restored visit", () => {
    expect(codeNames(tableT)).toEqual({
      publicStoreReference: STORE_B,
      publicTableReference: TABLE_T,
    });
    expect(codeNames("not-a-code")).toBeNull();
    expect(isRestoredVisitCode(pickupB, restoredPickup)).toBe(true);
    expect(isRestoredVisitCode(tableT, restoredPickup)).toBe(false);
    expect(isRestoredVisitCode(tableT, restoredTable)).toBe(true);
    expect(isRestoredVisitCode(pickupB, restoredTable)).toBe(false);
    expect(
      isRestoredVisitCode(
        code({ publicStoreReference: "other", publicTableReference: TABLE_T }),
        restoredTable,
      ),
    ).toBe(false);
  });

  it("a reload with a restored pickup visit resumes it: no entry, no bare pickup code", async () => {
    const f = setup({ restored: restoredPickup, pickup: "DEMO.cafe.code" });
    expect(await f.client.start()).toEqual({ kind: "Resumed", context: restoredPickup });
    expect(f.forCode).not.toHaveBeenCalled();
    expect(f.pickupCode).not.toHaveBeenCalled();
  });

  it("a reload after a scan that started no visit asks the same Store about it again", async () => {
    const f = setup({ restored: restoredPickup, replay: tableNotOpen });
    expect(await f.client.start()).toBe(tableNotOpen);
    expect(f.forReplay).toHaveBeenCalledOnce();
    // "We've been seated" and the timer ask the same replay again.
    await f.client.retry();
    expect(f.replay.retry).toHaveBeenCalledOnce();
    await f.client.enter?.("Start");
    expect(f.replay.enter).toHaveBeenCalledWith("Start");
  });

  it("a passing failure of the replay doesn't hide the guest's own restored visit", async () => {
    const f = setup({ restored: restoredTable, replay: { kind: "Offline" } });
    expect((await f.client.start()).kind).toBe("Resumed");
    const g = setup({ replay: { kind: "Offline" } });
    expect((await g.client.start()).kind).toBe("Offline");
  });

  it("no scan and no visit: only an installation's only Store answers the bare address", async () => {
    const single = setup({ pickup: pickupB });
    expect(await single.client.start()).toBe(established);
    expect(single.pickupCode).toHaveBeenCalledWith();
    expect(single.forCode).toHaveBeenCalledWith(pickupB);
    const several = setup({ pickup: undefined });
    expect(await several.client.start()).toEqual({ kind: "Missing" });
    expect(several.forCode).not.toHaveBeenCalled();
  });

  it("scanning the same pickup poster or the same table again keeps the visit and its cart", async () => {
    for (const [token, restored] of [
      [pickupB, restoredPickup],
      [tableT, restoredTable],
    ] as const) {
      const f = setup({ source: { kind: "Code", load: async () => token }, restored });
      expect(await f.client.start()).toEqual({ kind: "Resumed", context: restored });
      expect(f.forCode).not.toHaveBeenCalled();
      expect(f.forReplay).not.toHaveBeenCalled();
    }
    // Another table, or another Store's code, is a new scan.
    const other = code({ publicStoreReference: STORE_B, publicTableReference: STORE_B });
    const f = setup({ source: { kind: "Code", load: async () => other }, restored: restoredTable });
    expect(await f.client.start()).toBe(established);
    expect(f.forCode).toHaveBeenCalledWith(other);
  });

  it("'Start a new order' starts at the restored Store, or stays at the same table", async () => {
    const pickup = setup({ restored: restoredPickup, pickup: pickupB });
    expect(pickup.client.startsNewVisit).toBe(true);
    expect(await pickup.client.startNew?.()).toBe(established);
    expect(pickup.pickupCode).toHaveBeenCalledWith(STORE_B);
    // Where this installation hands out no pickup codes, the guest is told to scan instead.
    expect(
      createCustomerStartClient({
        source: { kind: "None" },
        restored: restoredPickup,
        forCode: vi.fn(),
        forReplay: vi.fn(),
        pickupCode: vi.fn(),
        pickupOffered: false,
      }).startsNewVisit,
    ).toBe(false);
    const table = setup({ restored: restoredTable, pickup: "DEMO.cafe.code" });
    expect(table.client.startsNewVisit).toBe(false);
    expect(await table.client.startNew?.()).toEqual({ kind: "Resumed", context: restoredTable });
    expect(table.pickupCode).not.toHaveBeenCalled();
    // A poster scanned while an order is open: asked for, a new order there.
    const scanned = setup({
      source: { kind: "Code", load: async () => pickupB },
      restored: restoredPickup,
    });
    expect(await scanned.client.startNew?.()).toBe(established);
    expect(scanned.forCode).toHaveBeenCalledWith(pickupB);
  });

  it("an address that is no code asks to scan and fetches nothing", async () => {
    const f = setup({ source: { kind: "Unusable" }, restored: restoredPickup, pickup: pickupB });
    expect(await f.client.start()).toEqual({ kind: "Missing" });
    expect(f.pickupCode).not.toHaveBeenCalled();
    expect(f.forReplay).not.toHaveBeenCalled();
  });
});
