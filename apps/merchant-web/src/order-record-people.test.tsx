import { afterEach, describe, expect, it } from "vitest";
import { setLanguageForTest } from "./i18n/i18n.js";
import { orderRecordRows, personLabel } from "./CurrentOrderQueuePage.js";
import { parseOrderRecordPeople as parseNullable } from "./current-order-queue-client.js";

const parseOrderRecordPeople = (value: unknown) => {
  const parsed = parseNullable(value);
  if (parsed === null) throw new Error("expected a record");
  return parsed;
};

afterEach(() => setLanguageForTest("en"));

const record = {
  accepted: [{ round: 1, by: "Sam", at: "2026-11-06T00:42:00.000Z" }],
  handedOver: [{ name: "Mia", at: "2026-11-06T01:15:00.000Z" }],
  payments: [
    { method: "CardMachine", part: null, round: null, by: "Sam", at: "2026-11-06T01:20:00.000Z" },
  ],
  cancellations: [],
  refunds: [
    {
      method: "CardMachine",
      amountMinor: "1250",
      by: "Mia",
      approvedBy: "You",
      at: "2026-11-06T01:30:00.000Z",
    },
  ],
  writeOff: null,
  paidOnlineByGuest: false,
};
const tz = "America/Toronto";

describe("M61: the order record says who did what", () => {
  it("parses names and times only, and refuses an id or a nameless staff payment", () => {
    const parsed = parseOrderRecordPeople(record);
    expect(parsed?.accepted[0]?.by).toBe("Sam");
    expect(parseNullable(null)).toBeNull();
    expect(() =>
      parseOrderRecordPeople({
        ...record,
        payments: [{ ...record.payments[0], by: null }],
      }),
    ).toThrow();
    expect(() => parseOrderRecordPeople({ ...record, extra: 1 })).toThrow();
  });

  it("lists accepted, handed over, payment and refund with the approver, in English", () => {
    const parsed = parseOrderRecordPeople(record);
    const rows = orderRecordRows(parsed, "Pickup", tz, "2026-11-05");
    expect(rows.map((row) => [row.label, row.text])).toEqual([
      ["Accepted", "Sam · 19:42"],
      ["Handed over", "Mia · 20:15"],
      ["Payment taken", "Card machine · Sam · 20:20"],
      ["Refund $12.50", "Card machine · asked by Mia, approved by You · 20:30"],
    ]);
  });

  it("v15 b15: a cash refund names the refund and the cash given back from the drawer (en and zh)", () => {
    const cash = {
      ...record,
      payments: [{ ...record.payments[0], method: "Cash" }],
      refunds: [
        {
          ...record.refunds[0],
          method: "Cash",
          amountMinor: "509",
          approvedBy: null,
          cashGivenBackMinor: "510",
        },
      ],
    };
    const rows = orderRecordRows(parseOrderRecordPeople(cash), "Pickup", tz, "2026-11-05");
    expect(rows.at(-1)).toMatchObject({
      label: "Refund $5.09",
      text: "Cash, $5.10 given back from the drawer · Mia · 20:30",
    });
    setLanguageForTest("zh-Hans");
    expect(
      orderRecordRows(parseOrderRecordPeople(cash), "Pickup", tz, "2026-11-05").at(-1)?.text,
    ).toContain("现金，从钱箱退还 $5.10");
    // Only a cash refund carries the drawer's cash, and only as an amount.
    expect(() =>
      parseOrderRecordPeople({ ...cash, refunds: [{ ...cash.refunds[0], method: "CardMachine" }] }),
    ).toThrow();
    expect(() =>
      parseOrderRecordPeople({
        ...cash,
        refunds: [{ ...cash.refunds[0], cashGivenBackMinor: 510 }],
      }),
    ).toThrow();
  });

  it("says an automatic acceptance and an online payment plainly, per round at a table", () => {
    const parsed = parseOrderRecordPeople({
      ...record,
      accepted: [
        { round: 1, by: null, at: "2026-11-06T00:42:00.000Z" },
        { round: 2, by: "Mia", at: "2026-11-06T01:05:00.000Z" },
      ],
      handedOver: [],
      payments: [
        { method: "Online", part: 2, round: null, by: null, at: "2026-11-06T01:40:00.000Z" },
        { method: "Cash", part: 1, round: null, by: "Store owner", at: "2026-11-06T01:41:00.000Z" },
      ],
      refunds: [],
      writeOff: {
        amountMinor: "900",
        by: "Mia",
        approvedBy: "Sam",
        at: "2026-11-06T02:00:00.000Z",
      },
    });
    const rows = orderRecordRows(parsed, "DineIn", tz, "2026-11-05");
    expect(rows.map((row) => [row.label, row.text])).toEqual([
      ["Round 1 accepted", "Automatically, when paid · 19:42"],
      ["Round 2 accepted", "Mia · 20:05"],
      ["Part 2 paid", "Paid online by the guest · 20:40"],
      ["Part 1 paid", "Cash · Store owner · 20:41"],
      ["Written off $9.00", "Asked by Mia, approved by Sam · 21:00"],
    ]);
  });

  it("v15 batch 7: a table that pays at the end says its round was accepted when sent, not when paid", () => {
    const parsed = parseOrderRecordPeople({
      ...record,
      accepted: [{ round: 1, by: null, at: "2026-11-06T00:42:00.000Z" }],
      handedOver: [],
      payments: [],
      refunds: [],
    });
    const rows = orderRecordRows(parsed, "DineIn", tz, "2026-11-05", true);
    expect(rows.map((row) => [row.label, row.text])).toEqual([
      ["Round 1 accepted", "Automatically, when sent (the table pays at the end) · 19:42"],
    ]);
    expect(rows.some((row) => row.text.includes("when paid"))).toBe(false);
    setLanguageForTest("zh-Hans");
    expect(orderRecordRows(parsed, "DineIn", tz, "2026-11-05", true)[0]?.text).toBe(
      "送出后自动接单（这桌最后结账）· 19:42",
    );
    setLanguageForTest("en");
  });

  it("reads the same in Chinese, with fixed role names translated and never an id", () => {
    setLanguageForTest("zh-Hans");
    expect(personLabel("Store owner")).toBe("店主");
    expect(personLabel("You")).toBe("你");
    expect(personLabel("Sam")).toBe("Sam");
    const rows = orderRecordRows(parseOrderRecordPeople(record), "Pickup", tz, "2026-11-05");
    expect(rows.map((row) => [row.label, row.text])).toEqual([
      ["已接单", "Sam · 19:42"],
      ["已交付", "Mia · 20:15"],
      ["收款", "刷卡机 · Sam · 20:20"],
      ["退款 $12.50", "刷卡机 · Mia 申请，你 批准 · 20:30"],
    ]);
  });

  it("v15 b12: a paper order entered again is recorded as closed and entered again, never Cancelled (en and zh)", () => {
    const parsed = parseOrderRecordPeople({
      ...record,
      accepted: [],
      handedOver: [],
      payments: [],
      refunds: [],
      cancellations: [{ what: "Order", by: "You", at: "2026-11-06T01:12:00.000Z" }],
    });
    expect(
      orderRecordRows(parsed, "Pickup", tz, "2026-11-05", false, "85").map((row) => [
        row.label,
        row.text,
      ]),
    ).toEqual([["Closed · entered again as order 85", "You · 20:12"]]);
    // Any other whole-order cancellation still reads Cancelled.
    expect(orderRecordRows(parsed, "Pickup", tz, "2026-11-05")[0]?.label).toBe("Cancelled");
    setLanguageForTest("zh-Hans");
    expect(orderRecordRows(parsed, "Pickup", tz, "2026-11-05", false, "85")[0]?.label).toBe(
      "已关闭 · 已重新录入为订单 85",
    );
  });
});
