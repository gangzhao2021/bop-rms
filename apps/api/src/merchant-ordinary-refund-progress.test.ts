import { expect, it } from "vitest";
import { ordinaryRefundProgress } from "./merchant-ordinary-refund-progress.js";

it("WP-2423 Q5: names a request's progress from its payment states", () => {
  expect(ordinaryRefundProgress(true, ["Confirmed"])).toBe("Declined");
  expect(ordinaryRefundProgress(false, ["Confirmed", "Confirmed"])).toBe("Refunded");
  expect(ordinaryRefundProgress(false, ["NotDispatched"])).toBe("Recorded");
  expect(ordinaryRefundProgress(false, ["Confirmed", "NeedsReconciliation"])).toBe("Sending");
  // WP-2423 item 6: prepared but not sent is never reported as sent.
  expect(ordinaryRefundProgress(false, ["Prepared"])).toBe("ReadyToSend");
  expect(ordinaryRefundProgress(false, ["Confirmed", "Prepared"])).toBe("ReadyToSend");
  expect(ordinaryRefundProgress(false, ["Confirmed", "NotDispatched"])).toBe("ReadyToSend");
  expect(ordinaryRefundProgress(false, ["NeedsReconciliation", "Prepared"])).toBe("ReadyToSend");
  expect(ordinaryRefundProgress(false, ["NeedsReconciliation"])).toBe("Sending");
});
