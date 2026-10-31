import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { parseCurrentOrderDetail } from "./current-order-queue-client.js";
import { removedItemsTotal } from "./CurrentOrderQueuePage.js";
import {
  PayLaterItemRemoveAction,
  PayLaterRemoveRefusalNotice,
  payLaterRemoveFailureText,
} from "./PayLaterItemRemoveAction.js";
import { MemoryRouter } from "react-router";

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
        onRefused={() => undefined}
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
  // Coordinator 2026-10-30: each refusal says why and what to do instead, in staff words.
  expect(payLaterRemoveFailureText("AlreadyPaid")).toBe(
    "This table has paid, so dishes can't come off its bill. A manager gives the guest money back from the table's payment instead; it is recorded.",
  );
  for (const failure of ["NotRemovable", "Started"] as const) {
    const text = payLaterRemoveFailureText(failure);
    expect(text).toContain("comp");
    expect(text).toContain("recorded");
    expect(text).not.toMatch(/UNPAID_ITEM|NOT_REMOVABLE|_/u);
  }
});

it("Coordinator 2026-10-30: a refusal names what to do instead, with the way there when allowed", () => {
  const notice = (
    failure: "NotRemovable" | "AlreadyPaid",
    compable: string[],
    compInstead = true,
  ) => {
    const { order } = detail({ unpaidRemovableItems: [], unpaidRemovedItems: [] });
    const batch = order.batches[0];
    if (!batch) throw new Error("fixture");
    const withComps = { ...order, batches: [{ ...batch, compableItems: compable }] };
    return renderToStaticMarkup(
      <MemoryRouter>
        <PayLaterRemoveRefusalNotice
          refusal={{ failure, orderItemReferences: [id(202)] }}
          order={withComps}
          compInstead={compInstead ? () => undefined : undefined}
          compHref="/operations/dining"
          refundHref={"/operations/orders/" + id(1)}
          onDone={() => undefined}
        />
      </MemoryRouter>,
    );
  };
  // Made or served, and this person may comp it: one button to the recorded comp.
  expect(notice("NotRemovable", [id(202)])).toContain("Comp these dishes");
  // Comps given on another page: a link there.
  expect(notice("NotRemovable", [id(202)], false)).toContain('href="/operations/dining"');
  // Not allowed to comp (the order lists nothing compable for this person): ask a manager.
  const manager = notice("NotRemovable", []);
  expect(manager).toContain("Ask a manager to comp them.");
  expect(manager).not.toContain("Comp these dishes");
  // Paid: money back from the table's payment, on the order's page.
  expect(notice("AlreadyPaid", [])).toContain('href="/operations/orders/' + id(1) + '"');
  expect(notice("AlreadyPaid", [])).toContain("Give money back from the payment");
});
