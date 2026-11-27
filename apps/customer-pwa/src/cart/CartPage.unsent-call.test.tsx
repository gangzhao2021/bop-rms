// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnsentAtCheckout } from "./CartPage.js";
import type { CartItemView } from "./types.js";
import type { DiningStaffCallClient } from "../dining/dining-staff-call-client.js";

// Batch 66 (v15 b65 live, guest-cart-and-payments): once every part of the table's bill was paid,
// the Cart still said "Ask a staff member to add these dishes." beside the unsent dishes, though
// Dining takes no round on a paid bill: following it means dishes on a paid bill, or a guest
// unsure whether they will be charged again.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const noodles: CartItemView = {
  cartItemReference: "01902520-0000-7000-8000-000000000002",
  sellableReference: "01902520-0000-7000-8000-000000000003",
  displayName: "Beef noodles (TEST)",
  quantity: 2,
  configuration: [],
  customerNote: null,
  lineEstimate: { status: "Unavailable", reasonCode: "LINE_ESTIMATE_UNAVAILABLE" },
  warnings: [],
} as unknown as CartItemView;

function staffCall(): DiningStaffCallClient & {
  readonly read: ReturnType<typeof vi.fn>;
  readonly call: ReturnType<typeof vi.fn>;
} {
  const view = { open: null, recentlyClosed: null, nextCallAt: null };
  return {
    read: vi.fn(async () => view),
    call: vi.fn(),
    withdraw: vi.fn(),
    newOperationReference: () => "01902520-0000-7000-8000-000000000009",
  } as never;
}

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

describe("UnsentAtCheckout (batch 66)", () => {
  it("while the bill is unpaid, still offers to call staff to add them", async () => {
    const client = staffCall();
    await act(async () => {
      root.render(<UnsentAtCheckout items={[noodles]} staffCall={client} />);
    });
    expect(client.read).toHaveBeenCalledTimes(1);
    expect([...host.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Ask staff to add these",
    ]);
    expect(host.textContent).not.toContain("not charged");
  });

  it("once the bill is paid, says the dishes were not ordered or charged, and calls nobody", async () => {
    const client = staffCall();
    await act(async () => {
      root.render(
        <UnsentAtCheckout
          items={[noodles]}
          staffCall={client}
          paidLine="To order anything else, ask staff."
        />,
      );
    });
    expect(host.querySelector("h3")?.textContent).toBe("Not sent to the kitchen");
    expect(host.querySelector("li")?.textContent).toBe("Beef noodles (TEST) × 2");
    expect([...host.querySelectorAll("p")].map((p) => p.textContent)).toEqual([
      "These dishes weren’t ordered, and you aren’t charged for them.",
      "To order anything else, ask staff.",
    ]);
    expect(host.querySelectorAll("button")).toHaveLength(0);
    expect(host.textContent).not.toContain("add these");
    expect(client.read).not.toHaveBeenCalled();
    expect(client.call).not.toHaveBeenCalled();
  });
});
