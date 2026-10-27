import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { parseCurrentOrderDetail } from "./current-order-queue-client.js";
import { removedItemsTotal } from "./CurrentOrderQueuePage.js";
import { PayLaterItemRemoveAction, payLaterRemoveFailureText } from "./PayLaterItemRemoveAction.js";

const id = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const line = (n: number, name: string) => ({
  orderItemReference: id(200 + n),
  orderBatchReference: id(90),
  name,
  options: [],
  quantity: 1,
  customerNote: null,
  unitPrice: money("1000"),
  subtotal: money("1000"),
  discount: money("0"),
  tax: money("130"),
  fee: money("0"),
  total: money("1130"),
  canCancel: false,
  cancellation: null,
});
const detail = (batch: Record<string, unknown>, orderType: "DineIn" | "Pickup" = "DineIn") =>
  parseCurrentOrderDetail(
    {
      screenId: "OPS-ORDER-DETAIL",
      pickupContact: null,
      order: {
        orderReference: id(1),
        orderNumber: "ORD-1001",
        orderType,
        sourceChannel: "Qr",
        submittedAt: "2026-10-11T12:00:00.000Z",
        observedAt: "2026-10-11T12:05:00.000Z",
        initialBatchReference: id(90),
        batches: [
          {
            orderBatchReference: id(90),
            sequence: 1,
            acceptanceStatus: "Accepted",
            canRequestAcceptance: false,
            canCancel: false,
            staffCancellation: null,
            canCancelItems: false,
            ...batch,
          },
        ],
        canRequestAcceptance: false,
        unfulfillable: null,
        pickupNotCollected: false,
        acceptBy: null,
        awaitingPayment: false,
        currentPhase: "InProgress",
        currentVersion: 3,
      },
      lines: {
        items: [line(1, "Synthetic rice bowl"), line(2, "Synthetic soup")],
        totals: {
          subtotal: money("2000"),
          discount: money("0"),
          tax: money("260"),
          fee: money("0"),
          total: money("2260"),
        },
      },
    },
    id(1),
  );

it("DEC-DINE-IN-PAY-LATER: reads the dishes an unpaid round can drop and those it dropped", () => {
  const { order } = detail({ unpaidRemovableItems: [id(201)], unpaidRemovedItems: [id(202)] });
  expect(order.batches[0]?.unpaidRemovableItems).toEqual([id(201)]);
  expect(order.batches[0]?.unpaidRemovedItems).toEqual([id(202)]);
  // An older server leaves them out: nothing to take off.
  expect(detail({}).order.batches[0]?.unpaidRemovableItems).toEqual([]);
  // A pickup order never has them; a dish is never both removable and removed.
  expect(() =>
    detail({ unpaidRemovableItems: [id(201)], unpaidRemovedItems: [] }, "Pickup"),
  ).toThrow();
  expect(() =>
    detail({ unpaidRemovableItems: [id(201)], unpaidRemovedItems: [id(201)] }),
  ).toThrow();
});

it("DEC-DINE-IN-PAY-LATER: offers the action only while a dish can come off the bill", () => {
  const render = (removable: string[]) => {
    const { order, lines } = detail({ unpaidRemovableItems: removable, unpaidRemovedItems: [] });
    const batch = order.batches[0];
    if (!batch) throw new Error("fixture");
    return renderToStaticMarkup(
      <PayLaterItemRemoveAction
        order={order}
        batch={batch}
        lines={lines.items}
        csrf="synthetic"
        onSettled={() => undefined}
      />,
    );
  };
  expect(render([id(201)])).toContain("Take dishes off the bill");
  expect(render([])).toBe("");
});

it("DEC-DINE-IN-PAY-LATER: the bill shows what came off and what is left", () => {
  const { lines } = detail({ unpaidRemovableItems: [], unpaidRemovedItems: [id(202)] });
  expect(removedItemsTotal(lines, new Set([id(202)]))).toEqual({
    cancelled: money("1130"),
    remaining: money("1130"),
  });
  expect(removedItemsTotal(lines, new Set())).toBeNull();
  expect(payLaterRemoveFailureText("AlreadyPaid")).toBe(
    "This table has paid. Give the guest money back from its payment instead.",
  );
});
