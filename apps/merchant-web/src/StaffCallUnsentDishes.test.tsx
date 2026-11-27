// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callAsksForUnsentDishes,
  StaffCallUnsentDishes,
  useCallUnsentDishes,
} from "./StaffCallUnsentDishes.js";
import type { TableCartLine } from "./table-cart-client.js";

// Batch 66 (v15 b65 live, guest-cart-and-payments): a guest pressed "Ask staff to add these" with
// 2 Beef noodles unsent; staff Tables and the table panel read only "Asked for staff · A problem
// with their order", so the server had to ask the guest what was missing.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = (n: number) => "01909966-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const line = (n: number, phoneNumber: number | null, withOptions = false): TableCartLine => ({
  cartItemReference: id(n),
  sellableReference: id(50),
  optionSelections: [],
  names: { en: "Beef noodles (TEST)", "zh-Hans": "牛肉面" },
  quantity: 1,
  withOptions,
  phoneNumber,
  phoneLeft: false,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the dishes the table didn't send, under a guest's open call", () => {
  it("lists the unsent dishes with who added them, and opens a staff round for them", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <StaffCallUnsentDishes
            lines={[line(10, 1), line(11, 2, true)]}
            tableReference={id(1)}
            tableLabel="G65 B (TEST)"
            roundOffer="Offered"
            canTakeOrders
            paymentStarted={false}
            fullyRefunded={false}
          />
        </MemoryRouter>,
      ),
    );
    expect(host.querySelector("h3")?.textContent).toBe("Not sent to the kitchen");
    expect([...host.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Beef noodles (TEST) × 1Phone 1",
      "Beef noodles (TEST) × 1with options · Phone 2",
    ]);
    const link = host.querySelector("a");
    expect(link?.textContent).toBe("Order these for G65 B (TEST)");
    expect(link?.getAttribute("href")).toBe(
      "/operations/order-entry?table=" + encodeURIComponent(id(1)),
    );
  });

  it("at a table checking out, says what comes first instead of a round it can't take", () => {
    act(() =>
      root.render(
        <MemoryRouter>
          <StaffCallUnsentDishes
            lines={[line(10, 1)]}
            tableReference={id(1)}
            tableLabel="G65 B (TEST)"
            roundOffer="CheckingOut"
            canTakeOrders
            paymentStarted={false}
            fullyRefunded={false}
          />
        </MemoryRouter>,
      ),
    );
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector("p")?.textContent).toBe(
      "No new rounds while checking out. To add dishes, cancel checkout first.",
    );
  });

  it("reads the table's cart only while a call is open", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            cart: {
              cartReference: id(20),
              cartVersion: 3,
              guestPaying: false,
              guestChoosing: null,
              lines: [line(10, 1)],
            },
          }),
          { headers: { "content-type": "application/json", "cache-control": "no-store" } },
        ),
    );
    const seen: number[] = [];
    function Probe({ open }: { readonly open: boolean }) {
      seen.push(
        useCallUnsentDishes({
          open,
          diningSessionReference: id(3),
          csrf: "A".repeat(43),
          refreshKey: "1",
          fetcher: fetcher as unknown as typeof fetch,
        }).length,
      );
      return null;
    }
    await act(async () => root.render(<Probe open={false} />));
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => root.render(<Probe open />));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toBe(1);
  });

  it("is about the unsent dishes only for the Cart's OrderProblem call", () => {
    expect(callAsksForUnsentDishes({ reason: "OrderProblem" })).toBe(true);
    for (const reason of ["TableNeeds", "ReadyToPay", "Question", "AllergyQuestion"])
      expect(callAsksForUnsentDishes({ reason })).toBe(false);
    expect(callAsksForUnsentDishes(null)).toBe(false);
  });
});
