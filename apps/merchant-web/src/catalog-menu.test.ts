import { describe, expect, it } from "vitest";
import { menuBuilderFixture, menuListFixture } from "./catalog-menu.fixtures.js";
import {
  parseMenuBuilderView,
  parseMenuListView,
  parseMenuRouteReference,
} from "./catalog-menu.js";

describe("WP-1802 Catalog menu browser contracts", () => {
  it("admits the closed WP-1027 menu projection", () => {
    expect(parseMenuListView(menuListFixture())).toMatchObject({
      screenId: "CAT-MENU-LIST",
      items: [{ internalCode: "ALL_DAY", lifecycle: "Approved" }],
    });
  });

  it("rejects open, stale and duplicate list data", () => {
    expect(() => parseMenuListView({ ...menuListFixture(), secret: "hidden" })).toThrow();
    expect(() =>
      parseMenuListView({
        ...menuListFixture(),
        projection: { ...menuListFixture().projection, stale: true },
      }),
    ).toThrow();
    expect(() =>
      parseMenuListView({
        ...menuListFixture(),
        items: [menuListFixture().items[0], menuListFixture().items[0]],
      }),
    ).toThrow();
  });

  it("admits only the closed, ordered builder projection", () => {
    expect(parseMenuBuilderView(menuBuilderFixture())).toMatchObject({
      screenId: "CAT-MENU-BUILDER",
      version: 4,
      unresolvedIssueCount: 1,
    });
    expect(() =>
      parseMenuBuilderView({
        ...menuBuilderFixture(),
        sections: [{ ...menuBuilderFixture().sections[0], validation: "Trusted" }],
      }),
    ).toThrow();
    expect(() =>
      parseMenuBuilderView({
        ...menuBuilderFixture(),
        sections: [menuBuilderFixture().sections[0], menuBuilderFixture().sections[0]],
      }),
    ).toThrow();
  });

  it("accepts only UUIDv7 route references", () => {
    expect(parseMenuRouteReference("018f7600-0000-7000-8000-000000000001")).toMatch(/-7/);
    expect(() => parseMenuRouteReference("../../private-table")).toThrow();
  });
});
