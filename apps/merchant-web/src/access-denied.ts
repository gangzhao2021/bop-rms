import { t } from "./i18n/i18n.js";
/**
 * v15 store-day L4: one plain message when staff open a page, or try an action, their role does not
 * allow. It names who can help instead of a permission or scope name, and stays distinct from real
 * failures (offline, unavailable), which keep their own messages and retry paths.
 *
 * Batch 38 (v15 b37 finding 4b): every refusal says what this person can't do here and what to do
 * next — ask the owner or a manager for access, or sign in as a staff member who has it (shared
 * tablets switch staff with a PIN). A screen's own action refusal follows the same pattern:
 * "Your role can't <do it>. Ask the owner or a manager."
 */
export const noAccessHeading = t("No access");
export const pageAccessDeniedText = t(
  "Your role can't open this page. Ask the owner or a manager to give you access, or sign in as a staff member who has it.",
);
export const actionAccessDeniedText = t(
  "Your role can't do this. Ask the owner or a manager to give you access, or sign in as a staff member who can.",
);
/**
 * A kitchen display sign-in, or a cook whose role is the kitchen alone, on a page outside it: the
 * screen is only for kitchen work; the way back is the kitchen screen itself.
 */
export const kitchenOnlyAccessDeniedText = t(
  "You're signed in for kitchen work, which doesn't include this page. To use it, ask the owner or a manager, or sign in as a staff member who has it.",
);
export const backToKitchenText = t("Go to the kitchen");

/** The screens a kitchen-only sign-in lists: the kitchen board and recording waste. */
const kitchenWork: ReadonlySet<string> = new Set(["KIT-KITCHEN-QUEUE", "INV-WASTE-RECORD"]);
/**
 * Whether the person's navigation is kitchen work alone (a kitchen display sign-in lists only the
 * kitchen; a Kitchen role adds recording waste). Presentation only: the server refused the page.
 */
export function kitchenOnlyNavigation(items: readonly { readonly screenId: string }[]): boolean {
  return (
    items.some((item) => item.screenId === "KIT-KITCHEN-QUEUE") &&
    items.every((item) => kitchenWork.has(item.screenId))
  );
}
