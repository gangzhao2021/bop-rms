import { describe, expect, it } from "vitest";
import { parseKitchenBoardView, parseKitchenWorkItemView } from "./kitchen-board.js";
import { kitchenBoardFixture, kitchenItemFixture } from "./kitchen-board.fixtures.js";
import {
  applyConfirmedKitchenSteps,
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
    expect(kitchenStepText("Order 6 · Pickup", item, accepted.result)).toBe(
      "Order 6 · Pickup · Latte accepted.",
    );
    expect(
      kitchenStepText("Order 6 · Pickup", item, {
        outcome: "ProgressRecorded",
        completedQuantity: 1,
      }),
    ).toBe("Order 6 · Pickup · Latte 1 of 2 done.");
    expect(
      kitchenStepText("Order 6 · Pickup", item, {
        outcome: "OrderItemReady",
        completedQuantity: 2,
      }),
    ).toBe("Order 6 · Pickup · Latte ready.");
  });
});
