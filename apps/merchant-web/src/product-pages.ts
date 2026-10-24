import { t } from "./i18n/i18n.js";
/** WP-2423 / DEC-CAT-PRODUCT-ADMIN: CAT-PRODUCT-LIST / CAT-PRODUCT-EDIT view contract and client. */
export type ProductErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Conflict"
  | "CodeTaken"
  | "SizeInUse"
  | "TaxClassUnavailable"
  | "Lifecycle"
  | "Invalid"
  | "Offline"
  | "Unavailable";
export class ProductPageError extends Error {
  constructor(readonly code: ProductErrorCode) {
    super(t("Products are unavailable"));
    this.name = "ProductPageError";
  }
}
export interface ProductTaxClass {
  readonly taxClassificationReference: string;
  readonly rules: readonly {
    readonly orderType: string;
    readonly taxComponentCode: string;
    readonly treatment: string;
    readonly rate: string;
    readonly priceInclusion: string;
  }[];
}
interface ProductViewBase {
  readonly sourceAsOf: string;
  readonly locale: string;
  readonly permissions: {
    readonly mayRead: boolean;
    readonly mayCreate: boolean;
    readonly mayEdit: boolean;
    readonly mayAddSize: boolean;
    readonly mayStartSelling: boolean;
  };
  readonly productTypes: readonly string[];
  readonly sellingUnits: readonly string[];
  readonly taxClasses: readonly ProductTaxClass[];
}
export interface ProductSummary {
  readonly productReference: string;
  readonly internalCode: string;
  readonly productType: string;
  readonly lifecycle: string;
  readonly aggregateVersion: number;
  readonly name: string;
  readonly taxClassificationReference: string | null;
  readonly sizes: number;
  readonly activeSizes: number;
  readonly updatedAt: string;
}
export interface ProductDetail {
  readonly productReference: string;
  readonly internalCode: string;
  readonly productType: string;
  readonly lifecycle: string;
  readonly aggregateVersion: number;
  readonly name: string;
  /** Owner 2026-10-23: the Simplified Chinese name customers see ("" when none). */
  readonly nameZh?: string;
  readonly taxClassificationReference: string | null;
  readonly sizes: readonly {
    readonly skuReference: string;
    readonly skuCode: string;
    readonly name: string;
    readonly nameZh?: string;
    readonly lifecycle: string;
    readonly unitOfSale: string;
  }[];
  /** The option sets on the product, in order, with the options it offers from each. */
  readonly optionSets?: readonly ProductOptionSetInput[];
  /** What customers see on the menu under the product name, after the menu is next published. */
  readonly presentation?: ProductPresentation;
  readonly createdAt: string;
  readonly updatedAt: string;
}
/** A product photo as recorded for the Brand; previewUrl is its 640-pixel JPEG. */
export interface ProductPhoto {
  readonly imageReference: string;
  readonly width: number;
  readonly height: number;
  readonly previewUrl: string;
}
export interface ProductPresentation {
  /** "" when the product has no description. */
  readonly description: string;
  /** Owner 2026-10-23: the Simplified Chinese description ("" when none). */
  readonly descriptionZh: string;
  readonly photo: (ProductPhoto & { readonly altText: string }) | null;
}
export interface ProductPresentationInput {
  readonly description: string;
  readonly descriptionZh: string;
  readonly photo: { readonly imageReference: string; readonly altText: string } | null;
}
export interface ProductListView extends ProductViewBase {
  readonly screenId: "CAT-PRODUCT-LIST";
  readonly products: readonly ProductSummary[];
}
export interface ProductOptionSetChoice {
  readonly optionSetReference: string;
  readonly name: string;
  readonly archived: boolean;
  readonly displayStyle: string;
  readonly minimum: number;
  readonly maximum: number | null;
  readonly perOptionMaximum: number;
  readonly options: readonly {
    readonly optionReference: string;
    readonly name: string;
    readonly offered: boolean;
  }[];
}
export interface ProductDetailView extends ProductViewBase {
  readonly screenId: "CAT-PRODUCT-DETAIL";
  readonly product: ProductDetail;
  /** The Brand's option sets; null without permission to read them. */
  readonly optionSetChoices?: readonly ProductOptionSetChoice[] | null;
  /** WP-2423: each size's availability at the selected Store (Item availability), by size. */
  readonly availabilityHere?: Readonly<
    Record<string, "Available" | "SoldOut" | "Unavailable" | "NotOffered" | "Varies">
  >;
}
export interface ProductOptionSetInput {
  readonly optionSetReference: string;
  readonly enabledOptionReferences: readonly string[];
}
export interface ProductSizeInput {
  readonly skuReference: string | null;
  readonly skuCode: string;
  readonly name: string;
  readonly nameZh: string;
}
export type ProductCommand =
  | {
      readonly action: "Create";
      readonly operationReference: string;
      readonly internalCode: string;
      readonly productType: string;
      readonly name: string;
      readonly nameZh: string;
      readonly taxClassificationReference: string;
      readonly sizes: readonly ProductSizeInput[];
    }
  | {
      readonly action: "SaveDraft";
      readonly operationReference: string;
      readonly productReference: string;
      readonly expectedAggregateVersion: number;
      readonly name: string;
      readonly nameZh: string;
      readonly taxClassificationReference: string;
      readonly sizes: readonly ProductSizeInput[];
      readonly optionSets?: readonly ProductOptionSetInput[];
      readonly presentation?: ProductPresentationInput;
    }
  | {
      readonly action: "StartSelling";
      readonly operationReference: string;
      readonly productReference: string;
      readonly expectedAggregateVersion: number;
    };
export interface ProductClient {
  load(productReference: string | null): Promise<unknown>;
  command?(command: ProductCommand): Promise<unknown>;
  /**
   * Records a photo for the product's draft; the same operation reference makes a retry of the
   * same file safe. The photo reaches customers only once a draft naming it is saved and the menu
   * is next published.
   */
  uploadPhoto?(
    productReference: string,
    file: Blob,
    operationReference: string,
  ): Promise<ProductPhoto>;
}
const object = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
function base(r: Record<string, unknown> | null): r is Record<string, unknown> {
  return (
    r !== null &&
    typeof r.sourceAsOf === "string" &&
    object(r.permissions) !== null &&
    Array.isArray(r.taxClasses) &&
    Array.isArray(r.productTypes)
  );
}
export function parseProductListView(value: unknown): ProductListView {
  const r = object(value);
  if (!base(r) || r.screenId !== "CAT-PRODUCT-LIST" || !Array.isArray(r.products))
    throw new Error("PRODUCT_PAGE_INVALID");
  return r as unknown as ProductListView;
}
/** The public path of a product photo rendition (content-hashed). */
export const productPhotoPathPattern = /^\/media\/images\/[0-9a-f]{64}\.(?:jpg|webp)$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const dimension = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 20_000;
function parsePhoto(value: unknown): ProductPhoto | null {
  const photo = object(value);
  if (
    photo === null ||
    typeof photo.imageReference !== "string" ||
    !uuid.test(photo.imageReference) ||
    !dimension(photo.width) ||
    !dimension(photo.height) ||
    typeof photo.previewUrl !== "string" ||
    !productPhotoPathPattern.test(photo.previewUrl)
  )
    return null;
  return {
    imageReference: photo.imageReference,
    width: photo.width as number,
    height: photo.height as number,
    previewUrl: photo.previewUrl,
  };
}
function parsePresentation(value: unknown): ProductPresentation | null {
  const presentation = object(value);
  if (
    presentation === null ||
    typeof presentation.description !== "string" ||
    presentation.description.length > presentationLimits.description ||
    (presentation.descriptionZh !== undefined &&
      (typeof presentation.descriptionZh !== "string" ||
        presentation.descriptionZh.length > presentationLimits.description))
  )
    return null;
  const descriptionZh = (presentation.descriptionZh as string | undefined) ?? "";
  if (presentation.photo === null)
    return { description: presentation.description, descriptionZh, photo: null };
  const photo = parsePhoto(presentation.photo);
  const altText = object(presentation.photo)?.altText;
  if (photo === null || typeof altText !== "string" || altText.length > presentationLimits.altText)
    return null;
  return { description: presentation.description, descriptionZh, photo: { ...photo, altText } };
}
export function parseProductDetailView(value: unknown): ProductDetailView {
  const r = object(value);
  const product = object(r?.product);
  if (
    !base(r) ||
    r.screenId !== "CAT-PRODUCT-DETAIL" ||
    product === null ||
    !Array.isArray(product.sizes)
  )
    throw new Error("PRODUCT_PAGE_INVALID");
  if (product.presentation === undefined) return r as unknown as ProductDetailView;
  const presentation = parsePresentation(product.presentation);
  if (presentation === null) throw new Error("PRODUCT_PAGE_INVALID");
  return {
    ...(r as unknown as ProductDetailView),
    product: { ...(product as unknown as ProductDetail), presentation },
  };
}

/** WP-2423: the customer description and photo being edited on the product page. */
export const presentationLimits = { description: 240, altText: 160 } as const;
export interface PresentationDraft {
  readonly description: string;
  readonly descriptionZh: string;
  readonly photo: ProductPhoto | null;
  readonly altText: string;
}
export const presentationDraftFrom = (presentation: ProductPresentation): PresentationDraft => ({
  description: presentation.description,
  // A server response used as-is (after a save) may predate the Chinese description.
  descriptionZh: (presentation.descriptionZh as string | undefined) ?? "",
  photo: presentation.photo
    ? {
        imageReference: presentation.photo.imageReference,
        width: presentation.photo.width,
        height: presentation.photo.height,
        previewUrl: presentation.photo.previewUrl,
      }
    : null,
  altText: presentation.photo?.altText ?? "",
});
/** Plain text as the server keeps it: trimmed, runs of whitespace as one space. */
export const plainText = (value: string) => value.replace(/\s+/gu, " ").trim();
export const presentationInput = (draft: PresentationDraft): ProductPresentationInput => ({
  description: plainText(draft.description),
  descriptionZh: plainText(draft.descriptionZh),
  photo: draft.photo
    ? { imageReference: draft.photo.imageReference, altText: plainText(draft.altText) }
    : null,
});
export function presentationChanged(draft: PresentationDraft, saved: ProductPresentation) {
  const input = presentationInput(draft);
  return (
    input.description !== saved.description ||
    input.descriptionZh !== saved.descriptionZh ||
    (input.photo?.imageReference ?? null) !== (saved.photo?.imageReference ?? null) ||
    (input.photo !== null && input.photo.altText !== saved.photo?.altText)
  );
}
/** Markup, braces, links, and control or invisible format characters are not plain text. */
const notPlain = /[<>{}\p{Cc}\p{Cf}]|https?:\/\/|www\./iu;
export type PresentationProblem = "NotPlain" | "TooLong" | "AltTextMissing";
/** Why the draft cannot be saved, by field; empty when it can. */
export function presentationProblems(draft: PresentationDraft): {
  readonly description?: PresentationProblem;
  readonly descriptionZh?: PresentationProblem;
  readonly altText?: PresentationProblem;
} {
  const input = presentationInput(draft);
  const check = (value: string, max: number) =>
    value.length > max ? "TooLong" : notPlain.test(value) ? "NotPlain" : undefined;
  const description = check(input.description, presentationLimits.description);
  const descriptionZh = check(input.descriptionZh, presentationLimits.description);
  const altText =
    input.photo === null
      ? undefined
      : input.photo.altText === ""
        ? "AltTextMissing"
        : check(input.photo.altText, presentationLimits.altText);
  return {
    ...(description ? { description } : {}),
    ...(descriptionZh ? { descriptionZh } : {}),
    ...(altText ? { altText } : {}),
  };
}

export type ProductPhotoErrorCode =
  | "PhotoTypeUnsupported"
  | "PhotoTooLarge"
  | "PhotoTooSmall"
  | "PhotoUnreadable"
  | "PhotoStorageUnavailable"
  | "PermissionDenied"
  | "NotFound"
  | "Offline"
  | "Unavailable";
export class ProductPhotoError extends Error {
  constructor(readonly code: ProductPhotoErrorCode) {
    super(t("The photo was not recorded"));
    this.name = "ProductPhotoError";
  }
}
export const photoContentTypes = ["image/jpeg", "image/png", "image/webp"] as const;
export const photoMaximumBytes = 10 * 1024 * 1024;
/** The checks the browser can make before sending; the server checks the photo itself again. */
export function photoFileProblem(file: {
  readonly type: string;
  readonly size: number;
}): "PhotoTypeUnsupported" | "PhotoTooLarge" | null {
  if (!(photoContentTypes as readonly string[]).includes(file.type)) return "PhotoTypeUnsupported";
  return file.size > photoMaximumBytes ? "PhotoTooLarge" : null;
}
/** Failures a retry of the same file may fix: nothing was recorded, or it is unknown. */
export const photoRetryable = (code: ProductPhotoErrorCode) =>
  code === "PhotoStorageUnavailable" || code === "Offline" || code === "Unavailable";
const photoCodes = new Set<string>([
  "PhotoTypeUnsupported",
  "PhotoTooLarge",
  "PhotoTooSmall",
  "PhotoUnreadable",
  "PhotoStorageUnavailable",
  "PermissionDenied",
  "NotFound",
]);
export const parseProductRouteReference = (value: string | undefined): string | null =>
  value !== undefined && uuid.test(value) ? value : null;
/** Product and size codes: capital letters, digits, hyphen and underscore, starting with a letter. */
export const productCodeValid = (value: string) =>
  /^[A-Z][A-Z0-9_-]{0,63}$/u.test(value.trim().toUpperCase());
export const suggestProductCode = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/[^A-Za-z0-9-]/gu, "")
    .replace(/^[^A-Za-z]+|-+$/gu, "")
    .toUpperCase()
    .slice(0, 40);
const orderTypeText: Readonly<Record<string, string>> = {
  Pickup: t("Pickup"),
  DineIn: t("Dine-in"),
  Delivery: t("Delivery"),
  Catering: t("Catering"),
};
const treatmentText: Readonly<Record<string, string>> = {
  ZeroRated: "zero-rated",
  Exempt: "tax-exempt",
  OutOfScope: t("not taxed"),
};
/** "Pickup 13% · Dine-in 13%" — each order type's sellable rate (rates are exact decimals). */
export function taxClassText(choice: ProductTaxClass): string {
  const percent = (rate: string) => {
    const [whole = "0", fraction = ""] = rate.split(".");
    const scaled = (whole + fraction.padEnd(2, "0").slice(0, 2)).replace(/^0+(?=\d)/u, "");
    const rest = fraction.slice(2).replace(/0+$/u, "");
    return scaled + (rest ? "." + rest : "") + "%";
  };
  return choice.rules
    .map(
      (rule) =>
        `${orderTypeText[rule.orderType] ?? rule.orderType} ${
          rule.treatment === "Taxable"
            ? percent(rule.rate)
            : (treatmentText[rule.treatment] ?? rule.treatment.toLowerCase())
        }`,
    )
    .join(" · ");
}
export const productTypeText: Record<string, string> = {
  PreparedFood: t("Prepared food"),
  NonAlcoholicBeverage: t("Non-alcoholic beverage"),
};
export const unavailableProductClient: ProductClient = {
  load: async () => {
    throw new ProductPageError("Unavailable");
  },
};
const codes = new Set<ProductErrorCode>([
  "PermissionDenied",
  "NotFound",
  "Conflict",
  "CodeTaken",
  "SizeInUse",
  "TaxClassUnavailable",
  "Lifecycle",
  "Invalid",
]);
export function createProductClient(csrf: string, fetcher: typeof fetch = fetch): ProductClient {
  const post = async (path: string, body: unknown) => {
    let response: Response;
    try {
      response = await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(body),
      });
    } catch {
      throw new ProductPageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const code = String(payload?.error) as ProductErrorCode;
      throw new ProductPageError(
        codes.has(code) ? code : response.status === 403 ? "PermissionDenied" : "Unavailable",
      );
    }
    return response.json() as Promise<unknown>;
  };
  const uploadPhoto = async (
    productReference: string,
    file: Blob,
    operationReference: string,
  ): Promise<ProductPhoto> => {
    let response: Response;
    try {
      response = await fetcher("/merchant/commerce/products/photo", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": file.type,
          "x-bop-csrf": csrf,
          "x-bop-product-reference": productReference,
          "x-bop-operation-reference": operationReference,
        },
        body: file,
      });
    } catch {
      throw new ProductPhotoError("Offline");
    }
    const payload = object(await response.json().catch(() => null));
    if (!response.ok) {
      const code = String(payload?.error);
      throw new ProductPhotoError(
        photoCodes.has(code)
          ? (code as ProductPhotoErrorCode)
          : code === "Invalid"
            ? "PhotoUnreadable"
            : response.status === 413
              ? "PhotoTooLarge"
              : response.status === 403
                ? "PermissionDenied"
                : "Unavailable",
      );
    }
    const photo = payload?.status === "Recorded" ? parsePhoto(payload.photo) : null;
    if (photo === null) throw new ProductPhotoError("Unavailable");
    return photo;
  };
  return {
    load: (productReference) => post("/merchant/commerce/products/query", { productReference }),
    command: (command) => post("/merchant/commerce/products/command", command),
    uploadPhoto,
  };
}
