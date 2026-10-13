import { expect, it } from "vitest";
import { ordinaryRefundProgress } from "./merchant-ordinary-refund-progress.js";

it("WP-2423 Q5: names a request's progress from its payment states", () => {
  expect(ordinaryRefundProgress(true, ["Confirmed"])).toBe("Declined");
  expect(ordinaryRefundProgress(false, ["Confirmed", "Confirmed"])).toBe("Refunded");
  expect(ordinaryRefundProgress(false, ["NotDispatched"])).toBe("Recorded");
  expect(ordinaryRefundProgress(false, ["Confirmed", "NeedsReconciliation"])).toBe("Sending");
  expect(ordinaryRefundProgress(false, ["Prepared"])).toBe("Sending");
});
