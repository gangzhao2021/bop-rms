import { expect, it } from "vitest";
import {
  formatMinorCad,
  unmatchedRefundFailure,
  unmatchedRefundNextStep,
} from "./UnmatchedCaptureRefundAction.js";

it("WP-2423 P6: formats integer minor units without floating point", () => {
  expect(formatMinorCad("2260")).toBe("CAD 22.60");
  expect(formatMinorCad("5")).toBe("CAD 0.05");
  expect(formatMinorCad("-1")).toBe("CAD amount unavailable");
});

it("WP-2423 P6: a requester waits for another manager; an approved refund can be resent", () => {
  expect(unmatchedRefundNextStep({ status: "Unrefunded" })).toBe("Request");
  expect(unmatchedRefundNextStep({ status: "Requested", requestedByYou: true })).toBe(
    "AwaitApproval",
  );
  expect(unmatchedRefundNextStep({ status: "Requested", requestedByYou: false })).toBe("Approve");
  expect(unmatchedRefundNextStep({ status: "Approved" })).toBe("Resend");
  expect(unmatchedRefundNextStep({ status: "Refunded" })).toBe("None");
});

it("WP-2423 P6: names denied, same-approver and changed outcomes; anything else is unknown", () => {
  expect(unmatchedRefundFailure(403, "UNMATCHED_REFUND_PERMISSION_DENIED")).toBe("Denied");
  expect(unmatchedRefundFailure(422, "UNMATCHED_REFUND_SAME_APPROVER")).toBe("SameApprover");
  expect(unmatchedRefundFailure(409, "UNMATCHED_REFUND_STATE_CONFLICT")).toBe("Changed");
  expect(unmatchedRefundFailure(502, null)).toBe("Unknown");
});
