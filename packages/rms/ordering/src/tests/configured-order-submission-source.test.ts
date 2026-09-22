import { expect, it, vi } from "vitest";
import { configuredOrderItemFixture } from "./configured-order-item.fixture.js";
import {
  createConfiguredOrderSubmissionSource,
  createOrderSubmissionSource,
} from "../application/order-submission-source.js";
async function fixture(dining = false) {
  const f = await configuredOrderItemFixture(dining);
  const input = f.input;
  const pricing = vi.fn(async (): Promise<readonly unknown[]> => [f.item.pricing]);
  const capture = vi.fn(async (): Promise<unknown> => input.lines[0]?.catalog);
  const options = {
    scope: { brandReference: input.cart.brandReference, storeReference: input.cart.storeReference },
    carts: { load: vi.fn(async () => input.cart) },
    pricing: { load: pricing },
    catalog: { capture },
    clock: { now: () => input.snapshotCapturedAt },
  };
  return {
    ...f,
    options,
    pricing,
    capture,
    source: createConfiguredOrderSubmissionSource(options),
  };
}
it.each([false, true])(
  "loads complete original configured evidence for Dining=%s",
  async (dining) => {
    const f = await fixture(dining);
    const result = await f.source.load({ evidence: f.input.checkoutValidationEvidence } as never);
    expect(result.lines[0]?.pricing).toEqual(f.item.pricing);
    expect(result.lines[0]?.catalog).toEqual(f.input.lines[0]?.catalog);
    expect(Object.isFrozen(result.lines)).toBe(true);
  },
);
it("keeps default v1 closed to v2 and configured source closed to v1", async () => {
  const f = await fixture();
  await expect(
    createOrderSubmissionSource(f.options).load({
      evidence: f.input.checkoutValidationEvidence,
    } as never),
  ).rejects.toThrow();
  await expect(
    f.source.load({
      evidence: { ...f.input.checkoutValidationEvidence, quoteVersion: 1 },
    } as never),
  ).rejects.toThrow();
  expect(f.options.carts.load).not.toHaveBeenCalled();
});
it.each(["binding", "choice", "orderType"] as const)(
  "rejects configured %s drift before publishing source lines",
  async (field) => {
    const f = await fixture(),
      price = f.item.pricing;
    f.pricing.mockResolvedValue([
      {
        ...price,
        optionPrices: price.optionPrices.map((option) => ({
          ...option,
          ...(field === "binding" ? { bindingReference: f.input.cart.brandReference } : {}),
          ...(field === "choice" ? { optionReference: f.input.cart.brandReference } : {}),
          ...(field === "orderType" ? { orderType: "DineIn" } : {}),
        })),
      },
    ]);
    await expect(
      f.source.load({ evidence: f.input.checkoutValidationEvidence } as never),
    ).rejects.toMatchObject({ code: "ORDER_SUBMISSION_SOURCE_UNAVAILABLE" });
  },
);
it("rejects a different Catalog SKU despite matching sellable reference", async () => {
  const f = await fixture();
  f.capture.mockResolvedValue({
    ...f.input.lines[0]?.catalog,
    skuReference: f.input.cart.brandReference,
  });
  await expect(
    f.source.load({ evidence: f.input.checkoutValidationEvidence } as never),
  ).rejects.toThrow();
});
