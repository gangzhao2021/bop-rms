/**
 * v15 store-day L4: one plain message when staff open a page, or try an action, their role does not
 * allow. It names who can help instead of a permission or scope name, and stays distinct from real
 * failures (offline, unavailable), which keep their own messages and retry paths.
 */
export const noAccessHeading = "No access";
export const pageAccessDeniedText =
  "You don't have access to this page. Ask the owner or a manager.";
export const actionAccessDeniedText =
  "You don't have access to do this. Ask the owner or a manager.";
