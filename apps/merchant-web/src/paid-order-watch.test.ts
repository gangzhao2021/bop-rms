import { describe, expect, it } from "vitest";
import { findInternalText } from "../e2e/internal-text-patterns.js";
import {
  notSentReasonText,
  paidOrderAlarm,
  paidOrderAlarmLines,
  paidOrderRefundDeadlines,
  parsePaidOrderWatch,
  type PaidOrderAlarm,
  type PaidOrderWatch,
} from "./paid-order-watch.js";

const now = Date.parse("2026-11-05T20:00:00.000Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const watch = (input: Partial<PaidOrderWatch>): PaidOrderWatch => ({
  on: true,
  recentlyOn: false,
  settingVersion: 1,
  lastKitchenStepAt: null,
  kitchenScreenSeenAt: null,
  canTurnOff: false,
  canAcceptOrders: false,
  cantMakeRefunds: 0,
  waiting: [],
  ...input,
});
const waiting = (minutes: number, reachedKitchen = true) => ({
  orderNumber: String(minutes),
  orderType: "Pickup" as const,
  acceptedAt: ago(minutes),
  reachedKitchen,
  refundAt: new Date(now + (30 - minutes) * 60_000).toISOString(),
  kept: false,
});

describe("DEC-PAID-ORDER-AUTO-ACCEPT Store-level alarm", () => {
  it("a Store that does not use it, or has nothing old enough, raises nothing", () => {
    expect(paidOrderAlarm(null, now)).toBeNull();
    expect(paidOrderAlarm(watch({ waiting: [waiting(4)] }), now)).toBeNull();
  });

  it("a busy kitchen working other tickets raises nothing, however long the queue", () => {
    expect(
      paidOrderAlarm(
        watch({
          lastKitchenStepAt: ago(2),
          waiting: Array.from({ length: 12 }, (_, index) => waiting(6 + index)),
        }),
        now,
      ),
    ).toBeNull();
  });

  it("no kitchen step for 5 minutes with a paid order waiting raises one alarm, urgent at 10", () => {
    const alarm = paidOrderAlarm(
      watch({ lastKitchenStepAt: ago(6), waiting: [waiting(7), waiting(8)] }),
      now,
    );
    expect(alarm).toMatchObject({ silent: 2, notReached: 0, minutes: 6, tier: 1 });
    expect(paidOrderAlarmLines(alarm as PaidOrderAlarm)).toEqual([
      "The kitchen hasn't touched anything for 6 min and 2 paid orders are waiting · check the kitchen screen",
    ]);
    expect(
      paidOrderAlarm(watch({ lastKitchenStepAt: ago(11), waiting: [waiting(12)] }), now),
    ).toMatchObject({ tier: 2 });
  });

  it("an order sent after a quiet afternoon counts from when it was sent", () => {
    expect(
      paidOrderAlarm(watch({ lastKitchenStepAt: ago(180), waiting: [waiting(6)] }), now),
    ).toMatchObject({ minutes: 6, silent: 1 });
    expect(
      paidOrderAlarm(watch({ lastKitchenStepAt: ago(180), waiting: [waiting(4)] }), now),
    ).toBeNull();
  });

  it("the same quiet stretch keeps its key, so each tier chimes once", () => {
    const first = paidOrderAlarm(watch({ waiting: [waiting(6)] }), now);
    const later = paidOrderAlarm(watch({ waiting: [waiting(6)] }), now + 60_000);
    expect(first?.key).toBe(later?.key);
  });

  it("an order that never reached the kitchen is said even when the kitchen is busy", () => {
    const alarm = paidOrderAlarm(
      watch({ lastKitchenStepAt: ago(1), waiting: [waiting(6, false), waiting(7)] }),
      now,
    );
    expect(alarm).toMatchObject({ notReached: 1, silent: 0 });
    expect(paidOrderAlarmLines(alarm as PaidOrderAlarm).join(" ")).toContain(
      "did not reach the kitchen",
    );
    expect(paidOrderAlarm(watch({ waiting: [waiting(4, false)] }), now)).toBeNull();
  });

  it("only pickups count down to a refund; a table round never does", () => {
    expect(
      paidOrderRefundDeadlines(
        watch({
          waiting: [
            waiting(26),
            { ...waiting(26), orderNumber: "T", orderType: "DineIn", refundAt: null },
          ],
        }),
      ),
    ).toEqual([{ orderNumber: "26", acceptBy: ago(-4), kitchenStart: true }]);
    expect(paidOrderRefundDeadlines(null)).toEqual([]);
  });

  it("one that never reached the kitchen counts down as such: only Orders can stop it", () => {
    expect(paidOrderRefundDeadlines(watch({ waiting: [waiting(26, false)] }))).toEqual([
      { orderNumber: "26", acceptBy: ago(-4), kitchenStart: true, notReached: true },
    ]);
  });

  it("one somebody is making by hand raises nothing", () => {
    expect(
      paidOrderAlarm(
        watch({
          lastKitchenStepAt: ago(20),
          waiting: [
            { ...waiting(12), kept: true, refundAt: null },
            { ...waiting(9, false), kept: true, refundAt: null },
          ],
        }),
        now,
      ),
    ).toBeNull();
  });

  it("a kitchen screen that is off is said after 3 minutes, before the 5-minute quiet rule", () => {
    const alarm = paidOrderAlarm(
      watch({ lastKitchenStepAt: ago(1), kitchenScreenSeenAt: ago(3), waiting: [waiting(2)] }),
      now,
    );
    expect(alarm).toMatchObject({ screenOff: true, silent: 1, minutes: 3, tier: 1 });
    expect(paidOrderAlarmLines(alarm as PaidOrderAlarm)).toEqual([
      "No kitchen screen has been open for 3 min and 1 paid order was sent there · open the kitchen screen",
    ]);
    expect(
      paidOrderAlarm(
        watch({ kitchenScreenSeenAt: ago(11), waiting: [waiting(2), waiting(12)] }),
        now,
      ),
    ).toMatchObject({ screenOff: true, silent: 2, tier: 2 });
  });

  it("an open board, or one not known, leaves the quiet rule as it was", () => {
    expect(
      paidOrderAlarm(watch({ kitchenScreenSeenAt: ago(1), waiting: [waiting(2)] }), now),
    ).toBeNull();
    expect(
      paidOrderAlarm(watch({ kitchenScreenSeenAt: null, waiting: [waiting(2)] }), now),
    ).toBeNull();
    // Nothing sent there, or only what is made by hand: a closed board at night raises nothing.
    expect(paidOrderAlarm(watch({ kitchenScreenSeenAt: ago(60), waiting: [] }), now)).toBeNull();
    expect(
      paidOrderAlarm(
        watch({ kitchenScreenSeenAt: ago(60), waiting: [{ ...waiting(2), kept: true }] }),
        now,
      ),
    ).toBeNull();
  });

  it("the screen-off episode keeps its key while the board stays off, so each tier chimes once", () => {
    const off = watch({ kitchenScreenSeenAt: ago(4), waiting: [waiting(2)] });
    expect(paidOrderAlarm(off, now)?.key).toBe(paidOrderAlarm(off, now + 60_000)?.key);
  });
});

describe("what staff are told", () => {
  it.each([
    ["HasAlcohol", null],
    ["LargeOrder", 22],
    ["LargeOrder", null],
    ["StockChanged", 2],
    ["StoreNotOpen", 2],
    ["KitchenScreenOff", 2],
    ["PaidBeforeSwitch", 2],
    ["PaidTooLongAgo", 2],
    ["NotEligible", 2],
  ])("%s reads as staff words", (reason, count) => {
    const text = notSentReasonText(reason, count);
    expect(text.length).toBeGreaterThan(5);
    expect(findInternalText([text])).toEqual([]);
    expect(text).not.toContain(reason);
  });

  it("names the size of a large order", () => {
    expect(notSentReasonText("LargeOrder", 22)).toContain("22");
  });
});

describe("the watch's own parser", () => {
  it("a Store without it, or a wrong answer, is no watch; the page keeps working", () => {
    expect(parsePaidOrderWatch(undefined)).toBeNull();
    expect(parsePaidOrderWatch(null)).toBeNull();
    expect(parsePaidOrderWatch({ on: "yes" })).toBeNull();
    expect(
      parsePaidOrderWatch({
        on: true,
        settingVersion: 2,
        canTurnOff: true,
        lastKitchenStepAt: "not an instant",
        waiting: [],
      }),
    ).toBeNull();
  });

  it("reads what the server sends", () => {
    expect(
      parsePaidOrderWatch({
        on: true,
        settingVersion: 2,
        canTurnOff: true,
        lastKitchenStepAt: null,
        cantMakeRefunds: 1,
        waiting: [{ ...waiting(6), refundAt: null }],
      }),
    ).toMatchObject({ on: true, canAcceptOrders: false, cantMakeRefunds: 1 });
  });

  it("reads a day after turning off, the board's last read and who is making one by hand", () => {
    const parsed = parsePaidOrderWatch({
      on: false,
      recentlyOn: true,
      settingVersion: 3,
      canTurnOff: false,
      lastKitchenStepAt: null,
      kitchenScreenSeenAt: ago(2),
      cantMakeRefunds: 0,
      waiting: [{ ...waiting(6), refundAt: null, kept: true }, waiting(7)],
    });
    expect(parsed).toMatchObject({ on: false, recentlyOn: true, kitchenScreenSeenAt: ago(2) });
    expect(parsed?.waiting.map((item) => item.kept)).toEqual([true, false]);
    // An earlier server leaves them out: not turned off lately, board not known, none by hand.
    expect(
      parsePaidOrderWatch({
        on: true,
        settingVersion: 1,
        canTurnOff: false,
        lastKitchenStepAt: null,
        waiting: [{ ...waiting(6), kept: undefined }],
      }),
    ).toMatchObject({ recentlyOn: false, kitchenScreenSeenAt: null, waiting: [{ kept: false }] });
  });
});
