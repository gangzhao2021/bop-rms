import { expect, it } from "vitest";
import { partsThisPhoneMayClaim, paymentPhone } from "./customer-member.js";

const me = "019a0000-0000-7000-8000-000000000001";
const other = "019a0000-0000-7000-8000-000000000002";
const meBeforeLostCookie = "019a0000-0000-7000-8000-000000000003";
const [mine, theirs, mineEarlier] = [
  "019a0000-0000-7000-8000-0000000000a1",
  "019a0000-0000-7000-8000-0000000000a2",
  "019a0000-0000-7000-8000-0000000000a3",
];
const online = [
  { onlinePaymentReference: mine, guestSessionReference: me },
  { onlinePaymentReference: theirs, guestSessionReference: other },
  { onlinePaymentReference: mineEarlier, guestSessionReference: meBeforeLostCookie },
];

it("v15 batch 8: a payment made on another phone's card is that phone's, never this one's to claim", () => {
  expect(paymentPhone({ onlinePaymentReference: mine }, online, [me])).toBe("ThisPhone");
  expect(paymentPhone({ onlinePaymentReference: theirs }, online, [me])).toBe("OtherPhone");
  // Cash or the card machine at the counter: any phone at the table may say it was theirs.
  expect(paymentPhone({ onlinePaymentReference: null }, online, [me])).toBe("Unknown");
});

it("v15 batch 8: a phone that lost its cookie and came back as the same guest still owns what it paid before", () => {
  expect(paymentPhone({ onlinePaymentReference: mineEarlier }, online, [me])).toBe("OtherPhone");
  expect(
    paymentPhone({ onlinePaymentReference: mineEarlier }, online, [me, meBeforeLostCookie]),
  ).toBe("ThisPhone");
});

it("v15 batch 8: a phone that paid its own part is offered only that part, claimed or not", () => {
  const parts = [
    { partNumber: 1, certain: true },
    { partNumber: 2, certain: false },
    { partNumber: 3, certain: false },
  ];
  expect(partsThisPhoneMayClaim(parts).map((part) => part.partNumber)).toEqual([1]);
  // A phone that paid nothing itself is asked which of the counter's parts was theirs.
  const counter = parts.map((part) => ({ ...part, certain: false }));
  expect(partsThisPhoneMayClaim(counter).map((part) => part.partNumber)).toEqual([1, 2, 3]);
  // The table's one phone is certain of every part.
  const onlyPhone = parts.map((part) => ({ ...part, certain: true }));
  expect(partsThisPhoneMayClaim(onlyPhone)).toHaveLength(3);
});
