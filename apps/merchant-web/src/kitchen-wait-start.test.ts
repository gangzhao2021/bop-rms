import { describe, expect, it } from "vitest";
import { kitchenBoardFixture, kitchenItemFixture } from "./kitchen-board.fixtures.js";
import { kitchenWaitStart, parseKitchenBoardView } from "./kitchen-board.js";
import { kitchenTicketAge } from "./KitchenBoardPages.js";

describe("merchant-outage-recovery M120: the kitchen counts a ticket's wait from the order", () => {
  it("reads placedAt when the server sends it, and works without it", () => {
    const placed = parseKitchenBoardView({
      ...kitchenBoardFixture(),
      items: [{ ...kitchenItemFixture(), placedAt: "2026-08-12T14:51:00.000Z" }],
    }).items[0];
    expect(placed?.placedAt).toBe("2026-08-12T14:51:00.000Z");
    const older = parseKitchenBoardView(kitchenBoardFixture()).items[0];
    expect(older?.placedAt).toBeUndefined();
    expect(older && kitchenWaitStart(older)).toBe("2026-08-12T15:00:00.000Z");
    expect(() =>
      parseKitchenBoardView({
        ...kitchenBoardFixture(),
        items: [{ ...kitchenItemFixture(), placedAt: "yesterday" }],
      }),
    ).toThrow();
  });

  it("an order accepted 9 minutes after it was placed shows its full wait", () => {
    const view = parseKitchenBoardView({
      ...kitchenBoardFixture(),
      // Placed 14:51, accepted (the work item created) 15:00, now 15:12.
      items: [{ ...kitchenItemFixture(), placedAt: "2026-08-12T14:51:00.000Z" }],
    });
    expect(kitchenTicketAge(view.items, "2026-08-12T15:12:00.000Z").minutes).toBe(21);
  });
});
