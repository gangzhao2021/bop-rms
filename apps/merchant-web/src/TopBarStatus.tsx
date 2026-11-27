import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Batch 63 (F38, Figma 58:65 after v3 46:2): on a tablet (wider than a phone, narrower than the
 * sidebar layout) the page's "Updated 01:36" sits in the top bar beside the language switch, as on
 * the approved 1024 frame. The workspace frame offers the place in its bar; a page shows its stamp
 * there instead of in its own header while the window is that wide, and back in its header
 * otherwise (a phone's bar has no room for it; a wide screen has the sidebar).
 */
export const TopBarStatusSlotContext = createContext<HTMLElement | null>(null);

/** The tablet range: the top bar replaces the sidebar but the page is not a phone. */
export const TABLET_TOP_BAR = "(min-width: 48.0625rem) and (max-width: 74.9375rem)";

function subscribe(query: string) {
  return (changed: () => void) => {
    if (typeof globalThis.matchMedia !== "function") return () => undefined;
    const list = globalThis.matchMedia(query);
    list.addEventListener("change", changed);
    return () => list.removeEventListener("change", changed);
  };
}
const subscribers = new Map<string, (changed: () => void) => () => void>();

/** Whether the window matches `query` now, following it as the window is resized or turned. */
export function useMediaQuery(query: string): boolean {
  let subscriber = subscribers.get(query);
  if (subscriber === undefined) {
    subscriber = subscribe(query);
    subscribers.set(query, subscriber);
  }
  return useSyncExternalStore(
    subscriber,
    () =>
      typeof globalThis.matchMedia === "function" && globalThis.matchMedia(query).matches === true,
    () => false,
  );
}

/** The page's status: in the top bar on a tablet, else where the page puts it. */
export function TopBarStatus({ children }: { readonly children: ReactNode }) {
  const slot = useContext(TopBarStatusSlotContext);
  const tablet = useMediaQuery(TABLET_TOP_BAR);
  if (slot !== null && tablet) return createPortal(children, slot);
  return <>{children}</>;
}

/**
 * Batch 65 (v15 b64: Products, Prices, Stock counts and Item availability had no "Updated 14:02",
 * only a date in their body text): the one stamp of a page that draws its own heading (a
 * `screen-heading` inside AppFrame) instead of WorkspacePage. In the tablet top bar as on every
 * other page, else at the heading's end beside the page's actions, where WorkspacePage puts it.
 */
export function PageStamp({ children }: { readonly children: ReactNode }) {
  return (
    <TopBarStatus>
      <div className="workspace-page__status page-stamp">{children}</div>
    </TopBarStatus>
  );
}
