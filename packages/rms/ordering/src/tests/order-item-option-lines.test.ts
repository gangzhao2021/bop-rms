import { expect, it } from "vitest";
import { configuredOrderItemFixture } from "./configured-order-item.fixture.js";
import { orderItemOptionLines } from "../domain/order-item-option-lines.js";

it("lists each chosen option of a frozen Order item with what it added to the line (WP-2423)", async () => {
  const { item } = await configuredOrderItemFixture();
  const lines = orderItemOptionLines(item, "en-CA");
  expect(lines).toEqual([
    {
      displayName: "Synthetic option",
      quantity: item.catalog.options[0]?.quantity,
      amount: item.pricing.optionPrices[0]?.subtotal,
    },
  ]);
  expect(lines[0]?.amount.amountMinor).toBe(500n);
  // Never more than the item's own price before tax, which already includes the options.
  expect(lines[0]?.amount.amountMinor).toBeLessThanOrEqual(item.pricing.subtotal.amountMinor);
  // Another language falls back to a name the option has instead of failing.
  expect(orderItemOptionLines(item, "fr-CA")[0]?.displayName).toBe("Synthetic option");
});

it("prices options as free on items quoted before option prices existed", async () => {
  const { item } = await configuredOrderItemFixture();
  const pricing: Record<string, unknown> = { ...item.pricing, quoteVersion: 1 };
  delete pricing.optionPrices;
  const lines = orderItemOptionLines(
    { ...item, pricing } as unknown as Parameters<typeof orderItemOptionLines>[0],
    "en-CA",
  );
  expect(lines[0]?.amount.amountMinor).toBe(0n);
});
