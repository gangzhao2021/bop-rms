import { expect, it } from "vitest";
import { paymentPhone } from "./customer-member.js";

const me = "019a0000-0000-7000-8000-000000000001";
const other = "019a0000-0000-7000-8000-000000000002";
const online = [
  { onlinePaymentReference: "019a0000-0000-7000-8000-0000000000a1", guestSessionReference: me },
  { onlinePaymentReference: "019a0000-0000-7000-8000-0000000000a2", guestSessionReference: other },
];

it("v15 batch 8: a payment made on another phone's card is that phone's, never this one's to claim", () => {
  expect(
    paymentPhone({ onlinePaymentReference: online[0]!.onlinePaymentReference }, online, me),
  ).toBe("ThisPhone");
  expect(
    paymentPhone({ onlinePaymentReference: online[1]!.onlinePaymentReference }, online, me),
  ).toBe("OtherPhone");
  // Cash or the card machine at the counter: any phone at the table may say it was theirs.
  expect(paymentPhone({ onlinePaymentReference: null }, online, me)).toBe("Unknown");
});
