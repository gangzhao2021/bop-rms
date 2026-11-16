import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { parseCurrentOrderDetail } from "./current-order-queue-client.js";
import { removedItemsTotal } from "./CurrentOrderQueuePage.js";
import {
  PayLaterItemRemoveAction,
  PayLaterRemoveRefusalNotice,
  payLaterChosenWholeRound,
  payLaterRemoveButtonText,
  payLaterRemoveDishText,
  payLaterRemoveFailureText,
  payLaterRemovePreviewMinor,
  payLaterRemoveTogetherNote,
} from "./PayLaterItemRemoveAction.js";
import { setLanguageForTest } from "./i18n/i18n.js";
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
  expect(render([id(201)])).toContain("Take dishes off round 1");
  expect(render([])).toBe("");
});

// v15 b21 live check: a table's rounds each had a "Take dishes off the bill" button, stacked
// under the totals with the same name; staff could tell them apart only by where they were.
it("v15 b21: each round's take-off button names its round, in staff words", () => {
  const render = (sequence: number) => {
    const { order, lines } = detail({ unpaidRemovableItems: [id(201)], unpaidRemovedItems: [] });
    const batch = order.batches[0];
    if (!batch) throw new Error("fixture");
    return renderToStaticMarkup(
      <PayLaterItemRemoveAction
        order={order}
        batch={{ ...batch, sequence }}
        lines={lines.items}
        csrf="synthetic"
        onSettled={() => undefined}
        onRefused={() => undefined}
      />,
    );
  };
  expect(render(2)).toBe('<button type="button">Take dishes off round 2</button>');
  expect(render(3)).toContain("Take dishes off round 3");
  setLanguageForTest("zh-Hans");
  try {
    expect(render(2)).toBe('<button type="button">从第 2 轮删菜</button>');
  } finally {
    setLanguageForTest("en");
  }
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
    failure: "NotRemovable" | "AlreadyPaid" | "Comped",
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
  // DEC-KITCHEN-ONE-TAP: a comped dish stays on the bill; nothing more to comp, nobody to ask.
  const comped = notice("Comped", []);
  expect(comped).toContain("stays on the bill at that price");
  expect(comped).not.toContain("Ask a manager to comp them.");
  expect(comped).not.toContain("Comp these dishes");
  expect(payLaterRemoveFailureText("Comped")).toContain("tell the kitchen");
});

// v15 b20 live check: the panel read "1 × Beef noodles (TEST) · $14.13" and the button "Take the
// whole round off · $14.13", but the bill went down by $14.12 (its tax is worked out on the whole
// bill). The button names what the bill goes down by, from the server (b22: so does each dish).
it("v15 b20: the take-off button names what the bill goes down by, never the dishes' own prices", () => {
  const text = (previewMinor: string | null, chosen = 1, offered = 1, busy = false) =>
    payLaterRemoveButtonText({
      busy,
      chosen,
      wholeRound: chosen === offered,
      previewMinor,
      currencyCode: "CAD",
      sequence: 1,
    });
  expect(text("1412")).toBe("Take the whole round off · $14.12");
  expect(text("1412", 1, 2)).toBe("Take off $14.12");
  // Not worked out yet (or it couldn't be): no amount, never the dishes' own sum.
  expect(text(null)).toBe("Take the whole round off");
  expect(text(null, 1, 2)).toBe("Take these dishes off");
  // b22: nothing ticked yet: a prompt for its round, never the older unnumbered name.
  expect(text(null, 0, 2)).toBe("Choose dishes to take off round 1");
  expect(text("1412", 1, 1, true)).toBe("Recording…");
  expect(payLaterRemovePreviewMinor({ status: "Preview", totalMinor: "1412" })).toBe("1412");
  for (const broken of [null, {}, { totalMinor: 1412 }, { totalMinor: "-1" }, { totalMinor: "01" }])
    expect(payLaterRemovePreviewMinor(broken)).toBeNull();
  setLanguageForTest("zh-Hans");
  try {
    expect(text("1412")).toBe("删掉整轮 · $14.12");
    expect(text(null)).toBe("删掉整轮");
    expect(text(null, 1, 2)).toBe("删掉这些菜");
  } finally {
    setLanguageForTest("en");
  }
});

// v15 live21 (TM2 Order 9, round 2): the panel listed "1 × Smashed cucumber · price $7.07" while
// the preview, the button and the bill drop were $7.06; and before anything was ticked the round's
// own panel said "Take dishes off the bill".
it("b22: a dish says what the bill goes down by, as the button does, and the empty button asks for its round's dishes", () => {
  const dish = (billDownMinor: string | null | undefined) =>
    payLaterRemoveDishText({
      quantity: 1,
      name: "Smashed cucumber",
      billDownMinor,
      total: money("707"),
    });
  expect(dish("706")).toBe("1 × Smashed cucumber · bill goes down $7.06 with tax");
  // Being worked out: no figure yet; couldn't be: its own price, said as that.
  expect(dish(undefined)).toBe("1 × Smashed cucumber");
  expect(dish(null)).toBe("1 × Smashed cucumber · price $7.07");
  const empty = (sequence: number) =>
    payLaterRemoveButtonText({
      busy: false,
      chosen: 0,
      wholeRound: false,
      previewMinor: null,
      currencyCode: "CAD",
      sequence,
    });
  expect(empty(3)).toBe("Choose dishes to take off round 3");
  setLanguageForTest("zh-Hans");
  try {
    expect(dish("706")).toBe("1 × Smashed cucumber · 账单减 $7.06（含税）");
    expect(empty(3)).toBe("请选要从第 3 轮删的菜");
  } finally {
    setLanguageForTest("en");
  }
});

// b22 review: a round of Beef noodles the kitchen started and Soy milk not started offers only Soy
// milk. Ticking it is all that can come off, but the noodles stay: not the whole round, so the
// round's figure is never compared (it differs because a dish stays, not because of tax).
it("b22: ticking every dish that can come off is the whole round only when no dish of it stays on the bill", () => {
  const round = { orderBatchReference: id(91), unpaidRemovedItems: [id(205)] };
  const dish = (n: number, batch = 91, cancelled = false) => ({
    orderItemReference: id(200 + n),
    orderBatchReference: id(batch),
    cancellation: cancelled
      ? ({ refund: money("0") } as unknown as Parameters<
          typeof payLaterChosenWholeRound
        >[0]["lines"][number]["cancellation"])
      : null,
  });
  const whole = (lines: ReturnType<typeof dish>[], chosen: number[]) =>
    payLaterChosenWholeRound({ batch: round, lines, chosen: chosen.map((n) => id(200 + n)) });
  // Soy milk (1) and Beef noodles (3, started): ticking Soy milk is not the whole round.
  expect(whole([dish(1), dish(3)], [1])).toBe(false);
  expect(whole([dish(1), dish(3)], [1, 3])).toBe(true);
  // A dish taken off before (5), a cancelled one (6) and another round's (7) don't count.
  expect(whole([dish(1), dish(5), dish(6, 91, true), dish(7, 92)], [1])).toBe(true);
  expect(whole([dish(1)], [])).toBe(false);
  // The button then names what comes off, never the whole round.
  expect(
    payLaterRemoveButtonText({
      busy: false,
      chosen: 1,
      wholeRound: whole([dish(1), dish(3)], [1]),
      previewMinor: "367",
      currencyCode: "CAD",
      sequence: 2,
    }),
  ).toBe("Take off $3.67");
});

it("b22: when dishes together take a cent more or less off than their figures, the panel says why", () => {
  const note = (
    previewMinor: string | null,
    dishMinors: (string | null | undefined)[],
    roundMinor?: string,
  ) => payLaterRemoveTogetherNote({ previewMinor, dishMinors, roundMinor, currencyCode: "CAD" });
  // Soy milk alone $3.67 + Smashed cucumber alone $7.06; the whole round takes $10.74 off.
  expect(note("1074", ["367", "706"])).toBe(
    "Tax is worked out once on the whole bill, so the bill goes down $10.74.",
  );
  // One dish: its figure is the button's.
  expect(note("706", ["706"])).toBeNull();
  // The whole round reads $14.13 on the bill; taking it off takes $14.12 off.
  expect(note("1412", ["1412"], "1413")).toBe(
    "Tax is worked out once on the whole bill, so the bill goes down $14.12.",
  );
  expect(note("1413", ["1413"], "1413")).toBeNull();
  // Not known yet: nothing said.
  expect(note(null, ["706"])).toBeNull();
  expect(note("1074", ["367", undefined])).toBeNull();
  setLanguageForTest("zh-Hans");
  try {
    expect(note("1074", ["367", "706"])).toBe("税按整张账单算一次，所以账单减 $10.74。");
  } finally {
    setLanguageForTest("en");
  }
});
