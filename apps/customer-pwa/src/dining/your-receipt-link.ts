import { useEffect } from "react";

/**
 * Batch 62 (v15 b61 live, guest-refund-receipts-and-notices): Menu, dish pages and Cart's "See your
 * receipt" / 查看您的收据 opened Your table at the top. With the pay notice and the points sign-up
 * card above it, the payer's receipt heading sat below the fold on a phone (y=911 on an 844 px
 * screen), so the guest landed on the points form, not the receipt. The link now says, in the
 * router's state (nothing in the address), that it was followed for the receipt; Your table then
 * brings that receipt's heading into view and gives it focus.
 */
export const yourReceiptLinkState = Object.freeze({ show: "receipt" as const });

export const wantsYourReceipt = (state: unknown): boolean =>
  (state as { readonly show?: unknown } | null | undefined)?.show === "receipt";

/** The element a receipt's section carries so the link finds it, whichever receipt it is. */
export const yourReceiptAttribute = "data-your-receipt";
/**
 * Batch 62 review: this phone's payment said as lines inside the table's Receipt (it paid the whole
 * bill): the link opens that Receipt. A receipt of its own, when there is one, comes first.
 */
export const yourReceiptInTableAttribute = "data-your-receipt-in-table";

/** How long after the receipt is first shown content arriving above it may still move it. */
const settleMilliseconds = 4000;
/** How long the page waits for the receipt to be read at all. */
const waitMilliseconds = 15_000;

/**
 * While `active`, waits for this phone's receipt to be shown, scrolls its heading into view (the
 * heading's scroll margin keeps it clear of the tab bar) and focuses it. The pay section and the
 * points card are read at the same time and may arrive after it, pushing it down: until the guest
 * scrolls, taps or types, or a few seconds after it was first shown, it is brought back.
 */
export function useBringYourReceiptIntoView(active: boolean): void {
  useEffect(() => {
    if (!active || typeof document === "undefined") return;
    // The element given focus; a receipt drawn again (its section read anew) is given it again.
    let focused: HTMLElement | null = null;
    let shownAt: number | null = null;
    let stopped = false;
    // Its heading; a receipt that could not be read is its "try again" notice.
    const heading = () => {
      const receipt = document.querySelector<HTMLElement>(`[${yourReceiptAttribute}]`);
      if (receipt !== null) return receipt.querySelector<HTMLElement>("h2") ?? receipt;
      const inside = document.querySelector<HTMLElement>(`[${yourReceiptInTableAttribute}]`);
      return inside?.parentElement?.closest("section")?.querySelector<HTMLElement>("h2") ?? inside;
    };
    const place = () => {
      if (stopped) return;
      const target = heading();
      if (target === null) return;
      shownAt ??= Date.now();
      if (Date.now() - shownAt > settleMilliseconds) {
        stop();
        return;
      }
      target.scrollIntoView?.({ block: "start" });
      if (
        focused !== target &&
        (focused === null || !focused.isConnected || document.activeElement === document.body)
      ) {
        focused = target;
        if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
        target.focus({ preventScroll: true });
      }
    };
    const observer =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(() => place());
    observer?.observe(document.body, { childList: true, subtree: true, characterData: true });
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => place());
    resize?.observe(document.body);
    const guestMoved = () => stop();
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    for (const name of events) window.addEventListener(name, guestMoved, { passive: true });
    const giveUp = window.setTimeout(() => stop(), waitMilliseconds);
    function stop() {
      if (stopped) return;
      stopped = true;
      observer?.disconnect();
      resize?.disconnect();
      for (const name of events) window.removeEventListener(name, guestMoved);
      window.clearTimeout(giveUp);
    }
    place();
    return stop;
  }, [active]);
}
