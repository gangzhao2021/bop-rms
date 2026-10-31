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
  const source = createOrderSubmissionSource({
    scope: { brandReference: input.cart.brandReference, storeReference: input.cart.storeReference },
    carts: { load },
    pricing: { load: pricing },
    catalog: { capture },
    clock: { now: () => time },
  });
  return {
    input,
    evidence,
    load,
    pricing,
    capture,
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
