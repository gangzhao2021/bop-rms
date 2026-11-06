import { expect, it } from "vitest";
import { CatalogError } from "@rms/catalog";
import { menuStopReason, throwSite } from "./merchant-menus.js";

/**
 * v15 2026-10-29: a listing review refused as "unavailable" says where it was refused (a file and
 * line, never a reference), so the cause is found from the page.
 */
it("names the source line an unavailable review was refused at, past its fail helper", () => {
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  let caught: unknown;
  try {
    fail();
  } catch (error) {
    caught = error;
  }
  expect(throwSite(caught)).toMatch(/^merchant-menus-review-stop\.test\.ts:\d+$/u);
  expect(throwSite("not an error")).toBe("unknown");
});

/**
 * WP-2423 item 14: the page is told a reason from a closed list. A code naming a source line, or
 * anything else unforeseen, is "Unexpected": staff try again, and the log has the rest.
 */
it("sends only a named reason to the page", () => {
  for (const reason of [
    "NoAllergenList",
    "AllergenListChanged",
    "AllergenEvidenceDiffers",
    "NoAllergenEvidence",
    "NoDraft",
    "NotAuthorized",
    "NoConfiguration",
    "ChoiceGroup",
  ]) {
    expect(menuStopReason(reason)).toBe(reason);
    expect(menuStopReason("Submit:" + reason)).toBe(reason);
  }
  for (const reason of [
    "Unknown",
    "Submit:Unavailable@merchant-menus.ts:123",
    "Submit:Unavailable@merchant-menus.ts:123:ChoiceGroupRule",
    "Unexpected:TypeError:CATALOG_DEPENDENCY_UNAVAILABLE",
    "",
  ])
    expect(menuStopReason(reason)).toBe("Unexpected");
});
