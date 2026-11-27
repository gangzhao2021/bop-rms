import { describe, expect, it } from "vitest";
import { customerPageTitle } from "./CustomerPage.js";

describe("M111: each step's page title says where the guest is, then the Store", () => {
  it("names the step first on every step of the journey", () => {
    expect(customerPageTitle("menu", "Harbour Store")).toBe("Menu · Harbour Store");
    expect(customerPageTitle("cart", "Harbour Store")).toBe("Cart · Harbour Store");
    expect(customerPageTitle("checkout", "Harbour Store")).toBe("Checkout · Harbour Store");
    expect(customerPageTitle("payment", "Harbour Store")).toBe("Payment · Harbour Store");
    expect(customerPageTitle("order", "Harbour Store")).toBe("Your order · Harbour Store");
    expect(customerPageTitle("receipt", "Harbour Store")).toBe("Receipt · Harbour Store");
    expect(customerPageTitle("table", "Harbour Store")).toBe("Your table · Harbour Store");
    expect(customerPageTitle("entry", "Harbour Store")).toBe("Start your order · Harbour Store");
    const titles = (["menu", "cart", "checkout", "payment", "order", "receipt"] as const).map(
      (step) => customerPageTitle(step, "Harbour Store"),
    );
    expect(new Set(titles).size).toBe(titles.length);
  });
  it("keeps the product's name before a Store is known", () => {
    expect(customerPageTitle("menu")).toBe("BOP Order");
  });
});
