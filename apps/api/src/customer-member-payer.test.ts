import { expect, it } from "vitest";
import { paymentPhone } from "./customer-member.js";

const me = "019a0000-0000-7000-8000-000000000001";
const other = "019a0000-0000-7000-8000-000000000002";
const [mine, theirs] = [
  "019a0000-0000-7000-8000-0000000000a1",
  "019a0000-0000-7000-8000-0000000000a2",
];
const online = [
  { onlinePaymentReference: mine, guestSessionReference: me },
  { onlinePaymentReference: theirs, guestSessionReference: other },
];

it("v15 batch 8: a payment made on another phone's card is that phone's, never this one's to claim", () => {
  expect(paymentPhone({ onlinePaymentReference: mine }, online, me)).toBe("ThisPhone");
  expect(paymentPhone({ onlinePaymentReference: theirs }, online, me)).toBe("OtherPhone");
  // Cash or the card machine at the counter: any phone at the table may say it was theirs.
  expect(paymentPhone({ onlinePaymentReference: null }, online, me)).toBe("Unknown");
});
