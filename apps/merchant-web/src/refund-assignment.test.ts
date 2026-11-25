import { describe, expect, it } from "vitest";
import {
  refundsBehindRefunded,
  type ListedRefundPart,
  type RecordedRefund,
  type RefundWay,
} from "./refund-assignment.js";

const r = (method: RefundWay, amountMinor: string, at: string): RecordedRefund => ({
  method,
  amountMinor,
  at: `2026-11-24T${at}:00.000Z`,
});
const part = (method: RefundWay, amountMinor: bigint, at?: string): ListedRefundPart =>
  at === undefined
    ? { method, amountMinor }
    : { method, amountMinor, at: `2026-11-24T${at}:00.000Z` };

describe("F27 fix-up: the record refunds behind 'Refunded', only when provably unique", () => {
  it("an empty record, or nothing to show, says nothing", () => {
    expect(refundsBehindRefunded([], [], 500n)).toBeNull();
    expect(refundsBehindRefunded([r("Online", "500", "22:59")], [], 0n)).toBeNull();
  });

  it("the whole record is the money to show when nothing is listed above", () => {
    const record = [r("Cash", "375", "03:28"), r("Online", "500", "03:59")];
    expect(refundsBehindRefunded(record, [], 875n)).toEqual(record);
  });

  it("a partial record (less or more than the money to show) says nothing", () => {
    expect(refundsBehindRefunded([r("Online", "500", "22:59")], [], 800n)).toBeNull();
    expect(refundsBehindRefunded([r("Online", "500", "22:59")], [], 300n)).toBeNull();
  });

  it("same amount, different ways, in both orders: the listed one is taken by its way", () => {
    const machine = r("CardMachine", "1200", "21:05");
    const online = r("Online", "1200", "22:59");
    const listed = [part("CardMachine", 1200n)];
    expect(refundsBehindRefunded([machine, online], listed, 1200n)).toEqual([online]);
    expect(refundsBehindRefunded([online, machine], listed, 1200n)).toEqual([online]);
    expect(refundsBehindRefunded([machine, online], [part("Online", 1200n)], 1200n)).toEqual([
      machine,
    ]);
    expect(refundsBehindRefunded([online, machine], [part("Online", 1200n)], 1200n)).toEqual([
      machine,
    ]);
  });

  it("several refunds of one way and amount: all taken is certain, one of two at other times is not", () => {
    const first = r("CardMachine", "1200", "21:05");
    const second = r("CardMachine", "1200", "21:15");
    const cash = r("Cash", "500", "02:28");
    const two = [part("CardMachine", 1200n), part("CardMachine", 1200n)];
    expect(refundsBehindRefunded([first, second, cash], two, 500n)).toEqual([cash]);
    // One listed, two in the record at different times: which is left over is not known.
    expect(refundsBehindRefunded([first, second], [part("CardMachine", 1200n)], 1200n)).toBeNull();
    // Two exactly alike (same time too) cannot be told apart: either is the same line.
    const twin = r("CardMachine", "1200", "21:05");
    expect(refundsBehindRefunded([first, twin], [part("CardMachine", 1200n)], 1200n)).toEqual([
      twin,
    ]);
    // A listed refund that knows its time takes exactly that one.
    expect(
      refundsBehindRefunded([first, second], [part("CardMachine", 1200n, "21:15")], 1200n),
    ).toEqual([first]);
    // More listed than the record holds: not in the record yet.
    expect(refundsBehindRefunded([first, cash], two, 500n)).toBeNull();
  });

  it("cancelled items are taken item by item, never as one record refund equal to their sum", () => {
    const items = [part("Online", 200n), part("Online", 300n)];
    const two = r("Online", "200", "21:00");
    const three = r("Online", "300", "21:10");
    const other = r("Online", "500", "22:59");
    expect(refundsBehindRefunded([two, three, other], items, 500n)).toEqual([other]);
    expect(refundsBehindRefunded([other, three, two], items, 500n)).toEqual([other]);
    // The record holds only the unrelated $5.00: the items are not in it, so no way or time.
    expect(refundsBehindRefunded([other], items, 500n)).toBeNull();
    // Only one of the two items is in the record: still not certain.
    expect(refundsBehindRefunded([two, other], items, 500n)).toBeNull();
  });

  it("the record holds only a listed refund and the other money is not in it: says nothing", () => {
    const machine = r("CardMachine", "1200", "21:05");
    expect(refundsBehindRefunded([machine], [part("CardMachine", 1200n)], 1200n)).toBeNull();
    expect(refundsBehindRefunded([machine], [part("CardMachine", 1200n)], 600n)).toBeNull();
  });

  it("the record's total equal to the money to show still has the listed refunds taken out", () => {
    // Sum of the record is $12.00 = the money to show, but that $12.00 is the listed cancellation.
    expect(
      refundsBehindRefunded(
        [r("CardMachine", "1200", "21:05")],
        [part("CardMachine", 1200n)],
        1200n,
      ),
    ).toBeNull();
  });

  it("a listed refund not in the record at all says nothing", () => {
    expect(
      refundsBehindRefunded([r("Online", "500", "22:59")], [part("Cash", 375n)], 500n),
    ).toBeNull();
    expect(
      refundsBehindRefunded([r("Online", "500", "22:59")], [part("Online", 500n, "21:00")], 0n),
    ).toBeNull();
  });
});
