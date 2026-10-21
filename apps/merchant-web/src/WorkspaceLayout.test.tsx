import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactElement } from "react";
import { MemoryRouter } from "react-router";
import {
  currentNavigationItem,
  usesWorkspaceLayout,
  WorkspaceLayout,
  workspaceNavigationSections,
} from "./WorkspaceLayout.js";

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
const inRouter = (element: ReactElement) =>
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/app"] }, element));
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
  it("WP-2423 Q5: shows each destination once in the workspace links", () => {
    const approvals = {
      screenId: "APPROVAL-INBOX",
      label: "Approvals",
      href: "/app/approvals",
      permission: "workflow.operate",
    };
    const html = inRouter(
      createElement(WorkspaceLayout, {
        items: [approvals, approvals] as never,
        path: "/app/approvals",
        storeLabel: "Synthetic Store",
        children: null,
      }),
    );
    const sidebar = html.slice(
      html.indexOf("workspace-sidebar__links"),
      html.indexOf("workspace-sidebar__compact"),
    );
    expect(sidebar.match(/>Approvals</gu)).toHaveLength(1);
  });
  it("v15 run: sidebar links keep real addresses for new tabs and mark the current page", () => {
    const html = inRouter(
      createElement(WorkspaceLayout, {
        items,
        path: "/operations/orders",
        storeLabel: "Synthetic Store",
        children: null,
      }),
    );
    const sidebar = html.slice(
      html.indexOf("workspace-sidebar__links"),
      html.indexOf("workspace-sidebar__compact"),
    );
    expect(sidebar).toContain('href="/app"');
    expect(sidebar).toContain('href="/app/commerce/menus"');
    expect(sidebar).toContain('aria-current="page" href="/operations/orders"');
  });
  describe("UI refresh 2026-10-21: navigation grouped by job (Section 88.3 / 88.26)", () => {
    const owner = [
      ["STORE-SETUP", "Store setup", "/app/organization/stores/x/setup"],
      ["CAT-PRODUCT-LIST", "Products", "/app/commerce/products"],
      ["OPS-ORDER-QUEUE", "Orders", "/operations/orders"],
      ["OPS-ORDER-ENTRY", "Counter order", "/operations/order-entry"],
      ["KIT-KITCHEN-QUEUE", "Kitchen", "/operations/kitchen"],
      ["FUL-PICKUP-QUEUE", "Pickup", "/operations/pickup"],
      ["DIN-FLOOR-BOARD", "Tables", "/operations/dining"],
      ["DIN-TABLE-LIST", "Table QR codes", "/app/operations/tables"],
      ["PAY-RECONCILIATION", "Settlement", "/app/operations/payment-reconciliation"],
      ["OPS-ORDER-EXCEPTION", "Exceptions", "/operations/order-exceptions"],
      ["RPT-OPS-DASHBOARD", "Reports", "/app/reports/operations"],
      ["INV-ITEM-LIST", "Inventory items", "/app/supply/items"],
      ["INV-RECEIPT-LIST", "Receiving", "/operations/receiving"],
      ["APPROVAL-INBOX", "Approvals", "/app/approvals"],
      ["IAM-USER-LIST", "Staff", "/app/organization/users"],
    ].map(([screenId, label, href]) => ({ screenId, label, href, permission: "x" })) as never;
    it("places each screen in its canonical group, in working order", () => {
      const sections = workspaceNavigationSections(owner);
      expect(sections.map((section) => section.label)).toEqual([
        null,
        "Operations",
        "Commerce",
        "Supply",
        "Reports",
        "Organization",
      ]);
      expect(sections[0]?.items.map((item) => item.label)).toEqual(["Approvals"]);
      expect(sections[1]?.items.map((item) => item.label)).toEqual([
        "Orders",
        "Counter order",
        "Kitchen",
        "Pickup",
        "Tables",
        "Exceptions",
        "Settlement",
        "Table QR codes",
      ]);
      expect(sections[3]?.items.map((item) => item.label)).toEqual([
        "Inventory items",
        "Receiving",
      ]);
    });
    it("keeps a short list (a cook, a cashier) flat, without group headings", () => {
      const sections = workspaceNavigationSections(items);
      expect(sections).toHaveLength(1);
      expect(sections[0]?.items.map((item) => item.label)).toEqual([
        "Orders",
        "Menus",
        "Item availability",
      ]);
    });
    it("opens Operations and the current page's group; other groups start closed", () => {
      const html = inRouter(
        createElement(WorkspaceLayout, {
          items: owner,
          path: "/app/supply/items",
          storeLabel: "Synthetic Store",
          children: null,
        }),
      );
      const sidebar = html.slice(
        html.indexOf("workspace-sidebar__links"),
        html.indexOf("workspace-sidebar__compact"),
      );
      expect(sidebar).toMatch(/aria-expanded="true"[^>]*><span>Operations</u);
      expect(sidebar).toMatch(/aria-expanded="true"[^>]*><span>Supply</u);
      expect(sidebar).toMatch(/aria-expanded="false"[^>]*><span>Commerce</u);
      expect(sidebar).toMatch(
        /id="workspace-nav-sidebar-commerce" class="workspace-nav__list" hidden/u,
      );
      expect(sidebar).toContain('aria-current="page" href="/app/supply/items"');
      // Every link still carries its real address, open or closed.
      expect(sidebar).toContain('href="/app/commerce/products"');
    });
  });
});
