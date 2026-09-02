import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { FeatureFlagListPage, StoreCapabilityPage } from "./FeatureControlAdminPages.js";
import { featureFlagFixture, storeCapabilityFixture } from "./feature-control-admin.fixtures.js";
import type { FeatureAdminClient } from "./feature-control-admin.js";
const client: FeatureAdminClient = {
  loadStoreCapabilities: async () => storeCapabilityFixture,
  loadFeatures: async () => featureFlagFixture,
};
describe("WP-2193 Feature Control pages", () => {
  it("renders the canonical loading states without implying success", () => {
    const store = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={[
          "/app/organization/stores/018f0000-0000-7000-8000-000000000004/capabilities",
        ]}
      >
        <Routes>
          <Route
            path="/app/organization/stores/:id/capabilities"
            element={<StoreCapabilityPage client={client} />}
          />
        </Routes>
      </MemoryRouter>,
    );
    const features = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/app/organization/features"]}>
        <FeatureFlagListPage client={client} />
      </MemoryRouter>,
    );
    expect(store).toContain("Loading Feature Control");
    expect(features).toContain("Loading Feature Control");
  });
});
