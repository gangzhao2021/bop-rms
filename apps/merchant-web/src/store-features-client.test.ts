import { describe, expect, it } from "vitest";
import { createStoreFeaturesClient, parseStoreFeatures } from "./store-features-client.js";

const view = {
  version: 2,
  templateCode: "Custom",
  modules: { counterOrder: true, pickup: true, inventory: false },
  changedAt: "2026-10-29T15:05:00.000Z",
  canChange: true,
};

describe("WP-2423 item 8 ⑦ Store features client", () => {
  it("reads the Store's modules and refuses anything else", () => {
    expect(parseStoreFeatures(view).modules).toEqual({
      counterOrder: true,
      pickup: true,
      inventory: false,
    });
    for (const bad of [
      { ...view, version: -1 },
      { ...view, templateCode: "Cafe" },
      { ...view, changedAt: "yesterday" },
      { ...view, modules: { counterOrder: true, inventory: false } },
      { ...view, modules: { ...view.modules, inventory: "no" } },
      null,
    ])
      expect(() => parseStoreFeatures(bad)).toThrow();
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
      modules: { counterOrder: true, pickup: false, inventory: false },
    });
    expect(sent[0]).toEqual({
      action: "Change",
      operationReference: "0190a7f2-0000-7000-8000-000000000001",
      expectedVersion: 1,
      modules: { counterOrder: true, pickup: false, inventory: false },
    });
    await expect(client.read()).rejects.toMatchObject({ code: "Changed" });
  });
});
