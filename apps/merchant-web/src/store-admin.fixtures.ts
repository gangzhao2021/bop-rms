import { STORE_SETUP_STEPS } from "./store-admin.js";

export const STORE_REFERENCE = "018f8100-0000-7000-8000-000000000001";
export const AT = "2026-08-12T15:00:00.000Z";
export const listView = () => ({
  screenId: "STORE-LIST",
  projection: { asOfUtc: AT, freshness: "Current" },
  items: [
    {
      storeReference: STORE_REFERENCE,
      code: "TRAINING_01",
      name: "Training Store",
      lifecycle: "Draft",
      timeZone: "America/Toronto",
      addressSummary: "100 Synthetic Avenue, Toronto",
      serviceModes: ["DineIn", "Pickup"],
      todayHours: "Unavailable",
      liveGate: "Blocked",
      configurationSource: "Store",
      version: 3,
    },
  ],
});

export const detailView = () => ({
  screenId: "STORE-DETAIL",
  storeReference: STORE_REFERENCE,
  name: "Training Store",
  lifecycle: "Draft",
  version: 3,
  projection: { asOfUtc: AT, freshness: "Partial" },
  sections: Object.fromEntries(
    [
      "Summary",
      "Hours",
      "ServiceModes",
      "Capacity",
      "Payments",
      "Tax",
      "Devices",
      "People",
      "Evidence",
      "History",
    ].map((name) => [name, name === "Summary" ? "Configured" : "Unavailable"]),
  ),
});

export const setupView = () => ({
  screenId: "STORE-SETUP",
  storeReference: STORE_REFERENCE,
  name: "Training Store",
  version: 3,
  projection: { asOfUtc: AT, freshness: "Stale" },
  evidenceGate: "Required",
  steps: STORE_SETUP_STEPS.map((step, index) => ({
    step,
    status: index === 0 ? "Valid" : index === 1 ? "InProgress" : "NotStarted",
  })),
});
