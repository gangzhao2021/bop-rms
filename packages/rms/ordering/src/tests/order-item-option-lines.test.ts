import { expect, it } from "vitest";
import { configuredOrderItemFixture } from "./configured-order-item.fixture.js";
import { orderItemOptionLines, orderLocalizedName } from "../domain/order-item-option-lines.js";

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

it("Owner 2026-10-23: chooses a frozen name in the guest's language, then the session's, never none", () => {
  const names = { "en-CA": "Latte", "zh-Hans-CA": "拿铁" };
  expect(orderLocalizedName(names, ["zh-Hans-CA", "en-CA"])).toBe("拿铁");
  expect(orderLocalizedName(names, "en-CA")).toBe("Latte");
  // An item without a Chinese name keeps its session-language name.
  expect(orderLocalizedName({ "en-CA": "Plain bagel" }, ["zh-Hans-CA", "en-CA"])).toBe(
    "Plain bagel",
  );
  // A blank stored name is skipped, as is an empty requested locale.
  expect(orderLocalizedName({ "zh-Hans-CA": " ", "en-CA": "Mocha" }, ["zh-Hans-CA", "en-CA"])).toBe(
    "Mocha",
  );
  expect(orderLocalizedName({ "fr-CA": "Thé" }, ["", "zh-Hans-CA", "en-CA"])).toBe("Thé");
  expect(() => orderLocalizedName({}, ["zh-Hans-CA"])).toThrow();
});

it("names options in the first requested language each one has", async () => {
  const { item } = await configuredOrderItemFixture();
  const option = item.catalog.options[0];
  if (option === undefined) throw new Error("fixture option missing");
  const chinese = {
    ...item,
    catalog: {
      ...item.catalog,
      options: [
        { ...option, localizedNames: { ...option.localizedNames, "zh-Hans-CA": "燕麦奶" } },
      ],
    },
  } as typeof item;
  expect(orderItemOptionLines(chinese, ["zh-Hans-CA", "en-CA"])[0]?.displayName).toBe("燕麦奶");
  expect(orderItemOptionLines(item, ["zh-Hans-CA", "en-CA"])[0]?.displayName).toBe(
    "Synthetic option",
  );
});
