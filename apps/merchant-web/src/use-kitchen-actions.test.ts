import { describe, expect, it } from "vitest";
import { parseKitchenBoardView, parseKitchenWorkItemView } from "./kitchen-board.js";
import { kitchenBoardFixture, kitchenItemFixture } from "./kitchen-board.fixtures.js";
import {
  applyConfirmedKitchenSteps,
  kitchenActionNotice,
  kitchenStepText,
  type KitchenConfirmedStep,
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
const accepted: KitchenConfirmedStep = {
  workItemReference: kitchenItemFixture().workItemReference,
  ticketReference: kitchenItemFixture().ticketReference,
  result: Object.freeze({
    outcome: "Accepted",
    ticketVersion: "8",
    workItemVersion: "2",
    workItemStatus: "Queued",
    completedQuantity: 0,
    occurredAt: "2026-08-12T15:13:00.000Z",
    projectionPending: true,
  }),
};

describe("WP-2423 a confirmed kitchen step shows at once", () => {
  it("shows the server-confirmed step while the queue projection has not caught up", () => {
    const view = applyConfirmedKitchenSteps(board({}), [accepted]);
    const [latte, croissant] = view.items;
    // Accepted: the next step (Start) is offered, with the versions the server confirmed.
    expect(latte?.status).toBe("Queued");
    expect(latte?.execution).toMatchObject({
      ticketVersion: "8",
      workItemVersion: "2",
      acceptedAt: "2026-08-12T15:13:00.000Z",
    });
    // Other work on the same ticket takes the confirmed ticket version, nothing else.
    expect(croissant?.execution).toMatchObject({
      ticketVersion: "8",
      workItemVersion: "1",
      acceptedAt: null,
    });
    // The changed items still read as valid work items (they are sent with the next step).
    expect(() => parseKitchenWorkItemView(latte)).not.toThrow();
    expect(() => parseKitchenWorkItemView(croissant)).not.toThrow();
  });
  it("leaves the projection as the source once it reaches the confirmed versions", () => {
    const caughtUp = board(
      { status: "In Progress", execution: execution("9", "3", "2026-08-12T15:13:00.000Z") },
      { execution: { ...execution("9", "1", null), orderItemReference: id(10) } },
    );
    expect(applyConfirmedKitchenSteps(caughtUp, [accepted])).toBe(caughtUp);
    // Nothing confirmed: nothing changes.
    const plain = board({});
    expect(applyConfirmedKitchenSteps(plain, [])).toBe(plain);
  });
  it("applies completion and ready exactly as confirmed", () => {
    const started = board({
      status: "In Progress",
      execution: execution("8", "2", "2026-08-12T15:13:00.000Z"),
    });
    const [done] = applyConfirmedKitchenSteps(started, [
      {
        ...accepted,
        result: {
          ...accepted.result,
          outcome: "CompletedAndOrderItemReady",
          ticketVersion: "9",
          workItemVersion: "3",
          workItemStatus: "Completed",
          completedQuantity: 2,
          occurredAt: "2026-08-12T15:20:00.000Z",
        },
      },
    ]).items;
    expect(done).toMatchObject({ status: "Completed", completedQuantity: 2 });
    expect(done?.execution).toMatchObject({
      acceptedAt: "2026-08-12T15:13:00.000Z",
      readyAt: "2026-08-12T15:20:00.000Z",
    });
  });
  it("says what the cook just did in plain words", () => {
    const item = { displayName: "Latte", requiredQuantity: 2 };
    expect(kitchenStepText("Pickup · Order 6", item, accepted.result)).toBe(
      "Pickup · Order 6 · Latte accepted.",
    );
    expect(
      kitchenStepText("Pickup · Order 6", item, {
        outcome: "ProgressRecorded",
        completedQuantity: 1,
      }),
    ).toBe("Pickup · Order 6 · Latte 1 of 2 done.");
    expect(
      kitchenStepText("Pickup · Order 6", item, {
        outcome: "OrderItemReady",
        completedQuantity: 2,
      }),
    ).toBe("Pickup · Order 6 · Latte ready.");
  });
});

describe("WP-2423 (v15 2026-10-16) what the board says about a step that did not complete", () => {
  const attempt = { item: kitchenItemFixture(), operation: {}, revision: 1 } as never;
  it("a busy server is 'try again', never a permission problem", () => {
    const busy = kitchenActionNotice({ kind: "Unknown", attempt, busy: true }, false);
    expect(busy).toEqual({
      heading: "Kitchen busy, try again",
      text: "The kitchen system was busy for a moment and nothing was changed. Try again.",
      retry: "Try again",
    });
    expect(JSON.stringify(busy)).not.toMatch(/permission/iu);
  });
  it("a lost answer offers the same operation again", () => {
    expect(kitchenActionNotice({ kind: "Unknown", attempt, busy: false }, false).retry).toBe(
      "Retry same operation",
    );
  });
  it("only a refusal speaks of permission", () => {
    expect(
      kitchenActionNotice({ kind: "Rejected", attempt, code: "PermissionDenied" }, false).text,
    ).toMatch(/permission/u);
    expect(kitchenActionNotice({ kind: "Rejected", attempt, code: "Conflict" }, false).text).toBe(
      "The work item changed. Refresh and review its current state before choosing an action.",
    );
  });
});
