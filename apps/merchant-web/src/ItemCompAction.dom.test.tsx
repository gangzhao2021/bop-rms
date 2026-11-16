// @vitest-environment jsdom
import { act, type ReactNode, useState } from "react";
import { afterEach, expect, it } from "vitest";
import { parseCurrentOrderDetail } from "./current-order-queue-client.js";
import { ItemCompAction } from "./ItemCompAction.js";
import { buttonNamed, click, mount, settle, typeInto } from "./dom-test-kit.fixture.js";
import { setLanguageForTest } from "./i18n/i18n.js";

/**
 * b23 (live22, TM2 L22 MCC A): the Comp or discount panel listed "1 × Smashed cucumber · price
 * $7.07" while its own button read "Comp $7.06" and the bill went down $7.06 (the bill's tax is
 * worked out once). Each dish now says what the bill goes down by, as the take-off panel does, so
 * the list and the button agree; partial discounts too.
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
const { order, lines } = parseCurrentOrderDetail(
  {
    screenId: "OPS-ORDER-DETAIL",
    pickupContact: null,
    order: {
      orderReference: id(1),
      orderNumber: "1",
      orderType: "DineIn",
      sourceChannel: "Qr",
      submittedAt: "2026-11-16T05:32:48.000Z",
      observedAt: "2026-11-16T05:39:00.000Z",
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
          compableItems: [id(201), id(202)],
          compedItems: [],
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
      items: [
        line(1, "Soy milk", "325", "42", "367"),
        line(2, "Smashed cucumber", "625", "82", "707"),
      ],
      totals: {
        subtotal: money("950"),
        discount: money("0"),
        tax: money("124"),
        fee: money("0"),
        total: money("1074"),
      },
    },
  },
  id(1),
);
/** The server's preview on the live bill: what the bill goes down by for this choice. */
const asked: { orderItemReferences: string[]; kind: string; percent: number | null }[] = [];
const fetcher = (async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as (typeof asked)[number];
  asked.push(body);
  const half = body.kind === "Percent" && body.percent === 50;
  const each = new Map([
    [id(201), half ? "184" : "367"],
    [id(202), half ? "353" : "706"],
  ]);
  const both = body.orderItemReferences.length === 2;
  // Together the bill's cent falls differently: $3.67 + $7.07 = $10.74 (or $1.84 + $3.53).
  const together = new Map([
    [id(201), half ? "184" : "367"],
    [id(202), half ? "354" : "707"],
  ]);
  const amounts = body.orderItemReferences.map((item) =>
    (both ? together : each).get(item),
  ) as string[];
  return new Response(
    JSON.stringify({
      status: "Preview",
      totalMinor: String(amounts.reduce((sum, value) => sum + Number(value), 0)),
      lines: body.orderItemReferences.map((item, index) => ({
        orderItemReference: item,
        amountMinor: amounts[index],
      })),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}) as typeof fetch;
const comp = () =>
  mount(
    <ItemCompAction
      order={order}
      lines={lines.items}
      csrf={"a".repeat(43)}
      fetcher={fetcher}
      onSettled={() => undefined}
    />,
  );
const pause = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 250));
  });
  await settle(10);
};
const labels = (container: HTMLElement) =>
  [...container.querySelectorAll(".pay-later-remove__lines label")].map((label) =>
    label.textContent?.trim(),
  );
const tick = async (container: HTMLElement, name: string) => {
  await click(
    [...container.querySelectorAll(".pay-later-remove__lines label")]
      .find((label) => label.textContent?.includes(name))
      ?.querySelector("input"),
  );
  await pause();
};

it("each dish says what the bill goes down by, and the button says the same", async () => {
  const { container } = await comp();
  await click(buttonNamed(container, "Comp or discount"));
  await pause();
  expect(labels(container)).toEqual([
    "1 × Soy milk · bill goes down $3.67 with tax",
    "1 × Smashed cucumber · bill goes down $7.06 with tax",
  ]);
  expect(container.textContent).not.toContain("price $7.07");
  await tick(container, "Smashed cucumber");
  expect(buttonNamed(container, "Comp $7.06")).toBeDefined();
  // Both ticked: each says its part of the ticked dishes' figure, which add up to the button.
  await tick(container, "Soy milk");
  expect(labels(container)).toEqual([
    "1 × Soy milk · bill goes down $3.67 with tax",
    "1 × Smashed cucumber · bill goes down $7.07 with tax",
  ]);
  expect(buttonNamed(container, "Comp $10.74")).toBeDefined();
});

it("a partial discount: each dish says what the bill goes down by for that percent", async () => {
  const { container } = await comp();
  await click(buttonNamed(container, "Comp or discount"));
  await settle(10);
  const percent = [...container.querySelectorAll('input[type="radio"]')].find((input) =>
    input.parentElement?.textContent?.includes("Percent off"),
  );
  await click(percent);
  // No percent yet: no figure for the choice, so each dish says its own price as that.
  expect(labels(container)).toEqual([
    "1 × Soy milk · price $3.67",
    "1 × Smashed cucumber · price $7.07",
  ]);
  await typeInto(container.querySelector('input[inputmode="numeric"]'), "50");
  await pause();
  expect(labels(container)).toEqual([
    "1 × Soy milk · bill goes down $1.84 with tax",
    "1 × Smashed cucumber · bill goes down $3.53 with tax",
  ]);
  await tick(container, "Smashed cucumber");
  expect(buttonNamed(container, "Take $3.53 off")).toBeDefined();
});

it("in Chinese the dish and the button read the same amount", async () => {
  setLanguageForTest("zh-Hans");
  const { container } = await comp();
  await click(buttonNamed(container, "免单或折让"));
  await pause();
  expect(labels(container)).toContain("1 × Smashed cucumber · 账单减 $7.06（含税）");
  await tick(container, "Smashed cucumber");
  expect(buttonNamed(container, "免单 $7.06")).toBeDefined();
});

it("opening moves the focus into the panel; Cancel gives it back to the opener", async () => {
  const { container } = await comp();
  const opener = buttonNamed(container, "Comp or discount");
  opener?.focus();
  await click(opener);
  await settle(10);
  const group = container.querySelector('[role="group"]');
  expect(group?.getAttribute("aria-label")).toBe("Comp or discount");
  expect(document.activeElement).toBe(group);
  await click(buttonNamed(container, "Cancel"));
  expect(container.querySelector('[role="group"]')).toBeNull();
  expect(document.activeElement).toBe(buttonNamed(container, "Comp or discount"));
});

// b23 review: each keystroke in Percent or Amount asked the server about every dish at once; the
// dishes' figures now wait as the button's does, and a newer keystroke cancels the older wait.
it("typing a percent asks about the dishes once it is typed, not at each keystroke", async () => {
  const { container } = await comp();
  await click(buttonNamed(container, "Comp or discount"));
  await click(
    [...container.querySelectorAll('input[type="radio"]')].find((input) =>
      input.parentElement?.textContent?.includes("Percent off"),
    ),
  );
  asked.length = 0;
  const input = container.querySelector('input[inputmode="numeric"]');
  await typeInto(input, "5");
  await typeInto(input, "50");
  await pause();
  expect(asked.filter((body) => body.percent === 5)).toHaveLength(0);
  expect(asked.filter((body) => body.percent === 50)).toHaveLength(2);
  expect(labels(container)).toEqual([
    "1 × Soy milk · bill goes down $1.84 with tax",
    "1 × Smashed cucumber · bill goes down $3.53 with tax",
  ]);
});

// b23 review: comping the table's last dishes leaves no "Comp or discount" button to give the
// focus back to (Tables drops the action): it fell to the page (document.activeElement BODY).
const compFetcher = (async (url: string, init?: RequestInit) =>
  url.endsWith("/preview")
    ? fetcher(url, init)
    : new Response(JSON.stringify({ status: "Recorded" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;
const table = (comped: boolean, action: ReactNode) => (
  <section className="table-order-rounds" data-focus-return="table">
    <h3>Round 1</h3>
    {comped ? (
      <ul className="table-order-rounds__comps" aria-label="Comps and discounts">
        <li>Smashed cucumber · Comped</li>
      </ul>
    ) : null}
    {action}
  </section>
);
const compAll = async (container: HTMLElement) => {
  await click(buttonNamed(container, "Comp or discount"));
  await pause();
  await tick(container, "Soy milk");
  await tick(container, "Smashed cucumber");
  await click(
    [...container.querySelectorAll('input[name="item-comp-reason"]')].find((input) =>
      input.parentElement?.textContent?.includes("Goodwill"),
    ),
  );
  await click(buttonNamed(container, "Comp $10.74"));
  await settle(10);
};
const later = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
};
const action = (detail: typeof order) => (
  <ItemCompAction
    order={detail}
    lines={lines.items}
    csrf={"a".repeat(43)}
    fetcher={compFetcher}
    onSettled={() => undefined}
  />
);
const nothingCompable = {
  ...order,
  batches: order.batches.map((batch) => ({ ...batch, compableItems: [] })),
};

it("b23 review: the last dishes comped: the focus goes to the table's comps, not the page", async () => {
  const { container, root } = await mount(table(false, action(order)));
  await compAll(container);
  // The table read again: nothing left to comp, so Tables shows no comp action.
  await act(async () => {
    root.render(table(true, null));
  });
  await later();
  expect(document.activeElement).toBe(container.querySelector(".table-order-rounds__comps"));
});

it("b23 review: the last dishes comped with the action still there: the focus goes to the comps", async () => {
  const { container, root } = await mount(table(false, action(order)));
  await compAll(container);
  await act(async () => {
    root.render(table(true, action(nothingCompable)));
  });
  await later();
  expect(document.activeElement).toBe(container.querySelector(".table-order-rounds__comps"));
});

// b24 (live23, TM2 L23 MCT A): on Tables, comping one dish while others stay compable left the
// focus on the page (BODY) for 5 s+. The confirm rereads the floor, which locks the table panel
// (its fieldset disabled) in the same render as the panel closes, so the opener could not take the
// focus; and the table's order may be drawn again, replacing the opener.
function TablesPanel({ remount }: { readonly remount: boolean }) {
  const [locked, setLocked] = useState(false);
  const [revision, setRevision] = useState(0);
  return table(
    false,
    <fieldset disabled={locked}>
      <ItemCompAction
        key={remount ? revision : 0}
        order={order}
        lines={lines.items}
        csrf={"a".repeat(43)}
        fetcher={compFetcher}
        onSettled={() => {
          setLocked(true);
          setTimeout(() => {
            setLocked(false);
            setRevision((value) => value + 1);
          }, 40);
        }}
      />
    </fieldset>,
  );
}
const compOne = async (container: HTMLElement) => {
  await click(buttonNamed(container, "Comp or discount"));
  await pause();
  await tick(container, "Smashed cucumber");
  await click(
    [...container.querySelectorAll('input[name="item-comp-reason"]')].find((input) =>
      input.parentElement?.textContent?.includes("Goodwill"),
    ),
  );
  await click(buttonNamed(container, "Comp $7.06"));
  await settle(10);
};
/** The floor read again and the panel unlocked (React applies the unlock as each act ends). */
const reread = async () => {
  for (let step = 0; step < 8; step += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
};

it("b24: on Tables one dish comped: the focus goes back to the opener once the panel unlocks", async () => {
  const { container } = await mount(<TablesPanel remount={false} />);
  await compOne(container);
  await reread();
  expect(document.activeElement).toBe(buttonNamed(container, "Comp or discount"));
});

it("b24: on Tables the opener drawn again after the reread still gets the focus", async () => {
  const { container } = await mount(<TablesPanel remount />);
  await compOne(container);
  await reread();
  expect(document.activeElement).toBe(buttonNamed(container, "Comp or discount"));
});

it("b24: staff already moved on: the focus is never taken back", async () => {
  const { container } = await mount(
    <>
      <TablesPanel remount={false} />
      <input aria-label="Search" />
    </>,
  );
  await compOne(container);
  container.querySelector<HTMLInputElement>('input[aria-label="Search"]')?.focus();
  await reread();
  expect(document.activeElement).toBe(container.querySelector('input[aria-label="Search"]'));
});
