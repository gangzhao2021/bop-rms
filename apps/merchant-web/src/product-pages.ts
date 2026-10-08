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
    super("Products are unavailable");
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
  readonly taxClassificationReference: string | null;
  readonly sizes: readonly {
    readonly skuReference: string;
    readonly skuCode: string;
    readonly name: string;
    readonly lifecycle: string;
    readonly unitOfSale: string;
  }[];
  /** The option sets on the product, in order, with the options it offers from each. */
  readonly optionSets?: readonly ProductOptionSetInput[];
  readonly createdAt: string;
  readonly updatedAt: string;
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
}
export interface ProductOptionSetInput {
  readonly optionSetReference: string;
  readonly enabledOptionReferences: readonly string[];
}
export interface ProductSizeInput {
  readonly skuReference: string | null;
  readonly skuCode: string;
  readonly name: string;
}
export type ProductCommand =
  | {
      readonly action: "Create";
      readonly operationReference: string;
      readonly internalCode: string;
      readonly productType: string;
      readonly name: string;
      readonly taxClassificationReference: string;
      readonly sizes: readonly ProductSizeInput[];
    }
  | {
      readonly action: "SaveDraft";
      readonly operationReference: string;
      readonly productReference: string;
      readonly expectedAggregateVersion: number;
      readonly name: string;
      readonly taxClassificationReference: string;
      readonly sizes: readonly ProductSizeInput[];
      readonly optionSets?: readonly ProductOptionSetInput[];
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
  return r as unknown as ProductDetailView;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
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
/** "Pickup 13% · DineIn 13%" — each order type's sellable rate (rates are exact decimals). */
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
        `${rule.orderType} ${rule.treatment === "Taxable" ? percent(rule.rate) : rule.treatment}`,
    )
    .join(" · ");
}
export const productTypeText: Record<string, string> = {
  PreparedFood: "Prepared food",
  NonAlcoholicBeverage: "Non-alcoholic beverage",
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
  return {
    load: (productReference) => post("/merchant/commerce/products/query", { productReference }),
    command: (command) => post("/merchant/commerce/products/command", command),
  };
}
