import { describe, expect, it } from "vitest";
import { diningRoundPhoneNumbers } from "./merchant-dining-qr-join.js";

const id = (n: number) => "01902423-0000-7000-8000-" + n.toString(16).padStart(12, "0");

describe("WP-2423 M139: the table phones panel labels each round by who sent it", () => {
  it("names the sending phone of a guest round and none for a staff round", () => {
    const phones = [
      { participantReference: id(1), phoneNumber: 1 },
      { participantReference: id(2), phoneNumber: 2 },
    ];
    const rounds = diningRoundPhoneNumbers(
      [
        { orderBatchReference: id(10), participantReference: id(2), staffEntered: false },
        // Staff entered it for the table on a guest's session: never shown as that phone's.
        { orderBatchReference: id(11), participantReference: id(1), staffEntered: true },
        { orderBatchReference: id(12), participantReference: null, staffEntered: false },
        // A phone no longer listed at the table (taken off): no number to show.
        { orderBatchReference: id(13), participantReference: id(9), staffEntered: false },
        { orderBatchReference: id(14), participantReference: id(1), staffEntered: false },
      ],
      phones,
    );
    expect(rounds).toEqual([
      { orderBatchReference: id(10), phoneNumber: 2 },
      { orderBatchReference: id(11), phoneNumber: null },
      { orderBatchReference: id(12), phoneNumber: null },
      { orderBatchReference: id(13), phoneNumber: null },
      { orderBatchReference: id(14), phoneNumber: 1 },
    ]);
  });
});
