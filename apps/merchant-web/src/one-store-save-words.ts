import { t } from "./i18n/i18n.js";
import { MenuPageError } from "./store-menu-pages.js";
import { menuErrorText } from "./StoreMenuPages.js";

/**
 * WP-2423 item 10: a one-page save is several transactions. When it stops, the same operation goes
 * again and carries on from the steps it finished, so saving again never makes a second dish.
 */
export function oneStoreSaveMayContinue(error: unknown): boolean {
  return (
    error instanceof MenuPageError &&
    (error.code === "Offline" || error.code === "Unavailable" || error.code === "StoppedPartWay")
  );
}

/**
 * An existing item may be part saved. A new one may not exist at all (the first step can be what
 * failed), so it is not told what was saved: the form stays, and saving again finishes it.
 */
export function oneStoreSaveFailureText(error: unknown, existing: boolean): string {
  if (!(error instanceof MenuPageError))
    return t("That didn't go through. Read the menu again and retry.");
  if (error.code === "Unavailable" && existing) return menuErrorText.StoppedPartWay;
  return menuErrorText[error.code];
}

export const formChangedAfterStopText = t(
  "This form changed after saving stopped. Close it and open the item again to change it; nothing is lost.",
);
