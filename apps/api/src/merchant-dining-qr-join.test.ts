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
        {
          orderBatchReference: id(10),
          guestSessionReference: id(110),
          participantReference: id(2),
          staffEntered: false,
        },
        // Staff entered it for the table on a guest's session: never shown as that phone's.
        {
          orderBatchReference: id(11),
          guestSessionReference: id(111),
          participantReference: id(1),
          staffEntered: true,
        },
        {
          orderBatchReference: id(12),
          guestSessionReference: id(112),
          participantReference: null,
          staffEntered: false,
        },
        // A phone no longer listed at the table (taken off): no number to show.
        {
          orderBatchReference: id(13),
          guestSessionReference: id(113),
          participantReference: id(9),
          staffEntered: false,
        },
        {
          orderBatchReference: id(14),
          guestSessionReference: id(114),
          participantReference: id(1),
          staffEntered: false,
        },
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

  it("batch 42: labels a round from a phone that joined the table cart by the phone Identity bound its session to", () => {
    // v15 L41 OSB P: phone 1 opened the table cart (one Create row); phone 2 joined later and
    // sent round 2 with no cart record of its own, so the round's own sender read as unknown.
    const phones = [
      { participantReference: id(1), phoneNumber: 1 },
      { participantReference: id(2), phoneNumber: 2 },
    ];
    const rounds = diningRoundPhoneNumbers(
      [
        {
          orderBatchReference: id(20),
          guestSessionReference: id(31),
          participantReference: id(1),
          staffEntered: false,
        },
        {
          orderBatchReference: id(21),
          guestSessionReference: id(32),
          participantReference: null,
          staffEntered: false,
        },
        {
          orderBatchReference: id(22),
          guestSessionReference: id(31),
          participantReference: id(1),
          staffEntered: false,
        },
        // A session Identity never bound to this table, and no cart record: still no label.
        {
          orderBatchReference: id(23),
          guestSessionReference: id(33),
          participantReference: null,
          staffEntered: false,
        },
        // Staff rounds stay unlabelled whatever their session is bound to.
        {
          orderBatchReference: id(24),
          guestSessionReference: id(32),
          participantReference: null,
          staffEntered: true,
        },
      ],
      phones,
      new Map([
        [id(31), id(1)],
        [id(32), id(2)],
      ]),
    );
    expect(rounds.map((round) => round.phoneNumber)).toEqual([1, 2, 1, null, null]);
  });
});
