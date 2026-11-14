import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createCustomerMenuClient } from "./menu-client.js";
import { guestUnreadableItems } from "./menu-contract.js";
import type { MenuJourneyContext, MenuLoadResult } from "./types.js";

/**
 * WP-2423 item 8 ⑥ part 4 (v15 2026-10-29: every guest menu showed "Menu is unavailable" once a
 * combo was listed). The payload is not written by hand: the single-store combo acceptance
 * (packages/database, BOP_CAPTURE_GUEST_MENU=1) captures it from the real published projection
 * and store facts after a real "List it", in the public form the server sends. TEST data.
 */
const captured = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(new URL("./combo-menu.captured.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
type Item = { name: string } & Record<string, unknown>;
const sectionsOf = (payload: Record<string, unknown>) =>
  (payload.menu as { sections: { name: string; sellables: Item[] }[] }).sections;
const context = (payload: Record<string, unknown>): MenuJourneyContext => ({
  publicStoreReference: (payload.scope as { publicStoreReference: string }).publicStoreReference,
  channel: "DineIn",
  locale: "en-CA",
  brandDisplayName: "TEST",
  storeDisplayName: "TEST",
});
const load = (payload: Record<string, unknown>): Promise<MenuLoadResult> =>
  createCustomerMenuClient(context(payload), {
    online: () => true,
    fetch: async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  }).load();
const names = (result: MenuLoadResult) =>
  result.kind === "Found"
    ? result.menu.sections.flatMap((section) => section.sellables.map((item) => item.name))
    : result.kind;

describe("the guest menu with a listed combo", () => {
  it("reads the combo's parts as the server sends them: choose one, nothing chosen", async () => {
    const payload = captured();
    // As v15 sent it: the parts in the quantity form, each with the binding's default.
    const parts = sectionsOf(payload)
      .flatMap((section) => section.sellables)
      .find((item) => item.name === "Combo for two (TEST)")?.optionRules as Record<
      string,
      unknown
    >[];
    expect(parts.map((rule) => [rule.comboPart, rule.semanticsVersion])).toEqual([
      [true, 2],
      [true, 2],
    ]);
    const result = await load(payload);
    expect(names(result)).toEqual([
      "Hot and sour soup (TEST)",
      "Wonton soup (TEST)",
      "Fried rice (TEST)",
      "Chow mein (TEST)",
      "Combo for two (TEST)",
    ]);
    if (result.kind !== "Found") throw new Error("menu not found");
    const combo = result.menu.sections
      .flatMap((section) => section.sellables)
      .find((item) => item.name === "Combo for two (TEST)");
    expect(
      combo?.optionRules.map((rule) => ({
        comboPart: rule.comboPart,
        minimum: rule.minimumSelections,
        maximum: rule.maximumSelections,
        chosen: rule.options.filter(
          (option) => option.selectedByDefault || (option.defaultQuantity ?? 0) > 0,
        ).length,
      })),
    ).toEqual([
      { comboPart: true, minimum: 1, maximum: 1, chosen: 0 },
      { comboPart: true, minimum: 1, maximum: 1, chosen: 0 },
    ]);
    expect(guestUnreadableItems(payload)).toEqual([]);
  });

  it("leaves out only an item it cannot read; the rest of the menu stays", async () => {
    const payload = captured();
    const soups = sectionsOf(payload)[0];
    if (soups === undefined) throw new Error("no section");
    // An item in a form this app does not know (for example, a field added on the server first).
    soups.sellables = soups.sellables.map((item) =>
      item.name === "Wonton soup (TEST)" ? { ...item, servedWith: "TEST" } : item,
    );
    const result = await load(payload);
    expect(names(result)).toEqual([
      "Hot and sour soup (TEST)",
      "Fried rice (TEST)",
      "Chow mein (TEST)",
      "Combo for two (TEST)",
    ]);
    // Staff are told which item guests are not shown.
    expect(guestUnreadableItems(payload)).toEqual(["Wonton soup (TEST)"]);
  });

  it("does not show a section whose every item it cannot read", async () => {
    const payload = captured();
    const combos = sectionsOf(payload)[1];
    if (combos === undefined) throw new Error("no section");
    combos.sellables = combos.sellables.map((item) => ({ ...item, optionRules: "TEST" }));
    const result = await load(payload);
    if (result.kind !== "Found") throw new Error("menu not found");
    expect(result.menu.sections.map((section) => section.name)).toEqual(["Soups (TEST)"]);
    expect(guestUnreadableItems(payload)).toEqual(["Combo for two (TEST)"]);
  });
});
