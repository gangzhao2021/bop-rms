import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
describe("customer PWA shell", () => {
  it("renders safe offline and error language", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(html).toContain("Order at BOP");
    expect(html).toContain("No cached menu is enabled");
    expect(html).toContain("Your order was not submitted");
    expect(html).toContain('href="#main-content"');
  });
  it("does not enable a Service Worker or background replay", () => {
    const source = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
    const manifest = JSON.parse(
      readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    );
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(source).not.toMatch(/serviceWorker|registerSW|workbox/i);
    expect(JSON.stringify(pkg)).not.toMatch(/vite-plugin-pwa|workbox-background-sync/i);
    expect(manifest.start_url).toBe("/");
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
});
