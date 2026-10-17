import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  ProductCustomerMenuFieldset,
  ProductCustomerMenuReadOnly,
  ProductListPage,
  photoUploadMessage,
} from "./ProductPages.js";
import {
  ProductPhotoError,
  createProductClient,
  parseProductDetailView,
  parseProductListView,
  photoFileProblem,
  photoRetryable,
  presentationChanged,
  presentationDraftFrom,
  presentationInput,
  presentationProblems,
  type ProductPresentation,
  productCodeValid,
  suggestProductCode,
  taxClassText,
} from "./product-pages.js";

describe("WP-2423 product page helpers", () => {
  it("suggests and checks product codes", () => {
    expect(suggestProductCode("Caffè Latte")).toBe("CAFFE-LATTE");
    expect(suggestProductCode("12 oz drip")).toBe("OZ-DRIP");
    expect(productCodeValid("latte-s")).toBe(true);
    expect(productCodeValid("12OZ")).toBe(false);
  });
  it("shows each order type's rate exactly", () => {
    expect(
      taxClassText({
        taxClassificationReference: "x",
        rules: [
          {
            orderType: "DineIn",
            taxComponentCode: "T",
            treatment: "Taxable",
            rate: "0.13",
            priceInclusion: "Exclusive",
          },
          {
            orderType: "Pickup",
            taxComponentCode: "T",
            treatment: "Taxable",
            rate: "0.05",
            priceInclusion: "Exclusive",
          },
          {
            orderType: "Delivery",
            taxComponentCode: "T",
            treatment: "ZeroRated",
            rate: "0",
            priceInclusion: "Exclusive",
          },
          {
            orderType: "Catering",
            taxComponentCode: "T",
            treatment: "Taxable",
            rate: "0.14975",
            priceInclusion: "Exclusive",
          },
        ],
      }),
    ).toBe("Dine-in 13% · Pickup 5% · Delivery zero-rated · Catering 14.975%");
  });
  it("maps server refusals and offline failures", async () => {
    const reply = (status: number, body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    await expect(
      createProductClient("csrf", () => reply(409, { error: "SizeInUse" })).load(null),
    ).rejects.toMatchObject({ code: "SizeInUse" });
    await expect(
      createProductClient("csrf", () => reply(403, { error: "other" })).load(null),
    ).rejects.toMatchObject({ code: "PermissionDenied" });
    await expect(
      createProductClient("csrf", () => Promise.reject(new TypeError("offline"))).load(null),
    ).rejects.toMatchObject({ code: "Offline" });
  });
  it("renders the empty list with a create link only for creators", () => {
    const view = parseProductListView({
      screenId: "CAT-PRODUCT-LIST",
      sourceAsOf: "2026-10-07T12:00:00.000Z",
      locale: "en-CA",
      permissions: {
        mayRead: true,
        mayCreate: false,
        mayEdit: false,
        mayAddSize: false,
        mayStartSelling: false,
      },
      productTypes: ["PreparedFood"],
      sellingUnits: ["EACH"],
      taxClasses: [],
      products: [],
    });
    expect(view.products).toEqual([]);
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <ProductListPage />
      </MemoryRouter>,
    );
    expect(html).toContain("Loading products");
  });
});

const ref = (n: number) => "0190996a-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const previewUrl = "/media/images/" + "c".repeat(64) + ".jpg";
const photo = { imageReference: ref(5), width: 1280, height: 960, previewUrl };
function detail(presentation: unknown) {
  return {
    screenId: "CAT-PRODUCT-DETAIL",
    sourceAsOf: "2026-10-17T12:00:00.000Z",
    locale: "en-CA",
    permissions: {
      mayRead: true,
      mayCreate: true,
      mayEdit: true,
      mayAddSize: true,
      mayStartSelling: true,
    },
    productTypes: ["PreparedFood"],
    sellingUnits: ["EACH"],
    taxClasses: [],
    product: {
      productReference: ref(1),
      internalCode: "FLAT_WHITE",
      productType: "PreparedFood",
      lifecycle: "Active",
      aggregateVersion: 3,
      name: "Flat White",
      taxClassificationReference: null,
      sizes: [],
      createdAt: "2026-10-17T12:00:00.000Z",
      updatedAt: "2026-10-17T12:00:00.000Z",
      ...(presentation === undefined ? {} : { presentation }),
    },
  };
}

describe("WP-2423 product description and photo", () => {
  it("reads the description and photo, and refuses a photo outside the media path", () => {
    const saved = {
      description: "Double ristretto, steamed milk.",
      photo: { ...photo, altText: "Cup" },
    };
    expect(parseProductDetailView(detail(saved)).product.presentation).toEqual(saved);
    expect(
      parseProductDetailView(detail({ description: "", photo: null })).product.presentation,
    ).toEqual({ description: "", photo: null });
    expect(parseProductDetailView(detail(undefined)).product.presentation).toBeUndefined();
    for (const bad of [
      { description: "x", photo: { ...photo, altText: "Cup", previewUrl: "https://x.test/a.jpg" } },
      {
        description: "x",
        photo: { ...photo, altText: "Cup", previewUrl: "/media/images/abc.jpg" },
      },
      { description: "x", photo: { ...photo, imageReference: "IMG-1", altText: "Cup" } },
      { description: "x".repeat(241), photo: null },
      { description: null, photo: null },
      { description: "x" },
    ])
      expect(() => parseProductDetailView(detail(bad))).toThrow("PRODUCT_PAGE_INVALID");
  });

  it("counts description, photo and alt text as unsaved changes", () => {
    const saved: ProductPresentation = {
      description: "Velvety milk.",
      photo: { ...photo, altText: "Flat white in a cup" },
    };
    const draft = presentationDraftFrom(saved);
    expect(presentationChanged(draft, saved)).toBe(false);
    expect(presentationChanged({ ...draft, description: "  Velvety   milk. " }, saved)).toBe(false);
    expect(presentationChanged({ ...draft, description: "Smooth." }, saved)).toBe(true);
    expect(presentationChanged({ ...draft, altText: "A cup" }, saved)).toBe(true);
    expect(presentationChanged({ ...draft, photo: null, altText: "" }, saved)).toBe(true);
    expect(
      presentationChanged({ ...draft, photo: { ...photo, imageReference: ref(6) } }, saved),
    ).toBe(true);
    expect(
      presentationChanged(
        { description: "", photo, altText: "Cup" },
        { description: "", photo: null },
      ),
    ).toBe(true);
  });

  it("requires a photo description and plain text before saving", () => {
    expect(presentationProblems({ description: "", photo: null, altText: "" })).toEqual({});
    expect(presentationProblems({ description: "Nice", photo, altText: "  " })).toEqual({
      altText: "AltTextMissing",
    });
    expect(
      presentationProblems({ description: "See https://example.test", photo, altText: "<b>" }),
    ).toEqual({ description: "NotPlain", altText: "NotPlain" });
    expect(
      presentationProblems({ description: "x".repeat(241), photo: null, altText: "" }),
    ).toEqual({ description: "TooLong" });
  });

  it("sends the current description and photo with its description in the save", () => {
    expect(
      presentationInput({ description: " Rich\n espresso ", photo, altText: " Cup  of coffee " }),
    ).toEqual({
      description: "Rich espresso",
      photo: { imageReference: ref(5), altText: "Cup of coffee" },
    });
    expect(presentationInput({ description: "", photo: null, altText: "stale" })).toEqual({
      description: "",
      photo: null,
    });
  });

  it("checks the file before upload and says each refusal in staff words", () => {
    expect(photoFileProblem({ type: "image/gif", size: 10 })).toBe("PhotoTypeUnsupported");
    expect(photoFileProblem({ type: "image/png", size: 10 * 1024 * 1024 + 1 })).toBe(
      "PhotoTooLarge",
    );
    expect(photoFileProblem({ type: "image/webp", size: 10 * 1024 * 1024 })).toBeNull();
    expect(photoUploadMessage("PhotoTypeUnsupported")).toBe("Use a JPEG, PNG or WebP photo.");
    expect(photoUploadMessage("PhotoTooLarge")).toBe(
      "This photo is larger than 10 MB. Choose a smaller one.",
    );
    expect(photoUploadMessage("PhotoTooSmall")).toBe(
      "This photo is too small or too narrow. Use one at least 480 pixels on its shorter side.",
    );
    expect(photoUploadMessage("PhotoUnreadable")).toBe(
      "This file couldn't be read as a photo. Try another one.",
    );
    for (const code of ["PhotoStorageUnavailable", "Offline"] as const) {
      expect(photoUploadMessage(code)).toBe(
        "The photo didn't upload. Check the connection and try again.",
      );
      expect(photoRetryable(code)).toBe(true);
    }
    expect(photoRetryable("PhotoTooSmall")).toBe(false);
    expect(photoUploadMessage("PermissionDenied")).toBe(
      "You do not have permission for this product action at Brand level.",
    );
  });

  it("uploads the raw photo with its operation reference and maps server refusals", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const file = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const client = createProductClient("csrf-token", (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(
        new Response(JSON.stringify({ status: "Recorded", photo }), { status: 200 }),
      );
    });
    await expect(client.uploadPhoto?.(ref(1), file, ref(9))).resolves.toEqual(photo);
    expect(calls[0]?.url).toBe("/merchant/commerce/products/photo");
    expect(calls[0]?.init.body).toBe(file);
    expect(calls[0]?.init.headers).toEqual({
      "content-type": "image/png",
      "x-bop-csrf": "csrf-token",
      "x-bop-product-reference": ref(1),
      "x-bop-operation-reference": ref(9),
    });
    const refusal = (status: number, body: unknown) =>
      createProductClient("c", () =>
        Promise.resolve(new Response(JSON.stringify(body), { status })),
      ).uploadPhoto?.(ref(1), file, ref(9));
    await expect(refusal(400, { error: "PhotoTooSmall" })).rejects.toMatchObject({
      code: "PhotoTooSmall",
    });
    await expect(refusal(413, { error: "PhotoTooLarge" })).rejects.toMatchObject({
      code: "PhotoTooLarge",
    });
    await expect(refusal(503, { error: "PhotoStorageUnavailable" })).rejects.toMatchObject({
      code: "PhotoStorageUnavailable",
    });
    await expect(refusal(400, { error: "Invalid" })).rejects.toMatchObject({
      code: "PhotoUnreadable",
    });
    await expect(refusal(403, {})).rejects.toMatchObject({ code: "PermissionDenied" });
    await expect(
      refusal(200, { status: "Recorded", photo: { ...photo, previewUrl: "/x.jpg" } }),
    ).rejects.toBeInstanceOf(ProductPhotoError);
    await expect(
      createProductClient("c", () => Promise.reject(new TypeError("offline"))).uploadPhoto?.(
        ref(1),
        file,
        ref(9),
      ),
    ).rejects.toMatchObject({ code: "Offline" });
  });

  it("renders the editable fields, the preview and a retry for a failed upload", () => {
    const html = renderToStaticMarkup(
      <ProductCustomerMenuFieldset
        disabled={false}
        client={{ load: () => Promise.resolve(null) }}
        productReference={ref(1)}
        value={{ description: "Silky", photo, altText: "" }}
        onChange={() => undefined}
        onUploadingChange={() => undefined}
        problems={{ altText: "AltTextMissing" }}
        initialUpload={{
          kind: "Failed",
          code: "PhotoStorageUnavailable",
          file: new File([new Uint8Array([1])], "a.png", { type: "image/png" }),
          operationReference: ref(9),
        }}
      />,
    );
    expect(html).toContain("Customer menu");
    expect(html).toContain("235 characters left");
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toContain("Replace photo");
    expect(html).toContain("Remove photo");
    expect(html).toContain(`src="${previewUrl}"`);
    expect(html).toContain('alt=""');
    expect(html).toContain("Photo preview, not described yet");
    expect(html).toContain("Describe the photo before saving.");
    expect(html).toContain("The photo didn&#x27;t upload. Check the connection and try again.");
    expect(html).toContain(">Retry</button>");
    expect(html).toMatch(/aria-describedby="[^"]*-alt-help [^"]*-alt-error"/u);
    expect(html).not.toMatch(/0190996a|PhotoStorage|imageReference/u);
  });

  it("shows read-only staff the description and photo without controls", () => {
    const html = renderToStaticMarkup(
      <ProductCustomerMenuReadOnly
        presentation={{ description: "Silky", photo: { ...photo, altText: "Flat white" } }}
      />,
    );
    expect(html).toContain("Silky");
    expect(html).toContain('alt="Flat white"');
    expect(html).not.toMatch(/<(input|textarea|button)/u);
  });
});
