import { t } from "./i18n/i18n.js";
/**
 * WP-2423 (staff PIN design "A"): the BFF refuses sensitive changes made on a PIN sign-in that has
 * not been confirmed (refunds, cancellations, prices, tax, staff and roles, payment settings,
 * switching Store) with `403 { error: "full_sign_in_required" }`. This is not a missing
 * permission: the same person may go ahead after confirming it is them. Every command client maps
 * that answer to the one shared error kind below so pages show the same "Confirm it's you" step.
 */
export const FULL_SIGN_IN_REQUIRED = "FullSignInRequired" as const;
export type FullSignInRequired = typeof FULL_SIGN_IN_REQUIRED;

/** Plain-language guidance shown with the verification step (no internal codes). */
export const FULL_SIGN_IN_REQUIRED_TEXT = t(
  "You signed in with a PIN. Confirm it's you with your authenticator app, or sign in with your account, to do this.",
);

/** True for the BFF's PIN-session refusal (status and closed error code both match). */
export function isFullSignInRequired(status: number, payload: unknown): boolean {
  return (
    status === 403 &&
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as { error?: unknown }).error === "full_sign_in_required"
  );
}

/** Reads a copy of the body, so a client can still read the original response afterwards. */
export async function responseNeedsFullSignIn(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    return isFullSignInRequired(response.status, (await response.clone().json()) as unknown);
  } catch {
    return false;
  }
}

/** True for any client error (or outcome) carrying the shared kind. */
export function needsFullSignIn(value: unknown): boolean {
  if (value === FULL_SIGN_IN_REQUIRED) return true;
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { code?: unknown }).code === FULL_SIGN_IN_REQUIRED
  );
}
