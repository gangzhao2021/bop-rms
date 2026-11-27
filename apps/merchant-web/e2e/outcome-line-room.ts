import { expect, type Locator } from "@playwright/test";

/**
 * WP-2423 batch 52 (v15 batch 51 live check): an outcome line brought into view must land whole
 * on the screen with room above it, never flush on the top edge (zh 390 sat at top -0.3 px) and
 * never under a warning pinned to the top. Polled until the scroll has settled. The value is the
 * room in px above the line, below anything pinned; a line cut off at the foot reads -1 and one
 * still moving -2.
 */
export async function expectRoomAbove(line: Locator, minimum = 12): Promise<void> {
  await expect
    .poll(
      () =>
        line.evaluate(async (node) => {
          const read = () => {
            const box = node.getBoundingClientRect();
            const pinned =
              Number.parseFloat(
                getComputedStyle(document.documentElement).getPropertyValue("--bop-pinned-top"),
              ) || 0;
            if (box.bottom > window.innerHeight) return -1;
            return Math.round((box.top - pinned) * 10) / 10;
          };
          const first = read();
          await new Promise((settle) => setTimeout(settle, 250));
          // Still moving (a later read or render scrolled it again): not settled yet.
          return read() === first ? first : -2;
        }),
      { message: "room above the outcome line (px), the line whole on screen", timeout: 3_000 },
    )
    .toBeGreaterThanOrEqual(minimum);
}
