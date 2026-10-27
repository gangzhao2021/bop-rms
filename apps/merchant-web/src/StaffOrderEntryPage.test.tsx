import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  choicesComplete,
  estimatedLineMinor,
  paidAtInstant,
  placeErrorText,
  StaffOrderEntryPage,
  paymentWindowNotice,
} from "./StaffOrderEntryPage.js";
import {
  CounterOrderClientError,
  createCounterOrderClient,
  parseCounterMenu,
  parsePlacedCounterOrder,
} from "./staff-order-entry.js";
import { validSlipReference } from "./CardMachineRefundAction.js";

const id = (n: number) => `018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const price = (amount: string | null) =>
  amount === null
    ? { status: "Unavailable", amount: null, currency: null, reason: "PRICE_NOT_SET" }
    : { status: "Available", amount, currency: "CAD", reason: null };
function counterMenuResponse() {
  return {
    screenId: "OPS-ORDER-ENTRY",
    menu: {
      status: "Found",
      schemaVersion: 1,
      projection: {},
      scope: {},
      menu: {
        menuReference: id(1),
        menuVersionReference: id(2),
        releaseReference: id(3),
        locale: "en-CA",
        name: "Menu",
        effectiveFrom: "2026-10-01T00:00:00.000Z",
        effectiveUntil: null,
        sections: [
          {
            sectionReference: id(4),
            name: "Coffee",
            sellables: [
              {
                sellableReference: id(5),
                productVersionReference: id(6),
                name: "Flat White",
                presentationRole: "Standard",
                pinned: false,
                availability: "Available",
                optionRules: [
                  {
                    name: "Milk",
                    bindingReference: id(7),
                    optionSetVersionReference: id(8),
                    minimumSelections: 1,
                    maximumSelections: 1,
                    enabledOptionReferences: [id(9), id(10)],
                    defaultOptionReferences: [id(9)],
                    options: [
                      {
                        optionReference: id(9),
                        name: "Whole milk",
                        maximumQuantity: 1,
                        conflictOptionReferences: [],
                        selectedByDefault: true,
                        incrementalPrice: price("0.00"),
                      },
                      {
                        optionReference: id(10),
                        name: "Oat milk",
                        maximumQuantity: 1,
                        conflictOptionReferences: [],
                        selectedByDefault: false,
                        incrementalPrice: price("0.75"),
                      },
                    ],
                  },
                ],
                allergenDisclosure: {},
                displayPrice: price("4.50"),
                taxDisplayContext: {},
              },
              {
                sellableReference: id(11),
                productVersionReference: id(12),
                name: "Croissant",
                presentationRole: "Standard",
                pinned: false,
                availability: "SoldOut",
                optionRules: [],
                allergenDisclosure: {},
                displayPrice: price("3.25"),
                taxDisplayContext: {},
                // Newer menus carry the customer description and photo; older ones omit them.
                description: "Laminated butter croissant, baked each morning.",
                photo: {
                  altText: "Croissant on a white plate",
                  width: 1280,
                  height: 960,
                  renditions: [
                    {
                      url: "/media/images/" + "a".repeat(64) + ".jpg",
                      contentType: "image/jpeg",
                      width: 640,
                      height: 480,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
  };
}

describe("counter order (OPS-ORDER-ENTRY) — WP-2423 Q7", () => {
  it("reads the pickup menu customers see, with prices in exact cents and sold-out items", () => {
    const menu = parseCounterMenu(counterMenuResponse());
    const [flatWhite, croissant] = menu.sections[0]?.items ?? [];
    expect(flatWhite?.priceMinor).toBe("450");
    expect(flatWhite?.available).toBe(true);
    expect(flatWhite?.rules[0]?.options.map((option) => option.priceMinor)).toEqual(["0", "75"]);
    expect(croissant?.available).toBe(false);
    expect(() => parseCounterMenu({ ...counterMenuResponse(), screenId: "OTHER" })).toThrow(
      CounterOrderClientError,
    );
  });

  it("estimates a line from the menu and requires each required choice", () => {
    const item = parseCounterMenu(counterMenuResponse()).sections[0]?.items[0];
    if (!item) throw new Error("fixture");
    expect(
      estimatedLineMinor({
        key: "a",
        item,
        quantity: 2,
        options: [{ optionReference: id(10), name: "Oat milk", quantity: 1 }],
      }),
    ).toBe(1050n);
    expect(choicesComplete(item, { [id(7)]: [] })).toBe(false);
    expect(choicesComplete(item, { [id(7)]: [id(9)] })).toBe(true);
  });

  it("v15 run: names a short item, how many are left and how many were ordered", () => {
    const item = parseCounterMenu(counterMenuResponse()).sections[0]?.items[0];
    if (!item) throw new Error("fixture");
    const oat = [{ optionReference: id(10), name: "Oat milk", quantity: 1 }];
    const lines = [
      { key: "a", item, quantity: 1, options: oat },
      { key: "b", item, quantity: 1, options: [] },
      { key: "c", item, quantity: 2, options: oat },
    ];
    const text = placeErrorText(new CounterOrderClientError("ItemShort", 0, null, [], 1), lines);
    expect(text).toBe(
      "Only 1 Flat White left, 3 in this order. Remove Flat White and add 1 back, then send again. Nothing was sent or charged.",
    );
    expect(text).not.toMatch(/item_short|409|[0-9a-f]{8}-/u);
    expect(placeErrorText(new CounterOrderClientError("ItemShort", 9, null, [], 2), lines)).toBe(
      "An item has only 2 left. Remove it and add 2 back, then send again. Nothing was sent or charged.",
    );
  });

  it("WP-2423: explains an item short only because other items use the same ingredients", () => {
    const menu = parseCounterMenu(counterMenuResponse()).sections[0]?.items[0];
    if (!menu) throw new Error("fixture");
    const lines = [
      { key: "a", item: menu, quantity: 2, options: [] },
      { key: "b", item: { ...menu, name: "Mocha" }, quantity: 2, options: [] },
    ];
    const short = placeErrorText(
      new CounterOrderClientError("ItemShort", 1, null, [], 1, true),
      lines,
    );
    expect(short).toBe(
      "Only 1 Mocha can be made with the rest of this order (other items use the same ingredients). Lower Mocha to 1 or change the other items, then send again. Nothing was sent or charged.",
    );
    const none = placeErrorText(
      new CounterOrderClientError("ItemUnavailable", 1, null, [], null, true),
      lines,
    );
    expect(none).toBe(
      "There isn't enough left to make Mocha with the rest of this order (other items use the same ingredients). Remove Mocha or change the other items, then send again. Nothing was sent or charged.",
    );
    for (const text of [short, none]) expect(text).not.toMatch(/item_short|409|[0-9a-f]{8}-/u);
  });

  it("WP-2423: a table round's short item is read like the counter's", async () => {
    const responses: [number, unknown][] = [
      [409, { error: "item_short", lineIndex: 1, available: 2, sharedStock: true }],
      [409, { error: "item_unavailable", lineIndex: 0, sharedStock: false }],
    ];
    const fetcher = vi.fn(async () => {
      const [status, body] = responses.shift() ?? [500, {}];
      return new Response(JSON.stringify(body), { status });
    });
    const client = createCounterOrderClient("a".repeat(43), fetcher as unknown as typeof fetch);
    const round = {
      operationReference: id(30),
      tableReference: id(31),
      lines: [],
      tip: { kind: "None" } as const,
      recordedAfterOutage: false,
    };
    await expect(client.placeTableRound(round)).rejects.toMatchObject({
      code: "ItemShort",
      lineIndex: 1,
      available: 2,
      sharedStock: true,
    });
    await expect(client.placeTableRound(round)).rejects.toMatchObject({
      code: "ItemUnavailable",
      lineIndex: 0,
      sharedStock: false,
    });
  });

  it("accepts a paper order's paid time only within the last three days", () => {
    const now = Date.parse("2026-10-13T18:00:00");
    expect(paidAtInstant("2026-10-13T14:05", now)).toBe(new Date("2026-10-13T14:05").toISOString());
    expect(paidAtInstant("2026-10-13T18:30", now)).toBeNull();
    expect(paidAtInstant("2026-10-09T18:00", now)).toBeNull();
    expect(paidAtInstant("", now)).toBeNull();
  });

  it("never takes a card number as the slip reference", () => {
    expect(validSlipReference("")).toBe(true);
    expect(validSlipReference("AUTH 482913")).toBe(true);
    expect(validSlipReference("1234 5678 9012 3456")).toBe(false);
    expect(validSlipReference("x".repeat(41))).toBe(false);
  });

  it("reads the placed order and maps refusals to plain outcomes", async () => {
    const placed = {
      status: "Placed",
      orderReference: id(20),
      orderBatchReference: id(21),
      orderNumber: "12",
      orderVersion: 1,
      orderMinor: "1130",
      tipMinor: "150",
      totalMinor: "1280",
      payBy: "2026-10-13T18:30:00.000Z",
      recordedAfterOutage: false,
    };
    expect(parsePlacedCounterOrder(placed).totalMinor).toBe("1280");
    expect(() => parsePlacedCounterOrder({ ...placed, totalMinor: "1281" })).toThrow();
    const responses: [number, unknown][] = [
      [409, { error: "item_unavailable", lineIndex: 1 }],
      [409, { error: "item_short", lineIndex: 0, available: 1 }],
      [409, { error: "store_not_taking_pickup_orders" }],
      [503, { error: "counter_order_unavailable" }],
      [409, { error: "counter_order_no_pickup_times" }],
      [502, {}],
    ];
    const fetcher = vi.fn(async () => {
      const [status, body] = responses.shift() ?? [500, {}];
      return new Response(JSON.stringify(body), { status });
    });
    const client = createCounterOrderClient("a".repeat(43), fetcher as unknown as typeof fetch);
    const command = {
      operationReference: id(30),
      lines: [],
      tip: { kind: "None" } as const,
      recordedAfterOutage: false,
    };
    await expect(client.placeOrder(command)).rejects.toMatchObject({
      code: "ItemUnavailable",
      lineIndex: 1,
    });
    await expect(client.placeOrder(command)).rejects.toMatchObject({
      code: "ItemShort",
      lineIndex: 0,
      available: 1,
    });
    await expect(client.placeOrder(command)).rejects.toMatchObject({
      code: "StoreNotTakingOrders",
    });
    // WP-2423: the server's own "could not place" is a definite answer with what to do, not
    // "no answer"; a gateway failure without the server's answer stays OutcomeUnknown.
    await expect(client.placeOrder(command)).rejects.toMatchObject({ code: "SystemProblem" });
    await expect(client.placeOrder(command)).rejects.toMatchObject({ code: "NoPickupTimes" });
    await expect(client.placeOrder(command)).rejects.toMatchObject({ code: "OutcomeUnknown" });
    expect(placeErrorText(new CounterOrderClientError("SystemProblem"), [])).toBe(
      "The system couldn't place this order (a problem on our side, not with the order). Nothing was charged. Send it once more. If it fails again, take the order on paper, charge it on the card machine and enter it under Paper order later. Home shows any alert.",
    );
    expect(placeErrorText(new CounterOrderClientError("NoPickupTimes"), [])).toContain(
      "Take this order on paper and charge it on the card machine, then enter it under Paper order once pickup times are back.",
    );
    expect(fetcher).toHaveBeenCalledWith(
      "/merchant/counter/orders",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "X-BOP-CSRF": "a".repeat(43) }),
      }),
    );
    const pay = createCounterOrderClient(
      "a".repeat(43),
      (async () =>
        new Response(JSON.stringify({ error: "amount_changed", totalMinor: "1310" }), {
          status: 409,
        })) as unknown as typeof fetch,
    );
    await expect(
      pay.recordPayment({
        operationReference: id(31),
        orderReference: id(20),
        orderBatchReference: id(21),
        expectedTotalMinor: "1280",
        slipReference: null,
        takenAt: null,
      }),
    ).rejects.toMatchObject({ code: "AmountChanged", totalMinor: "1310" });
    // WP-2423 D1: the server says whether it sent the paid order to the kitchen with the record.
    const recorded = {
      status: "Recorded",
      orderReference: id(20),
      orderBatchReference: id(21),
      amountMinor: "1280",
      recordingReason: "AtCounter",
      takenAt: "2026-10-13T18:01:00.000Z",
      recordedAt: "2026-10-13T18:01:00.000Z",
    };
    const payWith = (body: unknown) =>
      createCounterOrderClient(
        "a".repeat(43),
        (async () =>
          new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch,
      ).recordPayment({
        operationReference: id(31),
        orderReference: id(20),
        orderBatchReference: id(21),
        expectedTotalMinor: "1280",
        slipReference: null,
        takenAt: null,
      });
    for (const acceptance of ["Accepted", "NotAccepted"] as const)
      expect((await payWith({ ...recorded, acceptance })).acceptance).toBe(acceptance);
    await expect(payWith(recorded)).rejects.toBeInstanceOf(CounterOrderClientError);
    await expect(payWith({ ...recorded, acceptance: "Maybe" })).rejects.toBeInstanceOf(
      CounterOrderClientError,
    );
  });

  it("starts by loading the menu", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <StaffOrderEntryPage storeLabel="Toronto Pilot" csrf={"a".repeat(43)} />
      </MemoryRouter>,
    );
    expect(markup).toContain("Counter order");
    expect(markup).toContain("Loading the menu");
  });

  // WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND): a round entered for a table.
  it("sends a table round with notes and reads its refusals in staff words", async () => {
    const placed = {
      status: "Placed",
      orderReference: id(20),
      orderBatchReference: id(21),
      orderNumber: "7",
      orderVersion: 4,
      tableLabel: "T4",
      orderMinor: "2260",
      tipMinor: "300",
      totalMinor: "2560",
      payBy: "2026-10-15T18:30:00.000Z",
      recordedAfterOutage: false,
    };
    const responses: [number, unknown][] = [
      [200, placed],
      [409, { error: "table_cart_has_items", items: [{ name: "Iced latte", quantity: 2 }] }],
      [409, { error: "table_checkout_in_progress" }],
      [409, { error: "table_unavailable" }],
      [409, { error: "store_not_taking_dine_in_orders" }],
      [403, { error: "staff_round_permission_denied" }],
      [503, { error: "staff_round_unavailable" }],
      [409, { error: "staff_round_in_progress" }],
      [502, {}],
    ];
    const fetcher = vi.fn(async () => {
      const [status, body] = responses.shift() ?? [500, {}];
      return new Response(JSON.stringify(body), { status });
    });
    const client = createCounterOrderClient("a".repeat(43), fetcher as unknown as typeof fetch);
    const command = {
      operationReference: id(30),
      tableReference: id(40),
      lines: [{ sellableReference: id(5), quantity: 1, optionSelections: [], note: "No onions" }],
      tip: { kind: "None" } as const,
      recordedAfterOutage: false,
    };
    expect(await client.placeTableRound(command)).toMatchObject({
      tableLabel: "T4",
      totalMinor: "2560",
    });
    // DEC-DINE-IN-PAY-LATER: a round of a table that pays at the end has no payment window or tip.
    expect(
      parsePlacedCounterOrder(
        { ...placed, tipMinor: "0", totalMinor: "2260", payBy: null, payLater: true },
        true,
      ),
    ).toMatchObject({ payLater: true, payBy: null, totalMinor: "2260" });
    expect(() =>
      parsePlacedCounterOrder({ ...placed, payBy: null, payLater: false }, true),
    ).toThrow();
    expect(() => parsePlacedCounterOrder({ ...placed, payLater: true }, true)).toThrow();
    expect(fetcher).toHaveBeenCalledWith(
      "/merchant/dining/staff-rounds",
      expect.objectContaining({ method: "POST", body: JSON.stringify(command) }),
    );
    await expect(client.placeTableRound(command)).rejects.toMatchObject({
      code: "TableCartHasItems",
      pendingItems: [{ name: "Iced latte", quantity: 2 }],
    });
    await expect(client.placeTableRound(command)).rejects.toMatchObject({
      code: "TableCheckoutInProgress",
    });
    await expect(client.placeTableRound(command)).rejects.toMatchObject({
      code: "TableUnavailable",
    });
    await expect(client.placeTableRound(command)).rejects.toMatchObject({
      code: "StoreNotTakingOrders",
    });
    await expect(client.placeTableRound(command)).rejects.toMatchObject({
      code: "PermissionDenied",
    });
    // WP-2423: the server's own "could not send" is a definite answer (a new attempt next); a round
    // that may exist is still being sent; only no answer from the server is OutcomeUnknown.
    await expect(client.placeTableRound(command)).rejects.toMatchObject({ code: "SystemProblem" });
    await expect(client.placeTableRound(command)).rejects.toMatchObject({ code: "InProgress" });
    await expect(client.placeTableRound(command)).rejects.toMatchObject({ code: "OutcomeUnknown" });
    expect(placeErrorText(new CounterOrderClientError("SystemProblem"), [], "Table T4")).toBe(
      "The system couldn't send this round for Table T4 (a problem on our side, not with the order). Nothing was sent to the kitchen or charged. Send it once more. If it fails again, take the order on paper, charge it on the card machine and enter it under Paper order later. Home shows any alert.",
    );
    // A table round's reply names its table; a counter order's never does.
    expect(() => parsePlacedCounterOrder(placed)).toThrow();
    const { tableLabel: _label, ...counter } = placed;
    void _label;
    expect(parsePlacedCounterOrder(counter).tableLabel).toBeNull();
  });

  it("loads the dine-in menu for a table opened from the Tables page", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/operations/order-entry?table=${id(40)}`]}>
        <StaffOrderEntryPage storeLabel="Toronto Pilot" csrf={"a".repeat(43)} />
      </MemoryRouter>,
    );
    expect(markup).toContain("Table order");
    expect(markup).not.toContain("Counter order");
  });
});

describe("WP-2423 item 5: warns before the time to record the payment ends", () => {
  const payBy = "2026-10-15T16:30:00.000Z";
  const at = (iso: string) => Date.parse(iso);
  it("tells staff the time, then the minutes left, then what happened", () => {
    expect(
      paymentWindowNotice({
        payBy,
        now: at("2026-10-15T16:05:00.000Z"),
        tableMode: true,
        timeZone: "UTC",
      }),
    ).toEqual({
      tier: "warning",
      ended: false,
      text: "Record the payment by 16:30. The kitchen starts this order once it is recorded here; if it isn't recorded by then, the round is cancelled.",
    });
    expect(
      paymentWindowNotice({
        payBy,
        now: at("2026-10-15T16:22:10.000Z"),
        tableMode: true,
        timeZone: "UTC",
      }),
    ).toEqual({
      tier: "urgent",
      ended: false,
      text: "8 min left: record the payment by 16:30 or this round is cancelled and its items go back to stock.",
    });
    const ended = paymentWindowNotice({ payBy, now: at(payBy), tableMode: true, timeZone: "UTC" });
    expect(ended).toMatchObject({ tier: "urgent", ended: true });
    expect(ended.text).toContain("It was not sent to the kitchen and is cancelled automatically");
    expect(ended.text).toContain("refund it on the machine");
    expect(
      paymentWindowNotice({
        payBy,
        now: at("2026-10-15T16:25:00.000Z"),
        tableMode: false,
        timeZone: "UTC",
      }).text,
    ).toBe(
      "5 min left: record the payment by 16:30 or the order is released and its items go back to stock.",
    );
  });
});
