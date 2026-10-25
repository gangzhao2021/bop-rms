import { describe, expect, it } from "vitest";
import { parseDiningStaffCallView } from "./dining-staff-call-client.js";

const call = "018f2331-0000-7000-8000-000000000030";
describe("WP-2423 Q28 staff call answer", () => {
  it("reads only what the server is expected to send", () => {
    expect(
      parseDiningStaffCallView({
        open: { callReference: call, reason: "OrderProblem", calledAt: "2026-10-25T18:00:00.000Z" },
        recentlyClosed: null,
        nextCallAt: null,
      }).open?.reason,
    ).toBe("OrderProblem");
    for (const bad of [
      { open: null, recentlyClosed: null },
      {
        open: { callReference: call, reason: "Coffee", calledAt: "2026-10-25T18:00:00.000Z" },
        recentlyClosed: null,
        nextCallAt: null,
      },
      {
        open: null,
        recentlyClosed: { kind: "Expired", closedAt: "2026-10-25T18:00:00.000Z" },
        nextCallAt: null,
      },
      { open: null, recentlyClosed: null, nextCallAt: "soon" },
    ])
      expect(() => parseDiningStaffCallView(bad)).toThrow();
  });
});
