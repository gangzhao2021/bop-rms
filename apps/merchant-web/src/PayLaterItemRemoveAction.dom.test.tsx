// @vitest-environment jsdom
import { act, type ReactNode, useState } from "react";
import { afterEach, expect, it } from "vitest";
import { parseCurrentOrderDetail } from "./current-order-queue-client.js";
import { PayLaterItemRemoveAction } from "./PayLaterItemRemoveAction.js";
import { buttonNamed, click, mount, settle } from "./dom-test-kit.fixture.js";
import { setLanguageForTest } from "./i18n/i18n.js";

/**
 * v15 live21 (TM2 Order 9, round 2 = Soy milk $3.67 + Smashed cucumber $7.07 at order time): the
 * panel listed "price $7.07" beside "Take off $7.06", and the bill went down by $7.06. b22: each dish
 * says what the bill goes down by when it alone comes off, so the dish and the button agree.
 */
afterEach(() => {
  setLanguageForTest("en");
  document.body.replaceChildren();
});

const id = (n: number) => `01909968-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const money = (amountMinor: string) => ({ amountMinor, currencyCode: "CAD" });
const line = (n: number, name: string, subtotal: string, tax: string, total: string) => ({
  orderItemReference: id(200 + n),
  orderBatchReference: id(91),
  name,
  options: [],
  quantity: 1,
  customerNote: null,
  unitPrice: money(subtotal),
  subtotal: money(subtotal),
  discount: money("0"),
  tax: money(tax),
  fee: money("0"),
  total: money(total),
  canCancel: false,
  cancellation: null,
});
/** Round 2's dishes, and those of them that can still come off (the rest stay on the bill). */
const readDetail = (
  dishes: ReturnType<typeof line>[],
  removable: readonly string[],
  totals: { subtotal: string; tax: string; total: string },
) =>
  parseCurrentOrderDetail(
    {
      screenId: "OPS-ORDER-DETAIL",
      pickupContact: null,
      order: {
        orderReference: id(1),
        orderNumber: "9",
        orderType: "DineIn",
        sourceChannel: "Qr",
        submittedAt: "2026-11-16T05:32:48.000Z",
        observedAt: "2026-11-16T05:39:00.000Z",
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
            unpaidRemovableItems: [],
            unpaidRemovedItems: [],
          },
          {
            orderBatchReference: id(91),
            sequence: 2,
            acceptanceStatus: "Accepted",
            canRequestAcceptance: false,
            canCancel: false,
            staffCancellation: null,
            canCancelItems: false,
            unpaidRemovableItems: removable,
            unpaidRemovedItems: [],
          },
        ],
        canRequestAcceptance: false,
        unfulfillable: null,
        pickupNotCollected: false,
        acceptBy: null,
        awaitingPayment: false,
        currentPhase: "InProgress",
        currentVersion: 7,
      },
      lines: {
        items: dishes,
        totals: {
          subtotal: money(totals.subtotal),
          discount: money("0"),
          tax: money(totals.tax),
          fee: money("0"),
          total: money(totals.total),
        },
      },
    },
    id(1),
  );
const { order, lines } = readDetail(
  [line(1, "Soy milk", "325", "42", "367"), line(2, "Smashed cucumber", "625", "82", "707")],
  [id(201), id(202)],
  { subtotal: "950", tax: "124", total: "1074" },
);
const batch = order.batches[1];
if (batch === undefined) throw new Error("fixture");
/** The server's preview on the live bill: what it goes down by for these dishes. */
const asked: string[][] = [];
const fetcher = (async (_url: string, init?: RequestInit) => {
  const items = (JSON.parse(String(init?.body)) as { orderItemReferences: string[] })
    .orderItemReferences;
  asked.push(items);
  const total =
    items.length === 2 ? "1074" : items[0] === id(201) ? "367" : items[0] === id(202) ? "706" : "";
  return new Response(JSON.stringify({ status: "Preview", totalMinor: total }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}) as typeof fetch;
const panel = (props: { openOnArrival?: boolean; onArrived?: () => void } = {}) =>
  mount(
    <PayLaterItemRemoveAction
      order={order}
      batch={batch}
      lines={lines.items}
      csrf={"a".repeat(43)}
      roundMinor="1073"
      fetcher={fetcher}
      onSettled={() => undefined}
      onRefused={() => undefined}
      {...props}
    />,
  );
const tick = async (container: HTMLElement, name: string) => {
  const box = [...container.querySelectorAll("label")]
    .find((label) => label.textContent?.includes(name))
    ?.querySelector("input");
  await click(box);
  // The ticked dishes together are asked for after a short pause.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  await settle();
};

it("each dish says what the bill goes down by, and the button says the same for it", async () => {
  const { container } = await panel();
  await click(buttonNamed(container, "Take dishes off round 2"));
  await settle(10);
  const group = container.querySelector('[role="group"]');
  expect(group?.getAttribute("aria-label")).toBe("Take dishes off round 2");
  const labels = [...container.querySelectorAll("label")].map((label) => label.textContent);
  // "with tax": the round above lists its dishes before tax ($3.25, $6.25).
  expect(labels).toContain(" 1 × Soy milk · bill goes down $3.67 with tax");
  expect(labels).toContain(" 1 × Smashed cucumber · bill goes down $7.06 with tax");
  expect(container.textContent).not.toContain("price $7.07");
  // Nothing ticked: a prompt for this round's dishes, which can't be pressed.
  const empty = buttonNamed(container, "Choose dishes to take off round 2");
  expect(empty).toBeDefined();
  expect((empty as HTMLButtonElement).disabled).toBe(true);
  expect(buttonNamed(container, "Take dishes off the bill")).toBeUndefined();
  await tick(container, "Smashed cucumber");
  expect(buttonNamed(container, "Take off $7.06")).toBeDefined();
  expect(container.querySelector(".pay-later-remove__note")).toBeNull();
  // Both: the bill goes down $10.74, a cent more than $3.67 + $7.06 and than the round's $10.73.
  await tick(container, "Soy milk");
  expect(buttonNamed(container, "Take the whole round off · $10.74")).toBeDefined();
  expect(container.querySelector(".pay-later-remove__note")?.textContent).toBe(
    "Tax is worked out once on the whole bill, so the bill goes down $10.74.",
  );
  // Each dish was asked about once; the one ticked dish was not asked again.
  expect(asked.filter((items) => items.length === 1 && items[0] === id(202))).toHaveLength(1);
});

it("in Chinese the dish and the button read the same amount", async () => {
  setLanguageForTest("zh-Hans");
  const { container } = await panel();
  await click(buttonNamed(container, "从第 2 轮删菜"));
  await settle(10);
  expect(container.textContent).toContain("1 × Smashed cucumber · 账单减 $7.06（含税）");
  expect(buttonNamed(container, "请选要从第 2 轮删的菜")).toBeDefined();
  await tick(container, "Smashed cucumber");
  expect(buttonNamed(container, "删掉 $7.06")).toBeDefined();
});

it("staff arriving for this round find its panel open, with the focus on it", async () => {
  let arrived = 0;
  const { container } = await panel({ openOnArrival: true, onArrived: () => (arrived += 1) });
  await settle(10);
  const group = container.querySelector('[role="group"]');
  expect(group).not.toBeNull();
  expect(document.activeElement).toBe(group);
  expect(arrived).toBe(1);
  // No second button of the same name to press.
  expect(buttonNamed(container, "Take dishes off round 2")).toBeUndefined();
});

// b22 review: round 2 has Beef noodles the kitchen started (it stays on the bill) and Soy milk not
// started. Ticking Soy milk is everything that can come off, but not the whole round: the round's
// $14.97 on the bill is more than $3.67 because the noodles stay, not because of tax.
it("a round with a dish that stays: ticking all that can come off is not the whole round, and no tax note", async () => {
  const mixed = readDetail(
    [line(1, "Soy milk", "325", "42", "367"), line(3, "Beef noodles", "1000", "130", "1130")],
    [id(201)],
    { subtotal: "1325", tax: "172", total: "1497" },
  );
  const round = mixed.order.batches[1];
  if (round === undefined) throw new Error("fixture");
  const { container } = await mount(
    <PayLaterItemRemoveAction
      order={mixed.order}
      batch={round}
      lines={mixed.lines.items}
      csrf={"a".repeat(43)}
      roundMinor="1497"
      fetcher={fetcher}
      onSettled={() => undefined}
      onRefused={() => undefined}
    />,
  );
  await click(buttonNamed(container, "Take dishes off round 2"));
  await settle(10);
  // Only the dish not started is offered.
  const labels = [...container.querySelectorAll(".pay-later-remove__lines label")].map(
    (label) => label.textContent,
  );
  expect(labels).toEqual([" 1 × Soy milk · bill goes down $3.67 with tax"]);
  await tick(container, "Soy milk");
  expect(buttonNamed(container, "Take off $3.67")).toBeDefined();
  expect(buttonNamed(container, "Take the whole round off · $3.67")).toBeUndefined();
  expect(container.querySelector(".pay-later-remove__note")).toBeNull();
});

// live22: on Tables, the Orders workbench and the order page, pressing "Take dishes off round 4"
// replaced the button with the panel and left the focus on the page (document.activeElement BODY).
it("b23: opening the panel in place moves the focus into it; Cancel gives it back to the opener", async () => {
  const { container } = await panel();
  const opener = buttonNamed(container, "Take dishes off round 2");
  opener?.focus();
  await click(opener);
  await settle(10);
  const group = container.querySelector('[role="group"]');
  expect(group).not.toBeNull();
  expect(document.activeElement).toBe(group);
  await click(buttonNamed(container, "Cancel"));
  expect(container.querySelector('[role="group"]')).toBeNull();
  expect(document.activeElement).toBe(buttonNamed(container, "Take dishes off round 2"));
});

// b23 review: after a confirmed take-off the focus went back to the button, but the whole round
// taken off leaves no button (the Tables round drops its take-off; the Orders page mounts it
// anew for the new version): the focus fell to the page (document.activeElement BODY).
const takeOffFetcher = (async (url: string, init?: RequestInit) =>
  url.endsWith("/preview")
    ? fetcher(url, init)
    : new Response(JSON.stringify({ status: "Removed" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
const round2 = (action: ReactNode) => (
  <section className="order-round" data-focus-return="round">
    <header className="order-round__head">
      <h3>Round 2</h3>
    </header>
    {action}
  </section>
);
const takeOff = (detail: ReturnType<typeof readDetail>, key: string) => {
  const round = detail.order.batches[1];
  if (round === undefined) throw new Error("fixture");
  return (
    <PayLaterItemRemoveAction
      key={key}
      order={detail.order}
      batch={round}
      lines={detail.lines.items}
      csrf={"a".repeat(43)}
      fetcher={takeOffFetcher}
      onSettled={() => undefined}
      onRefused={() => undefined}
    />
  );
};
const confirmTakeOff = async (container: HTMLElement, dishes: readonly string[]) => {
  await click(buttonNamed(container, "Take dishes off round 2"));
  await settle(10);
  for (const dish of dishes) await tick(container, dish);
  const select = container.querySelector("select");
  if (!(select instanceof HTMLSelectElement)) throw new Error("no reason");
  await act(async () => {
    select.value = select.options[1]?.value ?? "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click(container.querySelector(".pay-later-remove__actions .table-checkout__primary"));
  await settle(10);
};
const later = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
};

it("b23 review: the whole round taken off: the focus goes to the round's heading, not the page", async () => {
  const { container, root } = await mount(
    round2(
      takeOff(
        readDetail(
          [
            line(1, "Soy milk", "325", "42", "367"),
            line(2, "Smashed cucumber", "625", "82", "707"),
          ],
          [id(201), id(202)],
          { subtotal: "950", tax: "124", total: "1074" },
        ),
        "v7",
      ),
    ),
  );
  await confirmTakeOff(container, ["Soy milk", "Smashed cucumber"]);
  expect(document.activeElement).toBe(buttonNamed(container, "Take dishes off round 2"));
  // The table read again: nothing in round 2 comes off any more, so the round has no take-off.
  await act(async () => {
    root.render(round2(null));
  });
  await later();
  expect(document.activeElement).toBe(container.querySelector(".order-round__head h3"));
  expect(document.activeElement).not.toBe(document.body);
});

it("b23 review: some dishes taken off on a page that mounts the take-off anew: the focus is on its button again", async () => {
  const before = readDetail(
    [line(1, "Soy milk", "325", "42", "367"), line(2, "Smashed cucumber", "625", "82", "707")],
    [id(201), id(202)],
    { subtotal: "950", tax: "124", total: "1074" },
  );
  const { container, root } = await mount(round2(takeOff(before, "v7")));
  await confirmTakeOff(container, ["Soy milk"]);
  const after = readDetail([line(2, "Smashed cucumber", "625", "82", "707")], [id(202)], {
    subtotal: "625",
    tax: "82",
    total: "707",
  });
  await act(async () => {
    root.render(round2(takeOff(after, "v8")));
  });
  await later();
  expect(document.activeElement).toBe(buttonNamed(container, "Take dishes off round 2"));
});

// b24 (live23, TM2 L23 MCT A round 4): on Tables, taking one of a round's two dishes off left the
// focus on the page (BODY) for 5 s+: the confirm rereads the floor, which locks the table panel
// (its fieldset disabled) in the same render as the panel closes, so the opener couldn't take it.
function TablesRound() {
  const [locked, setLocked] = useState(false);
  const detail = readDetail(
    [line(1, "Soy milk", "325", "42", "367"), line(2, "Smashed cucumber", "625", "82", "707")],
    [id(201), id(202)],
    { subtotal: "950", tax: "124", total: "1074" },
  );
  const round = detail.order.batches[1];
  if (round === undefined) throw new Error("fixture");
  return round2(
    <fieldset disabled={locked}>
      <PayLaterItemRemoveAction
        order={detail.order}
        batch={round}
        lines={detail.lines.items}
        csrf={"a".repeat(43)}
        fetcher={takeOffFetcher}
        onSettled={() => {
          setLocked(true);
          setTimeout(() => setLocked(false), 40);
        }}
        onRefused={() => undefined}
      />
    </fieldset>,
  );
}

it("b24: on Tables one dish of two taken off: the focus goes back to the opener once the panel unlocks", async () => {
  const { container } = await mount(<TablesRound />);
  await confirmTakeOff(container, ["Soy milk"]);
  for (let step = 0; step < 8; step += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  expect(document.activeElement).toBe(buttonNamed(container, "Take dishes off round 2"));
});

// b26 (v15 b25 live): the confirm is locked while it is on its way, and the browser drops the focus
// to the page; when the answer was lost (the connection dropped) the panel said "Press the button
// again" with document.activeElement BODY. The focus goes back to the confirm, where it was.
it("b26: a take-off whose answer was lost gives the focus back to the confirm", async () => {
  const dropped = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/preview")) return fetcher(url, init);
    (document.activeElement as HTMLElement | null)?.blur();
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  const { container } = await mount(
    <PayLaterItemRemoveAction
      order={order}
      batch={batch}
      lines={lines.items}
      csrf={"a".repeat(43)}
      roundMinor="1073"
      fetcher={dropped}
      onSettled={() => undefined}
      onRefused={() => undefined}
    />,
  );
  await click(buttonNamed(container, "Take dishes off round 2"));
  await settle(10);
  await tick(container, "Smashed cucumber");
  const select = container.querySelector("select");
  if (!(select instanceof HTMLSelectElement)) throw new Error("no reason");
  await act(async () => {
    select.value = select.options[1]?.value ?? "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const confirm = buttonNamed(container, "Take off $7.06") as HTMLButtonElement;
  confirm.focus();
  await click(confirm);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
  });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "Press the button again",
  );
  expect(document.activeElement).toBe(buttonNamed(container, "Take off $7.06"));
});
