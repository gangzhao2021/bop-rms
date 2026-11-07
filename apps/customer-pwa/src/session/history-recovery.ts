/** A persisted document must not redisplay private React state before server reauthorization.
 * Reload uses ordinary startup and persisted checkout recovery; it never replays a command.
 */
export function protectCustomerHistoryRestore(options: {
  readonly events: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly cover: () => void;
  readonly reload: () => void;
}): () => void {
  let restoring = false;
  const hide = (event: PageTransitionEvent) => {
    if (event.persisted) options.cover();
  };
  const show = (event: PageTransitionEvent) => {
    if (!event.persisted || restoring) return;
    restoring = true;
    options.cover();
    options.reload();
  };
  options.events.addEventListener("pagehide", hide);
  options.events.addEventListener("pageshow", show);
  return () => {
    options.events.removeEventListener("pagehide", hide);
    options.events.removeEventListener("pageshow", show);
  };
}
