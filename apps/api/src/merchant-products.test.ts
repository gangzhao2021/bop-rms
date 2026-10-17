import { describe, expect, it } from "vitest";
import type { ProductImageRecord } from "@bop/media";
import type { ProductAggregate } from "@rms/catalog";
import {
  derivedReference,
  parseProductCommandBody,
  presentationView,
} from "./merchant-products.js";

const id = (n: number) => "01909a1b-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const size = (code: string, name: string, skuReference: string | null = null) => ({
  skuReference,
  skuCode: code,
  name,
});
describe("WP-2423 product command body", () => {
  it("accepts and normalizes each product action", () => {
    expect(
      parseProductCommandBody({
        action: "Create",
        operationReference: id(1),
        internalCode: " latte ",
        productType: "NonAlcoholicBeverage",
        name: "  Caffè   Latte ",
        taxClassificationReference: id(2),
        sizes: [size("latte-s", "Small"), size("LATTE-L", "Large")],
      }),
    ).toMatchObject({
      internalCode: "LATTE",
      name: "Caffè Latte",
      sizes: [{ skuCode: "LATTE-S" }, { skuCode: "LATTE-L" }],
    });
    expect(
      parseProductCommandBody({
        action: "SaveDraft",
        operationReference: id(1),
        productReference: id(3),
        expectedAggregateVersion: 2,
        name: "Latte",
        taxClassificationReference: id(2),
        sizes: [size("LATTE-S", "Small", id(4))],
      }).action,
    ).toBe("SaveDraft");
    expect(
      parseProductCommandBody({
        action: "StartSelling",
        operationReference: id(1),
        productReference: id(3),
        expectedAggregateVersion: 5,
      }).action,
    ).toBe("StartSelling");
  });
  it.each([
    ["no sizes", { sizes: [] }],
    ["duplicate size codes", { sizes: [size("A", "Small"), size("A", "Large")] }],
    ["duplicate size names", { sizes: [size("A", "Small"), size("B", "small")] }],
    ["an existing size on create", { sizes: [size("A", "Small", id(9))] }],
    ["a code starting with a digit", { internalCode: "12OZ" }],
    ["an unknown product type", { productType: "Alcohol" }],
    ["an extra field", { price: 500 }],
  ])("refuses %s", (_label, change) => {
    expect(() =>
      parseProductCommandBody({
        action: "Create",
        operationReference: id(1),
        internalCode: "LATTE",
        productType: "PreparedFood",
        name: "Latte",
        taxClassificationReference: id(2),
        sizes: [size("LATTE-S", "Small")],
        ...change,
      }),
    ).toThrow(expect.objectContaining({ code: "Invalid" }));
  });
  it("derives stable UUIDv7-shaped step references that keep the operation time", () => {
    const first = derivedReference(id(1), "start:product");
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(first.slice(0, 13)).toBe(id(1).slice(0, 13));
    expect(derivedReference(id(1), "start:product")).toBe(first);
    expect(derivedReference(id(1), "start:" + id(4))).not.toBe(first);
  });
});

describe("WP-2423 menu descriptions and photos", () => {
  const save = (presentation: unknown) =>
    parseProductCommandBody({
      action: "SaveDraft",
      operationReference: id(1),
      productReference: id(3),
      expectedAggregateVersion: 2,
      name: "Latte",
      taxClassificationReference: id(2),
      sizes: [size("LATTE-S", "Small", id(4))],
      presentation,
    });
  it("accepts a description and a photo with alt text, normalizing spaces", () => {
    expect(
      save({
        description: "  Espresso with   steamed milk. ",
        photo: { imageReference: id(7), altText: " Latte in a white cup " },
      }),
    ).toMatchObject({
      presentation: {
        description: "Espresso with steamed milk.",
        photo: { imageReference: id(7), altText: "Latte in a white cup" },
      },
    });
    expect(save({ description: "", photo: null })).toMatchObject({
      presentation: { description: "", photo: null },
    });
    // Without the key the product's description and photo stay as they are.
    expect(
      "presentation" in
        parseProductCommandBody({
          action: "SaveDraft",
          operationReference: id(1),
          productReference: id(3),
          expectedAggregateVersion: 2,
          name: "Latte",
          taxClassificationReference: id(2),
          sizes: [size("LATTE-S", "Small", id(4))],
        }),
    ).toBe(false);
  });
  it.each([
    ["a description over 240 characters", { description: "a".repeat(241), photo: null }],
    [
      "a photo without alt text",
      { description: "", photo: { imageReference: id(7), altText: " " } },
    ],
    [
      "alt text over 160 characters",
      { description: "", photo: { imageReference: id(7), altText: "a".repeat(161) } },
    ],
    [
      "a photo that is not an image reference",
      { description: "", photo: { imageReference: "/media/images/x.jpg", altText: "Latte" } },
    ],
    ["an extra field", { description: "", photo: null, imageUrl: "x" }],
    ["a control character", { description: "Latte\u0007", photo: null }],
  ])("refuses %s", (_label, presentation) => {
    expect(() => save(presentation)).toThrow(expect.objectContaining({ code: "Invalid" }));
  });

  const hash = (n: number) => n.toString(16).padStart(64, "0");
  const image: ProductImageRecord = {
    imageReference: id(7),
    brandReference: id(8),
    productReference: id(3),
    width: 1280,
    height: 960,
    renditions: [320, 640, 1280].flatMap((width, index) =>
      (["image/jpeg", "image/webp"] as const).map((contentType, kind) => ({
        contentType,
        width: width as 320 | 640 | 1280,
        height: (width * 3) / 4,
        byteSize: 1000,
        path: `/media/images/${hash(index * 2 + kind + 1)}.${kind ? "webp" : "jpg"}`,
      })),
    ),
    createdAt: "2026-10-17T00:00:00.000Z",
    createdByActorReference: id(9),
  };
  const product = (customerPresentation: unknown) =>
    ({
      draft: {
        defaultLocale: "en-CA",
        ...(customerPresentation === undefined ? {} : { customerPresentation }),
      },
    }) as unknown as ProductAggregate;
  it("shows the page-locale description and the photo's 640 px JPEG preview", () => {
    expect(presentationView(product(undefined), "en-CA", new Map())).toEqual({
      description: "",
      photo: null,
    });
    expect(
      presentationView(
        product({
          localizedDescriptions: { "en-CA": "Steamed milk", fr: "Lait" },
          photo: { imageReference: id(7), localizedAltText: { "en-CA": "Latte in a cup" } },
        }),
        "en-CA",
        new Map([[id(7), image]]),
      ),
    ).toEqual({
      description: "Steamed milk",
      photo: {
        imageReference: id(7),
        altText: "Latte in a cup",
        width: 1280,
        height: 960,
        previewUrl: `/media/images/${hash(3)}.jpg`,
      },
    });
  });
  it("refuses to show a photo whose image record cannot be read", () => {
    expect(() =>
      presentationView(
        product({
          localizedDescriptions: {},
          photo: { imageReference: id(7), localizedAltText: { "en-CA": "Latte" } },
        }),
        "en-CA",
        new Map(),
      ),
    ).toThrow(expect.objectContaining({ code: "PhotoStorageUnavailable" }));
  });
});
