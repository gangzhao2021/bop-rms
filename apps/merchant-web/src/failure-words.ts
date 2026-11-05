import { t } from "./i18n/i18n.js";

/**
 * WP-2423 item 10: what staff read when the server answered and it did not work. It is never about
 * their permissions (only a real 403 says that) and never about their connection (the server
 * answered). "Offline" stays for a request that got no answer at all.
 */

/** A back office page: a read or a save that failed on our side. It may or may not have saved. */
export const serverProblemText = t(
  "Something went wrong on our side. If you just saved, open it to see whether it is there, then try again.",
);

/**
 * A screen in use on the floor: what to do now, on the screen they are working in. Pairs with the
 * outage guide on Tables (AGENTS.md operating continuity).
 */
export const floorServerProblemHeading = t("This screen isn't working");
export const floorServerProblemText = t(
  "Our system has a problem; your wifi is fine. Keep serving: paper slips for new rounds, card machine for payment. This screen keeps trying.",
);

/**
 * A command whose answer was a server failure: a lost COMMIT looks the same as nothing saved. The
 * same operation goes again, and it is recorded once.
 */
export const notConfirmedPressAgainText = t(
  "We couldn't confirm the result. Press again: it is never recorded twice.",
);

/** Facts moved under the request (another server got there first); the screen has read again. */
export const tableChangedText = t("This table changed. It has been read again.");

/** A client's own word for "the server answered 5xx", as told apart from "no answer". */
export function isServerProblem(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ServerProblem";
}
