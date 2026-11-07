import { expect, it } from "vitest";
import { ordinaryRefundRecordEntries } from "./merchant-order-record-people.js";

const request = (n: number, state: "Requested" | "Declined" | "Withdrawn" | "Sent" | "Failed") => ({
  requestReference: "request-" + n,
  actorReference: "manager",
  requestedAt: "2026-11-06T18:0" + n + ":00.000Z",
  method: "Online" as const,
  state,
  goingBackMinor: state === "Sent" ? "2550" : "0",
});

it("WP-2423 M61 review: the order record lists only money Payment sent back as a refund", () => {
  expect(
    ordinaryRefundRecordEntries(
      [
        request(1, "Requested"),
        request(2, "Declined"),
        request(3, "Withdrawn"),
        request(4, "Failed"),
        request(5, "Sent"),
      ],
      [
        {
          requestReference: "request-4",
          approverReference: "owner",
          approvedAt: "2026-11-06T18:14:00.000Z",
        },
        {
          requestReference: "request-5",
          approverReference: "owner",
          approvedAt: "2026-11-06T18:15:00.000Z",
        },
      ],
    ),
  ).toEqual([
    {
      method: "Online",
      amountMinor: "2550",
      actor: "manager",
      approver: "owner",
      at: "2026-11-06T18:15:00.000Z",
    },
  ]);
  // A refund sent with no approval needed is the requester's, at the time they asked.
  expect(ordinaryRefundRecordEntries([request(6, "Sent")], [])).toEqual([
    {
      method: "Online",
      amountMinor: "2550",
      actor: "manager",
      approver: null,
      at: "2026-11-06T18:06:00.000Z",
    },
  ]);
});
