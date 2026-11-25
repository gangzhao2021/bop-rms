import { describe, expect, it } from "vitest";
import {
  refundsBehindRefunded,
  type ListedRefundPart,
  type RecordedRefund,
  type RefundWay,
} from "./refund-assignment.js";

// What the server puts in an order's record (persistent-merchant-order-queue.ts): a counter
// payment's refunds (card machine or cash), a card-machine round payment's refunds, a table's
// cash, card-machine and card refunds (to the card once sent, answered or not), and ordinary
// refunds once sent to the Provider (answered or not). Never a cancelled item's refund or an
// online cancellation refund.
const r = (method: RefundWay, amountMinor: string, at: string): RecordedRefund => ({
  method,
  amountMinor,
  at: `2026-11-24T${at}:00.000Z`,
});
/** A listed refund the record holds (a cancellation given back on the card machine or in cash). */
const held = (method: RefundWay, amountMinor: bigint, at?: string): ListedRefundPart =>
  at === undefined
    ? { method, amountMinor, inRecord: true }
    : { method, amountMinor, at: `2026-11-24T${at}:00.000Z`, inRecord: true };
/** A listed refund the record never holds (a cancelled item, an online cancellation). */
const apart = (amountMinor: bigint): ListedRefundPart => ({
  method: "Online",
  amountMinor,
  inRecord: false,
});
const settled = { onlineMayBeOnItsWay: false } as const;
const onItsWay = { onlineMayBeOnItsWay: true } as const;
const behind = (
  record: readonly RecordedRefund[],
  listed: readonly ListedRefundPart[],
  refundedMinor: bigint,
  context: { readonly onlineMayBeOnItsWay: boolean } = settled,
) => refundsBehindRefunded(record, listed, refundedMinor, context);

describe("F27 round 2: the record refunds behind 'Refunded', only when provably unique", () => {
  it("an empty record, or nothing to show, says nothing", () => {
    expect(behind([], [], 500n)).toBeNull();
    expect(behind([], [apart(500n)], 500n)).toBeNull();
    expect(behind([r("Online", "500", "22:59")], [], 0n)).toBeNull();
  });

  it("the whole record is the money to show when nothing is listed above", () => {
    const record = [r("Cash", "375", "03:28"), r("Online", "500", "03:59")];
    expect(behind(record, [], 875n)).toEqual(record);
  });

  it("a partial record (less or more than the money to show) says nothing", () => {
    expect(behind([r("Online", "500", "22:59")], [], 800n)).toBeNull();
    expect(behind([r("Online", "500", "22:59")], [], 300n)).toBeNull();
    // Partly refunded: a $3.00 refund of a $10.00 payment is exactly that $3.00.
    expect(behind([r("CardMachine", "300", "21:05")], [], 300n)).toEqual([
      r("CardMachine", "300", "21:05"),
    ]);
  });

  it("same amount, different ways, in both orders: the listed one is taken by its way", () => {
    const machine = r("CardMachine", "1200", "21:05");
    const cash = r("Cash", "1200", "22:59");
    for (const record of [
      [machine, cash],
      [cash, machine],
    ]) {
      expect(behind(record, [held("CardMachine", 1200n)], 1200n)).toEqual([cash]);
      expect(behind(record, [held("Cash", 1200n)], 1200n)).toEqual([machine]);
    }
  });

  it("several refunds of one way and amount: all taken is certain, one of two at other times is not", () => {
    const first = r("CardMachine", "1200", "21:05");
    const second = r("CardMachine", "1200", "21:15");
    const cash = r("Cash", "500", "02:28");
    const two = [held("CardMachine", 1200n), held("CardMachine", 1200n)];
    expect(behind([first, second, cash], two, 500n)).toEqual([cash]);
    expect(behind([cash, second, first], two, 500n)).toEqual([cash]);
    // One listed, two in the record at different times: which is left over is not known.
    expect(behind([first, second], [held("CardMachine", 1200n)], 1200n)).toBeNull();
    // Two exactly alike (same time too) cannot be told apart: either is the same line.
    const twin = r("CardMachine", "1200", "21:05");
    expect(behind([first, twin], [held("CardMachine", 1200n)], 1200n)).toEqual([twin]);
    // A listed refund that knows its time takes exactly that one.
    expect(behind([first, second], [held("CardMachine", 1200n, "21:15")], 1200n)).toEqual([first]);
    // More listed than the record holds: not in the record yet.
    expect(behind([first, cash], two, 500n)).toBeNull();
  });

  it("listed parts made of several refunds are taken one by one, never as one equal refund", () => {
    // Two card-machine round cancellations ($2.00, $3.00) and an unrelated $5.00 on the machine.
    const parts = [held("CardMachine", 200n), held("CardMachine", 300n)];
    const two = r("CardMachine", "200", "21:00");
    const three = r("CardMachine", "300", "21:10");
    const other = r("CardMachine", "500", "22:59");
    expect(behind([two, three, other], parts, 500n)).toEqual([other]);
    expect(behind([other, three, two], parts, 500n)).toEqual([other]);
    // The record holds only the unrelated $5.00: it is never taken for the two parts.
    expect(behind([other], parts, 500n)).toBeNull();
    // Only one of the two parts is in the record: still not certain.
    expect(behind([two, other], parts, 500n)).toBeNull();
  });

  it("a cancelled item's refund (never in the record) takes no record refund", () => {
    // $2.00 + $3.00 of items back online, then an unrelated ordinary $5.00 at 22:59 (answered).
    const ordinary = r("Online", "500", "22:59");
    expect(behind([ordinary], [apart(200n), apart(300n)], 500n)).toEqual([ordinary]);
    // One cancelled item of exactly $5.00: still never takes the ordinary refund of $5.00.
    expect(behind([ordinary], [apart(500n)], 500n)).toEqual([ordinary]);
  });

  it("round 2 scenario: refunds still on their way are never said as given back", () => {
    // A pickup: one cancelled item refunded $5.00 online (not in the record); an ordinary $5.00
    // answered at 22:59; ordinary $2.00 (21:00) and $3.00 (21:10) sent, not answered yet.
    const record = [
      r("Online", "200", "21:00"),
      r("Online", "300", "21:10"),
      r("Online", "500", "22:59"),
    ];
    expect(behind(record, [apart(500n)], 500n, onItsWay)).toBeNull();
    // Had the item's refund taken the $5.00, the two on their way would have been left as $5.00.
    expect(behind(record, [apart(500n)], 500n, settled)).toBeNull();
    // A card-machine or cash refund is never on its way: it is said even then.
    const cash = r("Cash", "375", "02:28");
    expect(behind([cash], [], 375n, onItsWay)).toEqual([cash]);
    expect(behind([cash, r("Online", "300", "21:10")], [], 375n, onItsWay)).toBeNull();
  });

  it("the record holds only a listed refund and the other money is not in it: says nothing", () => {
    const machine = r("CardMachine", "1200", "21:05");
    expect(behind([machine], [held("CardMachine", 1200n)], 1200n)).toBeNull();
    expect(behind([machine], [held("CardMachine", 1200n)], 600n)).toBeNull();
    // The record's total equals the money to show, but that $12.00 is the listed cancellation.
    expect(behind([machine], [held("CardMachine", 1200n), apart(500n)], 1200n)).toBeNull();
  });

  it("a listed refund the record should hold but does not says nothing", () => {
    expect(behind([r("Online", "500", "22:59")], [held("Cash", 375n)], 500n)).toBeNull();
    expect(behind([r("Cash", "500", "22:59")], [held("Cash", 500n, "21:00")], 500n)).toBeNull();
  });
});
