import { SkipLinkProvidedContext } from "@bop-rms/ui";
import type { MouseEvent, ReactNode } from "react";
import { Link } from "react-router";
import type { MerchantNavigationItem } from "./merchant-workspace.js";

/** Pages that render their own full-screen chrome (kitchen display, dining floor) or must guard leaving. */
const ownNavigation = [
  /^\/operations\/(kitchen|dining)(\/|$)/u,
  /^\/app\/organization\/brands\/[^/]+$/u,
  /^\/app\/commerce\/products\/new$/u,
  // WP-2423 (design "A"): the shared tablet's staff PIN switch is a full-screen lock screen.
  /^\/operations\/switch-staff$/u,
  // WP-2423 DEC-COGNITO-STORE-STAFF: Staff sign-in, and the end of the "confirm it is you" window.
  /^\/operations\/sign-in$/u,
  /^\/app\/identity\/step-up-complete$/u,
];
export const usesWorkspaceLayout = (path: string) =>
  (path === "/app" || path.startsWith("/app/") || path.startsWith("/operations/")) &&
  !ownNavigation.some((pattern) => pattern.test(path));

/** The item whose route is the longest prefix of the current path is the current page. */
export function currentNavigationItem(
  items: readonly MerchantNavigationItem[],
  path: string,
): string | null {
  const matches = items.filter(
    (item) => item.href !== "/app" && (path === item.href || path.startsWith(item.href + "/")),
  );
  return matches.sort((a, b) => b.href.length - a.href.length)[0]?.screenId ?? null;
}

/**
 * v15 run (738b4c8b): the navigation that full-screen pages (Kitchen, kitchen work item, Dining,
 * Brand administration) pass to their own frame. Router links, like the workspace sidebar, so a
 * click stays inside the loaded app (no document reload, and no browser "No internet" page when
 * the screen was already fetched); the real href stays for new tabs and assistive technology.
 */
export function workspaceNavigationLinks(
  items: readonly MerchantNavigationItem[],
  isCurrent: (item: MerchantNavigationItem) => boolean,
): ReactNode[] {
  return items.map((item) => (
    <Link key={item.screenId} to={item.href} aria-current={isCurrent(item) ? "page" : undefined}>
      {item.label}
    </Link>
  ));
}

/**
 * WP-2423 M1: one persistent, permission-trimmed workspace navigation beside every back-office
 * page (bop-rms-figma-make-brief.md §3); collapses into a disclosure on narrow screens.
 */
export function WorkspaceLayout({
  items,
  path,
  storeLabel,
  children,
  footer = null,
}: {
  readonly items: readonly MerchantNavigationItem[];
  readonly path: string;
  readonly storeLabel: string;
  readonly children: ReactNode;
  /** WP-2423 Q18: session actions (Switch staff) under the navigation. */
  readonly footer?: ReactNode;
}) {
  const current = currentNavigationItem(items, path);
  // WP-2423 (v15 run): in-app navigation stays inside the loaded app. A plain link reloaded the
  // whole app on every click (re-checking every script) and showed the browser's own "No
  // internet" page offline even when the page was already downloaded. The real href stays for
  // open-in-new-tab, copy link and assistive technology.
  const closeCompactMenu = (event: MouseEvent<HTMLAnchorElement>) => {
    event.currentTarget.closest("details")?.removeAttribute("open");
  };
  const links = (
    <>
      <Link
        to="/app"
        aria-current={path === "/app" ? "page" : undefined}
        onClick={closeCompactMenu}
      >
        Home
      </Link>
      {items
        // WP-2423 Q5: one link per destination even if a screen is listed twice.
        .filter(
          (item, index) =>
            item.href !== "/app" && items.findIndex((other) => other.href === item.href) === index,
        )
        .map((item) => (
          <Link
            key={item.screenId}
            to={item.href}
            aria-current={item.screenId === current ? "page" : undefined}
            onClick={closeCompactMenu}
          >
            {item.label}
          </Link>
        ))}
    </>
  );
  return (
    <div className="workspace-layout">
      <a className="bop-skip-link" href="#main-content">
        Skip to main content
      </a>
      <nav className="workspace-sidebar" aria-label="Workspace">
        <p className="workspace-sidebar__brand">
          <strong aria-label="BOP">BOP</strong>
        </p>
        <p className="workspace-sidebar__store">{storeLabel}</p>
        <div className="workspace-sidebar__links">{links}</div>
        <details className="workspace-sidebar__compact">
          <summary>
            Menu
            {current === null
              ? ""
              : " · " + (items.find((item) => item.screenId === current)?.label ?? "")}
          </summary>
          <div>
            {links}
            {footer}
          </div>
        </details>
        {footer === null ? null : <div className="workspace-sidebar__footer">{footer}</div>}
      </nav>
      <div className="workspace-content">
        <SkipLinkProvidedContext.Provider value={true}>{children}</SkipLinkProvidedContext.Provider>
      </div>
    </div>
  );
}
