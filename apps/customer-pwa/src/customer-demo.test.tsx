import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import {
  customerDemoOrderReference,
  customerDemoSellableReference,
  enabledCustomerDemo,
  LocalCustomerDemoNotice,
} from "./customer-demo.js";
import { loadLocalCustomerDemo, shouldUseLocalCustomerDemoEntry } from "./customer-demo-entry.js";
import { MenuScreen } from "./menu/MenuPage.js";

describe("WP-2204 local Customer preview", () => {
  it("selects the separate entry only for the exact development flag", async () => {
    expect(shouldUseLocalCustomerDemoEntry("serve", "1")).toBe(true);
    expect(shouldUseLocalCustomerDemoEntry("build", "1")).toBe(false);
    expect(shouldUseLocalCustomerDemoEntry("serve", "true")).toBe(false);
    expect(shouldUseLocalCustomerDemoEntry("serve", undefined)).toBe(false);
    await expect(loadLocalCustomerDemo(async () => ({ enabledCustomerDemo }))).resolves.toBe(
      enabledCustomerDemo,
    );
    await expect(
      loadLocalCustomerDemo(async () => Promise.reject(new Error("load failed"))),
    ).resolves.toBeNull();
  });

  it("keeps the normal entry responsible for the Service Worker and the demo entry free of it", () => {
    const normal = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    const demo = readFileSync(new URL("./main.demo.tsx", import.meta.url), "utf8");
    const entry = readFileSync(new URL("./customer-demo-entry.ts", import.meta.url), "utf8");
    expect(normal).toContain("startCustomerServiceWorker");
    expect(normal).not.toContain("customer-demo");
    expect(demo).not.toMatch(/serviceWorker|startCustomerServiceWorker/u);
    expect(demo).toContain('import("./customer-demo.js")');
    expect(entry).toContain('command === "serve"');
  });

  it("labels every composed route and renders the Cart as read-only", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/cart"]}>
        <App demo={enabledCustomerDemo} />
      </MemoryRouter>,
    );
    expect(html).toContain("Local synthetic preview");
    expect(html).toContain("Read-only training data");
    expect(html).toContain("Synthetic mushroom rice bowl");
    expect(html).toContain("Offline read-only");
    expect(html).toContain(
      'disabled="" aria-label="Increase Synthetic mushroom rice bowl quantity"',
    );
    expect(html).not.toMatch(/customer@example|card number|delivery address/iu);
  });

  it("keeps menu item configuration unavailable in the preview", async () => {
    const loaded = await enabledCustomerDemo.menuClient.load();
    expect(loaded.kind).toBe("Found");
    if (loaded.kind !== "Found") throw new Error("synthetic menu missing");
    const sellable = loaded.menu.sections[0]?.sellables[0];
    expect(sellable?.sellableReference).toBe(customerDemoSellableReference);
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <MenuScreen
          context={enabledCustomerDemo.menuContext}
          detail={sellable}
          mode="detail"
          readOnlyNotice={enabledCustomerDemo.menuReadOnlyNotice}
          state={loaded}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Adding or configuring an item is unavailable");
    expect(html).not.toContain("Add to cart");
  });

  it("exposes deterministic read-only Checkout, Order, Delivery and Receipt facts", async () => {
    expect(enabledCustomerDemo.checkoutController.getState()).toMatchObject({ status: "ready" });
    expect(enabledCustomerDemo.orderStatusController.getState()).toMatchObject({
      status: "ready",
      view: { order: { orderReference: customerDemoOrderReference } },
    });
    await expect(
      enabledCustomerDemo.deliveryClient.load(customerDemoOrderReference),
    ).resolves.toMatchObject({
      publicOrderReference: customerDemoOrderReference,
      status: "Delivered",
      instructionUpdateAllowed: false,
    });
    expect(enabledCustomerDemo.receiptController.getState()).toMatchObject({
      status: "ready",
      view: { orderReference: customerDemoOrderReference, cancellationEligible: false },
    });
  });

  it.each([
    ["/orders/018f9900-0000-7000-8000-000000000099", "Loading order status"],
    ["/orders/018f9900-0000-7000-8000-000000000099/delivery", "Loading delivery status"],
    ["/orders/018f9900-0000-7000-8000-000000000099/receipt", "Loading receipt"],
  ])("does not treat another order route reference as preview authorization", (route, expected) => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[route]}>
        <App demo={enabledCustomerDemo} />
      </MemoryRouter>,
    );
    expect(html).toContain(expected);
    expect(html).not.toContain("Order completed");
    expect(html).not.toContain("Synthetic mushroom rice bowl");
  });

  it("uses only injected dependencies and does not require browser fetch", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await enabledCustomerDemo.entryClient.start();
    await enabledCustomerDemo.menuClient.load({ searchTerm: "mushroom" });
    await enabledCustomerDemo.cartController.load();
    await enabledCustomerDemo.checkoutController.load();
    await enabledCustomerDemo.orderStatusController.load();
    await enabledCustomerDemo.deliveryClient.load(customerDemoOrderReference);
    await enabledCustomerDemo.receiptController.load();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });

  it("renders the visible notice independently of route content", () => {
    const html = renderToStaticMarkup(<LocalCustomerDemoNotice />);
    expect(html).toContain('aria-label="Local synthetic preview"');
    expect(html).toContain("No API, payment, order or customer fact is created");
    expect(html).toContain(`/orders/${customerDemoOrderReference}/receipt`);
  });
});
