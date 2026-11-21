import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { CustomerPage, PageHeading } from "./CustomerPage.js";

describe("customer page frame", () => {
  it("names the Store, the service and the current journey step", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CustomerPage
          step="cart"
          store={{ storeName: "Harbour Store", brandName: "Harbour", serviceMode: "Pickup" }}
          orderReference="018f5300-0000-7000-8000-000000000001"
        >
          <PageHeading title="Your cart" />
        </CustomerPage>
      </MemoryRouter>,
    );
    expect(html).toContain("<h1>Harbour Store</h1>");
    expect(html).toContain("Harbour · Pickup");
    expect(html).toContain('aria-label="Customer journey"');
    expect(html).toContain('href="/menu"');
    expect(html).toContain('<span aria-current="page">Cart</span>');
    expect(html).toContain('href="/orders/018f5300-0000-7000-8000-000000000001"');
    expect(html).toContain('id="main-content"');
    expect(html).toContain("<h2");
  });
  it("falls back to a neutral title without a Store", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CustomerPage step="other">
          <p>Body</p>
        </CustomerPage>
      </MemoryRouter>,
    );
    expect(html).toContain("<h1>Order</h1>");
    expect(html).not.toContain('href="/orders/');
  });
});
