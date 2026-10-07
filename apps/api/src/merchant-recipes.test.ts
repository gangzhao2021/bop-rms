import { describe, expect, it } from "vitest";
import { parseRecipeCommandBody } from "./merchant-recipes.js";

const id = (n: number) => "01909a17-0000-7000-8000-" + n.toString(16).padStart(12, "0");
describe("WP-2423 recipe command body", () => {
  it("accepts each recipe action", () => {
    const bodies = [
      {
        action: "SaveDraft",
        operationReference: id(1),
        recipeReference: id(2),
        expectedAggregateVersion: null,
        revisionOf: null,
        draft: {},
      },
      {
        action: "Review",
        operationReference: id(1),
        recipeReference: id(2),
        versionReference: id(3),
        subject: "Recipe",
        kind: "FoodSafety",
        decision: "Approved",
        comment: null,
      },
      {
        action: "Publish",
        operationReference: id(1),
        recipeReference: id(2),
        expectedAggregateVersion: 2,
      },
      {
        action: "Archive",
        operationReference: id(1),
        recipeReference: id(2),
        expectedAggregateVersion: 4,
      },
      { action: "PublishKitchen", operationReference: id(1), recipeReference: id(2) },
      {
        action: "BindSku",
        operationReference: id(1),
        recipeReference: id(2),
        skuReference: id(4),
        storeOnly: true,
      },
      { action: "EndStoreBinding", operationReference: id(1), bindingReference: id(5) },
    ];
    expect(bodies.map((body) => parseRecipeCommandBody(body).action)).toEqual(
      bodies.map((body) => body.action),
    );
  });
  it.each([
    [
      "a rejection without a comment",
      {
        action: "Review",
        operationReference: id(1),
        recipeReference: id(2),
        versionReference: id(3),
        subject: "Recipe",
        kind: "Cost",
        decision: "Rejected",
        comment: null,
      },
    ],
    [
      "an unknown review kind",
      {
        action: "Review",
        operationReference: id(1),
        recipeReference: id(2),
        versionReference: id(3),
        subject: "Recipe",
        kind: "Taste",
        decision: "Approved",
        comment: null,
      },
    ],
    [
      "a client-chosen reviewer",
      {
        action: "Review",
        operationReference: id(1),
        recipeReference: id(2),
        versionReference: id(3),
        subject: "Recipe",
        kind: "Cost",
        decision: "Approved",
        comment: null,
        reviewerReference: id(9),
      },
    ],
    [
      "a padded comment",
      {
        action: "Review",
        operationReference: id(1),
        recipeReference: id(2),
        versionReference: id(3),
        subject: "Preparation",
        kind: "Cost",
        decision: "Rejected",
        comment: " too salty",
      },
    ],
    [
      "a Store reference instead of the selected Store",
      {
        action: "BindSku",
        operationReference: id(1),
        recipeReference: id(2),
        skuReference: id(4),
        storeOnly: true,
        storeReference: id(6),
      },
    ],
    [
      "a zero expected version",
      {
        action: "Publish",
        operationReference: id(1),
        recipeReference: id(2),
        expectedAggregateVersion: 0,
      },
    ],
    [
      "a non-UUIDv7 reference",
      { action: "PublishKitchen", operationReference: "x", recipeReference: id(2) },
    ],
  ])("refuses %s", (_name, body) => {
    expect(() => parseRecipeCommandBody(body)).toThrow();
  });
});
