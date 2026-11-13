import { StatePanel } from "@bop-rms/ui";
import { useEffect, useRef } from "react";
import { t } from "./i18n/i18n.js";
import { StaffSignInLink } from "./StaffSession.js";
import { useStaffSessionLive } from "./staff-session-reads.js";
import { WorkspacePage } from "./WorkspacePage.js";

/**
 * v15 b12: whether this screen's sign-in is usable; when it becomes usable again (Check again found
 * it valid), `readAgain` runs once, so a page refused while signed out reads again by itself.
 */
export function useReadAgainWhenSignedInAgain(readAgain: () => void): boolean {
  const live = useStaffSessionLive();
  const wasLive = useRef(live);
  const retry = useRef(readAgain);
  retry.current = readAgain;
  useEffect(() => {
    if (live && !wasLive.current) retry.current();
    wasLive.current = live;
  }, [live]);
  return live;
}

/**
 * WP-2423 item 10: a back office page whose read did not work. A page that didn't open has no saved
 * work to wonder about, so it says that and offers the same read again. Only a real 403 talks about
 * permissions, and only no answer at all talks about the Wi-Fi.
 */
export function PageDidNotLoad({
  code,
  title,
  onRetry,
}: {
  /** v15 b12: "SignedOut": this screen's sign-in ended, so the read was never sent. */
  readonly code: "Unavailable" | "Offline" | "SignedOut";
  /** The page's own name and frame; left out where the page draws its frame itself. */
  readonly title?: string | undefined;
  readonly onRetry: () => void;
}) {
  // v15 b12: a read refused because the sign-in ended (here or on another screen) is said as
  // that, with the way to sign in again, never as a dropped connection or a fault. Once this
  // screen's sign-in works again (Check again), the page reads again by itself.
  const live = useReadAgainWhenSignedInAgain(onRetry);
  const panel =
    code === "SignedOut" || !live ? (
      <StatePanel heading={t("Sign in again")} tone="neutral" status>
        <p>
          {t(
            "Your sign-in on this screen has ended, so this page wasn't read. Sign in again to keep working. Nothing you saved is affected.",
          )}
        </p>
        <StaffSignInLink label={t("Sign in again")} />
        <button type="button" onClick={onRetry}>
          {t("Try again")}
        </button>
      </StatePanel>
    ) : (
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
  return title === undefined ? panel : <WorkspacePage title={title}>{panel}</WorkspacePage>;
}

/**
 * For a page's read effect: `setState(readingAgain)`. After a failed read the next try shows the page
 * reading, so a press of Try again is seen; a view on screen stays while it refreshes.
 */
export function readingAgain<S extends { readonly kind: string }>(
  current: S,
): S | { readonly kind: "Loading" } {
  return current.kind === "Unavailable" ||
    current.kind === "Offline" ||
    current.kind === "SignedOut"
    ? { kind: "Loading" }
    : current;
}
