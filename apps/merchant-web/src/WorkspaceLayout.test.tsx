import { describe, expect, it } from "vitest";
import { currentNavigationItem, usesWorkspaceLayout } from "./WorkspaceLayout.js";

const items = [
  { screenId: "CAT-MENU-LIST", label: "Menus", href: "/app/commerce/menus", permission: "x" },
  {
    screenId: "CAT-AVAILABILITY",
    label: "Item availability",
    href: "/app/commerce/availability",
    permission: "x",
  },
  { screenId: "OPS-ORDER-QUEUE", label: "Orders", href: "/operations/orders", permission: "x" },
] as never;
describe("WP-2423 workspace layout", () => {
  it("wraps back-office pages except those with their own navigation", () => {
    expect(usesWorkspaceLayout("/app/commerce/menus/0190fa20-0000-7000-8000-000000000001")).toBe(
      true,
    );
    expect(usesWorkspaceLayout("/operations/orders")).toBe(true);
    expect(usesWorkspaceLayout("/app")).toBe(true);
    expect(usesWorkspaceLayout("/operations/kitchen")).toBe(false);
    expect(usesWorkspaceLayout("/app/commerce/products/new")).toBe(false);
    expect(usesWorkspaceLayout("/menu")).toBe(false);
  });
  it("marks the page whose route best matches the path", () => {
    expect(currentNavigationItem(items, "/app/commerce/menus/abc")).toBe("CAT-MENU-LIST");
    expect(currentNavigationItem(items, "/app/commerce/menusx")).toBeNull();
    expect(currentNavigationItem(items, "/operations/orders")).toBe("OPS-ORDER-QUEUE");
  });
});
