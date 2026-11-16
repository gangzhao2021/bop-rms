import { useEffect, useState } from "react";

/**
 * b23 review: where the focus goes after a confirmed take-off or comp whose button is gone with
 * the change (the whole round taken off, the last dish comped), so a keyboard or screen-reader user
 * never lands on the page itself. The panel's stable place on the page is the nearest element
 * marked `data-focus-return` (the round, the table's order); in it the focus goes to the first of
 * `selectors` that is there (the action's button again when it came back, then what says the
 * result), else to the place itself.
 */
export function useSettledFocus(selectors: readonly string[], gone: boolean) {
  const [box] = useState<{ place: HTMLElement | null; selectors: readonly string[] }>(() => ({
    place: null,
    selectors,
  }));
  box.selectors = selectors;
  // The action renders nothing any more (its dishes are gone), still mounted.
  useEffect(() => {
    if (!gone || box.place === null) return;
    const place = box.place;
    box.place = null;
    returnSettledFocus(place, box.selectors);
  }, [gone, box]);
  // The action left the page with the change (or came back as a new one).
  useEffect(
    () => () => {
      const place = box.place;
      if (place === null) return;
      box.place = null;
      setTimeout(() => returnSettledFocus(place, box.selectors), 0);
    },
    [box],
  );
  return {
    /** A confirm succeeded from `from` (the panel): remember its stable place. */
    settled(from: Element | null) {
      box.place = from?.closest<HTMLElement>("[data-focus-return]") ?? null;
    },
    /** Staff opened the action again: nothing to give back any more. */
    reset() {
      box.place = null;
    },
  };
}

/** The focus goes to the place only when it has nowhere else to be (never taken from staff). */
export function returnSettledFocus(place: HTMLElement, selectors: readonly string[]): boolean {
  const active = document.activeElement;
  if (active !== null && active !== document.body && active.isConnected) return false;
  if (!place.isConnected) {
    // b24: the place was drawn again (a reread replaced it): its opener, found by its stable
    // `data-focus-opener` value, is the one place that still says where staff were.
    for (const selector of selectors) {
      if (!selector.startsWith("[data-focus-opener=")) continue;
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null || element.matches(":disabled")) continue;
      element.focus();
      return document.activeElement === element;
    }
    return false;
  }
  for (const selector of selectors) {
    const element = place.querySelector<HTMLElement>(selector);
    if (element === null || element.matches(":disabled")) continue;
    focusable(element).focus();
    return true;
  }
  focusable(place).focus();
  return true;
}

function focusable(element: HTMLElement): HTMLElement {
  if (element.tabIndex < 0 && !element.hasAttribute("tabindex"))
    element.setAttribute("tabindex", "-1");
  return element;
}

/** How long a closed panel keeps trying to give the focus back to its opener (ms). */
export const OPENER_FOCUS_WAIT_MS = 6_000;
const OPENER_FOCUS_STEP_MS = 50;

/**
 * b24 (live23, Tables): a confirm rereads the floor, which locks the table panel (its fieldset
 * disabled) in the same render as the take-off or comp panel closes, and the table's order may be
 * drawn again, replacing the opener: `focus()` on it then did nothing and the focus stayed on the
 * page. The opener is found again by its `data-focus-opener` value and focused once it can take
 * it, for a few seconds at most; never once staff have put the focus somewhere else.
 */
export function focusOpenerWhenReady(value: string, current: HTMLElement | null): void {
  const selector = focusOpenerSelector(value);
  const until = Date.now() + OPENER_FOCUS_WAIT_MS;
  const attempt = () => {
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    const opener =
      current?.isConnected === true ? current : document.querySelector<HTMLElement>(selector);
    if (opener !== null && !opener.matches(":disabled")) {
      opener.focus();
      if (document.activeElement === opener) return;
    }
    if (Date.now() < until) setTimeout(attempt, OPENER_FOCUS_STEP_MS);
  };
  attempt();
}

/** The selector of an action's button by its `data-focus-opener` value (references only). */
export function focusOpenerSelector(value: string): string {
  return `[data-focus-opener="${value.replace(/["\\]/gu, "")}"]`;
}
