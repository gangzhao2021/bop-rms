import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { StoreTaxReviewPage, parseTaxReviewView, percent } from "./StoreTaxReviewPage.js";

describe("WP-2423 tax review", () => {
  it("shows rates as percentages", () => {
    expect(percent("0.13")).toBe("13%");
    expect(percent("0.055")).toBe("5.5%");
    expect(percent("0.05")).toBe("5%");
    expect(percent("0")).toBe("0%");
  });
  it("accepts only tax review views", () => {
    expect(() => parseTaxReviewView({ screenId: "TAX-CONFIG" })).toThrow();
    expect(
      parseTaxReviewView({ screenId: "TAX-STORE-REVIEW", classes: [], products: [] }).products,
    ).toEqual([]);
  });
  it("renders the loading state before the review arrives", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StoreTaxReviewPage client={{ load: () => new Promise(() => undefined) }} />
      </MemoryRouter>,
    );
    expect(html).toContain("Loading tax review");
  });
});
