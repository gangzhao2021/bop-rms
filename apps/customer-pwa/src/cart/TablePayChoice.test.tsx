// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCheckoutScopeClient } from "./checkout-scope-client.js";
import {
  PayerChoiceBanner,
  ScopeExpiryWarning,
  TablePayChooser,
  TableWaitingDishes,
  useWaitingReturn,
} from "./TablePayChoice.js";
import { createBrowserCustomerCartClient } from "./cart-client.js";
import type { CartTablePay, CartView } from "./types.js";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";

// WP-2423 shared-table-checkout (a): at a pay-first table the payer chooses this round's dishes,
// starting on the Store's choice; what waits is shown plainly; the payer is warned a minute before
// the choice stops being kept and can keep it or go back; a phone gives the waiting dishes back
// once nobody pays for them.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = (n: number) => "01902520-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const credential = "c".repeat(43);

function tableCart(tablePay: CartTablePay, version = 5): CartView {
  return {
    schemaVersion: 1,
    cart: {
      cartReference: id(1),
      version,
      orderType: "DineIn",
      serviceMode: "DineIn",
      context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
      lifecycle: {
        status: "Active",
        idleExpiresAt: "2026-08-02T21:00:00.000Z",
        absoluteExpiresAt: "2026-08-03T20:00:00.000Z",
      },
      items: [
        {
          cartItemReference: id(2),
          sellableReference: id(3),
          displayName: "Synthetic noodles",
          quantity: 2,
          configuration: [],
          customerNote: null,
          lineEstimate: { status: "Unavailable", reasonCode: "LINE_ESTIMATE_UNAVAILABLE" },
          warnings: [],
        },
        {
          cartItemReference: id(4),
          sellableReference: id(5),
          displayName: "Synthetic tea",
          quantity: 1,
          configuration: [],
          customerNote: null,
          lineEstimate: { status: "Unavailable", reasonCode: "LINE_ESTIMATE_UNAVAILABLE" },
          warnings: ["OTHER_PARTICIPANT_ITEM"],
        },
      ],
      quote: null,
      warnings: [],
      tablePay,
    },
  };
}
const idle: CartTablePay = {
  defaultChoice: "WholeTable",
  payer: null,
  waiting: [],
  returnable: false,
};
const prices = new Map([
  [id(2), { amountMinor: 2400n, currency: "CAD" }],
  [id(4), { amountMinor: 500n, currency: "CAD" }],
]);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setCustomerCsrfCredential(credential);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});
const render = (node: React.ReactNode) =>
  act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>));
const button = (text: string) =>
  [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  ) as HTMLButtonElement;
const radio = (text: string) =>
  [...container.querySelectorAll("label")]
    .find((label) => label.textContent?.includes(text))
    ?.querySelector("input") as HTMLInputElement;

/** A fake server: records each request and answers the next outcome in line. */
function server(...answers: (() => Response)[]) {
  const sent: { body: unknown; key: string | null }[] = [];
  const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      body: JSON.parse(String(init?.body)),
      key: new Headers(init?.headers).get("idempotency-key"),
    });
    const answer = answers.shift();
    if (answer === undefined) throw new Error("no answer");
    return answer();
  });
  let n = 100;
  return { client: createCheckoutScopeClient(fetch as never, () => id(++n)), sent };
}
const ok = (body: unknown) => () =>
  new Response(JSON.stringify({ schemaVersion: 1, ...(body as object) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("WP-2423 shared-table-checkout (a): which dishes the payer pays at a pay-first table", () => {
  it("starts on the whole table by default and on only what I added when the Store chose it", async () => {
    const { client } = server();
    await render(
      <TablePayChooser
        cart={tableCart(idle)}
        prices={prices}
        onChanged={() => undefined}
        client={client}
      />,
    );
    expect(radio("The whole table").checked).toBe(true);
    expect(container.textContent).toContain("The whole table (3 dishes · $29.00)");
    expect(container.textContent).toContain("Only what I added (2 · $24.00)");
    await render(
      <TablePayChooser
        key="own"
        cart={tableCart({ ...idle, defaultChoice: "OwnDishes" })}
        prices={prices}
        onChanged={() => undefined}
        client={client}
      />,
    );
    expect(radio("Only what I added").checked).toBe(true);
    expect(container.textContent).toContain(
      "Dishes you don't choose stay for the others at your table.",
    );
  });

  it("sends only what I added once, resends the same key after a lost answer, and opens the checkout", async () => {
    const { client, sent } = server(
      () => {
        throw new TypeError("offline");
      },
      ok({ status: "Chosen", cartVersion: 6, expiresAt: "2026-08-02T20:05:00.000Z" }),
    );
    const changed = vi.fn();
    await render(
      <TablePayChooser
        cart={tableCart({ ...idle, defaultChoice: "OwnDishes" })}
        prices={prices}
        onChanged={changed}
        client={client}
      />,
    );
    await act(async () => button("Continue to pay").click());
    expect(container.textContent).toContain(
      "We couldn't reach the store. Try again; nothing was charged.",
    );
    await act(async () => button("Continue to pay").click());
    expect(sent.map((entry) => entry.body)).toEqual([
      { action: "Choose", cartReference: id(1), expectedCartVersion: 5, choice: "Mine", lines: [] },
      { action: "Choose", cartReference: id(1), expectedCartVersion: 5, choice: "Mine", lines: [] },
    ]);
    expect(sent[0]?.key).toBe(sent[1]?.key);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("chooses dishes by units, for anyone's dish", async () => {
    const { client, sent } = server(
      ok({ status: "Chosen", cartVersion: 6, expiresAt: "2026-08-02T20:05:00.000Z" }),
    );
    await render(
      <TablePayChooser
        cart={tableCart(idle)}
        prices={prices}
        onChanged={() => undefined}
        client={client}
      />,
    );
    await act(async () => radio("Choose dishes to pay for").click());
    expect(button("Continue to pay").disabled).toBe(true);
    const more = [...container.querySelectorAll("button")].filter(
      (candidate) => candidate.textContent === "+",
    );
    await act(async () => more[0]?.click());
    await act(async () => more[1]?.click());
    await act(async () => button("Continue to pay").click());
    expect(sent[0]?.body).toEqual({
      action: "Choose",
      cartReference: id(1),
      expectedCartVersion: 5,
      choice: "Chosen",
      lines: [
        { cartItemReference: id(2), quantity: 1 },
        { cartItemReference: id(4), quantity: 1 },
      ],
    });
  });

  it("another phone sees plainly that someone pays and which of its dishes wait", async () => {
    await render(
      <TableWaitingDishes
        tablePay={{
          ...idle,
          payer: {
            thisPhone: false,
            choice: "Mine",
            expiresAt: "2026-08-02T20:05:00.000Z",
            reserved: true,
          },
          waiting: [
            {
              waitingLineReference: id(9),
              quantity: 2,
              names: { "en-CA": "Mapo tofu", "zh-Hans-CA": "麻婆豆腐" },
              withOptions: false,
              mine: true,
            },
          ],
        }}
      />,
    );
    expect(container.textContent).toContain(
      "Someone at your table is paying for their dishes. Yours are kept and come back here when they finish.",
    );
    expect(container.textContent).toContain("Next round");
    expect(container.textContent).toContain("Mapo tofu");
    expect(container.textContent).toContain("×2");
    expect(container.textContent).not.toContain(id(9));
  });

  it("warns the payer a minute before, keeps them for 5 more minutes, and says when they're no longer kept", async () => {
    vi.useFakeTimers();
    let clock = Date.parse("2026-08-02T20:00:00.000Z");
    const now = () => clock;
    const { client, sent } = server(
      ok({ status: "Extended", expiresAt: "2026-08-02T20:09:00.000Z" }),
    );
    const payer = {
      thisPhone: true,
      choice: "Mine" as const,
      expiresAt: "2026-08-02T20:05:00.000Z",
      reserved: true,
    };
    await render(
      <ScopeExpiryWarning
        payer={payer}
        now={now}
        onBack={() => undefined}
        onEnded={() => undefined}
        client={client}
      />,
    );
    expect(container.textContent).toBe("");
    clock = Date.parse("2026-08-02T20:04:00.000Z");
    await act(async () => vi.advanceTimersByTime(240_000));
    expect(container.textContent).toContain("The dishes you chose are kept for 60 more seconds.");
    await act(async () => button("Keep them").click());
    expect(sent[0]?.body).toEqual({ action: "Extend" });
    expect(container.textContent).toBe("");
    // Ran out (nobody kept them): the guest is told, and can still keep them or go back.
    clock = Date.parse("2026-08-02T20:09:01.000Z");
    await act(async () => vi.advanceTimersByTime(300_000));
    expect(container.textContent).toContain(
      "The dishes you chose are no longer kept: the others at your table can take theirs back.",
    );
    expect(button("Back to cart")).toBeDefined();
  });

  it("gives the waiting dishes back once per cart version when nobody pays for them", async () => {
    const { client, sent } = server(ok({ status: "Returned", cartVersion: 7, returnedUnits: 2 }));
    const reload = vi.fn();
    function Probe({ cart }: { cart: CartView }) {
      useWaitingReturn(cart, reload, client);
      return null;
    }
    const waiting = {
      ...idle,
      waiting: [
        {
          waitingLineReference: id(9),
          quantity: 2,
          names: {},
          withOptions: false,
          mine: true,
        },
      ],
    };
    await render(<Probe cart={tableCart({ ...waiting, returnable: false })} />);
    expect(sent).toEqual([]);
    await render(<Probe cart={tableCart({ ...waiting, returnable: true })} />);
    await render(<Probe cart={tableCart({ ...waiting, returnable: true })} />);
    expect(sent.map((entry) => entry.body)).toEqual([{ action: "Return" }]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("the payer's own phone never gives the dishes back by itself, even once its reservation ran out", async () => {
    const { client, sent } = server();
    const reload = vi.fn();
    function Probe({ cart }: { cart: CartView }) {
      useWaitingReturn(cart, reload, client);
      return null;
    }
    const lapsed: CartTablePay = {
      ...idle,
      payer: {
        thisPhone: true,
        choice: "Mine",
        expiresAt: "2026-08-02T20:05:00.000Z",
        reserved: false,
      },
      waiting: [
        { waitingLineReference: id(9), quantity: 1, names: {}, withOptions: false, mine: false },
      ],
      returnable: true,
    };
    await render(<Probe cart={tableCart(lapsed)} />);
    expect(sent).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it("asks again at the same cart version when someone started paying just before, once that wait is over", async () => {
    vi.useFakeTimers();
    const conflict = () =>
      new Response(
        JSON.stringify({ schemaVersion: 1, error: { code: "cart_checkout_in_progress" } }),
        {
          status: 409,
          headers: { "content-type": "application/json", "retry-after": "30" },
        },
      );
    const { client, sent } = server(
      conflict,
      ok({ status: "Returned", cartVersion: 6, returnedUnits: 1 }),
    );
    const reload = vi.fn();
    function Probe({ cart }: { cart: CartView }) {
      useWaitingReturn(cart, reload, client);
      return null;
    }
    const waiting: CartTablePay = {
      ...idle,
      waiting: [
        { waitingLineReference: id(9), quantity: 1, names: {}, withOptions: false, mine: true },
      ],
      returnable: true,
    };
    await render(<Probe cart={tableCart(waiting)} />);
    expect(sent).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(sent.map((entry) => entry.body)).toEqual([{ action: "Return" }, { action: "Return" }]);
    expect(sent[1]?.key).not.toBe(sent[0]?.key);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("on the payer's own cart, a minute before the choice runs out, it warns and keeps the dishes", async () => {
    vi.useFakeTimers();
    let clock = Date.parse("2026-08-02T20:04:30.000Z");
    const { client, sent } = server(
      ok({ status: "Extended", expiresAt: "2026-08-02T20:09:30.000Z" }),
    );
    await render(
      <PayerChoiceBanner
        payer={{
          thisPhone: true,
          choice: "Mine",
          expiresAt: "2026-08-02T20:05:00.000Z",
          reserved: true,
        }}
        now={() => clock}
        onCancelled={() => undefined}
        client={client}
      />,
    );
    expect(container.textContent).toContain("The dishes you chose are kept for 30 more seconds.");
    // One way back only: the banner's own.
    expect(
      [...container.querySelectorAll("button")].filter((b) => b.textContent === "Back to cart"),
    ).toHaveLength(0);
    await act(async () => button("Keep them").click());
    expect(sent.map((entry) => entry.body)).toEqual([{ action: "Extend" }]);
    expect(container.textContent).not.toContain("more seconds");
    clock = Date.parse("2026-08-02T20:05:01.000Z");
    await act(async () => vi.advanceTimersByTime(1000));
    expect(container.textContent).not.toContain("more seconds");
  });

  it("reads another phone paying as a wait with its seconds, a changed cart as read again, and an outage as unknown", async () => {
    const refusal = (status: number, code: string, retryAfter?: string) => () =>
      new Response(JSON.stringify({ schemaVersion: 1, error: { code } }), {
        status,
        headers: {
          "content-type": "application/json",
          ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
        },
      });
    const { client } = server(
      refusal(409, "cart_checkout_in_progress", "240"),
      refusal(409, "cart_version_conflict"),
      refusal(503, "cart_service_unavailable"),
    );
    expect(await client.send(id(50), { action: "Return" })).toEqual({
      status: "OtherPaying",
      retryAfterSeconds: 240,
    });
    expect(await client.send(id(51), { action: "Extend" })).toEqual({ status: "Changed" });
    expect(await client.send(id(52), { action: "Cancel" })).toEqual({ status: "Unknown" });
  });

  it("the cart client reads what the store sends about the round, and refuses a malformed one", async () => {
    const tablePay: CartTablePay = {
      defaultChoice: "OwnDishes",
      payer: {
        thisPhone: true,
        choice: "Chosen",
        expiresAt: "2026-08-02T20:05:00.000Z",
        reserved: true,
      },
      waiting: [
        {
          waitingLineReference: id(9),
          quantity: 1,
          names: { "en-CA": "Tea" },
          withOptions: false,
          mine: false,
        },
      ],
      returnable: false,
    };
    for (const [body, expected] of [
      [tableCart(tablePay), tablePay],
      [tableCart({ ...tablePay, payer: { ...tablePay.payer, choice: "Everyone" } } as never), null],
    ] as const) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
      );
      try {
        const view = await createBrowserCustomerCartClient()
          .loadCurrent()
          .catch(() => null);
        expect(view?.cart.tablePay ?? null).toEqual(expected);
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });
});
