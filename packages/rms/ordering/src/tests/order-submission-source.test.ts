import { expect, it, vi } from "vitest";
import { orderSnapshotInput } from "./order-item-snapshot.fixture.js";
import { createOrderSubmissionSource } from "../application/order-submission-source.js";
import { createOrderItemSnapshots } from "../domain/order-item-snapshot.js";

function fixture() {
  const input = orderSnapshotInput();
  const at = input.snapshotCapturedAt;
  const evidence = {
    ...input.checkoutValidationEvidence,
    validatedAt: at,
    catalogLines: input.checkoutValidationEvidence.catalogLines.map((line) => ({
      ...line,
      validatedAt: at,
    })),
    fulfillment: { ...input.checkoutValidationEvidence.fulfillment, checkedAt: at },
  };
  let time = new Date(Date.parse(at) + 50).toISOString();
  const load = vi.fn(async (): Promise<unknown> => input.cart);
  const pricing = vi.fn(async (): Promise<readonly unknown[]> =>
    input.lines.map((line) => line.pricing),
  );
  const capture = vi.fn(async (): Promise<unknown> => input.lines[0]?.catalog);
  // WP-2423 (DEC-PRICE-HOLD §3): the dish is shown the same on both menus unless a test says not.
  const dishChanges = vi.fn(
    async (keys: readonly unknown[]): Promise<readonly (readonly string[])[]> => keys.map(() => []),
  );
  const source = createOrderSubmissionSource({
    scope: { brandReference: input.cart.brandReference, storeReference: input.cart.storeReference },
    carts: { load },
    pricing: { load: pricing },
    catalog: { capture, dishChanges },
    clock: { now: () => time },
  });
  return {
    input,
    evidence,
    load,
    pricing,
    capture,
    dishChanges,
    source,
    setTime: (value: string) => {
      time = value;
    },
  };
}
it("assembles owner snapshots at the original observation and satisfies actual Order snapshot rules", async () => {
  const f = fixture(),
    result = await f.source.load({ evidence: f.evidence } as never);
  expect(f.capture).toHaveBeenCalledWith(
    expect.objectContaining({ observedAt: f.input.snapshotCapturedAt }),
  );
  expect(
    createOrderItemSnapshots({
      ...f.input,
      checkoutValidationEvidence: f.evidence,
      cart: result.cart,
      lines: result.lines.map((line, index) => ({
        ...line,
        orderItemReference: f.input.lines[index]?.orderItemReference,
      })),
    }),
  ).toHaveLength(1);
  expect(Object.isFrozen(result.lines)).toBe(true);
});
it("Owner #26 (DEC-PRICE-HOLD): a cart priced on the menu before the latest listing is still ordered inside the hold", async () => {
  const f = fixture();
  const earlier = "01a7ee00-0000-7000-8000-00000000beef";
  const cart = {
    ...f.input.cart,
    items: f.input.cart.items.map((item) => ({
      ...item,
      catalogSelectionEvidence:
        item.catalogSelectionEvidence === null
          ? null
          : { ...item.catalogSelectionEvidence, menuVersionReference: earlier },
    })),
  };
  f.load.mockResolvedValue(cart);
  const result = await f.source.load({ evidence: f.evidence } as never);
  // The dish is recorded as the menu sells it now, and priced as the quote priced it.
  expect(result.lines[0]?.catalog).toEqual(f.input.lines[0]?.catalog);
  expect(result.lines[0]?.pricing).toEqual(f.input.lines[0]?.pricing);
  // A changed dish (another product version) is never held.
  f.load.mockResolvedValue({
    ...cart,
    items: cart.items.map((item) => ({
      ...item,
      catalogSelectionEvidence:
        item.catalogSelectionEvidence === null
          ? null
          : { ...item.catalogSelectionEvidence, productVersionReference: earlier },
    })),
  });
  await expect(f.source.load({ evidence: f.evidence } as never)).rejects.toThrow();
});
it("Owner #26 (DEC-PRICE-HOLD): a listing between checkout start and send still sends the same dish inside the hold", async () => {
  const f = fixture();
  const listedSince = "01a7ee00-0000-7000-8000-00000000cafe";
  // The menu sold now is newer than the one the checkout was validated on.
  f.capture.mockResolvedValue({ ...f.input.lines[0]?.catalog, menuVersionReference: listedSince });
  const result = await f.source.load({ evidence: f.evidence } as never);
  expect(result.lines[0]?.catalog).toMatchObject({ menuVersionReference: listedSince });
  expect(result.lines[0]?.pricing).toEqual(f.input.lines[0]?.pricing);
  // The dish itself changed (another product version): never held.
  f.capture.mockResolvedValue({
    ...f.input.lines[0]?.catalog,
    menuVersionReference: listedSince,
    productVersionReference: listedSince,
  });
  await expect(f.source.load({ evidence: f.evidence } as never)).rejects.toThrow();
});
it("Owner #26 (DEC-PRICE-HOLD): a later round validated before a listing is read once more as the menu sells it at the send", async () => {
  const f = fixture();
  const listedSince = "01a7ee00-0000-7000-8000-00000000cafe";
  const sentAt = new Date(Date.parse(f.input.snapshotCapturedAt) + 50).toISOString();
  // Catalog reads only the menu in force now: as of the validation it cannot be read back.
  const capture = vi.fn(async (request: unknown): Promise<unknown> => {
    const { observedAt } = request as { observedAt: string };
    if (observedAt !== sentAt) throw new Error("the old menu can no longer be read back");
    return { ...f.input.lines[0]?.catalog, menuVersionReference: listedSince, capturedAt: sentAt };
  });
  const source = createOrderSubmissionSource({
    scope: {
      brandReference: f.input.cart.brandReference,
      storeReference: f.input.cart.storeReference,
    },
    carts: { load: f.load },
    pricing: { load: f.pricing },
    catalog: { capture, dishChanges: f.dishChanges },
    clock: { now: () => sentAt },
    currentMenuVersion: async () => listedSince,
  });
  const result = await source.load({ evidence: f.evidence } as never);
  expect(result.lines[0]?.catalog).toMatchObject({
    menuVersionReference: listedSince,
    capturedAt: sentAt,
  });
  expect(result.lines[0]?.pricing).toEqual(f.input.lines[0]?.pricing);
});
it("price-hold-dish-changes (DEC-PRICE-HOLD §3): a dish renamed or given other allergens and listed inside the hold is never ordered at the held price", async () => {
  const f = fixture();
  const listedSince = "01a7ee00-0000-7000-8000-00000000cafe";
  const line = f.input.lines[0]?.catalog as { menuVersionReference: string };
  f.capture.mockResolvedValue({ ...f.input.lines[0]?.catalog, menuVersionReference: listedSince });
  // Same product version (the draft was edited in place), but the guest is told another thing.
  for (const changed of [["Name"], ["Allergens"], ["Name", "Allergens"]]) {
    f.dishChanges.mockResolvedValueOnce([changed]);
    await expect(f.source.load({ evidence: f.evidence } as never)).rejects.toMatchObject({
      code: "CHECKOUT_REQUOTE_REQUIRED",
    });
  }
  expect(f.dishChanges).toHaveBeenLastCalledWith([
    expect.objectContaining({
      fromMenuVersionReference: line.menuVersionReference,
      toMenuVersionReference: listedSince,
    }),
  ]);
  // A source that cannot compare the menus prices the dish again too, never holds it unchecked.
  const unchecked = createOrderSubmissionSource({
    scope: {
      brandReference: f.input.cart.brandReference,
      storeReference: f.input.cart.storeReference,
    },
    carts: { load: f.load },
    pricing: { load: f.pricing },
    catalog: { capture: f.capture },
    clock: { now: () => new Date(Date.parse(f.input.snapshotCapturedAt) + 50).toISOString() },
  });
  await expect(unchecked.load({ evidence: f.evidence } as never)).rejects.toMatchObject({
    code: "CHECKOUT_REQUOTE_REQUIRED",
  });
  // Shown the same: the held price stands.
  const kept = await f.source.load({ evidence: f.evidence } as never);
  expect(kept.lines[0]?.pricing).toEqual(f.input.lines[0]?.pricing);
});
it("denies foreign scope without reading Cart", async () => {
  const f = fixture();
  await expect(
    f.source.load({
      evidence: { ...f.evidence, brandReference: f.evidence.storeReference },
    } as never),
  ).rejects.toMatchObject({ code: "ORDER_SUBMISSION_SOURCE_UNAVAILABLE" });
  expect(f.load).not.toHaveBeenCalled();
});
it("denies current Cart version drift before downstream reads", async () => {
  const f = fixture();
  f.load.mockResolvedValue({
    ...f.input.cart,
    aggregateVersion: f.input.cart.aggregateVersion + 1,
  });
  await expect(f.source.load({ evidence: f.evidence } as never)).rejects.toThrow();
  expect(f.pricing).not.toHaveBeenCalled();
  expect(f.capture).not.toHaveBeenCalled();
});
it.each(["missing", "quantity", "digest"] as const)(
  "denies %s Pricing before Catalog capture",
  async (mode) => {
    const f = fixture(),
      line = f.input.lines[0];
    if (!line) throw new Error("missing fixture");
    f.pricing.mockResolvedValue(
      mode === "missing"
        ? []
        : [
            {
              ...line.pricing,
              ...(mode === "quantity"
                ? { quantity: 3 }
                : { quoteInputDigest: "sha256:" + "f".repeat(64) }),
            },
          ],
    );
    await expect(f.source.load({ evidence: f.evidence } as never)).rejects.toThrow();
    expect(f.capture).not.toHaveBeenCalled();
  },
);
it.each(["missing", "scope", "time", "tax", "options"] as const)(
  "denies %s Catalog snapshot",
  async (mode) => {
    const f = fixture(),
      line = f.input.lines[0];
    if (!line) throw new Error("missing fixture");
    f.capture.mockResolvedValue(
      mode === "missing"
        ? null
        : {
            ...line.catalog,
            ...(mode === "scope" ? { storeReference: f.evidence.brandReference } : {}),
            ...(mode === "time" ? { capturedAt: f.evidence.validUntil } : {}),
            ...(mode === "tax" ? { taxClassificationReference: f.evidence.brandReference } : {}),
            ...(mode === "options" ? { options: [] } : {}),
          },
    );
    await expect(f.source.load({ evidence: f.evidence } as never)).rejects.toThrow();
  },
);
it.each(["expired", "regressed"] as const)("denies a %s clock during capture", async (mode) => {
  const f = fixture();
  f.capture.mockImplementation(async () => {
    f.setTime(mode === "expired" ? f.evidence.validUntil : f.evidence.validatedAt);
    return f.input.lines[0]?.catalog;
  });
  await expect(f.source.load({ evidence: f.evidence } as never)).rejects.toThrow();
});
