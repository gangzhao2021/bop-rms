import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
describe("customer PWA shell", () => {
  it("maps the canonical clean root to the missing-entry state", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(html).toContain("Start your order");
    expect(html).toContain("Scan the location QR code");
    expect(html).toContain("No store search is shown");
    expect(html).toContain('href="#main-content"');
  });
  it("keeps the synthetic foundation on unknown routes", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/unknown"]}>
        <App />
      </MemoryRouter>,
    );
    expect(html).toContain("Order at BOP");
    expect(html).toContain("No cached menu is enabled");
  });
  it("does not enable a Service Worker or background replay", () => {
    const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    const entrySource = readFileSync(new URL("./entry/entry-client.ts", import.meta.url), "utf8");
    const menuSource = readFileSync(new URL("./menu/menu-client.ts", import.meta.url), "utf8");
    const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const manifest = JSON.parse(
      readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    );
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(source).not.toMatch(/serviceWorker|registerSW|workbox/i);
    expect(entrySource).not.toMatch(/localStorage|sessionStorage|indexedDB|CacheStorage/i);
    expect(menuSource).not.toMatch(/localStorage|sessionStorage|indexedDB|CacheStorage/i);
    expect(appSource).not.toMatch(/csrfToken|publicTableReference|contextExpiresAt/);
    expect(JSON.stringify(pkg)).not.toMatch(/vite-plugin-pwa|workbox-background-sync/i);
    expect(manifest.start_url).toBe("/");
  });
  it("keeps WP-1707 separate from Workbox and private caching", () => {
    const connectivity = readFileSync(
      new URL("./connectivity/connectivity-controller.ts", import.meta.url),
      "utf8",
    );
    const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    expect(connectivity).not.toMatch(/fetch|retry\(|submit\(|observe\(|load\(/u);
    expect(`${connectivity}\n${pkg}`).not.toMatch(
      /serviceWorker|workbox|background.?sync|CacheStorage|localStorage|sessionStorage|indexedDB/u,
    );
  });
  it("maps the canonical clean /cart route to CUST-CART loading state", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/cart"]}>
        <App />
      </MemoryRouter>,
    );
    expect(html).toContain("Your cart");
    expect(html).toContain("Loading cart");
    expect(html).toContain('id="main-content"');
  });
  it("maps /checkout to the bounded CUST-CHECKOUT review state", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/checkout"]}>
        <App />
      </MemoryRouter>,
    );
    expect(html).toContain("Review your order");
    expect(html).toContain("Loading checkout");
    expect(html).toContain("Continue to payment");
    expect(html).toContain("Payment remains gated until an approved Provider");
  });
  it("maps the canonical clean Payment routes without trusting callback state", () => {
    const payment = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/checkout/payment"]}>
        <App />
      </MemoryRouter>,
    );
    const result = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/checkout/result?payment=success#provider-secret"]}>
        <App />
      </MemoryRouter>,
    );
    expect(payment).toContain("Continue to payment");
    expect(payment).toContain("Loading payment");
    expect(result).toContain("Verify your payment");
    expect(result).toContain("Verifying payment");
    expect(result).not.toContain("Payment confirmed");
    expect(result).not.toContain("provider-secret");
  });
  it("maps the canonical Order Status route without treating the reference as authority", () => {
    const reference = "018f7a00-0000-7000-8000-000000000001";
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/orders/${reference}`]}>
        <App />
      </MemoryRouter>,
    );
    expect(html).toContain("Track your order");
    expect(html).toContain("Loading order status");
    expect(html).toContain("Your Guest Session authorizes access");
    expect(html).not.toContain(reference);
  });
  it("fails a direct /menu navigation closed without page-memory Store context", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/menu"]}>
        <App />
      </MemoryRouter>,
    );
    expect(html).toContain("Scan the location QR code");
    expect(html).toContain("Return to entry");
    expect(html).not.toContain("/api/v1/public/stores/");
  });
  it("maps the canonical /menu route to loading with the minimal established context", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/menu"]}>
        <App
          initialMenuContext={{
            publicStoreReference: "018f7500-0000-7000-8000-000000000001",
            channel: "DineIn",
            locale: "en-CA",
            brandDisplayName: "BOP Test Kitchen",
            storeDisplayName: "Harbour Test Store",
          }}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Loading the current menu");
    expect(html).toContain("BOP Test Kitchen · Harbour Test Store");
  });
});
