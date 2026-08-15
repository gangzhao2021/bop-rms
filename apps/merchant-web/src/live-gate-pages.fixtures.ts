import type { LiveGatePageView } from "./live-gate-pages.js";
export const blockedGate = {
  gateReference: "018f0000-0000-7000-8000-000000000010",
  gateId: "STORE-LIVE-GATE-CA-ON-TOR-001",
  tenant: "Synthetic Tenant",
  storeReference: "018f0000-0000-7000-8000-000000000004",
  store: "Synthetic Toronto Store",
  status: "Blocked",
  owner: "Store readiness owner",
  lastReviewedAt: null,
  requirements: [
    {
      requirementId: "018f0000-0000-7000-8000-000000000011",
      category: "Legal / Store",
      requirement: "IDR-0037 premises evidence",
      owner: "External evidence owner",
      status: "Missing",
      expiry: null,
      blockingReason: "External evidence unavailable",
    },
  ],
  history: [],
} as const;
export const storeLiveGateFixture: LiveGatePageView = {
  screenId: "STORE-LIVE-GATE",
  sourceAsOf: "2026-08-15T12:00:00.000Z",
  freshness: "Fresh",
  completeness: "Complete",
  gates: [blockedGate],
  mayManage: true,
};
export const platformLiveGateFixture: LiveGatePageView = {
  ...storeLiveGateFixture,
  screenId: "PLT-LIVE-GATE",
};
