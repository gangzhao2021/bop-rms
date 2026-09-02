import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { CatalogMenuStatePanel, MenuBuilderScreen, MenuListScreen } from "./CatalogMenuPages.js";
import { menuBuilderFixture, menuListFixture } from "./catalog-menu.fixtures.js";
import { parseMenuBuilderView, parseMenuListView } from "./catalog-menu.js";

describe("WP-1802 Catalog authoring and publish screens", () => {
  it("renders list facts and labels projection gaps as unavailable", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <MenuListScreen view={parseMenuListView(menuListFixture())} />
      </MemoryRouter>,
    );
    expect(html).toContain("CAT-MENU-LIST");
    expect(html).toContain("Synthetic All Day");
    expect(html).toContain("Scope / channels");
    expect(html.match(/Unavailable from catalog_menu_management_v1/g)?.length).toBe(4);
    expect(html).toContain("Create menu");
    expect(html).toContain("disabled");
  });

  it("renders sections, validation and disabled exact lifecycle actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <MenuBuilderScreen view={parseMenuBuilderView(menuBuilderFixture())} />
      </MemoryRouter>,
    );
    for (const value of [
      "CAT-MENU-BUILDER",
      "Expected Version 4",
      "Synthetic mains",
      "Validation rail",
      "Publish evidence",
      "Submit review",
      "Approve",
      "Publish / schedule",
      "Archive",
    ])
      expect(html).toContain(value);
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it("renders permission and conflict states with safe explanatory text", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CatalogMenuStatePanel state="PermissionDenied" />
        <CatalogMenuStatePanel state="Conflict" />
      </MemoryRouter>,
    );
    expect(html).toContain("Permission denied");
    expect(html).toContain("Source changed");
    expect(html).toContain("authoritative Menu version");
  });
});
