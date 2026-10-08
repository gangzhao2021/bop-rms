import { describe, expect, it } from "vitest";
import {
  choiceRule,
  createOptionSetClient,
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
});
