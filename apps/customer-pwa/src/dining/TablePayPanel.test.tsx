// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LanguageRoot } from "../i18n/i18n.js";
import type { StoreProfile, StoreProfileLoader } from "../store/store-profile-client.js";
import { TablePayPanel } from "./TablePayPanel.js";
import { parseTablePaymentView, type createTablePaymentClient } from "./table-payment-client.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement, root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // The points offer's own read (not under test): nothing offered.
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const paidWhole = parseTablePaymentView({
  schemaVersion: 1,
  payment: {
    tableLabel: "12",
    checkingOut: true,
    rounds: [
      {
        roundNumber: 1,
        items: [{ displayName: "Beef noodles (TEST)", subtotalMinor: "1800" }],
        totalMinor: "2034",
      },
    ],
    owed: { subtotalMinor: "1800", taxMinor: "234", totalMinor: "2034" },
    consistent: true,
    state: "Paid",
    attempt: null,
    receipt: {
      method: "Online",
      roundsMinor: "2034",
      pointsUsedMinor: "0",
      tipMinor: "305",
      roundingMinor: "0",
      totalMinor: "2339",
      paidAt: "2026-11-24T00:35:02.000Z",
    },
  },
});
const store: StoreProfile = {
  storeDisplayName: "Test Merchant 2 Main - not production",
  timeZone: "America/Toronto",
  address: {
    addressLines: ["100 Example Street (TEST)"],
    locality: "Exampleville",
    regionCode: "ON",
    postalCode: "A1A 1A1",
    countryCode: "CA",
  },
  phone: null,
  hours: null,
};
const client = {
  read: async () => paidWhole,
} as unknown as ReturnType<typeof createTablePaymentClient>;

/**
 * Batch 63 review (F05): the receipt of a table one payment paid in full, shown in Pay the bill
 * while the table is still open, had no Store name, address or date and no way to keep a copy —
 * only the ended table's receipt had them.
 */
it("batch 63 review: a table paid in full, still open, has who it is from, when, and print", async () => {
  const loader: StoreProfileLoader = vi.fn().mockResolvedValue(store);
  await act(async () => {
    root.render(
      <LanguageRoot initial="en">
        {() => (
          <MemoryRouter>
            <TablePayPanel client={client} storeProfile={loader} />
          </MemoryRouter>
        )}
      </LanguageRoot>,
    );
  });
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve));
  });
  const receipt = container.querySelector("section.dining-session__receipt--printable");
  expect(receipt).not.toBeNull();
  const header = receipt?.querySelector(".dining-session__receipt-merchant");
  expect(header?.textContent).toContain("Test Merchant 2 Main - not production");
  expect(header?.textContent).toContain("100 Example Street (TEST)");
  expect(header?.textContent).toContain("Exampleville, ON A1A 1A1");
  expect(header?.textContent).toContain("Table 12");
  expect(header?.textContent).toMatch(/Paid Nov 2[34], 2026/u);
  const print = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Print or save receipt",
  );
  expect(print).toBeDefined();
  const printed = vi.spyOn(window, "print").mockImplementation(() => undefined);
  await act(async () => print?.click());
  expect(printed).toHaveBeenCalledTimes(1);
});

it("batch 63 review: a Store profile that can't be read leaves the header out, never the receipt", async () => {
  await act(async () => {
    root.render(
      <LanguageRoot initial="en">
        {() => (
          <MemoryRouter>
            <TablePayPanel client={client} storeProfile={vi.fn().mockResolvedValue(null)} />
          </MemoryRouter>
        )}
      </LanguageRoot>,
    );
  });
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve));
  });
  expect(container.querySelector(".dining-session__receipt-merchant")).toBeNull();
  expect(container.textContent).toContain("Thank you! Your table is paid in full.");
  expect(container.textContent).toContain("$23.39");
});

const dishRef = "0198b063-0000-7000-8000-000000000051";
const byGuests = (payment: Record<string, unknown>) =>
  parseTablePaymentView({
    schemaVersion: 1,
    payment: {
      tableLabel: "12",
      checkingOut: true,
      rounds: [
        {
          roundNumber: 1,
          items: [{ displayName: "Beef noodles (TEST)", subtotalMinor: "1800" }],
          totalMinor: "2034",
        },
      ],
      owed: { subtotalMinor: "1800", taxMinor: "234", totalMinor: "2034" },
      consistent: true,
      tips: { enabled: true, tierPercents: [10, 15, 18] },
      state: "NotPaid",
      attempt: null,
      receipt: null,
      split: { mode: "ByGuests", paidParts: 0, remainingMinor: "2034", parts: [] },
      choices: {
        defaultScope: "WholeTable",
        mine: null,
        addedAny: false,
        dishes: [
          {
            orderItemReference: dishRef,
            displayName: "Beef noodles (TEST)",
            roundNumber: 1,
            mine: false,
            unitMinor: ["2034"],
            unitSubtotalMinor: ["1800"],
          },
        ],
        rounds: [{ roundNumber: 1, restMinor: "2034", restSubtotalMinor: "1800" }],
      },
      ...payment,
    },
  });

/**
 * Batch 63 review: once a by-dish payment starts, the bill's way of paying changes (a part is
 * added for it), so the dishes and tip chosen for it are cleared. If that card payment then fails,
 * the guest chooses again (nothing is chosen for them), and paying again is a new payment, never
 * the failed one's reference.
 */
it("batch 63 review: after a by-dish card payment fails, the guest chooses again and pays anew", async () => {
  let current = byGuests({});
  const started = byGuests({
    state: "Paying",
    attempt: { totalMinor: "2304", tipMinor: "270", partNumber: 1 },
    split: {
      mode: "ByGuests",
      paidParts: 0,
      remainingMinor: "2034",
      parts: [{ partNumber: 1, amountMinor: "2034", subtotalMinor: "1800", status: "Mine" }],
    },
  });
  const start = vi.fn(async () => {
    current = started;
    return started;
  });
  const payments = {
    read: async () => current,
    start,
  } as unknown as ReturnType<typeof createTablePaymentClient>;
  const show = async (readKey: number) => {
    await act(async () => {
      root.render(
        <LanguageRoot initial="en">
          {() => (
            <MemoryRouter>
              <TablePayPanel client={payments} storeProfile={null} readKey={readKey} />
            </MemoryRouter>
          )}
        </LanguageRoot>,
      );
    });
    await act(async () => {
      for (let index = 0; index < 5; index += 1)
        await new Promise((resolve) => setTimeout(resolve));
    });
  };
  const radio = (selector: string) => container.querySelector<HTMLInputElement>(selector);
  const button = () => container.querySelector<HTMLButtonElement>(".dining-session__pay-button");
  await show(0);
  // The Store starts with the whole table; the guest chooses a tip and pays.
  expect(radio('input[name="table-pay-scope"]')?.checked).toBe(true);
  await act(async () => radio('input[name="table-tip"][value="15"]')?.click());
  expect(button()?.textContent).toBe("Pay $23.04");
  await act(async () => button()?.click());
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve));
  });
  expect(start).toHaveBeenCalledTimes(1);
  // The card was declined: the failed part is left out of the bill again.
  current = byGuests({ state: "Failed" });
  await show(1);
  expect(container.querySelectorAll("input:checked")).toHaveLength(0);
  expect(button()?.disabled).toBe(true);
  expect(button()?.textContent).toBe("Choose the dishes you pay for");
  // The guest chooses again; paying is a new payment.
  await act(async () => radio('input[name="table-pay-scope"]')?.click());
  await act(async () => radio('input[name="table-tip"][value="15"]')?.click());
  expect(button()?.textContent).toBe("Pay $23.04");
  await act(async () => button()?.click());
  expect(start).toHaveBeenCalledTimes(2);
  const references = start.mock.calls.map((call: unknown[]) => call[0]);
  expect(references[1]).not.toBe(references[0]);
});
