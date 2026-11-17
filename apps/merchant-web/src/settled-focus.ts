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
  const [box] = useState<{
    place: HTMLElement | null;
    selectors: readonly string[];
    /** `staffActions` when the confirm was pressed (null: no confirm on its way). */
    since: number | null;
  }>(() => ({ place: null, selectors, since: null }));
  box.selectors = selectors;
  useEffect(trackStaffActions, []);
  /** b25: staff pressed or tapped anything since the confirm: the focus is theirs from then on. */
  const movedOn = () => box.since !== null && staffActions > box.since;
  // The action renders nothing any more (its dishes are gone), still mounted.
  useEffect(() => {
    if (!gone || box.place === null) return;
    const place = box.place;
    box.place = null;
    if (!movedOn()) returnSettledFocus(place, box.selectors, movedOn);
  }, [gone, box]);
  // The action left the page with the change (or came back as a new one).
  useEffect(
    () => () => {
      const place = box.place;
      if (place === null) return;
      box.place = null;
      setTimeout(() => {
        if (!movedOn()) returnSettledFocus(place, box.selectors, movedOn);
      }, 0);
    },
    [box],
  );
  return {
    /**
     * b25 (live24): the confirm was pressed. Whatever staff press or tap from now on (also plain
     * text, which moves no focus, and before the answer comes) means they moved on.
     */
    confirming() {
      trackStaffActions();
      box.since = staffActions;
    },
    /**
     * b25 review: the confirm failed (an outage, a refusal, a change, a sign-in asked for) and the
     * panel stays open: what staff press from now on (Cancel, by click or Enter) is a step in this
     * panel again, so Cancel still gives the focus back to the opener.
     */
    failed(panel?: HTMLElement | null) {
      const moved = movedOn();
      box.since = null;
      // b26 (v15 b25 live): the confirm was locked while it was on its way, and the browser dropped
      // the focus to the page. Unless staff moved on, it goes back to the confirm once it can be
      // pressed again, else to what the panel now says (the failure, or the sign-in it asks for).
      if (moved || panel === undefined || panel === null) return;
      const since = staffActions;
      setTimeout(
        () =>
          whenFocusable(
            () => failedConfirmTarget(panel),
            undefined,
            () => staffActions > since,
          ),
        0,
      );
    },
    /** A confirm succeeded from `from` (the panel): remember its stable place. */
    settled(from: Element | null) {
      box.place = movedOn() ? null : (from?.closest<HTMLElement>("[data-focus-return]") ?? null);
    },
    /** Staff opened the action again: nothing to give back any more. */
    reset() {
      box.place = null;
      box.since = null;
    },
    /**
     * The panel closed with the action still there: the focus goes back to its opener once it can
     * take it. b24 review: the place is then forgotten once staff move on from the opener, or a few
     * seconds after, so a much later unmount (staff leaving the page) never looks for it again.
     * Until then it stays: the reread may still take the opener away (the last dish comped).
     */
    toOpener(value: string, current: HTMLElement | null) {
      const place = box.place;
      const forget = () => {
        if (box.place === place) box.place = null;
      };
      if (movedOn()) return forget();
      focusOpenerWhenReady(
        value,
        current,
        (focused) => {
          if (focused === null) return forget();
          setTimeout(forget, OPENER_FOCUS_WAIT_MS);
          focused.addEventListener(
            "focusout",
            () =>
              setTimeout(() => {
                if (focused.isConnected) forget();
              }, 0),
            { once: true },
          );
        },
        movedOn,
      );
    },
  };
}

/**
 * b25 (live24): every key press or tap by staff on the page, counted (never what it was). A tap on
 * plain text moves no focus, so the focus alone cannot say staff moved on.
 */
let staffActions = 0;
let trackingStaffActions = false;
function trackStaffActions(): void {
  if (trackingStaffActions || typeof document === "undefined") return;
  trackingStaffActions = true;
  const counted = (event: Event) => {
    if ((event as KeyboardEvent).repeat === true) return;
    staffActions += 1;
  };
  document.addEventListener("pointerdown", counted, true);
  document.addEventListener("keydown", counted, true);
}

/** The focus goes to the place only when it has nowhere else to be (never taken from staff). */
export function returnSettledFocus(
  place: HTMLElement,
  selectors: readonly string[],
  movedOn?: () => boolean,
): boolean {
  const active = document.activeElement;
  if (active !== null && active !== document.body && active.isConnected) return false;
  if (!place.isConnected) {
    // b24: the place was drawn again (a reread replaced it): its opener, found by its stable
    // `data-focus-opener` value, is the one place that still says where staff were.
    const opener = selectors.find((selector) => selector.startsWith("[data-focus-opener="));
    if (opener === undefined) return false;
    whenFocusable(() => document.querySelector<HTMLElement>(opener), undefined, movedOn);
    return true;
  }
  for (const selector of selectors) {
    const element = place.querySelector<HTMLElement>(selector);
    if (element === null) continue;
    if (element.matches(":disabled")) {
      // b24 review: the opener is there but locked while the floor is reread: wait for it.
      if (!selector.startsWith("[data-focus-opener=")) continue;
      whenFocusable(() => document.querySelector<HTMLElement>(selector), undefined, movedOn);
      return true;
    }
    focusable(element).focus();
    return true;
  }
  focusable(place).focus();
  return true;
}

/** The panel's confirm (`data-confirm`) when it can be pressed, else what the panel says. */
function failedConfirmTarget(panel: HTMLElement): HTMLElement | null {
  if (!panel.isConnected) return null;
  const confirm = panel.querySelector<HTMLElement>("[data-confirm]");
  if (confirm !== null && !confirm.matches(":disabled")) return confirm;
  const said = panel.querySelector<HTMLElement>('[role="alert"]');
  return said === null ? null : focusable(said);
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
export function focusOpenerWhenReady(
  value: string,
  current: HTMLElement | null,
  done?: (focused: HTMLElement | null) => void,
  movedOn?: () => boolean,
): void {
  const selector = focusOpenerSelector(value);
  whenFocusable(
    () => (current?.isConnected === true ? current : document.querySelector<HTMLElement>(selector)),
    done,
    movedOn,
  );
}

/**
 * Focuses what `find` returns once it is there and enabled (b24 review: also when it is drawn again
 * while still locked), for `OPENER_FOCUS_WAIT_MS` at most. It stops as soon as staff act: the focus
 * moved off the page, or they pressed or tapped anywhere (a tap on plain text moves no focus), here
 * or (b25) since the confirm was pressed (`movedOn`).
 * `done` runs with what took the focus, or with null once staff moved on.
 */
function whenFocusable(
  find: () => HTMLElement | null,
  done?: (focused: HTMLElement | null) => void,
  movedOn?: () => boolean,
): void {
  const until = Date.now() + OPENER_FOCUS_WAIT_MS;
  let staffActed = false;
  const onStaffAction = () => {
    staffActed = true;
  };
  document.addEventListener("pointerdown", onStaffAction, true);
  document.addEventListener("keydown", onStaffAction, true);
  const finish = (settled: boolean, focused: HTMLElement | null) => {
    document.removeEventListener("pointerdown", onStaffAction, true);
    document.removeEventListener("keydown", onStaffAction, true);
    if (settled) done?.(focused);
  };
  const attempt = () => {
    const active = document.activeElement;
    if (
      staffActed ||
      movedOn?.() === true ||
      (active !== null && active !== document.body && active.isConnected)
    ) {
      finish(true, null);
      return;
    }
    const target = find();
    if (target !== null && !target.matches(":disabled")) {
      target.focus();
      if (document.activeElement === target) {
        finish(true, target);
        return;
      }
    }
    if (Date.now() < until) setTimeout(attempt, OPENER_FOCUS_STEP_MS);
    else finish(false, null);
  };
  attempt();
}

/** The selector of an action's button by its `data-focus-opener` value (references only). */
export function focusOpenerSelector(value: string): string {
  return `[data-focus-opener="${value.replace(/["\\]/gu, "")}"]`;
}
