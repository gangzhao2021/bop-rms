import { describe, expect, it } from "vitest";
import { kitchenBoardFixture, kitchenItemFixture } from "./kitchen-board.fixtures.js";
import { parseKitchenBoardView } from "./kitchen-board.js";
import { newKitchenChases } from "./KitchenBoardPages.js";

describe("WP-2423 item 8 ⑦: a dish a server chased", () => {
  const board = (chase: unknown, status = "In Progress") =>
    parseKitchenBoardView({
      ...kitchenBoardFixture(),
      items: [
        {
          ...kitchenItemFixture(),
          status,
          completedQuantity: 0,
          ...(chase === undefined ? {} : { chase }),
        },
      ],
    });
  it("reads how often and when last, and refuses a malformed chase", () => {
    expect(board({ count: 2, lastChasedAt: "2026-10-29T15:00:00.000Z" }).items[0]?.chase).toEqual({
      count: 2,
      lastChasedAt: "2026-10-29T15:00:00.000Z",
    });
    expect(() => board({ count: 0, lastChasedAt: "2026-10-29T15:00:00.000Z" })).toThrow();
    expect(() => board({ count: 1 })).toThrow();
  });
  it("sounds for a chase made while the board is open, not for one it already showed", () => {
    const none = board(undefined);
    const once = board({ count: 1, lastChasedAt: "2026-10-29T15:00:00.000Z" });
    const twice = board({ count: 2, lastChasedAt: "2026-10-29T15:05:00.000Z" });
    const reference = once.items[0]?.workItemReference;
    expect(newKitchenChases(null, once)).toEqual([]);
    expect(newKitchenChases(none, once)).toEqual([reference]);
    expect(newKitchenChases(once, once)).toEqual([]);
    expect(newKitchenChases(once, twice)).toEqual([reference]);
    // Work already finished is not called out.
    expect(
      newKitchenChases(
        none,
        board({ count: 1, lastChasedAt: "2026-10-29T15:00:00.000Z" }, "Completed"),
      ),
    ).toEqual([]);
  });
});
