import { StatePanel } from "@bop-rms/ui";
import { t } from "./i18n/i18n.js";

/**
 * WP-2423 item 10: a back office page whose read did not work. A page that didn't open has no saved
 * work to wonder about, so it says that and offers the same read again. Only a real 403 talks about
 * permissions, and only no answer at all talks about the Wi-Fi.
 */
export function PageDidNotLoad({
  code,
  onRetry,
}: {
  readonly code: "Unavailable" | "Offline";
  readonly onRetry: () => void;
}) {
  return (
    <StatePanel
      heading={t("This page didn't load")}
      tone={code === "Offline" ? "offline" : "error"}
      status
    >
      <p>
        {code === "Offline"
          ? t(
              "The connection may have dropped while the page was opening. Check the Wi-Fi, then try again. Nothing you saved is affected.",
            )
          : t("Something went wrong on our side. Nothing you saved is affected.")}
      </p>
      <button type="button" onClick={onRetry}>
        {t("Try again")}
      </button>
    </StatePanel>
  );
}

/**
 * For a page's read effect: `setState(readingAgain)`. After a failed read the next try shows the page
 * reading, so a press of Try again is seen; a view on screen stays while it refreshes.
 */
export function readingAgain<S extends { readonly kind: string }>(
  current: S,
): S | { readonly kind: "Loading" } {
  return current.kind === "Unavailable" || current.kind === "Offline"
    ? { kind: "Loading" }
    : current;
}
