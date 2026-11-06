import { expect, it } from "vitest";
import { findInternalText } from "../e2e/internal-text-patterns.js";
import { oneStoreSaveFailureText } from "./one-store-save-words.js";
import { MenuPageError, createMenuClient } from "./store-menu-pages.js";

const problem = {
  missing: "Stopped" as const,
  reason: "ChoiceGroupDefault",
  productName: "Soy milk",
  sizeName: null,
  optionName: "Serve",
  quantity: null,
  ingredientName: null,
};
it("WP-2423: a dish save refused for its choice group names the dish and the group, never the menu's sections", () => {
  const text = oneStoreSaveFailureText(new MenuPageError("ChoiceGroup", problem), true);
  expect(text).toBe(
    "Soy milk: Serve has no choice guests start with that is still offered. Under Option sets, open Serve and offer that choice again, or let another choice be the default. Then save the dish.",
  );
  expect(text).not.toContain("section");
  expect(findInternalText([text])).toEqual([]);
  // A choice removed since the editor opened.
  expect(
    oneStoreSaveFailureText(
      new MenuPageError("ChoiceGroup", { ...problem, reason: "ChoiceGroupOption" }),
      true,
    ),
  ).toBe("Soy milk: a choice in Serve was removed. Close the dish, open it again and save it.");
  // No problem sent: the general choice-group sentence, still not the sections one.
  expect(oneStoreSaveFailureText(new MenuPageError("ChoiceGroup"), true)).toContain("Option sets");
});

it("WP-2423: the client reads a dish save's choice-group refusal (409, part Product) with its problem", async () => {
  const fetcher = async () =>
    new Response(JSON.stringify({ error: "ChoiceGroup", part: "Product", problem }), {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  const client = createMenuClient("c".repeat(43), fetcher as typeof fetch);
  const failure = await (client.oneStore?.({} as never) ?? Promise.resolve(null)).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(MenuPageError);
  expect((failure as MenuPageError).code).toBe("ChoiceGroup");
  expect((failure as MenuPageError).problem).toMatchObject({
    reason: "ChoiceGroupDefault",
    productName: "Soy milk",
    optionName: "Serve",
  });
});
