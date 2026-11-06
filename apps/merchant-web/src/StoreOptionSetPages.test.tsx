import { describe, expect, it } from "vitest";
import {
  choiceRule,
  createOptionSetClient,
  offDefaultText,
  optionSetProblemText,
  optionSetSaveEffectText,
  optionSetStateText,
  parseOptionSetListView,
} from "./store-option-set-page.js";

describe("WP-2423 option set page helpers", () => {
  it("states the rule customers see", () => {
    expect(choiceRule({ kind: "One", minimum: 1, maximum: 1, perOptionMaximum: 1 })).toBe(
      "Choose 1 (required)",
    );
    expect(choiceRule({ kind: "Any", minimum: 0, maximum: 3, perOptionMaximum: 1 })).toBe(
      "Choose up to 3 (optional)",
    );
    expect(choiceRule({ kind: "Quantity", minimum: 0, maximum: null, perOptionMaximum: 3 })).toBe(
      "Up to 3 of each, any number in total (optional)",
    );
  });
  it("never calls a set no product offers 'in use'", () => {
    expect(optionSetStateText({ archived: false, productNames: [] })).toMatch(
      /^Saved, not on any product yet — customers cannot choose it/u,
    );
    expect(optionSetStateText({ archived: false, productNames: ["Flat White", "Mocha"] })).toBe(
      "On Flat White, Mocha.",
    );
    expect(optionSetStateText({ archived: true, productNames: ["Mocha"] })).toMatch(/^Archived/u);
    expect(optionSetStateText({ archived: false, productNames: [] })).not.toMatch(/in use/iu);
  });
  it("accepts only option set lists", () => {
    const view = {
      screenId: "CAT-OPTIONSET-LIST",
      optionSets: [{ optionSetReference: "x", name: "Milk", kind: "One", options: [] }],
    };
    expect(parseOptionSetListView(view).optionSets).toHaveLength(1);
    expect(() =>
      parseOptionSetListView({ ...view, optionSets: [{ ...view.optionSets[0], kind: "Some" }] }),
    ).toThrow();
  });
  it("maps server refusals to page errors and sends the CSRF header", async () => {
    let header: string | null = null;
    const client = createOptionSetClient("csrf", async (_path, init) => {
      header = new Headers(init?.headers).get("x-bop-csrf");
      return Response.json({ error: "Conflict" }, { status: 409 });
    });
    await expect(client.list()).rejects.toMatchObject({ code: "Conflict" });
    expect(header).toBe("csrf");
  });
  it("WP-2423 (cart-unsellable-dishes): names the dishes a Save affects, and why one was refused", async () => {
    expect(offDefaultText("Hot", ["Soy milk", "Hot tea"])).toBe(
      "Guests start with Hot on Soy milk, Hot tea. While Hot isn't offered, guests choose another choice themselves. Tick Offered again when it's back.",
    );
    expect(
      optionSetSaveEffectText({
        defaultsCarried: [
          { productName: "Soy milk", startsWith: "Iced" },
          { productName: "Hot tea", startsWith: "Iced" },
        ],
        notOfferedDefaults: [],
      }),
    ).toEqual(["Soy milk, Hot tea now start with Iced. List the menu to show it to guests."]);
    expect(
      optionSetProblemText({
        reason: "DefaultNeeded",
        optionName: "Serve",
        productNames: ["Soy milk"],
      }),
    ).toMatch(/^Serve needs a choice guests start with on Soy milk\..*Nothing was saved\.$/u);
    const client = createOptionSetClient("csrf", async () =>
      Response.json(
        {
          error: "OptionSet",
          problem: {
            reason: "DefaultChangeNeedsDishEditor",
            optionName: "Serve",
            productNames: ["Soy milk"],
          },
        },
        { status: 409 },
      ),
    );
    await expect(client.list()).rejects.toMatchObject({
      code: "OptionSet",
      problem: { reason: "DefaultChangeNeedsDishEditor", productNames: ["Soy milk"] },
    });
  });
});
