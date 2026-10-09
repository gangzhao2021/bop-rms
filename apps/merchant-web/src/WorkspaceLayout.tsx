import { SkipLinkProvidedContext } from "@bop-rms/ui";
import type { ReactNode } from "react";
import type { MerchantNavigationItem } from "./merchant-workspace.js";

/** Pages that render their own full-screen chrome (kitchen display, dining floor) or must guard leaving. */
const ownNavigation = [
  /^\/operations\/(kitchen|dining)(\/|$)/u,
  /^\/app\/organization\/brands\/[^/]+$/u,
  /^\/app\/commerce\/products\/new$/u,
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
 * WP-2423 M1: one persistent, permission-trimmed workspace navigation beside every back-office
 * page (bop-rms-figma-make-brief.md §3); collapses into a disclosure on narrow screens.
 */
export function WorkspaceLayout({
  items,
  path,
  storeLabel,
  children,
}: {
  readonly items: readonly MerchantNavigationItem[];
  readonly path: string;
  readonly storeLabel: string;
  readonly children: ReactNode;
}) {
  const current = currentNavigationItem(items, path);
  const links = (
    <>
      <a href="/app" aria-current={path === "/app" ? "page" : undefined}>
        Home
      </a>
      {items
        .filter((item) => item.href !== "/app")
        .map((item) => (
          <a
            key={item.screenId}
            href={item.href}
            aria-current={item.screenId === current ? "page" : undefined}
          >
            {item.label}
          </a>
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
          <div>{links}</div>
        </details>
      </nav>
      <div className="workspace-content">
        <SkipLinkProvidedContext.Provider value={true}>{children}</SkipLinkProvidedContext.Provider>
      </div>
    </div>
  );
}
