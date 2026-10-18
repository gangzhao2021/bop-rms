import { createHash } from "node:crypto";
import {
  CatalogError,
  createCatalogProductService,
  createPostgresProductCreationStore,
  createPostgresProductDraftStore,
  createPostgresProductLifecycleStore,
  listBrandOptionSets,
  listBrandProducts,
  loadBrandProduct,
  parseCatalogHash,
  parseCatalogReference,
  type OptionSetAggregate,
  type ProductAggregate,
  type ProductLifecycleTransaction,
  listStoreAvailabilityRules,
} from "@rms/catalog";
import {
  MediaProductImageError,
  type ProductImageRecord,
  type createProductImageService,
} from "@bop/media";
import { listStoreTaxClassifications } from "@rms/pricing";
import { itemAvailability } from "./merchant-availability.js";
import { withRememberedBrandAuthorization } from "./merchant-brand-transaction-authorization.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 / DEC-CAT-PRODUCT-ADMIN: CAT-PRODUCT-LIST / CAT-PRODUCT-DETAIL for the selected Store's Brand.
 * Products are Brand facts written through the Catalog Product service (create, Draft replacement,
 * lifecycle) with its repository, operation records, events and audit. Reading needs
 * catalog.product.read; creating catalog.product.create; editing names, tax class and sizes
 * catalog.product.update (adding a size also catalog.sku.create); starting sale catalog.product.publish
 * and catalog.sku.activate. A Store grant alone never satisfies them. Pilot (WP-2423 bypass list):
 * a Product version is edited in place without the publication review; every change is audited and
 * versioned. Pausing, discontinuing and archiving need the lifecycle review and are not offered yet.
 * WP-2423 slice 4: a product lists the Brand option sets customers choose from (in order) and, for
 * each, which of the set's options this product offers; the set's default choices are preselected.
 * WP-2423 menu descriptions and photos: a product carries a short customer description and a photo
 * (with alt text) in its draft; the photo is uploaded first (Media records the processed image and
 * its sizes) and attached on save. Customers see both only after the next menu publication, which
 * pins them into the reviewed menu snapshot.
 */
export class MerchantProductError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "CodeTaken"
      | "SizeInUse"
      | "TaxClassUnavailable"
      | "Lifecycle"
      | "Invalid"
      | "PhotoTypeUnsupported"
      | "PhotoTooLarge"
      | "PhotoTooSmall"
      | "PhotoUnreadable"
      | "PhotoStorageUnavailable",
  ) {
    super(code);
    this.name = "MerchantProductError";
  }
}
const fail = (code: MerchantProductError["code"]): never => {
  throw new MerchantProductError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
const nullableRef = (value: unknown): string | null => (value === null ? null : ref(value));
const version = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : fail("Invalid");
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const text = (value: unknown, max: number): string => {
  if (typeof value !== "string") return fail("Invalid");
  const trimmed = value.trim().replace(/\s+/gu, " ");
  return trimmed.length >= 1 && trimmed.length <= max && !/[\p{Cc}]/u.test(trimmed)
    ? trimmed
    : fail("Invalid");
};
/** Plain customer text that may be empty ("" = none). */
const optionalText = (value: unknown, max: number): string => {
  if (typeof value !== "string") return fail("Invalid");
  return value.trim() === "" ? "" : text(value, max);
};
const codeOf = (value: unknown): string => {
  const normalized = text(value, 64).toUpperCase();
  return code.test(normalized) ? normalized : fail("Invalid");
};
export const productTypes = ["PreparedFood", "NonAlcoholicBeverage"] as const;
/** Units of sale the pilot sells; quantities are always one unit per sale line. */
export const productSellingUnits = ["EACH"] as const;
const maxSizes = 12;
/** Longest customer description and photo alt text (Catalog enforces the same limits). */
export const productDescriptionMaximum = 240;
export const productPhotoAltTextMaximum = 160;
/** Largest photo upload accepted (Media re-checks the bytes). */
export const productPhotoBytesMaximum = 10 * 1024 * 1024;
export const productPhotoContentTypes = ["image/jpeg", "image/png", "image/webp"] as const;

export interface ProductSizeInput {
  readonly skuReference: string | null;
  readonly skuCode: string;
  readonly name: string;
}
/** An option set on a product: the options of the set this product offers. */
export interface ProductOptionSetInput {
  readonly optionSetReference: string;
  readonly enabledOptionReferences: readonly string[];
}
/** The customer-facing description ("" = none) and photo of a product, in the page locale. */
export interface ProductPresentationInput {
  readonly description: string;
  readonly photo: { readonly imageReference: string; readonly altText: string } | null;
}
export type ProductCommandBody =
  | {
      readonly action: "Create";
      readonly operationReference: string;
      readonly internalCode: string;
      readonly productType: (typeof productTypes)[number];
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
      /** Absent: the product's option sets stay as they are. */
      readonly optionSets?: readonly ProductOptionSetInput[];
      /** Absent: the product's description and photo stay as they are. */
      readonly presentation?: ProductPresentationInput;
    }
  | {
      readonly action: "StartSelling";
      readonly operationReference: string;
      readonly productReference: string;
      readonly expectedAggregateVersion: number;
    };
function sizes(value: unknown, creating: boolean): readonly ProductSizeInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxSizes) return fail("Invalid");
  const parsed = value.map((candidate: unknown) => {
    const r = candidate as Record<string, unknown> | null;
    if (
      r === null ||
      typeof r !== "object" ||
      Array.isArray(r) ||
      Object.keys(r).sort().join(",") !== "name,skuCode,skuReference"
    )
      return fail("Invalid");
    const skuReference = nullableRef(r.skuReference);
    if (creating && skuReference !== null) return fail("Invalid");
    return { skuReference, skuCode: codeOf(r.skuCode), name: text(r.name, 80) };
  });
  if (
    new Set(parsed.map((size) => size.skuCode)).size !== parsed.length ||
    new Set(parsed.map((size) => size.name.toLowerCase())).size !== parsed.length ||
    new Set(parsed.filter((size) => size.skuReference).map((size) => size.skuReference)).size !==
      parsed.filter((size) => size.skuReference).length
  )
    return fail("Invalid");
  return parsed;
}
function optionSetInputs(value: unknown): readonly ProductOptionSetInput[] {
  if (!Array.isArray(value) || value.length > 12) return fail("Invalid");
  const parsed = value.map((candidate: unknown) => {
    const r = candidate as Record<string, unknown> | null;
    if (
      r === null ||
      typeof r !== "object" ||
      Array.isArray(r) ||
      Object.keys(r).sort().join(",") !== "enabledOptionReferences,optionSetReference" ||
      !Array.isArray(r.enabledOptionReferences) ||
      r.enabledOptionReferences.length < 1 ||
      r.enabledOptionReferences.length > 50
    )
      return fail("Invalid");
    const enabled = r.enabledOptionReferences.map(ref);
    if (new Set(enabled).size !== enabled.length) return fail("Invalid");
    return { optionSetReference: ref(r.optionSetReference), enabledOptionReferences: enabled };
  });
  if (new Set(parsed.map((item) => item.optionSetReference)).size !== parsed.length)
    return fail("Invalid");
  return parsed;
}
function presentationInput(value: unknown): ProductPresentationInput {
  const r = value as Record<string, unknown> | null;
  if (
    r === null ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).sort().join(",") !== "description,photo"
  )
    return fail("Invalid");
  const description = optionalText(r.description, productDescriptionMaximum);
  if (r.photo === null) return { description, photo: null };
  const photo = r.photo as Record<string, unknown> | null;
  if (
    photo === null ||
    typeof photo !== "object" ||
    Array.isArray(photo) ||
    Object.keys(photo).sort().join(",") !== "altText,imageReference"
  )
    return fail("Invalid");
  return {
    description,
    photo: {
      imageReference: ref(photo.imageReference),
      altText: text(photo.altText, productPhotoAltTextMaximum),
    },
  };
}
export function parseProductCommandBody(value: unknown): ProductCommandBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  const keys = Object.keys(r).sort().join(",");
  if (
    r.action === "Create" &&
    keys ===
      "action,internalCode,name,operationReference,productType,sizes,taxClassificationReference"
  ) {
    if (!(productTypes as readonly unknown[]).includes(r.productType)) return fail("Invalid");
    return {
      action: "Create",
      operationReference: ref(r.operationReference),
      internalCode: codeOf(r.internalCode),
      productType: r.productType as (typeof productTypes)[number],
      name: text(r.name, 120),
      taxClassificationReference: ref(r.taxClassificationReference),
      sizes: sizes(r.sizes, true),
    };
  }
  const saveKeys = [
    "action",
    "expectedAggregateVersion",
    "name",
    "operationReference",
    "productReference",
    "sizes",
    "taxClassificationReference",
  ];
  const own = Object.keys(r);
  if (
    r.action === "SaveDraft" &&
    saveKeys.every((key) => own.includes(key)) &&
    own.every((key) => saveKeys.includes(key) || key === "optionSets" || key === "presentation")
  )
    return {
      action: "SaveDraft",
      operationReference: ref(r.operationReference),
      productReference: ref(r.productReference),
      expectedAggregateVersion: version(r.expectedAggregateVersion),
      name: text(r.name, 120),
      taxClassificationReference: ref(r.taxClassificationReference),
      sizes: sizes(r.sizes, false),
      ...(own.includes("optionSets") ? { optionSets: optionSetInputs(r.optionSets) } : {}),
      ...(own.includes("presentation") ? { presentation: presentationInput(r.presentation) } : {}),
    };
  if (
    r.action === "StartSelling" &&
    keys === "action,expectedAggregateVersion,operationReference,productReference"
  )
    return {
      action: "StartSelling",
      operationReference: ref(r.operationReference),
      productReference: ref(r.productReference),
      expectedAggregateVersion: version(r.expectedAggregateVersion),
    };
  return fail("Invalid");
}

/** Stable UUIDv7-shaped identity derived from an operation, keeping its timestamp. */
export function derivedReference(operation: string, purpose: string): string {
  const digest = createHash("sha256")
    .update("bop-rms/merchant-products/v1:" + operation + ":" + purpose)
    .digest("hex");
  return (
    operation.slice(0, 14) +
    "7" +
    digest.slice(0, 3) +
    "-" +
    ((parseInt(digest.slice(3, 4), 16) & 3) | 8).toString(16) +
    digest.slice(4, 7) +
    "-" +
    digest.slice(7, 19)
  );
}

const catalogErrors: Partial<Record<CatalogError["code"], MerchantProductError["code"]>> = {
  CATALOG_PERMISSION_DENIED: "PermissionDenied",
  CATALOG_VERSION_CONFLICT: "Conflict",
  CATALOG_IDEMPOTENCY_CONFLICT: "Conflict",
  CATALOG_CODE_CONFLICT: "CodeTaken",
  CATALOG_LIFECYCLE_CONFLICT: "Lifecycle",
  CATALOG_INPUT_INVALID: "Invalid",
  CATALOG_UNAVAILABLE: "NotFound",
};

function optionSetsView(product: ProductAggregate) {
  return product.draft.optionBindings.map((binding) => ({
    optionSetReference: binding.optionSetReference,
    enabledOptionReferences: binding.enabledOptionReferences,
  }));
}
/** The product's customer description and photo as the editor shows them (page locale first). */
export function presentationView(
  product: ProductAggregate,
  locale: string,
  images: ReadonlyMap<string, ProductImageRecord>,
) {
  const presentation = product.draft.customerPresentation;
  const pick = (values: Readonly<Record<string, string>>) =>
    values[locale] ?? values[product.draft.defaultLocale] ?? Object.values(values)[0] ?? "";
  if (presentation === undefined) return { description: "", photo: null };
  const photo = presentation.photo;
  if (photo === null) return { description: pick(presentation.localizedDescriptions), photo: null };
  const image = images.get(String(photo.imageReference));
  const preview = image?.renditions.find(
    (rendition) => rendition.width === 640 && rendition.contentType === "image/jpeg",
  );
  if (image === undefined || preview === undefined) return fail("PhotoStorageUnavailable");
  return {
    description: pick(presentation.localizedDescriptions),
    photo: {
      imageReference: String(photo.imageReference),
      altText: pick(photo.localizedAltText),
      width: image.width,
      height: image.height,
      previewUrl: preview.path,
    },
  };
}
export function productView(
  product: ProductAggregate,
  locale: string,
  images: ReadonlyMap<string, ProductImageRecord> = new Map(),
) {
  const name = (names: Readonly<Record<string, string>>) =>
    names[locale] ?? names[product.draft.defaultLocale] ?? Object.values(names)[0] ?? "";
  return {
    productReference: product.productReference,
    internalCode: product.internalCode,
    productType: product.productType,
    lifecycle: product.lifecycle,
    aggregateVersion: product.aggregateVersion,
    name: name(product.draft.localizedNames),
    taxClassificationReference: product.draft.taxClassificationReference,
    sizes: product.draft.skus.map((sku) => ({
      skuReference: sku.skuReference,
      skuCode: sku.skuCode,
      name: name(sku.localizedNames),
      lifecycle: sku.lifecycle,
      unitOfSale: sku.unitOfSale,
    })),
    optionSets: optionSetsView(product),
    presentation: presentationView(product, locale, images),
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}
/** The Brand's option sets a product can use, with their options (archived options left out). */
export function optionSetChoices(sets: readonly OptionSetAggregate[], locale: string) {
  const name = (names: Readonly<Record<string, string>>, fallback: string) =>
    names[locale] ?? Object.values(names)[0] ?? fallback;
  return sets.map((set) => ({
    optionSetReference: set.optionSetReference,
    name: name(set.draft.localizedNames, set.internalCode),
    archived: set.lifecycle === "Archived",
    displayStyle: set.draft.displayStyle,
    minimum: set.draft.minimumSelection,
    maximum: set.draft.maximumSelection,
    perOptionMaximum: set.draft.perOptionMaximumQuantity,
    options: set.draft.options
      .filter((option) => option.lifecycle !== "Archived")
      .map((option) => ({
        optionReference: option.optionReference,
        name: name(option.localizedNames, option.stableCode),
        offered: option.lifecycle === "Active",
      })),
  }));
}

export function createMerchantProducts(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
  /** Locale Product and size names are written in (the Brand's default menu locale). */
  locale: string;
  /** Test seam: the Brand scope resolver (defaults to the current session's Brand scope). */
  resolveScope?: ReturnType<typeof createMerchantBrandScope>;
  /** Media product images (pilot: local storage adapter). Absent: photos cannot be added or shown. */
  images?: ReturnType<typeof createProductImageService>;
}) {
  const resolveScope = options.resolveScope ?? createMerchantBrandScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  type ReadTx = Parameters<typeof listBrandProducts>[0];
  const reads = (tx: Tx) => tx as unknown as ReadTx;
  const productTx = (tx: Tx) => tx as unknown as ProductLifecycleTransaction;
  type MediaTx = Parameters<ReturnType<typeof createProductImageService>["load"]>[0];
  const mediaTx = (tx: Tx) => tx as unknown as MediaTx;
  /** The Media record of the product's photo (none without a photo). */
  const imagesOf = async (
    tx: Tx,
    brand: string,
    product: ProductAggregate,
  ): Promise<ReadonlyMap<string, ProductImageRecord>> => {
    const photo = product.draft.customerPresentation?.photo;
    if (photo === undefined || photo === null) return new Map();
    if (options.images === undefined) return fail("PhotoStorageUnavailable");
    const images = options.images;
    return images
      .load(mediaTx(tx), { brandReference: brand, imageReferences: [String(photo.imageReference)] })
      .catch(() => fail("PhotoStorageUnavailable"));
  };
  const view = async (tx: Tx, brand: string, product: ProductAggregate) =>
    productView(product, options.locale, await imagesOf(tx, brand, product));
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(() => fail("PermissionDenied"));
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx, sessionCookie, sessionReference).catch(() =>
      fail("PermissionDenied"),
    );
    const decision = (action: string) => scope.authorizeAction(action);
    const may = async (action: string) => (await decision(action))?.effect === "Allow";
    const permissions = {
      mayRead: await may("catalog.product.read"),
      mayCreate: await may("catalog.product.create"),
      mayEdit: await may("catalog.product.update"),
      mayAddSize: await may("catalog.sku.create"),
      mayStartSelling:
        (await may("catalog.product.publish")) && (await may("catalog.sku.activate")),
    };
    if (!permissions.mayRead) fail("PermissionDenied");
    return {
      scope,
      brand: String(scope.context.brand.brandReference),
      store: String(scope.selectedStoreReference),
      actor: String(scope.actorReference),
      permissions,
      decision,
    };
  }
  const query = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    productReference: string | null;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
          const at = options.persistence.now();
          const base = {
            sourceAsOf: at,
            locale: options.locale,
            permissions: s.permissions,
            productTypes,
            sellingUnits: productSellingUnits,
            taxClasses: await listStoreTaxClassifications(
              reads(tx),
              { brandReference: s.brand, storeReference: s.store },
              at,
            ),
          };
          if (input.productReference !== null) {
            const product = await loadBrandProduct(
              reads(tx),
              { brandReference: s.brand },
              input.productReference,
            );
            if (product === null) return fail("NotFound");
            const mayReadOptions =
              (await s.decision("catalog.option_set.read"))?.effect === "Allow";
            // WP-2423 (v15 2026-10-16): whether each size is offered at the selected Store, so a
            // new product is never assumed visible to customers here.
            const rules = await listStoreAvailabilityRules(productTx(tx), {
              brandReference: s.brand,
              storeReference: s.store,
            });
            const availabilityHere = Object.fromEntries(
              product.draft.skus.map((sku) => [
                String(sku.skuReference),
                itemAvailability(
                  rules,
                  { brandReference: s.brand, storeReference: s.store },
                  String(sku.skuReference),
                  at,
                ).status,
              ]),
            );
            return {
              screenId: "CAT-PRODUCT-DETAIL" as const,
              ...base,
              product: await view(tx, s.brand, product),
              availabilityHere,
              optionSetChoices: mayReadOptions
                ? optionSetChoices(
                    await listBrandOptionSets(productTx(tx), { brandReference: s.brand }),
                    options.locale,
                  )
                : null,
            };
          }
          const products = await listBrandProducts(reads(tx), { brandReference: s.brand });
          return {
            screenId: "CAT-PRODUCT-LIST" as const,
            ...base,
            products: products.map((product) => ({
              ...product,
              name:
                product.localizedNames[options.locale] ??
                Object.values(product.localizedNames)[0] ??
                "",
            })),
          };
        }),
      ),
    );
  };

  const command = async (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) => {
    const body = parseProductCommandBody(input.body);
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
          if (
            (body.action === "Create" && !s.permissions.mayCreate) ||
            (body.action === "SaveDraft" && !s.permissions.mayEdit) ||
            (body.action === "StartSelling" && !s.permissions.mayStartSelling)
          )
            fail("PermissionDenied");
          const brand = s.brand;
          const productTx = tx as unknown as ProductLifecycleTransaction;
          const storeOptions = {
            brandReference: brand,
            transactions: {
              run: <T>(work: (t: ProductLifecycleTransaction) => Promise<T>) => work(productTx),
            },
            // The API admitted the Actor above; each service write re-checks the decision below.
            authorize: async () => true,
          };
          const creation = createPostgresProductCreationStore(storeOptions);
          const draftStore = createPostgresProductDraftStore(storeOptions);
          const lifecycleStore = createPostgresProductLifecycleStore(storeOptions);
          const actionCodes = {
            Create: "CATALOG_PRODUCT_CREATE",
            ReplaceDraft: "CATALOG_PRODUCT_REPLACEDRAFT",
            ChangeLifecycle: "CATALOG_PRODUCT_CHANGELIFECYCLE",
          } as const;
          const service = (operation: string) => {
            const generated: Record<string, number> = {};
            return createCatalogProductService({
              repository: {
                resolveOperation: creation.resolveOperation,
                load: creation.load,
                codeAvailable: creation.codeAvailable,
                create: creation.create,
                commit: (value) =>
                  value.record.action === "ChangeLifecycle"
                    ? lifecycleStore.commit(value)
                    : draftStore.commit(value),
              },
              // The Brand's option set whose current version the binding names.
              optionSets: {
                resolveVersion: async (request) => {
                  if (request.brandReference !== brand) return null;
                  const sets = await listBrandOptionSets(productTx, { brandReference: brand });
                  return (
                    sets.find(
                      (set) =>
                        set.optionSetReference === request.optionSetReference &&
                        set.draft.versionReference === request.optionSetVersionReference,
                    ) ?? null
                  );
                },
              },
              references: {
                generate: (purpose) => {
                  const index = generated[purpose] ?? 0;
                  generated[purpose] = index + 1;
                  return derivedReference(operation, purpose + ":" + index);
                },
                hashIntent: (value) =>
                  parseCatalogHash(createHash("sha256").update(value).digest("hex")),
                equals: (a, b) => a === b,
              },
              authorization: {
                authorize: async (request) => {
                  const permission = await s.decision("catalog.product.manage");
                  if (permission?.effect !== "Allow" || request.operationReference !== operation)
                    return null;
                  return {
                    tenantContext: s.scope.context,
                    permission,
                    audit: {
                      auditId: derivedReference(operation, "audit"),
                      brandId: brand,
                      actor: { type: "User", reference: s.actor },
                      actionCode: actionCodes[request.action],
                      targetType: "CatalogProduct",
                      targetId: request.productReference ?? "",
                      correlationId: operation,
                      occurredAt: request.observedAt,
                      reasonCode: "AUTHORIZED_OPERATION",
                      sourceChannel: "MERCHANT_WEB",
                      dataClassification: "Internal",
                      retentionPolicyCode: "CONFIGURATION_AUDIT",
                      retentionPolicyVersion: 1,
                    },
                  };
                },
              },
            });
          };
          // A retried operation replays with its original time so the recorded intent matches.
          const requestedAtFor = async (operation: string) =>
            (await creation.resolveOperation(parseCatalogReference(operation)))?.aggregate
              .updatedAt ?? options.persistence.now();
          const taxClassOffered = async (classification: string) =>
            (
              await listStoreTaxClassifications(
                reads(tx),
                { brandReference: brand, storeReference: s.store },
                options.persistence.now(),
              )
            ).some((choice) => choice.taxClassificationReference === classification);
          const names = (name: string) => ({ [options.locale]: name });
          /**
           * The product's option sets in the order given. A set already on the product keeps its
           * binding identity; a newly added set must be current (not archived). Enabled options are
           * the set's non-archived options the merchant chose; the set's default choices among them
           * that are offered are preselected (one each).
           */
          const bindingsFor = async (
            product: ProductAggregate,
            inputs: readonly ProductOptionSetInput[],
            operation: string,
          ) => {
            const changed = JSON.stringify(inputs) !== JSON.stringify(optionSetsView(product));
            if (changed && (await s.decision("catalog.option_set.read"))?.effect !== "Allow")
              fail("PermissionDenied");
            const sets = await listBrandOptionSets(productTx, { brandReference: brand });
            return inputs.map((input, sortOrder) => {
              const set = sets.find((item) => item.optionSetReference === input.optionSetReference);
              if (set === undefined) return fail("Invalid");
              const existing = product.draft.optionBindings.find(
                (binding) => binding.optionSetReference === input.optionSetReference,
              );
              if (existing === undefined && set.lifecycle === "Archived") fail("Invalid");
              const usable = new Set(
                set.draft.options
                  .filter((option) => option.lifecycle !== "Archived")
                  .map((option) => String(option.optionReference)),
              );
              if (input.enabledOptionReferences.some((reference) => !usable.has(reference)))
                fail("Invalid");
              const enabled = [...input.enabledOptionReferences].sort();
              const defaults = set.draft.options
                .filter(
                  (option) =>
                    option.defaultEligible &&
                    option.lifecycle === "Active" &&
                    enabled.includes(String(option.optionReference)),
                )
                .slice(0, set.draft.maximumSelection ?? undefined)
                .map((option) => ({ optionReference: option.optionReference, quantity: 1 }))
                .sort((a, b) => (a.optionReference < b.optionReference ? -1 : 1));
              return {
                bindingReference:
                  existing?.bindingReference ??
                  parseCatalogReference(
                    derivedReference(operation, "binding:" + input.optionSetReference),
                  ),
                optionSetReference: set.optionSetReference,
                optionSetVersionReference: set.draft.versionReference,
                purpose: existing?.purpose ?? "CUSTOMER_CHOICE",
                sortOrder,
                enabledOptionReferences: enabled.map(parseCatalogReference),
                defaultSelections: defaults,
                minimumSelectionOverride: null,
                maximumSelectionOverride: null,
                includedSkuReferences: [],
                excludedSkuReferences: [],
                channelCodes: [],
                storeOverrideAllowed: false,
              };
            });
          };
          /**
           * The draft's description and photo in the page locale; other locales are kept. A photo must
           * be a Media image of this Brand uploaded for this product; its alt text is required.
           */
          const presentationFor = async (
            product: ProductAggregate,
            input: ProductPresentationInput,
          ) => {
            const current = product.draft.customerPresentation;
            const descriptions: Record<string, string> = Object.fromEntries(
              Object.entries(current?.localizedDescriptions ?? {}).filter(
                ([locale]) => locale !== options.locale,
              ),
            );
            if (input.description !== "") descriptions[options.locale] = input.description;
            let photo: NonNullable<ProductAggregate["draft"]["customerPresentation"]>["photo"] =
              null;
            if (input.photo !== null) {
              const image = (
                await (options.images ?? fail("PhotoStorageUnavailable"))
                  .load(mediaTx(tx), {
                    brandReference: brand,
                    imageReferences: [input.photo.imageReference],
                  })
                  .catch(() => fail("PhotoStorageUnavailable"))
              ).get(input.photo.imageReference);
              if (image === undefined || image.productReference !== product.productReference)
                fail("Invalid");
              const kept =
                current?.photo !== null &&
                current?.photo !== undefined &&
                String(current.photo.imageReference) === input.photo.imageReference
                  ? current.photo.localizedAltText
                  : {};
              photo = {
                imageReference: parseCatalogReference(input.photo.imageReference),
                localizedAltText: {
                  ...kept,
                  ...(Object.hasOwn(kept, product.draft.defaultLocale)
                    ? {}
                    : { [product.draft.defaultLocale]: input.photo.altText }),
                  [options.locale]: input.photo.altText,
                },
              };
            }
            // Nothing to record on a product that never had a description or photo.
            if (current === undefined && Object.keys(descriptions).length === 0 && photo === null)
              return undefined;
            return { localizedDescriptions: descriptions, photo };
          };
          try {
            if (body.action === "Create") {
              if (!(await taxClassOffered(body.taxClassificationReference)))
                fail("TaxClassUnavailable");
              if (body.sizes.length > 1 && !s.permissions.mayAddSize) fail("PermissionDenied");
              const dimension = derivedReference(body.operationReference, "size-dimension");
              const result = await service(body.operationReference).create({
                internalCode: body.internalCode,
                productType: body.productType,
                defaultLocale: options.locale,
                localizedNames: names(body.name),
                taxClassificationReference: body.taxClassificationReference,
                skus: body.sizes.map((size, index) => ({
                  skuCode: size.skuCode,
                  localizedNames: names(size.name),
                  variantSelections:
                    body.sizes.length === 1
                      ? []
                      : [
                          {
                            dimensionReference: dimension,
                            valueReference: derivedReference(
                              body.operationReference,
                              "size:" + index,
                            ),
                          },
                        ],
                  unitOfSale: "EACH",
                  unitQuantity: "1",
                })),
                operationReference: body.operationReference,
                requestedAt: await requestedAtFor(body.operationReference),
              });
              return {
                status: result.status,
                product: await view(tx, brand, result.aggregate),
              };
            }
            const product = await loadBrandProduct(
              reads(tx),
              { brandReference: brand },
              body.productReference,
            );
            if (product === null) return fail("NotFound");
            if (body.action === "SaveDraft") {
              const prior = await creation.resolveOperation(
                parseCatalogReference(body.operationReference),
              );
              if (prior !== null) {
                if (
                  prior.action !== "ReplaceDraft" ||
                  prior.aggregate.productReference !== product.productReference
                )
                  fail("Conflict");
                return {
                  status: "AlreadyApplied",
                  product: await view(tx, brand, prior.aggregate),
                };
              }
              if (product.aggregateVersion !== body.expectedAggregateVersion) fail("Conflict");
              if (
                body.taxClassificationReference !== product.draft.taxClassificationReference &&
                !(await taxClassOffered(body.taxClassificationReference))
              )
                fail("TaxClassUnavailable");
              const kept = new Set(
                body.sizes.flatMap((size) =>
                  size.skuReference === null ? [] : [size.skuReference],
                ),
              );
              for (const reference of kept)
                if (!product.draft.skus.some((sku) => sku.skuReference === reference))
                  fail("Invalid");
              // A size that has started selling stays: orders, prices and recipes refer to it.
              for (const sku of product.draft.skus)
                if (!kept.has(sku.skuReference) && sku.lifecycle !== "Draft") fail("SizeInUse");
              if (
                body.sizes.some((size) => size.skuReference === null) &&
                !s.permissions.mayAddSize
              )
                fail("PermissionDenied");
              const dimension =
                product.draft.skus.flatMap((sku) => sku.variantSelections)[0]?.dimensionReference ??
                derivedReference(body.operationReference, "size-dimension");
              const at = options.persistence.now();
              const skus = body.sizes.map((size, index) => {
                const existing = product.draft.skus.find(
                  (sku) => sku.skuReference === size.skuReference,
                );
                const existingSelection = existing?.variantSelections ?? [];
                const selection =
                  body.sizes.length === 1 || existingSelection.length > 0
                    ? existingSelection
                    : [
                        {
                          dimensionReference: dimension,
                          valueReference: derivedReference(
                            body.operationReference,
                            "size:" + index,
                          ),
                        },
                      ];
                if (existing !== undefined) {
                  if (existing.skuCode !== size.skuCode) fail("Invalid");
                  return {
                    ...existing,
                    localizedNames: { ...existing.localizedNames, ...names(size.name) },
                    variantSelections: selection,
                  };
                }
                return {
                  skuReference: derivedReference(body.operationReference, "sku:" + index),
                  productReference: product.productReference,
                  brandReference: product.brandReference,
                  skuCode: size.skuCode,
                  lifecycle: "Draft" as const,
                  localizedNames: { [product.draft.defaultLocale]: size.name, ...names(size.name) },
                  variantSelections: selection,
                  unitOfSale: "EACH",
                  unitQuantity: "1",
                  createdAt: at,
                  createdByActorReference: parseCatalogReference(s.actor),
                };
              });
              const optionBindings =
                body.optionSets === undefined
                  ? product.draft.optionBindings
                  : await bindingsFor(product, body.optionSets, body.operationReference);
              const customerPresentation =
                body.presentation === undefined
                  ? product.draft.customerPresentation
                  : await presentationFor(product, body.presentation);
              const result = await service(body.operationReference).replaceDraft({
                productReference: product.productReference,
                expectedAggregateVersion: body.expectedAggregateVersion,
                operationReference: body.operationReference,
                requestedAt: at,
                draft: {
                  ...product.draft,
                  localizedNames: { ...product.draft.localizedNames, ...names(body.name) },
                  taxClassificationReference: body.taxClassificationReference,
                  skus,
                  optionBindings,
                  ...(customerPresentation === undefined ? {} : { customerPresentation }),
                  updatedAt: at,
                },
              });
              return {
                status: result.status,
                product: await view(tx, brand, result.aggregate),
              };
            }
            // StartSelling: the Product, then each size not yet selling, one recorded step each. A retry
            // after a partial or complete earlier attempt continues from the current state.
            let latest = product;
            const stepOperation = (sku: string | null) =>
              derivedReference(body.operationReference, "start:" + (sku ?? "product"));
            if (latest.aggregateVersion !== body.expectedAggregateVersion) {
              let started = false;
              for (const sku of [null, ...latest.draft.skus.map((item) => item.skuReference)])
                if (
                  (await creation.resolveOperation(parseCatalogReference(stepOperation(sku)))) !==
                  null
                )
                  started = true;
              if (!started) fail("Conflict");
            }
            const steps: readonly (string | null)[] = [
              ...(latest.lifecycle === "Draft" ? [null] : []),
              ...latest.draft.skus
                .filter((sku) => sku.lifecycle === "Draft")
                .map((sku) => sku.skuReference),
            ];
            if (steps.length === 0 && latest.lifecycle !== "Active") fail("Lifecycle");
            for (const sku of steps) {
              const operation = stepOperation(sku);
              const result = await service(operation).changeLifecycle({
                productReference: latest.productReference,
                skuReference: sku,
                targetLifecycle: "Active",
                expectedAggregateVersion: latest.aggregateVersion,
                operationReference: operation,
                requestedAt: options.persistence.now(),
              });
              latest = result.aggregate;
            }
            return { status: "Applied", product: await view(tx, brand, latest) };
          } catch (error) {
            if (error instanceof CatalogError) return fail(catalogErrors[error.code] ?? "Invalid");
            throw error;
          }
        }),
      ),
    );
  };
  const photoErrors: Partial<Record<MediaProductImageError["code"], MerchantProductError["code"]>> =
    {
      MEDIA_IMAGE_TYPE_UNSUPPORTED: "PhotoTypeUnsupported",
      MEDIA_IMAGE_TOO_LARGE: "PhotoTooLarge",
      MEDIA_IMAGE_TOO_SMALL: "PhotoTooSmall",
      MEDIA_IMAGE_UNREADABLE: "PhotoUnreadable",
      MEDIA_IMAGE_STORAGE_UNAVAILABLE: "PhotoStorageUnavailable",
    };
  /**
   * Record one product photo: Media checks the bytes are the declared JPEG/PNG/WebP, removes the
   * embedded metadata (camera, location) and stores the sizes customers are served. The photo is
   * attached to the product draft by a later SaveDraft. A retry with the same operation returns the
   * same image.
   */
  const uploadPhoto = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    productReference: unknown;
    operationReference: unknown;
    contentType: unknown;
    bytes: unknown;
  }) => {
    const productReference = ref(input.productReference);
    const operationReference = ref(input.operationReference);
    if (!(productPhotoContentTypes as readonly unknown[]).includes(input.contentType))
      return fail("PhotoTypeUnsupported");
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1) return fail("Invalid");
    if (input.bytes.byteLength > productPhotoBytesMaximum) return fail("PhotoTooLarge");
    const bytes = input.bytes;
    const images = options.images ?? fail("PhotoStorageUnavailable");
    const current = await session(input);
    const mediaFailure = (error: unknown): never => {
      if (error instanceof MediaProductImageError)
        return fail(photoErrors[error.code] ?? "Invalid");
      throw error;
    };
    /** The editor may change this Brand product (checked before and again when recording). */
    const editable = async (tx: Tx) => {
      const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
      if (!s.permissions.mayEdit) fail("PermissionDenied");
      const product = await loadBrandProduct(
        reads(tx),
        { brandReference: s.brand },
        productReference,
      );
      if (product === null) return fail("NotFound");
      return { s, product };
    };
    await retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, () => editable(tx)),
      ),
    );
    // Decoding and resizing run outside any database transaction.
    const prepared = await images
      .prepare({ declaredContentType: input.contentType as string, bytes })
      .catch(mediaFailure);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const { s, product } = await editable(tx);
          const image = await images
            .record(mediaTx(tx), {
              imageReference: derivedReference(operationReference, "product-photo"),
              tenantReference: String(s.scope.tenantReference),
              brandReference: s.brand,
              productReference: product.productReference,
              actorReference: s.actor,
              createdAt: options.persistence.now(),
              prepared,
            })
            .catch(mediaFailure);
          const preview = image.renditions.find(
            (rendition) => rendition.width === 640 && rendition.contentType === "image/jpeg",
          );
          if (image.productReference !== product.productReference || preview === undefined)
            return fail("Invalid");
          return {
            status: "Recorded" as const,
            photo: {
              imageReference: image.imageReference,
              width: image.width,
              height: image.height,
              previewUrl: preview.path,
            },
          };
        }),
      ),
    );
  };
  return { query, command, uploadPhoto };
}
