import type { FeatureAdminView } from "./feature-control-admin.js";
export const featureItem = {
  controlId: "018f0000-0000-7000-8000-000000000010",
  key: "ordering.delivery.capability",
  description: "Synthetic delivery capability",
  scope: "Store",
  source: "StoreOverride",
  effectiveValue: "Disabled",
  lifecycle: "Approved",
  temporary: true,
  effectiveFrom: "2026-08-15T00:00:00.000Z",
  effectiveUntil: "2026-09-15T00:00:00.000Z",
  expiresAt: "2026-09-15T00:00:00.000Z",
  owner: "Delivery platform owner",
  dependencies: [
    { key: "delivery.provider.readiness", kind: "RequiresFutureTrigger", status: "Unsatisfied" },
  ],
} as const;
export const storeCapabilityFixture: FeatureAdminView = {
  screenId: "STORE-CAPABILITY",
  storeReference: "018f0000-0000-7000-8000-000000000004",
  sourceAsOf: "2026-08-15T12:00:00.000Z",
  freshness: "Fresh",
  completeness: "Complete",
  items: [featureItem],
  mayManage: true,
};
export const featureFlagFixture: FeatureAdminView = {
  ...storeCapabilityFixture,
  screenId: "FEATURE-FLAG-LIST",
  storeReference: null,
};
