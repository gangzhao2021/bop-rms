import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, type ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { currentNavigationItem, usesWorkspaceLayout, WorkspaceLayout } from "./WorkspaceLayout.js";

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
});
