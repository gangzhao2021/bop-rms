import { t } from "./i18n/i18n.js";
import { SkipLinkProvidedContext } from "@bop-rms/ui";
import {
  useEffect,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { Link } from "react-router";
import type { MerchantNavigationItem } from "./merchant-workspace.js";

/**
 * Pages that render their own full-screen chrome or must guard leaving. The Kitchen pages pick
 * their frame once the board says who is using it: the workspace frame (passed in by the app) for
 * a counter or office sign-in, the kitchen display's own kitchen-only frame otherwise. The dining
 * floor (Tables) uses the workspace layout since the 2026-10-21 UI refresh.
 */
const ownNavigation = [
  /^\/operations\/kitchen(\/|$)/u,
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
 * WP-2423 UI refresh (2026-10-21): the workspace navigation grouped by the Section 88.3 / 88.26
 * canonical Merchant primary navigation (Home, Operations, Commerce, Supply, Customers, Reports,
 * Compliance, Organization, Integrations). Home's own pages stay at the top without a heading;
 * the server still decides which items exist (permission-trimmed), this only places them.
 * Within a group the order follows a working day (take and run orders first, set-up last).
 */
export type WorkspaceNavigationGroup =
  | "home"
  | "operations"
  | "commerce"
  | "supply"
  | "customers"
  | "reports"
  | "compliance"
  | "organization"
  | "integrations";

/**
 * Group headings, and (from the server) each screen's label, are English keys shown through `t()`;
 * `i18n.test.ts` checks every one has its Simplified Chinese wording.
 */
export const GROUP_LABELS: Readonly<Record<Exclude<WorkspaceNavigationGroup, "home">, string>> = {
  operations: "Operations",
  commerce: "Commerce",
  supply: "Supply",
  customers: "Customers",
  reports: "Reports",
  compliance: "Compliance",
  organization: "Organization",
  integrations: "Integrations",
};
const GROUP_ORDER = Object.keys(GROUP_LABELS) as readonly Exclude<
  WorkspaceNavigationGroup,
  "home"
>[];

/** Every screen the server can list has a place; a new screen fails the type check until placed. */
const PLACEMENT: Readonly<
  Record<MerchantNavigationItem["screenId"], readonly [WorkspaceNavigationGroup, number]>
> = {
  "HOME-OVERVIEW": ["home", 0],
  "TASK-INBOX": ["home", 1],
  "APPROVAL-INBOX": ["home", 2],
  "OPS-ORDER-QUEUE": ["operations", 0],
  "OPS-ORDER-ENTRY": ["operations", 1],
  "KIT-KITCHEN-QUEUE": ["operations", 2],
  "FUL-PICKUP-QUEUE": ["operations", 3],
  "DIN-FLOOR-BOARD": ["operations", 4],
  "OPS-ORDER-EXCEPTION": ["operations", 5],
  "PAY-RECONCILIATION": ["operations", 6],
  "DIN-TABLE-LIST": ["operations", 7],
  "CAT-PRODUCT-LIST": ["commerce", 0],
  "CAT-MENU-LIST": ["commerce", 1],
  "CAT-OPTIONSET-LIST": ["commerce", 2],
  "CAT-AVAILABILITY": ["commerce", 3],
  "PRICE-BOOK-LIST": ["commerce", 4],
  "PRICE-OPTION-LIST": ["commerce", 5],
  "RECIPE-LIST": ["commerce", 6],
  "RECIPE-OPTION-LIST": ["commerce", 7],
  "TAX-CONFIG": ["commerce", 8],
  "TAX-STORE-REVIEW": ["commerce", 9],
  "CAT-TAX-CLASSIFICATION-LIST": ["commerce", 10],
  "INV-ITEM-LIST": ["supply", 0],
  "INV-COUNT-LIST": ["supply", 1],
  "INV-RECEIPT-LIST": ["supply", 2],
  "INV-WASTE-RECORD": ["supply", 3],
  "INV-LOCATION-LIST": ["supply", 4],
  "INV-OPENING-COUNT": ["supply", 5],
  "RPT-OPS-DASHBOARD": ["reports", 0],
  "CMP-ALLERGEN-REVIEW": ["compliance", 0],
  "STORE-SETUP": ["organization", 0],
  "STORE-HOURS-SERVICE": ["organization", 1],
  "ORG-STORE-LIST": ["organization", 2],
  "ORG-BRAND-DETAIL": ["organization", 3],
  "IAM-USER-LIST": ["organization", 4],
  "IAM-ROLE-LIST": ["organization", 5],
  "IAM-SESSION-LIST": ["organization", 6],
  "DEV-KDS-PROFILE": ["integrations", 0],
};

/** A short list (a cook, a cashier) reads best flat; headings only help once the list is long. */
const FLAT_LIST_LIMIT = 7;

export interface WorkspaceNavigationSection {
  readonly group: WorkspaceNavigationGroup;
  readonly label: string | null;
  readonly items: readonly MerchantNavigationItem[];
}

/** The listed destinations, once each, placed in their Section 88 group and working order. */
export function workspaceNavigationSections(
  items: readonly MerchantNavigationItem[],
): readonly WorkspaceNavigationSection[] {
  // WP-2423 Q5: one link per destination even if a screen is listed twice.
  const unique = items.filter(
    (item, index) =>
      item.href !== "/app" && items.findIndex((other) => other.href === item.href) === index,
  );
  const placed = unique
    .map((item, index) => ({ item, index, place: PLACEMENT[item.screenId] ?? ["home", 99] }))
    .sort((a, b) => a.place[1] - b.place[1] || a.index - b.index);
  if (unique.length <= FLAT_LIST_LIMIT) {
    const order: readonly WorkspaceNavigationGroup[] = ["home", ...GROUP_ORDER];
    return [
      {
        group: "home",
        label: null,
        items: [...placed]
          .sort((a, b) => order.indexOf(a.place[0]) - order.indexOf(b.place[0]))
          .map((entry) => entry.item),
      },
    ];
  }
  const sections: WorkspaceNavigationSection[] = [
    {
      group: "home",
      label: null,
      items: placed.filter((entry) => entry.place[0] === "home").map((entry) => entry.item),
    },
  ];
  for (const group of GROUP_ORDER) {
    const members = placed.filter((entry) => entry.place[0] === group).map((entry) => entry.item);
    if (members.length > 0) sections.push({ group, label: t(GROUP_LABELS[group]), items: members });
  }
  return sections;
}

/** Matches the stylesheet: at or below this width the sidebar becomes the Menu drawer. */
const WIDER_THAN_PHONE = t("(min-width: 48.0625rem)");

/** Which groups this device keeps open: a layout preference only, never business data. */
const OPEN_GROUPS_KEY = "bop-rms.merchant.navigation.open-groups";
const DEFAULT_OPEN: readonly WorkspaceNavigationGroup[] = ["operations"];
function storedOpenGroups(): readonly WorkspaceNavigationGroup[] {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(OPEN_GROUPS_KEY) ?? "null");
    if (Array.isArray(parsed))
      return parsed.filter((value): value is WorkspaceNavigationGroup =>
        GROUP_ORDER.includes(value as never),
      );
  } catch {
    // Storage blocked or unreadable: fall back to the default layout.
  }
  return DEFAULT_OPEN;
}
function storeOpenGroups(groups: ReadonlySet<WorkspaceNavigationGroup>) {
  try {
    globalThis.localStorage?.setItem(OPEN_GROUPS_KEY, JSON.stringify([...groups]));
  } catch {
    // Storage full or blocked: the groups still open and close for this visit.
  }
}

/**
 * WP-2423 M1: one persistent, permission-trimmed workspace navigation beside every back-office
 * page (bop-rms-figma-make-brief.md §3). Grouped and collapsible on desktop and tablet; a
 * full-height menu drawer on phones.
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
  const sections = workspaceNavigationSections(items);
  const currentGroup =
    sections.find((section) => section.items.some((item) => item.screenId === current))?.group ??
    null;
  const [openGroups, setOpenGroups] = useState<ReadonlySet<WorkspaceNavigationGroup>>(
    () => new Set([...storedOpenGroups(), ...(currentGroup === null ? [] : [currentGroup])]),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Arriving on a page (a link, a deep link, Back) opens the group it belongs to.
  useEffect(() => {
    if (currentGroup === null) return;
    setOpenGroups((open) => (open.has(currentGroup) ? open : new Set([...open, currentGroup])));
  }, [currentGroup]);
  // The phone drawer makes the page inert; growing past phone width (rotation, a resized window)
  // hides the drawer, so close it rather than leave the page unusable behind nothing.
  useEffect(() => {
    if (!drawerOpen || typeof globalThis.matchMedia !== "function") return;
    const wide = globalThis.matchMedia(WIDER_THAN_PHONE);
    const close = () => {
      if (!wide.matches) return;
      document.querySelector("details.workspace-sidebar__compact")?.removeAttribute("open");
      setDrawerOpen(false);
    };
    close();
    wide.addEventListener("change", close);
    return () => wide.removeEventListener("change", close);
  }, [drawerOpen]);
  const toggleGroup = (group: WorkspaceNavigationGroup) =>
    setOpenGroups((open) => {
      const next = new Set(open);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      storeOpenGroups(next);
      return next;
    });
  // WP-2423 (v15 run): in-app navigation stays inside the loaded app. A plain link reloaded the
  // whole app on every click (re-checking every script) and showed the browser's own "No
  // internet" page offline even when the page was already downloaded. The real href stays for
  // open-in-new-tab, copy link and assistive technology.
  const closeCompactMenu = (event: MouseEvent<HTMLElement>) => {
    const details = event.currentTarget.closest("details");
    if (details === null || !details.open) return;
    details.removeAttribute("open");
    // A link moves focus to the new page; the close controls hand it back to the Menu button.
    if (!(event.currentTarget instanceof HTMLAnchorElement))
      details.querySelector("summary")?.focus();
  };
  const currentLabel =
    current === null
      ? path === "/app"
        ? t("Home")
        : null
      : ((label) => (label === undefined ? null : t(label)))(
          items.find((item) => item.screenId === current)?.label,
        );
  // `copy` keeps the two renderings (sidebar, phone drawer) from repeating element ids.
  const links = (copy: "sidebar" | "drawer") => (
    <>
      <ul className="workspace-nav__list">
        <li>
          <Link
            to="/app"
            aria-current={path === "/app" ? "page" : undefined}
            onClick={closeCompactMenu}
          >
            {t("Home")}
          </Link>
        </li>
        {sections[0]?.items.map((item) => (
          <li key={item.screenId}>
            <Link
              to={item.href}
              aria-current={item.screenId === current ? "page" : undefined}
              onClick={closeCompactMenu}
            >
              {t(item.label)}
            </Link>
          </li>
        ))}
      </ul>
      {sections.slice(1).map((section) => {
        const open = openGroups.has(section.group);
        const listId = t("workspace-nav-{copy}-{group}", { copy: copy, group: section.group });
        return (
          <div
            key={section.group}
            className="workspace-nav__group"
            data-current={section.group === currentGroup ? "true" : undefined}
          >
            <button
              type="button"
              className="workspace-nav__group-toggle"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => toggleGroup(section.group)}
            >
              <span>{section.label}</span>
              {!open && section.group === currentGroup && currentLabel !== null ? (
                <span className="workspace-nav__group-current">{currentLabel}</span>
              ) : null}
            </button>
            <ul id={listId} className="workspace-nav__list" hidden={!open}>
              {section.items.map((item) => (
                <li key={item.screenId}>
                  <Link
                    to={item.href}
                    aria-current={item.screenId === current ? "page" : undefined}
                    onClick={closeCompactMenu}
                  >
                    {t(item.label)}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </>
  );
  const closeOnEscape = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    event.currentTarget.removeAttribute("open");
    event.currentTarget.querySelector("summary")?.focus();
  };
  return (
    <div className="workspace-layout" data-menu-open={drawerOpen ? "true" : undefined}>
      <a className="bop-skip-link" href="#main-content">
        {t("Skip to main content")}
      </a>
      <nav className="workspace-sidebar" aria-label={t("Workspace")}>
        <div className="workspace-sidebar__identity">
          <p className="workspace-sidebar__brand">
            <strong aria-label="BOP">BOP</strong>
          </p>
          <p className="workspace-sidebar__store">{storeLabel}</p>
        </div>
        <div className="workspace-sidebar__links">{links("sidebar")}</div>
        <details
          className="workspace-sidebar__compact"
          onToggle={(event: SyntheticEvent<HTMLDetailsElement>) =>
            setDrawerOpen(event.currentTarget.open)
          }
          onKeyDown={closeOnEscape}
        >
          <summary>
            {t("Menu{value}", { value: currentLabel === null ? "" : " · " + currentLabel })}
          </summary>
          <div className="workspace-drawer">
            <div className="workspace-drawer__panel">
              <div className="workspace-drawer__head">
                <p className="workspace-drawer__store">{storeLabel}</p>
                <button type="button" onClick={closeCompactMenu}>
                  {t("Close menu")}
                </button>
              </div>
              {links("drawer")}
              {footer}
            </div>
            {/* Tapping beside the drawer closes it; the labelled button above is the accessible way. */}
            <div
              className="workspace-drawer__backdrop"
              aria-hidden="true"
              onClick={closeCompactMenu}
            />
          </div>
        </details>
        {footer === null ? null : <div className="workspace-sidebar__footer">{footer}</div>}
      </nav>
      <div className="workspace-content" inert={drawerOpen}>
        <SkipLinkProvidedContext.Provider value={true}>{children}</SkipLinkProvidedContext.Provider>
      </div>
    </div>
  );
}
