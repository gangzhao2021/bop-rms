import { expect, it } from "vitest";
import { configuredOrderItemFixture } from "./configured-order-item.fixture.js";
import { id } from "./configured-cart-quote.fixture.js";
import {
  createOrderItemSnapshots,
  createConfiguredOrderItemSnapshots,
  parseConfiguredOrderItemTransactionSnapshot,
  parseOrderItemTransactionSnapshot,
} from "../domain/order-item-snapshot.js";
import {
  encodeConfiguredOrderItemSnapshot,
  decodeConfiguredOrderItemSnapshot,
  encodeOrderItemSnapshot,
  decodeOrderItemSnapshot,
} from "../domain/order-item-snapshot-codec.js";

it.each([false, true])(
  "composes and round-trips configured transaction facts for Dining=%s",
  async (dining) => {
    const { item } = await configuredOrderItemFixture(dining);
    const wire = JSON.parse(encodeConfiguredOrderItemSnapshot(item));
    expect(wire.pricing.optionPrices[0].chargedQuantity).toBe("4");
    expect(wire.pricing.optionPrices[0].subtotal.amountMinor).toBe("500");
    expect(decodeConfiguredOrderItemSnapshot(wire)).toEqual(item);
    expect(item.catalog.options[0]?.localizedNames).toEqual({ "en-CA": "Synthetic option" });
    expect(item.pricing.total.amountMinor).toBe(2825n);
  },
);
it.each(["binding", "quantity", "classification", "brand", "store", "missing"])(
  "rejects %s Catalog/price mismatch",
  async (mode) => {
    const { item } = await configuredOrderItemFixture();
    const option = item.catalog.options[0];
    if (!option) throw new Error("missing fixture");
    const catalog = {
      ...item.catalog,
      ...(mode === "classification" ? { taxClassificationReference: id(999) } : {}),
      ...(mode === "brand" ? { brandReference: id(999) } : {}),
      ...(mode === "store" ? { storeReference: id(999) } : {}),
      options:
        mode === "missing"
          ? []
          : [
              {
                ...option,
                ...(mode === "binding" ? { bindingReference: id(999) } : {}),
                ...(mode === "quantity" ? { quantity: 2 } : {}),
              },
            ],
    };
    expect(() => parseConfiguredOrderItemTransactionSnapshot({ ...item, catalog })).toThrow();
  },
);
it("rejects changed option-set version against Cart selection evidence", async () => {
  const { input } = await configuredOrderItemFixture(),
    first = input.lines[0];
  if (!first) throw new Error("missing fixture");
  expect(() =>
    createConfiguredOrderItemSnapshots({
      ...input,
      lines: [
        {
          ...first,
          catalog: {
            ...first.catalog,
            options: first.catalog.options.map((option) => ({
              ...option,
              optionSetVersionReference: id(999),
            })),
          },
        },
      ],
    }),
  ).toThrow();
});
it("rejects a price context for another order type even when its rule is unqualified", async () => {
  const { input } = await configuredOrderItemFixture(),
    first = input.lines[0];
  if (!first) throw new Error("missing fixture");
  expect(() =>
    createConfiguredOrderItemSnapshots({
      ...input,
      lines: [
        {
          ...first,
          pricing: {
            ...first.pricing,
            optionPrices: first.pricing.optionPrices.map((option) => ({
              ...option,
              orderType: "DineIn",
            })),
          },
        },
      ],
    }),
  ).toThrow();
});
it.each(["04", "+4", "4.0", "4e0", "-0", "-1", "9223372036854775808", 4])(
  "rejects noncanonical charged quantity %s",
  async (value) => {
    const { item } = await configuredOrderItemFixture();
    const wire = JSON.parse(encodeConfiguredOrderItemSnapshot(item));
    wire.pricing.optionPrices[0].chargedQuantity = value;
    expect(() => decodeConfiguredOrderItemSnapshot(wire)).toThrow();
  },
);
it("does not allow legacy readers or creators to silently discard configured prices", async () => {
  const { item, input } = await configuredOrderItemFixture();
  expect(() => parseOrderItemTransactionSnapshot(item)).toThrow();
  expect(() => encodeOrderItemSnapshot(item)).toThrow();
  expect(() =>
    decodeOrderItemSnapshot(JSON.parse(encodeConfiguredOrderItemSnapshot(item))),
  ).toThrow();
  expect(() => createOrderItemSnapshots(input)).toThrow();
});
it("rejects missing price evidence for a free selected option", async () => {
  const { item } = await configuredOrderItemFixture();
  const wire = JSON.parse(encodeConfiguredOrderItemSnapshot(item));
  wire.pricing.optionPrices = [];
  wire.pricing.unitPrice.amountMinor = "1000";
  wire.pricing.subtotal.amountMinor = "2000";
  wire.pricing.total.amountMinor = "2325";
  expect(() => decodeConfiguredOrderItemSnapshot(wire)).toThrow();
});
