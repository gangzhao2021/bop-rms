import type { Page } from "@playwright/test";

/**
 * UI refresh 2026-10-21: follow a workspace navigation link the way staff do. On a phone the
 * Menu drawer opens first; a link inside a closed group (Commerce, Supply, Organization, ...)
 * opens its group first. Works for the flat list of a short navigation as well.
 */
export async function followWorkspaceLink(page: Page, name: string) {
  const nav = page.getByRole("navigation", { name: "Workspace" });
  await nav.waitFor();
  const compactMenu = nav.locator(".workspace-sidebar__compact > summary");
  const compact = await compactMenu.isVisible();
  if (compact) await compactMenu.click();
  const scope = nav.locator(compact ? ".workspace-drawer" : ".workspace-sidebar__links");
  const exact = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u");
  const closedGroup = scope
    .locator(".workspace-nav__group")
    .filter({ has: page.locator("ul[hidden] a", { hasText: exact }) });
  if ((await closedGroup.count()) > 0)
    await closedGroup.first().locator(".workspace-nav__group-toggle").click();
  await scope.getByRole("link", { name, exact: true }).first().click();
}
