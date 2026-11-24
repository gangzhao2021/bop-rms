// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { parseCurrentOrderDetail } from "./current-order-queue-client.js";
import { compDishesLeft, compRecordLabel, ItemCompAction } from "./ItemCompAction.js";
import { buttonNamed, click, mount, selectValue, settle } from "./dom-test-kit.fixture.js";
import { setLanguageForTest } from "./i18n/i18n.js";

/**
 * Batch 60 (v15 b59 live, L59S B, staff-refund-lines leftOpen): a comp could only cover a whole
 * line ("2 × Beef noodles" together), so to comp the one bowl that was wrong staff used "Amount
 * off (one dish)", which hides that it was a comp. A manager now comps 1 of the 2, from the same
 * panel with the same reason and confirm, and later the other one.
 */
afterEach(() => {
  setLanguageForTest("en");
  document.body.replaceChildren();
});

const id = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const noodles = id(201);
const tea = id(202);
const line = (
  reference: string,
  name: string,
  quantity: number,
  subtotal: string,
  tax: string,
  total: string,
) => ({
  orderItemReference: reference,
  orderBatchReference: id(91),
  name,
  options: [],
  quantity,
  customerNote: null,
  unitPrice: money(String(Number(subtotal) / quantity)),
  subtotal: money(subtotal),
  discount: money("0"),
  tax: money(tax),
  fee: money("0"),
  total: money(total),
  canCancel: false,
  cancellation: null,
});
/** The round as the server sends it: Beef noodles (TEST) $12.50 a bowl, two on one line. */
const detail = (compedItems: unknown[], compableItems = [noodles, tea], bowls = 2) =>
  parseCurrentOrderDetail(
    {
      screenId: "OPS-ORDER-DETAIL",
      pickupContact: null,
      order: {
        orderReference: id(1),
        orderNumber: "33",
        orderType: "DineIn",
        sourceChannel: "Qr",
        submittedAt: "2026-11-24T17:32:48.000Z",
        observedAt: "2026-11-24T17:39:00.000Z",
        initialBatchReference: id(91),
        batches: [
          {
            orderBatchReference: id(91),
            sequence: 1,
            acceptanceStatus: "Accepted",
            canRequestAcceptance: false,
            canCancel: false,
            staffCancellation: null,
            canCancelItems: false,
            unpaidRemovableItems: [],
            unpaidRemovedItems: [],
            compableItems,
            compedItems,
          },
        ],
        canRequestAcceptance: false,
        unfulfillable: null,
        pickupNotCollected: false,
        acceptBy: null,
        awaitingPayment: false,
        currentPhase: "InProgress",
        currentVersion: 9,
      },
      lines: {
        items: [
          bowls === 3
            ? line(noodles, "Beef noodles (TEST)", 3, "3750", "488", "4238")
            : line(noodles, "Beef noodles (TEST)", 2, "2500", "325", "2825"),
          line(tea, "Tea", 1, "380", "49", "429"),
        ],
        totals: {
          subtotal: money("2880"),
          discount: money("0"),
          tax: money("374"),
          fee: money("0"),
          total: money("3254"),
        },
      },
    },
    id(1),
  );
const firstBowl = {
  orderItemReference: noodles,
  kind: "Comp",
  percent: null,
  amountMinor: "1413",
  reasonCode: "WRONG_DISH",
  decidedAt: "2026-11-24T17:40:00.000Z",
  byLabel: "You",
  compedQuantity: 1,
  lineQuantity: 2,
};

interface Asked {
  orderItemReferences: string[];
  kind: string;
  compQuantities?: { orderItemReference: string; quantity: number }[];
  expectedTotalMinor?: string;
  reasonCode?: string;
}
const server = (refuse?: string) => {
  const previews: Asked[] = [];
  const commands: Asked[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Asked;
    if (!url.endsWith("/preview")) {
      commands.push(body);
      return new Response(
        JSON.stringify(
          refuse === undefined ? { status: "Recorded", reductions: [] } : { error: refuse },
        ),
        {
          status: refuse === undefined ? 200 : 409,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    previews.push(body);
    // One bowl: $12.50 + $1.63; both bowls: the line, $28.25; the tea alone $4.29.
    const amount = (item: string) => {
      if (item === tea) return "429";
      const quantity = body.compQuantities?.find((q) => q.orderItemReference === item)?.quantity;
      return quantity === 1 ? "1413" : "2825";
    };
    const lines = body.orderItemReferences.map((item) => ({
      orderItemReference: item,
      amountMinor: amount(item),
    }));
    return new Response(
      JSON.stringify({
        status: "Preview",
        totalMinor: String(lines.reduce((sum, entry) => sum + Number(entry.amountMinor), 0)),
        lines,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return { previews, commands, fetcher };
};
const open = async (comps: unknown[], fetcher: typeof fetch, compable?: string[], bowls = 2) => {
  const { order, lines } = detail(comps, compable, bowls);
  const mounted = await mount(
    <ItemCompAction
      order={order}
      lines={lines.items}
      csrf={"a".repeat(43)}
      fetcher={fetcher}
      onSettled={() => undefined}
    />,
  );
  return mounted;
};
const pause = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  await settle(10);
};
const dishLabels = (container: HTMLElement) =>
  [...container.querySelectorAll(".pay-later-remove__lines li > label")].map((label) =>
    label.textContent?.trim(),
  );
const tick = async (container: HTMLElement, name: string) => {
  await click(
    [...container.querySelectorAll(".pay-later-remove__lines li > label")]
      .find((label) => label.textContent?.includes(name))
      ?.querySelector("input"),
  );
  await pause();
};
const reason = async (container: HTMLElement, label: string) => {
  await click(container.querySelector(`[data-choice="${label}"] input`));
  await settle(5);
};

it("comps 1 of 2 Beef noodles: the panel asks how many, and the button says one bowl", async () => {
  const { previews, commands, fetcher } = server();
  const { container } = await open([], fetcher);
  await click(buttonNamed(container, "Comp or discount"));
  await pause();
  await tick(container, "Beef noodles");
  const quantity = container.querySelector(".item-comp__quantity select");
  // The whole line by default, as before.
  expect(quantity).not.toBeNull();
  expect((quantity as HTMLSelectElement).value).toBe("2");
  expect([...(quantity as HTMLSelectElement).options].map((option) => option.textContent)).toEqual([
    "2 of 2",
    "1 of 2",
  ]);
  expect(buttonNamed(container, "Comp $28.25")).toBeDefined();
  expect(previews.at(-1)).not.toHaveProperty("compQuantities");
  await selectValue(quantity, "1");
  await pause();
  expect(previews.at(-1)?.compQuantities).toEqual([{ orderItemReference: noodles, quantity: 1 }]);
  // Batch 61 (v15 b60 live): the dish says the count chosen and what that count takes off.
  expect(dishLabels(container)[0]).toBe(
    "1 of 2 × Beef noodles (TEST) · bill goes down $14.13 with tax",
  );
  await reason(container, "Wrong dish served");
  await click(buttonNamed(container, "Comp $14.13"));
  await settle(10);
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    orderItemReferences: [noodles],
    kind: "Comp",
    compQuantities: [{ orderItemReference: noodles, quantity: 1 }],
    reasonCode: "WRONG_DISH",
    expectedTotalMinor: "1413",
  });
});

it("offers the bowl left after one was comped, and nothing to choose for one bowl", async () => {
  const { previews, fetcher } = server();
  const { container } = await open([firstBowl], fetcher);
  await click(buttonNamed(container, "Comp or discount"));
  await pause();
  expect(dishLabels(container)[0]).toBe(
    "1 × Beef noodles (TEST) (1 comped already) · bill goes down $28.25 with tax",
  );
  await tick(container, "Beef noodles");
  // One bowl left: comped whole, with no count to choose (the server comps what is left).
  expect(container.querySelector(".item-comp__quantity")).toBeNull();
  expect(previews.at(-1)).not.toHaveProperty("compQuantities");
});

// Batch 60 review: the server refuses a percentage or an amount off on a line comped in part, so
// the panel never offers one there: under those choices the line is gone and a note says why.
it("offers the rest of a line comped in part only as a comp, and says so", async () => {
  const { previews, fetcher } = server();
  const { container } = await open([firstBowl], fetcher);
  await click(buttonNamed(container, "Comp or discount"));
  await pause();
  await tick(container, "Beef noodles");
  await tick(container, "Tea");
  const choose = async (index: number) => {
    await click(container.querySelectorAll('input[name="item-comp-choice"]')[index]);
    await pause();
  };
  const note = () =>
    [...container.querySelectorAll('[role="note"]')]
      .map((entry) => entry.textContent)
      .find((text) => text?.includes("comped in part"));
  expect(note()).toBeUndefined();
  await choose(1);
  expect(dishLabels(container).map((label) => label?.split(" · ")[0])).toEqual(["1 × Tea"]);
  expect(note()).toBe(
    "Beef noodles (TEST): comped in part already, so the rest can only be comped (free).",
  );
  await click(container.querySelector(".table-checkout__field input"));
  const percent = container.querySelector<HTMLInputElement>(".table-checkout__field input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(percent, "50");
    percent?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await pause();
  // The ticked noodles are left out of what is asked: only the tea is discounted.
  expect(previews.filter((asked) => asked.kind === "Percent").at(-1)?.orderItemReferences).toEqual([
    tea,
  ]);
  expect(
    previews.some((asked) => asked.kind !== "Comp" && asked.orderItemReferences.includes(noodles)),
  ).toBe(false);
  await choose(2);
  expect(dishLabels(container).map((label) => label?.split(" · ")[0])).toEqual(["1 × Tea"]);
  // Back to Comp, the bowl left is offered (still ticked) again.
  await choose(0);
  expect(note()).toBeUndefined();
  expect(dishLabels(container)[0]?.startsWith("1 × Beef noodles (TEST) (1 comped already)")).toBe(
    true,
  );
  setLanguageForTest("zh-Hans");
  const zh = await open([firstBowl], fetcher);
  await click(buttonNamed(zh.container, "免单或折让"));
  await pause();
  await click(zh.container.querySelectorAll('input[name="item-comp-choice"]')[1]);
  await pause();
  expect(
    [...zh.container.querySelectorAll('[role="note"]')]
      .map((entry) => entry.textContent)
      .find((text) => text?.includes("剩下的只能免单")),
  ).toBe("Beef noodles (TEST) 已免单一部分，剩下的只能免单。");
});

it("no longer offers a line whose every bowl was comped", async () => {
  const { fetcher } = server();
  const { container } = await open(
    [firstBowl, { ...firstBowl, amountMinor: "1412", decidedAt: "2026-11-24T17:45:00.000Z" }],
    fetcher,
  );
  await click(buttonNamed(container, "Comp or discount"));
  await pause();
  expect(dishLabels(container)).toEqual(["1 × Tea · bill goes down $4.29 with tax"]);
});

it("says plainly when fewer bowls are left than were chosen", async () => {
  const { fetcher } = server("not_that_many");
  const { container } = await open([], fetcher);
  await click(buttonNamed(container, "Comp or discount"));
  await pause();
  await tick(container, "Beef noodles");
  await selectValue(container.querySelector(".item-comp__quantity select"), "1");
  await pause();
  await reason(container, "Wrong dish served");
  await click(buttonNamed(container, "Comp $14.13"));
  await settle(10);
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Fewer of these dishes are left to comp than you chose. Refresh the table, then choose again.",
  );
});

it("in Chinese the count reads 2 份中的 1 份", async () => {
  setLanguageForTest("zh-Hans");
  const { fetcher } = server();
  const { container } = await open([], fetcher);
  await click(buttonNamed(container, "免单或折让"));
  await pause();
  await tick(container, "Beef noodles");
  const label = container.querySelector(".item-comp__quantity");
  expect(label?.firstChild?.textContent).toBe("免单份数");
  expect(
    [...(label?.querySelectorAll("option") ?? [])].map((option) => option.textContent),
  ).toEqual(["2 份中的 2 份", "2 份中的 1 份"]);
  // Batch 61: the whole line by default; the dish follows the count chosen.
  expect(dishLabels(container)[0]).toBe("2 × Beef noodles (TEST) · 账单减 $28.25（含税）");
  await selectValue(label?.querySelector("select") ?? null, "1");
  await pause();
  expect(dishLabels(container)[0]).toBe(
    "Beef noodles (TEST) · 2 份中的 1 份 · 账单减 $14.13（含税）",
  );
});

it("batch 61: a line comped in part says the count chosen of the dishes left", async () => {
  // v15 b60 verify, order 54: 3 × Beef noodles (TEST), 1 comped; 1 of the 2 left is chosen.
  const { fetcher } = server();
  const { container } = await open([{ ...firstBowl, lineQuantity: 3 }], fetcher, undefined, 3);
  await click(buttonNamed(container, "Comp or discount"));
  await pause();
  await tick(container, "Beef noodles");
  await selectValue(container.querySelector(".item-comp__quantity select"), "1");
  await pause();
  expect(dishLabels(container)[0]).toBe(
    "1 of 2 × Beef noodles (TEST) (1 comped already) · bill goes down $14.13 with tax",
  );
});

it("a comp of some of a line's dishes is said with the dish, in both languages", () => {
  const zone = "America/Toronto";
  expect(compRecordLabel("Beef noodles (TEST)", firstBowl as never, zone)).toBe(
    "1 of 2 × Beef noodles (TEST) comped · Wrong dish served · by You, 12:40",
  );
  // The whole line reads as it always did.
  expect(
    compRecordLabel("Beef noodles (TEST)", { ...firstBowl, compedQuantity: 2 } as never, zone),
  ).toBe("Beef noodles (TEST) · Comped · Wrong dish served · by You, 12:40");
  expect(compRecordLabel("Tea", { ...firstBowl, compedQuantity: undefined } as never, zone)).toBe(
    "Tea · Comped · Wrong dish served · by You, 12:40",
  );
  setLanguageForTest("zh-Hans");
  expect(compRecordLabel("牛肉面", firstBowl as never, zone)).toMatch(
    // (Reason labels are read in the language the page loaded in.)
    /^牛肉面 · 免单 2 份中的 1 份 · /u,
  );
});

it("counts the dishes left on a line from its comps", () => {
  const two = { orderItemReference: noodles, quantity: 2 };
  expect(compDishesLeft(two, [])).toBe(2);
  expect(compDishesLeft(two, [firstBowl])).toBe(1);
  expect(compDishesLeft(two, [firstBowl, firstBowl])).toBe(0);
  // A reduction that names no dishes (an older server, a percentage) covers the line.
  expect(compDishesLeft(two, [{ orderItemReference: noodles }])).toBe(0);
  expect(compDishesLeft(two, [{ ...firstBowl, compedQuantity: null }])).toBe(0);
  expect(compDishesLeft(two, [{ ...firstBowl, orderItemReference: tea }])).toBe(2);
});
