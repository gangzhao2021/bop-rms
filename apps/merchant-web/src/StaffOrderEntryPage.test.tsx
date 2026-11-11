import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  choicesComplete,
  counterOrderLines,
  estimatedLineMinor,
  guestCartLines,
  guestLineAdder,
  guestRemovalReason,
  guestRemovedNote,
  paidAtInstant,
  placeErrorText,
  repeatLimit,
  staffChoiceText,
  StaffOrderEntryPage,
  TableCartOfferActions,
  tableCartRemovedNote,
  paymentWindowNotice,
  rebindLines,
  withdrawnOptions,
} from "./StaffOrderEntryPage.js";
import { setLanguageForTest } from "./i18n/i18n.js";
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

  it("WP-2423 (cart-unsellable-dishes): a default choice not offered now is read, marked and never pre-chosen", () => {
    const response = counterMenuResponse();
    const whole = response.menu.menu.sections[0]?.sellables[0]?.optionRules[0]?.options[0];
    if (!whole) throw new Error("fixture");
    Object.assign(whole, { offeredNow: false });
    const item = parseCounterMenu(response).sections[0]?.items[0];
    expect(item?.rules[0]?.options.map((option) => option.offeredNow)).toEqual([false, undefined]);
    expect(item?.rules[0]?.options[0]?.selectedByDefault).toBe(false);
    // Only `false` is a mark: a dish sent any other way is not read (left out).
    Object.assign(whole, { offeredNow: true });
    expect(parseCounterMenu(response).sections[0]?.items.map((i) => i.name)).not.toContain(
      "Flat White",
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

  it("WP-2423 M165: a price raised mid-ticket moves the ticket to the new price and says what changed", () => {
    const menu = parseCounterMenu(counterMenuResponse());
    const item = menu.sections[0]?.items[0];
    if (!item?.priceMinor) throw new Error("fixture");
    const line = {
      key: "a",
      item,
      quantity: 2,
      options: [{ optionReference: id(10), name: "Oat milk", quantity: 1 }],
    };
    const raised = {
      ...menu,
      sections: menu.sections.map((section) => ({
        ...section,
        items: section.items.map((candidate) =>
          candidate.sellableReference === item.sellableReference
            ? { ...candidate, priceMinor: String(BigInt(candidate.priceMinor ?? "0") + 50n) }
            : candidate,
        ),
      })),
    };
    const rebound = rebindLines([line], raised);
    expect(estimatedLineMinor(rebound.lines[0] ?? line)).toBe(1150n);
    expect(rebound.repriced).toEqual([{ name: item.name, beforeMinor: 1050n, afterMinor: 1150n }]);
    // The same menu read again changes nothing and says nothing.
    expect(rebindLines([line], menu).repriced).toEqual([]);
  });

  it("WP-2423 M165 review: an option that leaves the menu mid-ticket stays on the line and is named, never dropped", () => {
    const menu = parseCounterMenu(counterMenuResponse());
    const item = menu.sections[0]?.items[0];
    if (!item) throw new Error("fixture");
    const line = {
      key: "a",
      item,
      quantity: 1,
      options: [{ optionReference: id(10), name: "Oat milk", quantity: 1 }],
    };
    expect(withdrawnOptions(line)).toEqual([]);
    const withMilk = (options: (typeof item.rules)[number]["options"]) => ({
      ...menu,
      sections: menu.sections.map((section) => ({
        ...section,
        items: section.items.map((candidate) =>
          candidate.sellableReference === item.sellableReference
            ? {
                ...candidate,
                rules: candidate.rules.map((rule) => ({ ...rule, options })),
              }
            : candidate,
        ),
      })),
    });
    const milk = item.rules[0]?.options ?? [];
    // Oat milk left the menu: the guest's choice is kept, not dropped, and named.
    const gone = rebindLines([line], withMilk(milk.filter((o) => o.optionReference !== id(10))));
    expect(gone.lines[0]?.options).toEqual(line.options);
    expect(withdrawnOptions(gone.lines[0] ?? line)).toEqual(["Oat milk"]);
    // Oat milk is still listed but not offered now: the same.
    const paused = rebindLines(
      [line],
      withMilk(
        milk.map((o) => (o.optionReference === id(10) ? { ...o, offeredNow: false as const } : o)),
      ),
    );
    expect(withdrawnOptions(paused.lines[0] ?? line)).toEqual(["Oat milk"]);
  });

  it("WP-2423 M53: a counter line sends the guest's kitchen note; a line without one sends none", async () => {
    const item = parseCounterMenu(counterMenuResponse()).sections[0]?.items[0];
    if (!item) throw new Error("fixture");
    const options = [{ optionReference: id(10), name: "Oat milk", quantity: 1 }];
    const lines = counterOrderLines([
      { key: "a", item, quantity: 2, options, note: "No green onion" },
      { key: "b", item, quantity: 1, options: [], note: null },
      { key: "c", item, quantity: 1, options: [] },
    ]);
    expect(lines[0]).toEqual({
      sellableReference: item.sellableReference,
      quantity: 2,
      optionSelections: [{ optionReference: id(10), quantity: 1 }],
      customerNote: "No green onion",
    });
    for (const plain of [lines[1], lines[2]]) expect(plain).not.toHaveProperty("customerNote");
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response("{}"),
    );
    await createCounterOrderClient("a".repeat(43), fetcher as unknown as typeof fetch)
      .placeOrder({
        operationReference: id(30),
        lines,
        tip: { kind: "None" },
        recordedAfterOutage: false,
      })
      .catch(() => null);
    const sent = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
      lines: Record<string, unknown>[];
    };
    expect(sent.lines.map((line) => line.customerNote ?? "none")).toEqual([
      "No green onion",
      "none",
      "none",
    ]);
    expect(sent.lines.map((line) => Object.hasOwn(line, "customerNote"))).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("WP-2423 item 3b: a choice repeated at the table counts each repeat, and prices each", () => {
    const item = parseCounterMenu(counterMenuResponse()).sections[0]?.items[0];
    if (!item) throw new Error("fixture");
    const rule = item.rules[0];
    if (!rule) throw new Error("fixture");
    const pearls = id(20),
      pudding = id(21);
    const toppings = {
      ...item,
      rules: [
        {
          ...rule,
          bindingReference: id(19),
          minimumSelections: 0,
          maximumSelections: 3,
          options: [
            {
              optionReference: pearls,
              name: "Pearls",
              priceMinor: "80",
              maximumQuantity: 2,
              selectedByDefault: false,
              defaultQuantity: 0,
              conflictOptionReferences: [],
            },
            {
              optionReference: pudding,
              name: "Pudding",
              priceMinor: "120",
              maximumQuantity: 2,
              selectedByDefault: false,
              defaultQuantity: 0,
              conflictOptionReferences: [],
            },
          ],
        },
      ],
    };
    const chosen = { [id(19)]: [pearls, pudding] };
    expect(choicesComplete(toppings, chosen, { [pearls]: 2, [pudding]: 1 })).toBe(true);
    // Two of pearls and two of pudding is four of "at most 3".
    expect(choicesComplete(toppings, chosen, { [pearls]: 2, [pudding]: 2 })).toBe(false);
    // More of one than the group allows of each.
    expect(choicesComplete(toppings, { [id(19)]: [pearls] }, { [pearls]: 3 })).toBe(false);
    expect(
      estimatedLineMinor({
        key: "a",
        item: toppings,
        quantity: 1,
        options: [{ optionReference: pearls, name: "Pearls", quantity: 2 }],
      }),
    ).toBe(610n);
    // "Up to 3 in total, up to 2 of each": with 2 pearls, pudding can be entered once only.
    const group = toppings.rules[0];
    if (!group) throw new Error("fixture");
    expect(repeatLimit(group, pudding, [pearls, pudding], { [pearls]: 2, [pudding]: 1 })).toBe(1);
    expect(repeatLimit(group, pearls, [pearls, pudding], { [pearls]: 2, [pudding]: 1 })).toBe(2);
    expect(repeatLimit(group, pearls, [pearls], { [pearls]: 1 })).toBe(2);
    // The legend says the rule as guests read it.
    expect(staffChoiceText(group)).toBe("Optional · up to 3");
    expect(staffChoiceText({ minimumSelections: 1, maximumSelections: 1 })).toBe("Required");
    expect(staffChoiceText({ minimumSelections: 1, maximumSelections: 2 })).toBe("Choose 1 to 2");
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
      [409, { error: "counter_order_already_ordered", orderNumber: "13" }],
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
    // WP-2423 M03: these dishes are already in order 13; staff open it instead of charging again.
    const already = await client.placeOrder(command).catch((error: unknown) => error);
    expect(already).toMatchObject({ code: "AlreadyOrdered", placedOrderNumber: "13" });
    expect(placeErrorText(already as CounterOrderClientError, [])).toBe(
      "Already ordered as order 13. Nothing new was charged. Open it in Orders.",
    );
    expect(placeErrorText(new CounterOrderClientError("AlreadyOrdered"), [])).toBe(
      "These items are already in an order. Nothing new was charged. Open it in Orders.",
    );
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
      [
        409,
        {
          error: "table_cart_has_items",
          items: [
            { cartItemReference: id(60), name: "Iced latte", quantity: 2, standing: "Available" },
          ],
        },
      ],
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
      pendingItems: [
        {
          cartItemReference: id(60),
          name: "Iced latte",
          quantity: 2,
          standing: "Available",
          available: null,
        },
      ],
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

  // WP-2423 (staff-round-soldout, v15 8911a4c1 M06): a guest's item in the table's cart sold out.
  it("marks a guest's sold-out item and offers to remove it and send the rest", async () => {
    const plum = {
      cartItemReference: id(61),
      name: "Plum juice",
      quantity: 1,
      standing: "Unavailable",
    };
    const noodles = {
      cartItemReference: id(62),
      name: "Hand-pulled noodles",
      quantity: 2,
      standing: "Available",
    };
    const responses: [number, unknown][] = [
      [
        409,
        {
          error: "table_cart_has_items",
          items: [plum, noodles, { name: "No reference", quantity: 1 }],
          cartVersion: 6,
          guestsCanSend: true,
        },
      ],
      [409, { error: "item_unavailable", lineIndex: 0, sharedStock: false, optionsChanged: true }],
    ];
    const sent: string[] = [];
    const fetcher = vi.fn(async (...args: [string, { body: string }]) => {
      sent.push(args[1].body);
      const [status, body] = responses.shift() ?? [500, {}];
      return new Response(JSON.stringify(body), { status });
    });
    const client = createCounterOrderClient("a".repeat(43), fetcher as unknown as typeof fetch);
    const command = {
      operationReference: id(30),
      tableReference: id(40),
      lines: [{ sellableReference: id(5), quantity: 1, optionSelections: [], note: null }],
      tip: { kind: "None" } as const,
      recordedAfterOutage: false,
      includeTableCart: { expectedCartVersion: 6, removeUnavailable: [id(61)] },
    };
    const refused = (await client.placeTableRound(command).catch((error: unknown) => error)) as
      CounterOrderClientError | undefined;
    expect(JSON.parse(sent[0] ?? "{}").includeTableCart).toEqual({
      expectedCartVersion: 6,
      removeUnavailable: [id(61)],
    });
    expect(refused).toMatchObject({
      code: "TableCartHasItems",
      pendingItems: [
        { ...plum, available: null },
        { ...noodles, available: null },
      ],
      tableCart: { cartVersion: 6, guestsCanSend: true },
    });
    if (refused === undefined) throw new Error("refused");
    expect(placeErrorText(refused, [])).toBe(
      "Guests at this table have items in their shared cart that haven't been sent. Plum juice can't be served now. Remove it from their order, or ask the guests to change their order on their phone.",
    );
    const offer = (items: typeof refused.pendingItems) =>
      renderToStaticMarkup(
        <TableCartOfferActions offer={{ items }} disabled={false} onSend={() => undefined} />,
      );
    const mixed = offer(refused.pendingItems);
    expect(mixed).toContain("Sold out or off the menu now");
    expect(mixed).toContain("Remove Plum juice and add the rest to this round");
    expect(mixed).not.toContain("Add them to this round");
    expect(offer([refused.pendingItems[0] as never])).toContain(
      "Remove Plum juice and send this round",
    );
    expect(offer([refused.pendingItems[1] as never])).toContain("Add them to this round");
    // Too few left: the guests change it; staff get no add or remove button.
    const short = { ...noodles, standing: "Short" as const, available: 1 };
    expect(offer([short])).toContain("Only 1 left");
    expect(offer([short])).not.toContain("<button");
    const shortRefusal = new CounterOrderClientError("TableCartHasItems", null, null, [short]);
    shortRefusal.tableCart = { cartVersion: 7, guestsCanSend: true };
    expect(placeErrorText(shortRefusal, [])).toBe(
      "Hand-pulled noodles has only 1 left. Ask the guests to lower it on their phone, then send again. Nothing was sent or charged.",
    );
    const none = new CounterOrderClientError("TableCartHasItems", null, null, [
      { ...short, available: 0 },
    ]);
    none.tableCart = { cartVersion: 7, guestsCanSend: true };
    expect(placeErrorText(none, [])).toBe(
      "Hand-pulled noodles has none left. Ask the guests to remove it on their phone, or mark it sold out, then send again. Nothing was sent or charged.",
    );
    // After last orders, two items off: staff remove them to send.
    const late = new CounterOrderClientError("TableCartHasItems", null, null, [
      { ...plum, standing: "Unavailable", available: null },
      { ...noodles, standing: "OptionsChanged", available: null },
    ]);
    late.tableCart = { cartVersion: 8, guestsCanSend: false };
    expect(placeErrorText(late, [])).toBe(
      "Guests at this table have items in their shared cart that haven't been sent. Plum juice, Hand-pulled noodles can't be served now, and guests can no longer send after last orders. Remove them from their order to send this round.",
    );
    // The counter's or round's own dish whose choices changed.
    const changed = (await client.placeTableRound(command).catch((error: unknown) => error)) as
      CounterOrderClientError | undefined;
    expect(changed).toMatchObject({ code: "ItemUnavailable", lineIndex: 0, optionsChanged: true });
    if (changed === undefined) throw new Error("changed");
    expect(
      placeErrorText(changed, [
        { item: { name: "Milk tea" }, quantity: 1, options: [], note: null } as never,
      ]),
    ).toBe(
      "Milk tea's choices changed on the menu. Remove it, add it again with the new choices, then send. Nothing was sent or charged.",
    );
    // In Chinese, names joined the Chinese way, no codes.
    setLanguageForTest("zh-Hans");
    try {
      expect(placeErrorText(late, [])).toBe(
        "这桌客人的共用购物车里还有没送出的菜。Plum juice、Hand-pulled noodles 现在不供应，过了最后点单时间客人已经不能自己送出。把它们从他们的点单里删掉，就能送出这一轮。",
      );
      const zh = offer(refused.pendingItems);
      expect(zh).toContain("现在不供应");
      expect(zh).toContain("删掉Plum juice，其余加进这一轮");
    } finally {
      setLanguageForTest("en");
    }
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

describe("DEC-PAPER-ORDER-PAID-AT-SEND: a paper order is recorded with its payment", () => {
  const placed = {
    status: "Placed",
    orderReference: id(20),
    orderBatchReference: id(21),
    orderNumber: "5",
    orderVersion: 1,
    orderMinor: "367",
    tipMinor: "0",
    totalMinor: "367",
    payBy: "2026-10-13T18:30:00.000Z",
    recordedAfterOutage: true,
  };
  const paperPayment = {
    operationReference: id(31),
    tender: "CardMachine" as const,
    slipReference: "AUTH 1",
    takenAt: "2026-10-13T16:00:00.000Z",
  };
  const command = {
    operationReference: id(30),
    lines: [],
    tip: { kind: "None" as const },
    recordedAfterOutage: true,
    paperPayment,
  };
  it("sends how it was paid and reads the payment recorded with it, or why it wasn't", async () => {
    const answers: unknown[] = [
      {
        ...placed,
        payment: {
          status: "Recorded",
          amountMinor: "367",
          recordingReason: "RecordedAfterOutage",
          takenAt: paperPayment.takenAt,
          recordedAt: "2026-10-13T18:01:00.000Z",
          acceptance: "Accepted",
        },
      },
      { ...placed, paymentError: "taken_before_records" },
      { ...placed, paymentError: "amount_changed", paymentTotalMinor: "390" },
      { ...placed, paymentError: "card_machine_payment_unavailable" },
      // A payment answer for an order sent without one is not believed.
      { ...placed, paymentError: "taken_before_records" },
    ];
    const bodies: unknown[] = [];
    const fetcher = vi.fn(async (_path: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(answers.shift()), { status: 200 });
    });
    const client = createCounterOrderClient("a".repeat(43), fetcher as unknown as typeof fetch);
    const recorded = await client.placeOrder(command);
    expect(bodies[0]).toEqual(command);
    expect(recorded.paperPayment).toEqual({
      kind: "Recorded",
      payment: {
        status: "Recorded",
        amountMinor: "367",
        recordingReason: "RecordedAfterOutage",
        takenAt: paperPayment.takenAt,
        acceptance: "Accepted",
        cash: null,
      },
    });
    const refused = await client.placeOrder(command);
    expect(refused.paperPayment?.kind).toBe("NotRecorded");
    expect(
      refused.paperPayment?.kind === "NotRecorded" ? refused.paperPayment.error.code : null,
    ).toBe("TakenBeforeRecords");
    const changed = await client.placeOrder(command);
    expect(
      changed.paperPayment?.kind === "NotRecorded" && changed.paperPayment.error,
    ).toMatchObject({ code: "AmountChanged", totalMinor: "390" });
    const failed = await client.placeOrder(command);
    expect(failed.paperPayment?.kind === "NotRecorded" && failed.paperPayment.error.code).toBe(
      "Unavailable",
    );
    const { paperPayment: _, ...unpaid } = command;
    await expect(client.placeOrder({ ...unpaid, recordedAfterOutage: false })).rejects.toThrow();
  });
  it("never tells staff to charge a paper order, and warns before the system takes it off", () => {
    const payBy = "2026-10-15T16:30:00.000Z";
    const notice = (now: string) =>
      paymentWindowNotice({
        payBy,
        now: Date.parse(now),
        tableMode: false,
        timeZone: "UTC",
        paper: true,
      });
    expect(notice("2026-10-15T16:05:00.000Z")).toEqual({
      tier: "warning",
      ended: false,
      text: "Record this paper order's payment now. Until it is recorded the sale isn't in the day's takings; if it still isn't by 16:30, the system takes the order off and you enter it again.",
    });
    expect(notice("2026-10-15T16:25:00.000Z")).toMatchObject({ tier: "urgent", ended: false });
    expect(notice(payBy)).toMatchObject({ tier: "urgent", ended: true });
    for (const at of ["2026-10-15T16:05:00.000Z", "2026-10-15T16:25:00.000Z", payBy])
      expect(notice(at).text).not.toMatch(/released|refund it|charge it on/iu);
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

describe("the counter menu with a listed combo (WP-2423 item 8 ⑥ part 4)", () => {
  // Captured from the real projection after a real "List it" (TEST data).
  const captured = () =>
    JSON.parse(
      readFileSync(
        new URL("../../customer-pwa/src/menu/combo-menu.captured.json", import.meta.url),
        "utf8",
      ),
    ) as { menu: { sections: { sellables: Record<string, unknown>[] }[] } };
  const names = (menu: ReturnType<typeof parseCounterMenu>) =>
    menu.sections.flatMap((section) => section.items.map((item) => item.name));
  it("offers the combo with nothing chosen in its parts", () => {
    const menu = parseCounterMenu({ screenId: "OPS-ORDER-ENTRY", menu: captured() });
    const combo = menu.sections
      .flatMap((s) => s.items)
      .find((i) => i.name === "Combo for two (TEST)");
    expect(combo?.rules.map((rule) => rule.options.some((o) => o.selectedByDefault))).toEqual([
      false,
      false,
    ]);
    expect(names(menu)).toHaveLength(5);
  });
  it("leaves out only a dish it cannot read", () => {
    const broken = captured();
    const soups = broken.menu.sections[0];
    if (soups === undefined) throw new Error("fixture");
    soups.sellables = soups.sellables.map((item) =>
      item.name === "Wonton soup (TEST)" ? { ...item, servedWith: "TEST" } : item,
    );
    expect(names(parseCounterMenu({ screenId: "OPS-ORDER-ENTRY", menu: broken }))).toEqual([
      "Hot and sour soup (TEST)",
      "Fried rice (TEST)",
      "Chow mein (TEST)",
      "Combo for two (TEST)",
    ]);
  });
});

describe("WP-2423 M06: the note after guest dishes were taken off a round", () => {
  const item = (n: number, name: string) =>
    ({
      cartItemReference: id(n),
      name,
      quantity: 1,
      standing: "Unavailable",
      available: null,
    }) as const;
  it("is singular for one dish and plural for several", () => {
    setLanguageForTest("en");
    expect(tableCartRemovedNote([item(1, "Plum juice")])).toBe(
      "Tell the guests: Plum juice isn't available now, so it was taken off their order.",
    );
    expect(tableCartRemovedNote([item(1, "Plum juice"), item(2, "Soup")])).toBe(
      "Tell the guests: Plum juice, Soup aren't available now, so they were taken off their order.",
    );
    expect(tableCartRemovedNote([])).toBeNull();
    setLanguageForTest("zh-Hans");
    expect(tableCartRemovedNote([item(1, "酸梅汤"), item(2, "汤")])).toBe(
      "请告诉客人：酸梅汤、汤 现在不供应，已从他们的点单里删掉。",
    );
    setLanguageForTest("en");
  });
});

describe("WP-2423 M35: the guests' unsent lines on the staff round screen", () => {
  const menu = () => parseCounterMenu(counterMenuResponse());
  const cart = (lines: Record<string, unknown>[]) => ({
    cartReference: id(70),
    cartVersion: 4,
    guestPaying: false,
    guestChoosing: null,
    lines: lines.map((line, index) => ({
      cartItemReference: id(80 + index),
      sellableReference: id(5),
      optionSelections: [],
      names: { "en-CA": "Flat White" },
      quantity: 1,
      withOptions: false,
      phoneNumber: 1,
      phoneLeft: false,
      ...line,
    })) as never,
  });
  it("names and prices each line from the menu staff hold, and marks one that can't be sent", () => {
    setLanguageForTest("en");
    const lines = guestCartLines(
      cart([
        { quantity: 2, optionSelections: [{ optionReference: id(10), quantity: 1 }] },
        { sellableReference: id(11), names: { "en-CA": "Croissant" }, phoneNumber: 2 },
        { sellableReference: id(99), names: { "en-CA": "Old soup" }, phoneLeft: true },
      ]),
      menu(),
    );
    // 2 × (4.50 + 0.75 oat milk), in exact cents.
    expect(lines[0]).toMatchObject({
      name: "Flat White",
      options: "Oat milk",
      quantity: 2,
      estimateMinor: 1050n,
      unsellable: false,
    });
    // Sold out now, and a dish on no current menu: neither can be sent, neither is priced.
    expect(lines[1]).toMatchObject({ name: "Croissant", unsellable: true, estimateMinor: null });
    expect(lines[2]).toMatchObject({ name: "Old soup", unsellable: true });
    // Why each leaves when taken out, with no extra tap: can't be made, the phone left, asked.
    expect(lines.map(guestRemovalReason)).toEqual(["GuestAsked", "CantMake", "CantMake"]);
    expect(guestRemovalReason({ ...lines[0], phoneLeft: true } as (typeof lines)[number])).toBe(
      "GuestLeft",
    );
    expect(lines.map(guestLineAdder)).toEqual(["Phone 1", "Phone 2", "Phone 1 has left"]);
    expect(guestCartLines(null, menu())).toEqual([]);
  });
  it("tells staff what to say for the lines they took out, one or many, in their language", () => {
    setLanguageForTest("en");
    const lines = guestCartLines(
      cart([
        { sellableReference: id(11), names: { "en-CA": "Croissant" } },
        { sellableReference: id(99), names: { "en-CA": "Soup" } },
        {},
      ]),
      menu(),
    );
    expect(guestRemovedNote(lines.slice(0, 1))).toBe(
      "Tell the guests: Croissant isn't available now, so it was taken off their order.",
    );
    expect(guestRemovedNote(lines)).toBe(
      "Tell the guests: Croissant, Soup aren't available now, so they were taken off their order. Removed from the guests' cart: Flat White.",
    );
    expect(guestRemovedNote([])).toBeNull();
    setLanguageForTest("zh-Hans");
    expect(guestRemovedNote(lines.slice(2, 3))).toBe("已从客人的购物车删掉：Flat White。");
    expect(guestLineAdder({ ...(lines[2] as (typeof lines)[number]), phoneLeft: true })).toBe(
      "手机 1 已离开",
    );
    setLanguageForTest("en");
  });
});
