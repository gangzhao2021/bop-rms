/**
 * Batch 64 (v15 b62 live, Orders and Exceptions): an order row's button draws no ring of its own;
 * the ring staff see is drawn by the row around it (`:has(.order-row__open:focus-visible)`). Tab
 * scrolls in only the button's own box, so a row arriving at the window's bottom edge kept the rest
 * of itself, and its ring, below the window (up to 118 px at 390). When the keyboard focuses a row
 * button, the box that draws the ring is brought wholly into view instead (its scroll-margin keeps
 * room for the ring). A pointer focus scrolls nothing.
 */
export function keepRowRingInView(button: HTMLElement): void {
  if (!button.matches(":focus-visible")) return;
  let ring: HTMLElement | null = button;
  for (let depth = 0; ring !== null && depth < 5; depth += 1) {
    const style = getComputedStyle(ring);
    if (
      style.display !== "contents" &&
      style.outlineStyle !== "none" &&
      (parseFloat(style.outlineWidth) || 0) > 0
    )
      break;
    ring = ring.parentElement;
  }
  if (ring === null || ring === button) return;
  const box = ring.getBoundingClientRect();
  const margin = getComputedStyle(ring);
  const view = document.documentElement;
  if (
    box.top >= (parseFloat(margin.scrollMarginTop) || 0) &&
    box.bottom <= view.clientHeight - (parseFloat(margin.scrollMarginBottom) || 0)
  )
    return;
  ring.scrollIntoView({ block: "nearest", inline: "nearest" });
}
