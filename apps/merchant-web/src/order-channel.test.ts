import { expect, it } from "vitest";
import { orderChannelFilterOptions, sourceChannelFilterLabel } from "./order-channel.js";

it("WP-2423: the channel filter offers each staff channel once, never Website beside Online", () => {
  expect(orderChannelFilterOptions.map((option) => option.label)).toEqual([
    "Online",
    "Counter",
    "Table QR code",
    "Taken by staff",
    "Partner integration",
  ]);
});

it("WP-2423: a stored channel filter (dashboard) uses the Orders list's words, never codes", () => {
  expect(sourceChannelFilterLabel("All", "All")).toBe("All channels");
  expect(sourceChannelFilterLabel("Pos", "All")).toBe("Counter");
  expect(sourceChannelFilterLabel("Api", "Pickup")).toBe("Partner integration");
  expect(sourceChannelFilterLabel("Qr", "Pickup")).toBe("Online");
  expect(sourceChannelFilterLabel("Web", "Pickup")).toBe("Online");
  expect(sourceChannelFilterLabel("Qr", "DineIn")).toBe("Table QR code");
  expect(sourceChannelFilterLabel("Qr", "All")).toBe("Online or table QR code");
});
