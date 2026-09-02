import { describe, expect, it } from "vitest";
import { featureFlagFixture, storeCapabilityFixture } from "./feature-control-admin.fixtures.js";
import { parseFeatureAdminRouteReference, parseFeatureAdminView } from "./feature-control-admin.js";
describe("WP-2193 Feature Control screen contracts", () => {
  it("parses closed canonical views", () => {
    expect(
      parseFeatureAdminView(storeCapabilityFixture, "STORE-CAPABILITY").items[0]?.dependencies[0]
        ?.status,
    ).toBe("Unsatisfied");
    expect(
      parseFeatureAdminView(featureFlagFixture, "FEATURE-FLAG-LIST").storeReference,
    ).toBeNull();
  });
  it("rejects route and payload ambiguity", () => {
    expect(() => parseFeatureAdminRouteReference("not-a-reference")).toThrow(
      "FEATURE_ADMIN_INVALID",
    );
    expect(() =>
      parseFeatureAdminView({ ...featureFlagFixture, extra: true }, "FEATURE-FLAG-LIST"),
    ).toThrow("FEATURE_ADMIN_INVALID");
  });
});
