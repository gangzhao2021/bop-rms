import { describe, expect, it } from "vitest";
import { createStoreFeaturesClient, parseStoreFeatures } from "./store-features-client.js";

const view = {
  version: 2,
  templateCode: "Custom",
  modules: { counterOrder: true, pickup: true, inventory: false, loyalty: false, alcohol: false },
  changedAt: "2026-10-29T15:05:00.000Z",
  services: {
    version: 1,
    staffCall: true,
    chaseDish: false,
    askPartySize: false,
    changedAt: "2026-10-29T15:06:00.000Z",
  },
  teaCharge: { version: 0, teaSellableReference: null, changedAt: null },
  tips: {
    version: 0,
    enabled: true,
    tierPercents: [10, 15, 18],
    changedAt: null,
    offInStoreSetup: false,
  },
  canChange: true,
};

describe("WP-2423 item 8 ⑦ Store features client", () => {
  it("reads the Store's modules and refuses anything else", () => {
    expect(parseStoreFeatures(view).modules).toEqual({
      counterOrder: true,
      pickup: true,
      inventory: false,
      loyalty: false,
      alcohol: false,
    });
    for (const bad of [
      { ...view, version: -1 },
      { ...view, templateCode: "Cafe" },
      { ...view, changedAt: "yesterday" },
      { ...view, modules: { counterOrder: true, inventory: false, loyalty: false } },
      { ...view, modules: { ...view.modules, inventory: "no" } },
      { ...view, services: { ...view.services, staffCall: "yes" } },
      { ...view, services: undefined },
      // WP-2423 item 8 ⑦: three ascending whole percentages 1–50, and tips on or off.
      { ...view, tips: undefined },
      // WP-2423 item 8 ⑦ 4b-2: the tea charge item is a reference or none.
      { ...view, teaCharge: undefined },
      { ...view, teaCharge: { ...view.teaCharge, teaSellableReference: "tea" } },
      { ...view, tips: { ...view.tips, enabled: "yes" } },
      { ...view, tips: { ...view.tips, tierPercents: [10, 10, 18] } },
      { ...view, tips: { ...view.tips, tierPercents: [10, 15, 51] } },
      { ...view, tips: { ...view.tips, tierPercents: [15, 18] } },
      null,
    ])
      expect(() => parseStoreFeatures(bad)).toThrow();
  });
  it("v15 2026-10-29: keeps only well-formed tea choices (none from an older server)", () => {
    const tea = "019a3c00-0000-7000-8000-000000000505";
    expect(parseStoreFeatures(view).teaChoices).toEqual([]);
    expect(
      parseStoreFeatures({
        ...view,
        teaChoices: [
          { sellableReference: tea, name: "Tea (TEST) 茶位" },
          { sellableReference: "tea", name: "Not a reference" },
          { sellableReference: tea },
        ],
      }).teaChoices,
    ).toEqual([{ sellableReference: tea, name: "Tea (TEST) 茶位", unavailable: null }]);
    expect(
      parseStoreFeatures({
        ...view,
        teaChoices: [{ sellableReference: tea, name: "Tea (TEST)", unavailable: "NotOffered" }],
      }).teaChoices[0]?.unavailable,
    ).toBe("NotOffered");
  });
  it("sends the owner's change, and says when another change came first", async () => {
    const sent: unknown[] = [];
    const client = createStoreFeaturesClient("a".repeat(43), async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return sent.length === 1
        ? Response.json(view)
        : Response.json({ error: "store_features_changed" }, { status: 409 });
    });
    await client.change({
      operationReference: "0190a7f2-0000-7000-8000-000000000001",
      expectedVersion: 1,
      modules: {
        counterOrder: true,
        pickup: false,
        inventory: false,
        loyalty: false,
        alcohol: false,
      },
    });
    expect(sent[0]).toEqual({
      action: "Change",
      operationReference: "0190a7f2-0000-7000-8000-000000000001",
      expectedVersion: 1,
      modules: {
        counterOrder: true,
        pickup: false,
        inventory: false,
        loyalty: false,
        alcohol: false,
      },
    });
    await expect(client.read()).rejects.toMatchObject({ code: "Changed" });
  });
  it("WP-2423 item 8 ⑦: sends the owner's tip choices against the version they saw", async () => {
    const sent: unknown[] = [];
    const client = createStoreFeaturesClient("a".repeat(43), async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({
        ...view,
        tips: {
          version: 1,
          enabled: false,
          tierPercents: [12, 15, 20],
          changedAt: view.changedAt,
          offInStoreSetup: false,
        },
      });
    });
    const next = await client.changeTips({
      operationReference: "0190a7f2-0000-7000-8000-000000000002",
      expectedVersion: 0,
      enabled: false,
      tierPercents: [12, 15, 20],
    });
    expect(sent[0]).toEqual({
      action: "ChangeTips",
      operationReference: "0190a7f2-0000-7000-8000-000000000002",
      expectedVersion: 0,
      enabled: false,
      tierPercents: [12, 15, 20],
    });
    expect(next.tips).toEqual({
      version: 1,
      enabled: false,
      tierPercents: [12, 15, 20],
      changedAt: view.changedAt,
      offInStoreSetup: false,
    });
  });
});

describe("DEC-PAID-ORDER-AUTO-ACCEPT", () => {
  const base = () => JSON.parse(JSON.stringify(view)) as Record<string, unknown>;
  it("an older server without it reads as off", () => {
    const value = parseStoreFeatures(base());
    expect(value.autoAccept).toEqual({ version: 0, pickup: false, dineIn: false, changedAt: null });
  });
  it("reads the two order types and refuses a wrong answer", () => {
    expect(
      parseStoreFeatures({
        ...base(),
        autoAccept: { version: 3, pickup: true, dineIn: false, changedAt: null },
      }).autoAccept,
    ).toEqual({ version: 3, pickup: true, dineIn: false, changedAt: null });
    expect(() =>
      parseStoreFeatures({ ...base(), autoAccept: { version: 3, pickup: "yes", dineIn: false } }),
    ).toThrow();
  });
});

describe("DEC-DINING-GUEST-TABLE-START: the switch on a page that may be open across a deploy", () => {
  it("reads both shapes: never set (no key), and on", () => {
    const base = view as unknown as { services: Record<string, unknown> };
    expect(parseStoreFeatures(base).services.guestTableStart).toBe(false);
    expect(parseStoreFeatures(base).guestTableStartAllowed).toBe(false);
    const on = {
      ...base,
      services: { ...base.services, guestTableStart: true },
      guestTableStartAllowed: true,
    };
    expect(parseStoreFeatures(on).services.guestTableStart).toBe(true);
    expect(parseStoreFeatures(on).guestTableStartAllowed).toBe(true);
    expect(() =>
      parseStoreFeatures({ ...base, services: { ...base.services, guestTableStart: "yes" } }),
    ).toThrow();
  });
});
