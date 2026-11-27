// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { kitchenSlotCovered, kitchenSlotHidden, kitchenSlotSeen } from "./KitchenBoardPages.js";

/**
 * Batch 53 (v15 b52 live, Test Merchant 2 orders 21, 22, 24 and 25): 53 tickets from earlier days
 * sat in the closed "Needs attention" section, yet kept boxes on the screen, so every new order
 * counted as arriving where a ticket was. Only tickets the cook can see count.
 */
const box = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});
const screen = { width: 1440, height: 900 };

describe("kitchenSlotSeen (WP-2423 batch 53)", () => {
  // The boxes peek.mjs read at 1440: earlier days' cards in the closed section, the new ticket.
  const earlier = [box(24, 361, 342, 969), box(382, 361, 700, 969)];
  const arriving = box(24, 328, 354, 601);
  it("leaves a closed section's cards out, so the new order is not covered", () => {
    const seen = earlier.filter((other) => kitchenSlotSeen(other, screen, true));
    expect(seen).toEqual([]);
    expect(kitchenSlotCovered(arriving, seen)).toBe(false);
    // Before batch 53 every box counted, and the new order waited.
    expect(kitchenSlotCovered(arriving, earlier)).toBe(true);
  });
  it("keeps a visible ticket, so a new one landing where it was still waits", () => {
    const seen = earlier.filter((other) => kitchenSlotSeen(other, screen, false));
    expect(seen).toEqual(earlier);
    expect(kitchenSlotCovered(arriving, seen)).toBe(true);
  });
  it("counts no ticket of no size or wholly off the screen", () => {
    expect(kitchenSlotSeen(box(24, 361, 24, 969), screen, false)).toBe(false);
    expect(kitchenSlotSeen(box(24, 361, 342, 361), screen, false)).toBe(false);
    expect(kitchenSlotSeen(box(24, -400, 342, -10), screen, false)).toBe(false);
    expect(kitchenSlotSeen(box(24, 900, 342, 1200), screen, false)).toBe(false);
    expect(kitchenSlotSeen(box(1440, 100, 1700, 300), screen, false)).toBe(false);
    expect(kitchenSlotSeen(box(-300, 100, 0, 300), screen, false)).toBe(false);
    // Partly on the screen is seen: a finger can reach what shows.
    expect(kitchenSlotSeen(box(24, 820, 342, 1100), screen, false)).toBe(true);
    expect(kitchenSlotSeen(box(24, -100, 342, 40), screen, false)).toBe(true);
  });
});

describe("kitchenSlotHidden (WP-2423 batch 53)", () => {
  const board = () => {
    document.body.innerHTML = `
      <details class="kitchen-earlier-days">
        <summary><span id="in-summary">Needs attention · 53 tickets from earlier days</span></summary>
        <div><section id="earlier" class="kitchen-earlier-ticket">Pickup · Order 1</section></div>
        <details id="inner" open><summary>More</summary><section id="nested">Order 2</section></details>
      </details>
      <section id="today" class="kitchen-ticket">Pickup · Order 21</section>`;
    const get = (id: string) => document.getElementById(id) as HTMLElement;
    return { get, section: document.querySelector("details") as HTMLDetailsElement };
  };
  it("a closed section hides its cards, not its summary or today's tickets", () => {
    const { get } = board();
    expect(kitchenSlotHidden(get("earlier"))).toBe(true);
    expect(kitchenSlotHidden(get("nested"))).toBe(true);
    expect(kitchenSlotHidden(get("in-summary"))).toBe(false);
    expect(kitchenSlotHidden(get("today"))).toBe(false);
  });
  it("an open section shows its cards again", () => {
    const { get, section } = board();
    section.open = true;
    expect(kitchenSlotHidden(get("earlier"))).toBe(false);
    expect(kitchenSlotHidden(get("nested"))).toBe(false);
    (get("inner") as HTMLDetailsElement).open = false;
    expect(kitchenSlotHidden(get("nested"))).toBe(true);
    expect(kitchenSlotHidden(get("earlier"))).toBe(false);
  });
});
