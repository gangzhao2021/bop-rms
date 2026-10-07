import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { centsToDollarsText, dollarsToCentsText, RecipeListPage } from "./RecipePages.js";
import {
  centsText,
  createRecipeClient,
  lineCostCentsText,
  parseRecipeEditorView,
  parseRecipeListView,
  RecipePageError,
  suggestRecipeCode,
} from "./recipe-pages.js";

describe("WP-2423 recipe authoring page helpers", () => {
  it("suggests stable codes from names", () => {
    expect(suggestRecipeCode("Flat white 12 oz")).toBe("FLAT-WHITE-12-OZ");
    expect(suggestRecipeCode("Crème brûlée")).toBe("CREME-BRULEE");
    expect(suggestRecipeCode("12 oz latte")).toBe("R-12-OZ-LATTE");
    expect(suggestRecipeCode("拿铁")).toBe("");
  });
  it("converts standard costs between dollars and cents exactly", () => {
    expect(dollarsToCentsText("0.00289")).toBe("0.289");
    expect(dollarsToCentsText("2.89")).toBe("289");
    expect(dollarsToCentsText("1.0000001")).toBeNull();
    expect(dollarsToCentsText("-1")).toBeNull();
    expect(centsToDollarsText("0.289")).toBe("0.00289");
    expect(centsToDollarsText(289)).toBe("2.89");
    expect(centsToDollarsText("300")).toBe("3.00");
    expect(centsToDollarsText(null)).toBe("");
  });
  it.each([
    ["0.25", "0", "289", "72"],
    ["0.25", "10", "289", "79"],
    ["18", "0", "4.5", "81"],
    ["0.5", "0", "5", "2"],
    ["1.5", "0", "5", "8"],
  ])("line %s with %s%% loss at %s cents costs %s cents", (q, loss, cost, cents) => {
    expect(lineCostCentsText(q, loss, cost)).toBe(cents);
  });
  it("refuses quantities finer than the recipe precision", () => {
    expect(lineCostCentsText("0.0000001", "0", "1")).toBeNull();
    expect(centsText("12345")).toBe("123.45");
    expect(centsText("7")).toBe("0.07");
  });
  it("maps server refusals and offline failures", async () => {
    const reply = (status: number, body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    const client = createRecipeClient("csrf", () => reply(422, { error: "LineInvalid", line: 3 }));
    await expect(client.load(null)).rejects.toMatchObject({ code: "LineInvalid", line: 3 });
    const forbidden = createRecipeClient("csrf", () => reply(403, { error: "unknown" }));
    await expect(forbidden.load(null)).rejects.toMatchObject({ code: "PermissionDenied" });
    const offline = createRecipeClient("csrf", () => Promise.reject(new TypeError("offline")));
    await expect(offline.load(null)).rejects.toBeInstanceOf(RecipePageError);
    await expect(offline.load(null)).rejects.toMatchObject({ code: "Offline" });
  });
  it("sends same-origin requests with the CSRF header", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const client = createRecipeClient("token", (url, init) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(new Response("{}", { status: 200 }));
    });
    await client.load("01909a0e-0000-7000-8000-000000000001");
    expect(calls[0]?.url).toBe("/merchant/commerce/recipes/query");
    expect(calls[0]?.init?.credentials).toBe("same-origin");
    expect((calls[0]?.init?.headers as Record<string, string>)["x-bop-csrf"]).toBe("token");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      recipeReference: "01909a0e-0000-7000-8000-000000000001",
    });
  });
  it("accepts only the matching screen", () => {
    const base = {
      sourceAsOf: "2026-10-07T12:00:00.000Z",
      permissions: { mayEdit: true, mayReview: false, mayPublish: false },
      viewer: "01909a0e-0000-7000-8000-000000000002",
      choices: { yieldUnits: ["EACH"], items: [], subRecipes: [], stations: [], skus: [] },
    };
    expect(parseRecipeListView({ ...base, screenId: "RECIPE-LIST", recipes: [] }).recipes).toEqual(
      [],
    );
    expect(() =>
      parseRecipeEditorView({ ...base, screenId: "RECIPE-LIST", recipes: [] }),
    ).toThrow();
  });
  it("renders the loading state before the source answers", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RecipeListPage />
      </MemoryRouter>,
    );
    expect(html).toContain("Loading recipes");
  });
});
