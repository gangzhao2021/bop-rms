import { expect, it } from "vitest";
import {
  cashRefundsAtRequestAmount,
  ordinaryRefundRecordEntries,
} from "./merchant-order-record-people.js";

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

// v15 b15 (DEMO order 16): a $5.09 cash refund request the drawer gave back as $5.10 read
// "Refund $5.10" on the order's Record while the payment pages said "Refunded $5.09".
it("says a counter cash refund at its request's amount, with the drawer's cash beside it", () => {
  const cash = (amountMinor: string, requestReference?: string) => ({
    method: "Cash" as const,
    amountMinor,
    actor: "manager",
    approver: null,
    at: "2026-11-13T18:55:40.829Z",
    ...(requestReference === undefined ? {} : { requestReference }),
  });
  const requests = [
    { requestReference: "request-1", amountMinor: "509" },
    { requestReference: "request-2", amountMinor: "435" },
  ];
  expect(
    cashRefundsAtRequestAmount(
      [
        cash("510", "request-1"),
        cash("435", "request-2"),
        // A cancellation's cash (no request) and a request not read: as the drawer recorded it.
        cash("2245"),
        cash("100", "request-9"),
        { ...cash("300", "request-1"), method: "CardMachine" as const },
      ],
      requests,
    ),
  ).toEqual([
    { ...cash("509"), cashGivenBackMinor: "510" },
    cash("435"),
    cash("2245"),
    cash("100"),
    { ...cash("300"), method: "CardMachine" },
  ]);
});
