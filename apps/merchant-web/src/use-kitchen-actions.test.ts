import { describe, expect, it } from "vitest";
import { parseKitchenBoardView, parseKitchenWorkItemView } from "./kitchen-board.js";
import { kitchenBoardFixture, kitchenItemFixture } from "./kitchen-board.fixtures.js";
import type { KitchenStepLineResult } from "./kitchen-step-client.js";
import {
  applyConfirmedKitchenSteps,
  kitchenRefusalText,
  kitchenStepText,
  kitchenTargetName,
  withoutTapProblems,
  type KitchenConfirmedStep,
  type KitchenStepNotice,
} from "./use-kitchen-actions.js";

const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const execution = (ticketVersion: string, workItemVersion: string, acceptedAt: string | null) => ({
  orderItemReference: id(4),
  stationReference: id(5),
  ticketVersion,
  workItemVersion,
  acceptedAt,
  readyAt: null,
});
const board = (latte: Record<string, unknown>, sibling: Record<string, unknown> = {}) =>
  parseKitchenBoardView({
    ...kitchenBoardFixture(),
    items: [
      { ...kitchenItemFixture(), execution: execution("7", "1", null), ...latte },
      {
        ...kitchenItemFixture(),
        workItemReference: id(9),
        displayName: "Croissant",
        execution: { ...execution("7", "1", null), orderItemReference: id(10) },
        ...sibling,
      },
    ],
  });
const line = (change: Partial<KitchenStepLineResult>): KitchenStepLineResult => ({
  workItemReference: kitchenItemFixture().workItemReference,
  orderItemReference: id(4),
  ticketReference: kitchenItemFixture().ticketReference,
  outcome: "Finished",
  refusedReason: null,
  ticketVersion: "10",
  workItemVersion: "4",
  workItemStatus: "Completed",
  completedQuantity: 2,
  requiredQuantity: 2,
  acceptedAt: "2026-08-12T15:13:00.000Z",
  readyAt: "2026-08-12T15:13:00.000Z",
  dishesDone: null,
  ...change,
});
const step = (result: KitchenStepLineResult): KitchenConfirmedStep => ({
  workItemReference: result.workItemReference,
  ticketReference: result.ticketReference,
  result,
});

describe("WP-2423 a confirmed kitchen step shows at once", () => {
  it("shows the server-confirmed step while the queue projection has not caught up", () => {
    const view = applyConfirmedKitchenSteps(board({}), [step(line({}))]);
    const [latte, croissant] = view.items;
    expect(latte).toMatchObject({ status: "Completed", completedQuantity: 2 });
    expect(latte?.execution).toMatchObject({
      ticketVersion: "10",
      workItemVersion: "4",
      acceptedAt: "2026-08-12T15:13:00.000Z",
      readyAt: "2026-08-12T15:13:00.000Z",
    });
    // Other work on the same ticket is left alone: the browser sends no versions any more.
    expect(croissant?.execution).toMatchObject({ ticketVersion: "7", workItemVersion: "1" });
    expect(() => parseKitchenWorkItemView(latte)).not.toThrow();
  });
  it("leaves the projection as the source once it reaches the confirmed versions", () => {
    const caughtUp = board({
      status: "Completed",
      completedQuantity: 2,
      execution: execution("10", "4", "2026-08-12T15:13:00.000Z"),
    });
    expect(applyConfirmedKitchenSteps(caughtUp, [step(line({}))])).toBe(caughtUp);
    const plain = board({});
    expect(applyConfirmedKitchenSteps(plain, [])).toBe(plain);
  });
  it("shows a combo's dish done at once, though the work item's versions did not move", () => {
    const parts = [
      { optionReference: id(20), nameZh: "奶茶", name: "Milk tea", done: false, served: false },
      { optionReference: id(21), nameZh: "薯条", name: "Fries", done: false, served: false },
    ];
    const started = board({
      status: "In Progress",
      comboParts: parts,
      execution: execution("8", "3", "2026-08-12T15:13:00.000Z"),
    });
    const [combo] = applyConfirmedKitchenSteps(started, [
      step(
        line({
          outcome: "DishDone",
          ticketVersion: "8",
          workItemVersion: "3",
          workItemStatus: "In Progress",
          completedQuantity: 0,
          readyAt: null,
          dishesDone: [id(20)],
        }),
      ),
    ]).items;
    expect(combo?.comboParts?.map((part) => part.done)).toEqual([true, false]);
    expect(combo?.status).toBe("In Progress");
  });
  it("names the dish a cook finished on a combo's card, never the whole combo", () => {
    const parts = [
      { optionReference: id(20), nameZh: "奶茶", name: "Milk tea", done: false, served: false },
      { optionReference: id(21), nameZh: "", name: "Fries", done: false, served: false },
    ];
    const [combo] = board({ displayName: "Set for two", comboParts: parts }).items;
    if (combo === undefined) throw new Error("fixture");
    const target = (optionReferences: readonly string[] | null) => ({
      lineKey: combo.workItemReference,
      item: combo,
      optionReferences,
    });
    expect(kitchenTargetName(target([id(20)]))).toBe("奶茶");
    expect(kitchenTargetName(target([id(21)]))).toBe("Fries");
    expect(kitchenTargetName(target([id(20), id(21)]))).toBe("奶茶, Fries");
    // The foot button finished the whole combo: then it is the combo that is done.
    expect(kitchenTargetName(target(null))).toBe("Set for two");
  });
  it("says what the cook just did in plain words, and nothing when nothing changed", () => {
    expect(kitchenStepText("Order 6", "Latte", { outcome: "Finished" })).toBe(
      "Order 6 · Latte done.",
    );
    expect(kitchenStepText("Order 6", "Latte", { outcome: "Started" })).toBe(
      "Order 6 · Latte started.",
    );
    expect(kitchenStepText("Order 6", "Latte", { outcome: "AlreadyFinished" })).toBeNull();
    expect(kitchenStepText("Order 6", "Latte", { outcome: "AlreadyStarted" })).toBeNull();
  });
  it("WP-2423 live minor 8: a tap said not recorded and then retried through says it went through", () => {
    // The first send reached the server: the retry's replay answers "already".
    expect(kitchenStepText("Order 6", "Latte", { outcome: "AlreadyFinished" }, true)).toBe(
      "Order 6 · Latte done.",
    );
    expect(kitchenStepText("Order 6", "Latte", { outcome: "AlreadyStarted" }, true)).toBe(
      "Order 6 · Latte started.",
    );
    const notices: KitchenStepNotice[] = [
      { id: 3, tone: "Problem", text: "Order 6 · Latte is not recorded yet.", at: 3, tapId: 7 },
      { id: 2, tone: "Problem", text: "Croissant is not recorded yet.", at: 2, tapId: 8 },
      { id: 1, tone: "Done", text: "Order 5 · Tea done.", at: 1, tapId: 7 },
      { id: 0, tone: "Problem", text: "The action was not accepted.", at: 0 },
    ];
    // Tap 7 answered: its "not recorded" goes; another tap's, a Done line and others stay.
    expect(withoutTapProblems(notices, 7).map((notice) => notice.id)).toEqual([2, 1, 0]);
    expect(withoutTapProblems(notices, 9)).toBe(notices);
  });
  it("says why a line of a tap was left out, in staff words", () => {
    expect(kitchenRefusalText("Latte", "Cancelled")).toBe(
      "Latte was cancelled, so nothing was recorded for it.",
    );
    for (const reason of ["Closed", "Held", "Blocked", "OrderChanged", "NotFound"] as const)
      expect(kitchenRefusalText("Latte", reason)).not.toMatch(
        /KITCHEN|\bunavailable\b|operation/iu,
      );
  });
});
