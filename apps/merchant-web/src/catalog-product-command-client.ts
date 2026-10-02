import {
  ProductCommandClientError,
  copyProductCommandValue,
  productCommandRecord as record,
  parseCatalogReference as ref,
  parseCatalogCode,
  parseCatalogDecimal,
  parseCatalogLocale,
  parseLocalizedNames,
  parseVariantSelections,
  parseProductCategoryClassification,
  parseProductVersion,
  type ProductCategoryClassification,
  type ProductVersion,
  type VariantSelection,
  type ProductType,
} from "./catalog-product-command-values.js";
import {
  parseProductEditorContentDetails,
  type ProductEditorContentDetails,
} from "./product-editor-content-values.js";
export { ProductCommandClientError } from "./catalog-product-command-values.js";
export interface ProductCommandScope {
  readonly brandReference: string;
  readonly storeReference: string;
}
export interface CreateProductCommand {
  readonly internalCode: string;
  readonly productType: ProductType;
  readonly defaultLocale: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly taxClassificationReference: string | null;
  readonly categoryClassification?: ProductCategoryClassification;
  readonly editorContent?: ProductEditorContentDetails;
  readonly operationReference: string;
  readonly skus: readonly {
    readonly skuCode: string;
    readonly localizedNames: Readonly<Record<string, string>>;
    readonly variantSelections: readonly VariantSelection[];
    readonly unitOfSale: string;
    readonly unitQuantity: string;
  }[];
}
export interface SaveProductDraftCommand {
  readonly productReference: string;
  readonly expectedAggregateVersion: number;
  readonly operationReference: string;
  readonly draft: ProductVersion;
}
export interface ProductCreationReceipt {
  readonly status: "Applied" | "AlreadyApplied";
  readonly scope: ProductCommandScope;
  readonly operationReference: string;
  readonly productReference: string;
  readonly versionReference: string;
  readonly aggregateVersion: 1;
  readonly lifecycle: "Draft";
  readonly categoryClassification?: ProductCategoryClassification;
  readonly skus: readonly {
    readonly skuReference: string;
    readonly skuCode: string;
    readonly lifecycle: "Draft";
  }[];
}
export interface ProductDraftReceipt {
  readonly status: "Applied" | "AlreadyApplied";
  readonly scope: ProductCommandScope;
  readonly operationReference: string;
  readonly productReference: string;
  readonly aggregateVersion: number;
  readonly draft: ProductVersion;
}
const invalid = (): never => {
  throw new ProductCommandClientError("Invalid");
};
const unknown = (): never => {
  throw new ProductCommandClientError("OutcomeUnknown");
};
export const productCommandMaximumRequestBytes = 8192;
/** Matches the existing native HTTP JSON ceiling; only parsed complete Draft uses it. */
export const productCompleteDraftMaximumRequestBytes = 65536;
export const productCommandMaximumResponseBytes = 65536;
function scope(value: unknown): ProductCommandScope {
  const raw = record(copyProductCommandValue(value), ["brandReference", "storeReference"]);
  return Object.freeze({
    brandReference: ref(raw.brandReference),
    storeReference: ref(raw.storeReference),
  });
}
function classification(raw: Readonly<Record<string, unknown>>) {
  return Object.hasOwn(raw, "categoryClassification")
    ? { categoryClassification: parseProductCategoryClassification(raw.categoryClassification) }
    : {};
}
function quantity(value: unknown) {
  const parsed = parseCatalogDecimal(value);
  if (!/^(?:0|[1-9][0-9]{0,13})(?:\.[0-9]{1,6})?$/u.test(parsed)) return invalid();
  return parsed;
}
function createCommand(value: unknown): CreateProductCommand {
  const raw = record(
    copyProductCommandValue(value),
    [
      "internalCode",
      "productType",
      "defaultLocale",
      "localizedNames",
      "taxClassificationReference",
      "operationReference",
      "skus",
    ],
    ["categoryClassification", "editorContent"],
  );
  if (
    (raw.productType !== "PreparedFood" && raw.productType !== "NonAlcoholicBeverage") ||
    !Array.isArray(raw.skus)
  )
    return invalid();
  const defaultLocale = parseCatalogLocale(raw.defaultLocale);
  const skus = Object.freeze(
    raw.skus.map((value) => {
      const row = record(value, [
        "skuCode",
        "localizedNames",
        "variantSelections",
        "unitOfSale",
        "unitQuantity",
      ]);
      return Object.freeze({
        skuCode: parseCatalogCode(row.skuCode),
        localizedNames: parseLocalizedNames(row.localizedNames, defaultLocale),
        variantSelections: Object.freeze(
          [...parseVariantSelections(row.variantSelections)].sort((a, b) =>
            a.dimensionReference.localeCompare(b.dimensionReference),
          ),
        ),
        unitOfSale: parseCatalogCode(row.unitOfSale),
        unitQuantity: quantity(row.unitQuantity),
      });
    }),
  );
  if (
    new Set(skus.map((sku) => sku.skuCode)).size !== skus.length ||
    new Set(skus.map((sku) => JSON.stringify(sku.variantSelections))).size !== skus.length
  )
    return invalid();
  const completeContent = Object.hasOwn(raw, "editorContent")
    ? (() => {
        if (skus.length !== 0) return invalid();
        return {
          editorContent: parseProductEditorContentDetails(raw.editorContent, {
            defaultLocale,
            skus: [],
            optionBindings: [],
          }),
        };
      })()
    : {};
  return Object.freeze({
    internalCode: parseCatalogCode(raw.internalCode),
    productType: raw.productType,
    defaultLocale,
    localizedNames: parseLocalizedNames(raw.localizedNames, defaultLocale),
    taxClassificationReference:
      raw.taxClassificationReference === null ? null : ref(raw.taxClassificationReference),
    operationReference: ref(raw.operationReference),
    ...classification(raw),
    ...completeContent,
    skus,
  });
}
function saveCommand(value: unknown, expectedScope: ProductCommandScope): SaveProductDraftCommand {
  const raw = record(copyProductCommandValue(value), [
    "productReference",
    "expectedAggregateVersion",
    "operationReference",
    "draft",
  ]);
  const productReference = ref(raw.productReference);
  if (
    typeof raw.expectedAggregateVersion !== "number" ||
    !Number.isSafeInteger(raw.expectedAggregateVersion) ||
    raw.expectedAggregateVersion < 1 ||
    raw.expectedAggregateVersion >= 2147483647
  )
    return invalid();
  const draft = parseProductVersion(raw.draft);
  if (
    draft.skus.some(
      (sku) =>
        sku.brandReference !== expectedScope.brandReference ||
        sku.productReference !== productReference,
    )
  )
    return invalid();
  for (const sku of draft.skus) quantity(sku.unitQuantity);
  return Object.freeze({
    productReference,
    expectedAggregateVersion: raw.expectedAggregateVersion,
    operationReference: ref(raw.operationReference),
    draft,
  });
}
function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function responseBase(
  raw: Readonly<Record<string, unknown>>,
  command: { readonly operationReference: string },
  expectedScope: ProductCommandScope,
) {
  const actualScope = scope(raw.scope);
  if (
    !same(actualScope, expectedScope) ||
    raw.operationReference !== command.operationReference ||
    (raw.status !== "Applied" && raw.status !== "AlreadyApplied")
  )
    return unknown();
  return {
    scope: actualScope,
    operationReference: command.operationReference,
    status: raw.status as "Applied" | "AlreadyApplied",
  };
}
function createReceipt(
  value: unknown,
  command: CreateProductCommand,
  expectedScope: ProductCommandScope,
): ProductCreationReceipt {
  const raw = record(
    copyProductCommandValue(value),
    [
      "status",
      "scope",
      "operationReference",
      "productReference",
      "versionReference",
      "aggregateVersion",
      "lifecycle",
      "skus",
    ],
    ["categoryClassification"],
  );
  const base = responseBase(raw, command, expectedScope),
    classified = classification(raw);
  if (
    raw.aggregateVersion !== 1 ||
    raw.lifecycle !== "Draft" ||
    !same(classified, classification(command as unknown as Record<string, unknown>)) ||
    !Array.isArray(raw.skus)
  )
    return unknown();
  const skus = Object.freeze(
    raw.skus.map((value) => {
      const row = record(value, ["skuReference", "skuCode", "lifecycle"]);
      if (row.lifecycle !== "Draft") return unknown();
      return Object.freeze({
        skuReference: ref(row.skuReference),
        skuCode: parseCatalogCode(row.skuCode),
        lifecycle: "Draft" as const,
      });
    }),
  );
  if (
    new Set(skus.map((sku) => sku.skuReference)).size !== skus.length ||
    new Set(skus.map((sku) => sku.skuCode)).size !== skus.length ||
    !same(skus.map((sku) => sku.skuCode).sort(), command.skus.map((sku) => sku.skuCode).sort())
  )
    return unknown();
  return Object.freeze({
    ...base,
    productReference: ref(raw.productReference),
    versionReference: ref(raw.versionReference),
    aggregateVersion: 1,
    lifecycle: "Draft",
    ...classified,
    skus,
  });
}
function draftIntent(draft: ProductVersion) {
  return {
    ...Object.fromEntries(
      Object.entries(draft).filter(([key]) => key !== "updatedAt" && key !== "skus"),
    ),
    skus: draft.skus.map((sku) =>
      Object.fromEntries(
        Object.entries(sku).filter(
          ([key]) => key !== "createdAt" && key !== "createdByActorReference",
        ),
      ),
    ),
  };
}
function draftReceipt(
  value: unknown,
  command: SaveProductDraftCommand,
  expectedScope: ProductCommandScope,
): ProductDraftReceipt {
  const raw = record(copyProductCommandValue(value), [
    "status",
    "scope",
    "operationReference",
    "productReference",
    "aggregateVersion",
    "draft",
  ]);
  const base = responseBase(raw, command, expectedScope),
    draft = parseProductVersion(raw.draft);
  if (
    raw.productReference !== command.productReference ||
    raw.aggregateVersion !== command.expectedAggregateVersion + 1 ||
    !same(draftIntent(draft), draftIntent(command.draft))
  )
    return unknown();
  return Object.freeze({
    ...base,
    productReference: command.productReference,
    aggregateVersion: raw.aggregateVersion as number,
    draft,
  });
}
async function read(response: Response, signal: AbortSignal) {
  if (!response.body) return unknown();
  const reader = response.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  let bytes = 0,
    text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > productCommandMaximumResponseBytes) return unknown();
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
/** No automatic retries or new operation IDs. Receipts describe the original mutation, not live state. */
export function createProductCommandClient(fetcher: typeof fetch = fetch) {
  const definitive = new WeakSet<ProductCommandClientError>();
  const rejectResponse = (code: "Invalid" | "Denied" | "FeatureDisabled" | "Conflict"): never => {
    const error = new ProductCommandClientError(code);
    definitive.add(error);
    throw error;
  };
  function prepared<C extends CreateProductCommand | SaveProductDraftCommand, T>(
    path: string,
    command: C,
    expectedScope: ProductCommandScope,
    decode: (value: unknown) => T,
    maximumRequestBytes = productCommandMaximumRequestBytes,
  ) {
    let uncertain = false;
    const body = JSON.stringify(command);
    if (new TextEncoder().encode(body).byteLength > maximumRequestBytes) return invalid();
    const scopeHeader = btoa(JSON.stringify(expectedScope))
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/u, "");
    return Object.freeze({
      command,
      scope: expectedScope,
      async execute(csrf: string, signal?: AbortSignal): Promise<T> {
        if (typeof csrf !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(csrf)) {
          if (uncertain) throw new ProductCommandClientError("OutcomeUnknown", "Invalid");
          return invalid();
        }
        if (signal?.aborted)
          throw new ProductCommandClientError(uncertain ? "OutcomeUnknown" : "Unavailable");
        const controller = new AbortController();
        let abortReject: ((reason: unknown) => void) | undefined;
        const aborted = new Promise<never>((_, reject) => {
          abortReject = reject;
        });
        const abort = () => {
          controller.abort();
          abortReject?.(new ProductCommandClientError("OutcomeUnknown"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, 15000);
        try {
          const response = await Promise.race([
            fetcher(path, {
              method: "POST",
              credentials: "same-origin",
              cache: "no-store",
              redirect: "error",
              signal: controller.signal,
              body,
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-BOP-CSRF": csrf,
                "X-BOP-Catalog-Scope": scopeHeader,
              },
            }),
            aborted,
          ]);
          if (
            controller.signal.aborted ||
            response.headers.get("cache-control") !== "no-store" ||
            !/^application\/json(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "")
          )
            return unknown();
          const value = await Promise.race([read(response, controller.signal), aborted]);
          if (controller.signal.aborted) return unknown();
          if (response.status !== 200) {
            const error = record(value, ["error"]).error;
            const purpose = path.endsWith("/draft") ? "product_draft" : "product_creation";
            if ((response.status === 401 || response.status === 403) && error === "request_denied")
              return rejectResponse("Denied");
            if (response.status === 409 && error === purpose + "_feature_disabled")
              return rejectResponse("FeatureDisabled");
            if (response.status === 409 && error === purpose + "_conflict")
              return rejectResponse("Conflict");
            if (response.status === 400 && error === purpose + "_invalid")
              return rejectResponse("Invalid");
            return unknown();
          }
          const receipt = decode(value);
          uncertain = false;
          return receipt;
        } catch (error) {
          if (error instanceof ProductCommandClientError && definitive.has(error)) {
            if (!uncertain) throw error;
            throw new ProductCommandClientError(
              "OutcomeUnknown",
              error.code as "Invalid" | "Denied" | "FeatureDisabled" | "Conflict",
            );
          }
          uncertain = true;
          return unknown();
        } finally {
          controller.abort();
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        }
      },
    });
  }
  return Object.freeze({
    prepareCreate(value: unknown, scopeValue: unknown) {
      const expectedScope = scope(scopeValue),
        command = createCommand(value);
      return prepared("/merchant/catalog/products", command, expectedScope, (value) =>
        createReceipt(value, command, expectedScope),
      );
    },
    prepareDraft(value: unknown, scopeValue: unknown) {
      const expectedScope = scope(scopeValue),
        command = saveCommand(value, expectedScope);
      return prepared(
        "/merchant/catalog/products/draft",
        command,
        expectedScope,
        (value) => draftReceipt(value, command, expectedScope),
        command.draft.editorContent === undefined
          ? productCommandMaximumRequestBytes
          : productCompleteDraftMaximumRequestBytes,
      );
    },
  });
}
