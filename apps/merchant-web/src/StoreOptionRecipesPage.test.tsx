import { describe, expect, it } from "vitest";
import {
  microText,
  optionRecipeStatus,
  type OptionRecipeRow,
} from "./store-option-recipes-page.js";

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
  comment: null,
  reviewedAt: "",
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
});
