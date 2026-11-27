/**
 * The warnings pinned above every screen (the refund countdown, then the paid order alarm) stack
 * one under the other, and the page's own sticky parts (side menu, panels) sit below them all:
 * `--bop-pinned-top` is their total height and `--bop-pinned-refund` the countdown's, where the
 * alarm starts. Each warning reports its height while shown and null when it goes.
 */
export type PinnedWarning = "refund" | "alarm";

const heights = new Map<PinnedWarning, number>();

export function publishPinnedHeight(name: PinnedWarning, height: number | null): void {
  if (height === null) heights.delete(name);
  else heights.set(name, Math.max(0, Math.ceil(height)));
  const root = globalThis.document?.documentElement;
  if (root === undefined) return;
  if (heights.size === 0) {
    root.style.removeProperty("--bop-pinned-top");
    root.style.removeProperty("--bop-pinned-refund");
    return;
  }
  let total = 0;
  for (const value of heights.values()) total += value;
  root.style.setProperty("--bop-pinned-top", `${total}px`);
  root.style.setProperty("--bop-pinned-refund", `${heights.get("refund") ?? 0}px`);
}

/** A ref callback that keeps one warning's height published while it is on screen. */
export function pinnedHeightRef(name: PinnedWarning) {
  return (node: HTMLElement | null) => {
    if (node === null) return;
    const publish = () => publishPinnedHeight(name, node.getBoundingClientRect().height);
    publish();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(publish) : null;
    observer?.observe(node);
    return () => {
      observer?.disconnect();
      publishPinnedHeight(name, null);
    };
  };
}
