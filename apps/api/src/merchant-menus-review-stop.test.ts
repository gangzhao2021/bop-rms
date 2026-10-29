import { expect, it } from "vitest";
import { CatalogError } from "@rms/catalog";
import { throwSite } from "./merchant-menus.js";

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
