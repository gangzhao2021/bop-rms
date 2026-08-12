import { describe, expect, it } from "vitest";
import {
  STORE_SETUP_STEPS,
  parseStoreDetailView,
  parseStoreListView,
  parseStoreRouteReference,
  parseStoreSetupView,
} from "./store-admin.js";
import { STORE_REFERENCE, detailView, listView, setupView } from "./store-admin.fixtures.js";

describe("Store administration screen contracts", () => {
  it("accepts closed list/detail/setup views and exact UUIDv7 route", () => {
    expect(parseStoreRouteReference(STORE_REFERENCE)).toBe(STORE_REFERENCE);
    expect(parseStoreListView(listView()).items).toHaveLength(1);
    expect(Object.keys(parseStoreDetailView(detailView()).sections)).toHaveLength(10);
    expect(parseStoreSetupView(setupView()).steps.map((step) => step.step)).toEqual(
      STORE_SETUP_STEPS,
    );
  });

  it("rejects open, mismatched and unordered values", () => {
    expect(() => parseStoreListView({ ...listView(), injected: true })).toThrow(
      "STORE_ADMIN_INVALID",
    );
    expect(() =>
      parseStoreDetailView({
        ...detailView(),
        sections: { ...detailView().sections, Secret: "Configured" },
      }),
    ).toThrow("STORE_ADMIN_INVALID");
    const setup = setupView();
    expect(() => parseStoreSetupView({ ...setup, steps: setup.steps.toReversed() })).toThrow(
      "STORE_ADMIN_INVALID",
    );
    expect(() => parseStoreRouteReference("not-a-store")).toThrow("STORE_ADMIN_INVALID");
  });
});
