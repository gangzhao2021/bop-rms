import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it } from "vitest";
import { App } from "./App.js";
import {
  setCustomerCsrfCredential,
  setEmptyTable,
  setMovedTableLabel,
  setSettledTable,
} from "./session/customer-transaction-context.js";

// Batch 46 (v15 b45 live, v-cart-after-close-G1-390.png): after staff closed a table where
// nothing was ordered, Your table showed the ended card with the Store, but Cart said "Order /
// Scan the location QR code to begin", "Your visit on this phone has ended" and offered "Refresh
// cart", and Menu went back to "Scan the location QR code". Every tab now says how the table's
// visit ended, with the Store's header, and offers nothing that cannot help.
const store = {
  brandDisplayName: "Test Merchant 2 - not production",
  storeDisplayName: "Test Merchant 2 Main - not production",
};
afterEach(() => {
  setCustomerCsrfCredential("D".repeat(43));
  setCustomerCsrfCredential(null);
});
const render = (path: string) =>
  renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
const tabs = ["/menu", "/menu/search", "/menu/items/0190fa21-0000-7000-8000-000000000003", "/cart"];

it("every tab after a table closed with nothing ordered says the visit ended, with the Store", () => {
  setEmptyTable({ tableLabel: "E45 A (TEST)", store });
  for (const path of [...tabs, "/"]) {
    const html = render(path);
    expect(html, path).toContain(store.storeDisplayName);
    expect(html, path).toContain(`${store.brandDisplayName} · Dine in`);
    expect(html, path).toContain("This table’s visit has ended");
    expect(html, path).toContain("Nothing was ordered at E45 A (TEST), so nothing was charged.");
    expect(html, path).toContain("New party? Ask staff to seat you, then scan again.");
    for (const wrong of [
      "Scan the location QR code",
      "Your visit on this phone has ended",
      "Refresh cart",
      "Your session ended",
      "join code",
    ])
      expect(html, `${path}: ${wrong}`).not.toContain(wrong);
    // The journey goes to Your table (where the same card is), not back to a scan.
    expect(html, path).toContain('href="/dine-in/session"');
  }
});

it("a paid table's tabs thank the guest and point to the receipt on Your table", () => {
  setSettledTable({ tableLabel: "E45 A (TEST)", csrfToken: "C".repeat(43), store });
  for (const path of tabs) {
    const html = render(path);
    expect(html, path).toContain("Thank you for dining with us.");
    expect(html, path).toContain("Your meal at E45 A (TEST) has ended.");
    expect(html, path).toContain("See the receipt");
    expect(html, path).not.toContain("Scan the location QR code");
    expect(html, path).not.toContain("Refresh cart");
  }
});

it("a merged party's tabs say where it eats now; with nothing ordered, no 'everything you ordered'", () => {
  setMovedTableLabel("E45 A (TEST)", true, store, true);
  for (const path of tabs) {
    const html = render(path);
    expect(html, path).toContain("Your table was merged into E45 A (TEST)");
    expect(html, path).toContain(
      "Staff joined your party to E45 A (TEST). Scan the code on E45 A (TEST) to keep ordering and paying together.",
    );
    expect(html, path).not.toContain("Everything your table ordered");
    expect(html, path).not.toContain("Scan the location QR code to begin");
    expect(html, path).not.toContain('role="alert"');
  }
  setMovedTableLabel("E45 A (TEST)", true, store, false);
  expect(render("/cart")).toContain("Everything your table ordered is on that table");
});

it("a phone with a visit, or none ever, keeps its ordinary pages", () => {
  expect(render("/cart")).not.toContain("This table’s visit has ended");
  expect(render("/")).toContain("Scan the location QR code");
  setEmptyTable({ tableLabel: "E45 A (TEST)", store });
  setCustomerCsrfCredential("D".repeat(43));
  expect(render("/cart")).not.toContain("This table’s visit has ended");
});
