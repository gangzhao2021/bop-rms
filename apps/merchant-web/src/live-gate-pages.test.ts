import { describe, expect, it } from "vitest";
import { platformLiveGateFixture, storeLiveGateFixture } from "./live-gate-pages.fixtures.js";
import { parseLiveGatePageView, parseLiveGateRouteReference } from "./live-gate-pages.js";
describe("WP-2194 Live Gate screen contracts", () => {
  it("retains explicit external-evidence blocking", () => {
    expect(
      parseLiveGatePageView(storeLiveGateFixture, "STORE-LIVE-GATE").gates[0]?.requirements[0],
    ).toMatchObject({ status: "Missing", blockingReason: "External evidence unavailable" });
    expect(parseLiveGatePageView(platformLiveGateFixture, "PLT-LIVE-GATE").gates[0]?.status).toBe(
      "Blocked",
    );
  });
  it("rejects malformed routes and open payloads", () => {
    expect(() => parseLiveGateRouteReference("STORE-LIVE-GATE-CA-ON-TOR-001")).toThrow(
      "LIVE_GATE_PAGE_INVALID",
    );
    expect(() =>
      parseLiveGatePageView({ ...platformLiveGateFixture, extra: true }, "PLT-LIVE-GATE"),
    ).toThrow("LIVE_GATE_PAGE_INVALID");
  });
});
