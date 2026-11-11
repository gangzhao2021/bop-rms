import { isEntryCodeAddress } from "./entry-address.js";

/**
 * Guest entry, same-tab scan: a phone already on a Store's page that opens another Store's pickup
 * link or table code in the same tab changes only the address's fragment (`/#pickup=…`). The
 * browser keeps the page as it is, so the earlier Store stayed selected and the guest could order
 * there by mistake. The page starts again at the new code (its boot reads and removes the code, as
 * on any scan). Returns a stop function.
 */
export function reloadOnEntryCodeChange(input: {
  readonly events: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly hash: () => string;
  readonly reload: () => void;
}): () => void {
  let reloading = false;
  const changed = () => {
    if (reloading || !isEntryCodeAddress(input.hash())) return;
    reloading = true;
    input.reload();
  };
  input.events.addEventListener("hashchange", changed);
  return () => input.events.removeEventListener("hashchange", changed);
}
