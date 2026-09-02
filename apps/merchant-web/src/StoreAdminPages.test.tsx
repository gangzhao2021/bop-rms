import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  LocalDemoNotice,
  StoreAdminStatePanel,
  StoreDetailScreen,
  StoreHoursServiceScreen,
  StoreListScreen,
  StoreSetupScreen,
} from "./StoreAdminPages.js";
import { detailView, hoursServiceView, listView, setupView } from "./store-admin.fixtures.js";
import {
  parseStoreDetailView,
  parseStoreHoursServiceView,
  parseStoreListView,
  parseStoreSetupView,
} from "./store-admin.js";

describe("Store administration Section 88 screens", () => {
  it("labels local preview data without implying authority or publication", () => {
    const html = renderToStaticMarkup(<LocalDemoNotice />);
    expect(html).toContain("Local synthetic preview");
    expect(html).toContain("Read-only training data");
    expect(html).toContain("No API, permission, business fact, or publication is implied");
    expect(html).toContain('role="status"');
  });

  it("renders every STORE-LIST field group and safe actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StoreListScreen view={parseStoreListView(listView())} />
      </MemoryRouter>,
    );
    for (const value of [
      "STORE-LIST",
      "TRAINING_01",
      "Training Store",
      "America/Toronto",
      "Synthetic Avenue",
      "DineIn, Pickup",
      "Today hours",
      "Live gate",
      "Configuration",
    ])
      expect(html).toContain(value);
    expect(html).toContain("Create draft");
    expect(html).toContain("disabled");
  });

  it("renders all STORE-DETAIL sections without inferring unavailable as empty", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StoreDetailScreen view={parseStoreDetailView(detailView())} />
      </MemoryRouter>,
    );
    for (const section of Object.keys(detailView().sections)) expect(html).toContain(section);
    expect(html).toContain("no zero/empty value is inferred");
  });

  it("renders ordered STORE-SETUP steps and evidence-gated disabled commands", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StoreSetupScreen view={parseStoreSetupView(setupView())} />
      </MemoryRouter>,
    );
    expect(html).toContain("Expected Version 3");
    expect(html).toContain("Evidence gate:");
    expect(html).toContain("TaxPaymentReferences");
    expect(html).toContain("Save draft");
    expect(html).toContain("Validate step");
    expect(html).toContain("Publish setup");
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it("renders safe, non-color-only permission and conflict states", () => {
    const permission = renderToStaticMarkup(
      <MemoryRouter>
        <StoreAdminStatePanel state="PermissionDenied" />
      </MemoryRouter>,
    );
    const conflict = renderToStaticMarkup(
      <MemoryRouter>
        <StoreAdminStatePanel state="Conflict" />
      </MemoryRouter>,
    );
    expect(permission).toContain("Permission denied");
    expect(permission).toContain("current permission and Store scope");
    expect(conflict).toContain("Source changed");
    expect(conflict).toContain("authoritative Store version");
  });

  it("renders STORE-HOURS-SERVICE source, Business Day Start and safe controls", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <StoreHoursServiceScreen view={parseStoreHoursServiceView(hoursServiceView())} />
      </MemoryRouter>,
    );
    for (const value of [
      "STORE-HOURS-SERVICE",
      "StoreOverride",
      "Business Day Start",
      "04:00:00 local",
      "Monday",
      "Pause service safely",
    ])
      expect(html).toContain(value);
  });
});
