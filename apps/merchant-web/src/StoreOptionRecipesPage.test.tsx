import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pinFixtureYear } from "./store-year.fixture.js";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";
import { ChangeHistory } from "./StoreOptionRecipesPage.js";
import { StoreTimeZoneContext } from "./StoreTime.js";
import {
  microText,
  optionRecipeStatus,
  type OptionRecipeRow,
} from "./store-option-recipes-page.js";

// Batch 64: dates of this year are written without the year; these fixtures are in 2026.
beforeEach(() => pinFixtureYear());
afterEach(() => vi.useRealTimers());

const row = (change: Partial<NonNullable<OptionRecipeRow["change"]>> | null, covered = false) =>
  ({
    covered,
    change:
      change === null
        ? null
        : {
            changeVersionReference: "x",
            version: 1,
            content: {},
            byViewer: false,
            recordedAt: "",
            published: false,
            reviews: [],
            lines: [],
            ...change,
          },
  }) as unknown as OptionRecipeRow;
const review = (kind: "Cost" | "FoodSafety", decision: "Approved" | "Rejected" = "Approved") => ({
  kind,
  decision,
  byViewer: false,
  reviewerLabel: "Noah",
  comment: null,
  reviewedAt: "2026-10-16T14:05:00.000Z",
});

describe("WP-2423 option recipe page helpers", () => {
  it("shows amounts from microunits", () => {
    expect(microText("200000000")).toBe("200");
    expect(microText("18000")).toBe("0.018");
    expect(microText("0")).toBe("0");
  });
  it("says what an option needs next", () => {
    expect(optionRecipeStatus(row(null))).toBe("NotSet");
    expect(optionRecipeStatus(row({ reviews: [review("Cost")] }))).toBe("NeedsReview");
    expect(optionRecipeStatus(row({ reviews: [review("Cost", "Rejected")] }))).toBe("Rejected");
    expect(optionRecipeStatus(row({ reviews: [review("Cost"), review("FoodSafety")] }))).toBe(
      "ReadyToPublish",
    );
    expect(optionRecipeStatus(row({ published: true }, true))).toBe("Published");
    expect(optionRecipeStatus(row({ published: true }, false))).toBe("NeedsUpdate");
  });
  it("names who saved and reviewed a change, in Store time, and who must review next", () => {
    const render = (value: OptionRecipeRow) =>
      staticText(
        renderToStaticMarkup(
          <StoreTimeZoneContext.Provider value="America/Toronto">
            <ChangeHistory row={{ ...value, optionName: "Oat milk" }} />
          </StoreTimeZoneContext.Provider>,
        ),
      ).replace(/\s+/gu, " ");
    const base = {
      authorLabel: "Mia",
      recordedAt: "2026-10-16T13:00:00.000Z",
    };
    const waiting = render(row({ ...base, reviews: [review("Cost")] }));
    expect(waiting).toContain("Saved by Mia on Fri, Oct 16 09:00");
    expect(waiting).toContain("Cost: approved by Noah on Fri, Oct 16 10:05");
    expect(waiting).toContain(
      "Still needed: food safety review, by someone who holds recipe review other than the person who saved it and the first reviewer",
    );
    expect(findInternalText([waiting])).toEqual([]);
    const own = render(row({ ...base, authorLabel: "You", byViewer: true }));
    expect(own).toContain("Saved by You");
    expect(own).toContain(
      "cost and food safety review, by someone who holds recipe review other than you",
    );
    expect(findInternalText([own])).toEqual([]);
  });
});
