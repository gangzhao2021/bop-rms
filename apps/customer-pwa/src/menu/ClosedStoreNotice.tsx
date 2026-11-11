import { Link } from "react-router";
import { t } from "../i18n/i18n.js";
import { nextOpeningText } from "../store/store-hours-text.js";
import type { MenuClosedStore } from "./types.js";

/** M116: "Closed now · opens tomorrow at 11:00 a.m.", and a way to ask again. */
export function ClosedStoreNotice({
  closed,
  primary,
}: {
  readonly closed: MenuClosedStore;
  /** The page's one main action, before Check again (which then is a plain link). */
  readonly primary?: React.ReactNode;
}) {
  return (
    <>
      <p className="menu-closed-notice__line">
        {closed.paused
          ? t("Ordering is paused for a short while")
          : closed.nextOpening === null
            ? t("Closed now")
            : t("Closed now") +
              " · " +
              nextOpeningText(closed.nextOpening, closed.localDate, "Line")}
      </p>
      <p>
        {closed.paused
          ? t("You can look at the menu. You can order once ordering starts again.")
          : t("You can look at the menu. You can order once the store opens.")}
      </p>
      {primary}
      <Link className={primary === undefined ? "menu-action" : undefined} to="/">
        {t("Check again")}
      </Link>
    </>
  );
}
