import {
  merchantBrandSoleOperatorGate,
  MerchantSingleStoreListingError,
  MerchantSoleOperatorGateError,
} from "./merchant-sole-operator.js";
import { createHash } from "node:crypto";
import { loadOutboxEnvelope, type ConsumerTransaction } from "@bop/eventing";
import {
  CatalogError,
  createCategoryMenuService,
  createPostgresMenuDraftSource,
  createPostgresMenuDraftStore,
  createPostgresMenuReviewContentStore,
  createPostgresPublishedMenuConsumerService,
  currentAllergenRegistry,
  availabilityPermission,
  listBrandMenus,
  listBrandOptionSets,
  listBrandSkuChoices,
  listCurrentIngredientDeclarations,
  listStoreAvailabilityRules,
  parseCatalogHash,
  parseCatalogReference,
  type MenuAggregate,
  type ProductLifecycleTransaction,
  type PublishedSellablePresentation,
  type ReviewedMenuContent,
} from "@rms/catalog";
import {
  createPostgresPriceBookRepository,
  currentStorePriceBook,
  listBrandPriceBooks,
  type CurrencyMetadataSnapshot,
} from "@rms/pricing";
import { listInventoryRecipeIngredientFacts } from "@rms/inventory";
import {
  listRecipes,
  listStaffDeclaredAllergenSources,
  type RecipeAuthoringTransaction,
} from "@rms/recipe";
import { MenuReviewGapError, type MenuReviewGap } from "./menu-recipe-allergen-source.js";
import { withRememberedBrandAuthorization } from "./merchant-brand-transaction-authorization.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { createMerchantMenuPublicationCommand } from "./merchant-menu-publication-command.js";
import {
  menuItemsWithoutTax,
  menuOptionsWithoutRecipes,
  unpricedMenuOptions,
} from "./menu-option-gates.js";
import { itemAvailability } from "./merchant-availability.js";
import { localBoundary } from "./merchant-prices.js";
import { derivedReference } from "./merchant-products.js";
import { sizeRecipeSource } from "./merchant-dish-allergens.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { chineseOf, optionalChinese, withChinese } from "./merchant-chinese-text.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";

/**
 * WP-2423 / DEC-MENU-REVISION: CAT-MENU-LIST / CAT-MENU-BUILDER for the selected Store's Brand. The current
 * Menu version is edited (catalog.menu.update) until it is submitted for review (catalog.menu.submit,
 * which also prepares the allergen-checked review content); someone else approves it
 * (catalog.menu.approve, Publishing approval) and it is published (catalog.menu.publish), effective at
 * once in the Store's time zone. Publishing updates the customer menu projection in the same flow.
 * A submitted or published version is frozen: changes start a revision (catalog.menu.update).
 * An unsubmitted draft of a published Menu can be discarded (catalog.menu.update): the Menu returns to
 * its latest release and the draft stays as history.
 */
export class MerchantMenuError extends Error {
  constructor(
    readonly code:
      | "PermissionDenied"
      | "NotFound"
      | "Conflict"
      | "Frozen"
      | "NotRevisable"
      /** WP-2423: only an unsubmitted draft of a Menu that has been published can be discarded. */
      | "NotDiscardable"
      | "ReviewBlocked"
      | "OptionPriceMissing"
      | "TaxNotCovered"
      | "OptionRecipeMissing"
      | "ApprovalRequired"
      | "Lifecycle"
      | "Invalid"
      /** WP-2423 Q19: the submitter asked to approve alone, but sole operator is not in effect. */
      | "SoleOperatorNotInEffect"
      /** WP-2423 Q19: approving alone needs a second-factor check in the last 15 minutes. */
      | "NeedsReverification"
      /** WP-2423 item 8 ⑥: "List it" without review needs a Brand with exactly one store. */
      | "NotSingleStore",
    /** WP-2423 (v15 2026-10-22): for ReviewBlocked, what the review found missing, named. */
    readonly problem: MenuReviewProblem | null = null,
  ) {
    super(code);
    this.name = "MerchantMenuError";
  }
}
/** A menu review gap in staff terms: names only, never references or internal codes. */
export interface MenuReviewProblem {
  readonly missing: MenuReviewGap["missing"];
  readonly productName: string | null;
  readonly sizeName: string | null;
  readonly optionName: string | null;
  readonly quantity: number | null;
  readonly ingredientName: string | null;
}
const fail = (code: MerchantMenuError["code"]): never => {
  throw new MerchantMenuError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const ref = (value: unknown): string =>
  typeof value === "string" && uuid.test(value) ? value : fail("Invalid");
const version = (value: unknown): number =>
  Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : fail("Invalid");
const digestOf = (value: unknown): string =>
  typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value) ? value : fail("Invalid");
const text = (value: unknown, max: number): string => {
  if (typeof value !== "string") return fail("Invalid");
  const trimmed = value.trim().replace(/\s+/gu, " ");
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : fail("Invalid");
};
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;

export interface MenuSectionInput {
  readonly sectionReference: string | null;
  readonly code: string;
  readonly name: string;
  /** Owner 2026-10-23: the section's Simplified Chinese name ("" clears it; absent keeps it). */
  readonly nameZh?: string;
  readonly items: readonly { readonly skuReference: string; readonly featured: boolean }[];
}
export type MenuCommandBody =
  | {
      readonly action: "SaveDraft";
      readonly operationReference: string;
      readonly menuReference: string;
      readonly expectedAggregateVersion: number;
      readonly name: string;
      readonly sections: readonly MenuSectionInput[];
    }
  | {
      readonly action: "Revise";
      readonly operationReference: string;
      readonly menuReference: string;
      readonly expectedAggregateVersion: number;
    }
  | {
      /** WP-2423: discard the open draft; the menu goes back to its latest release. */
      readonly action: "DiscardDraft";
      readonly operationReference: string;
      readonly menuReference: string;
      readonly expectedAggregateVersion: number;
    }
  | {
      readonly action: "Submit";
      readonly operationReference: string;
      readonly menuReference: string;
    }
  | {
      readonly action: "Approve" | "Publish";
      readonly operationReference: string;
      readonly menuReference: string;
      readonly menuVersionReference: string;
      readonly expectedVersion: number;
      readonly snapshotDigest: string;
      /** WP-2423 Q19: the submitter approves alone as sole operator (Approve only).
       * WP-2423 item 8 ⑥: SingleStoreListing — the submitter lists it at a single store. */
      readonly approvalMode?: "SoleOperator" | "SingleStoreListing";
    }
  | {
      /**
       * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU: "List it" — submit, approve as a single-store
       * listing and publish, from wherever the menu is now (a retry goes on from there).
       */
      readonly action: "List";
      readonly operationReference: string;
      readonly menuReference: string;
    }
  | {
      readonly action: "Rebuild";
      readonly operationReference: string;
      readonly menuReference: string;
      readonly publishOperationReference: string;
    };
export function parseMenuCommandBody(value: unknown): MenuCommandBody {
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return fail("Invalid");
  const keys = Object.keys(r).sort().join(",");
  if (
    r.action === "SaveDraft" &&
    keys === "action,expectedAggregateVersion,menuReference,name,operationReference,sections"
  ) {
    if (!Array.isArray(r.sections) || r.sections.length < 1 || r.sections.length > 40)
      return fail("Invalid");
    const sections = r.sections.map((candidate: unknown) => {
      const s = candidate as Record<string, unknown> | null;
      if (
        s === null ||
        typeof s !== "object" ||
        Object.keys(s)
          .filter((key) => key !== "nameZh")
          .sort()
          .join(",") !== "code,items,name,sectionReference" ||
        !Array.isArray(s.items) ||
        s.items.length > 200
      )
        return fail("Invalid");
      const sectionCode = typeof s.code === "string" ? s.code.trim().toUpperCase() : "";
      if (!code.test(sectionCode)) return fail("Invalid");
      const items = s.items.map((item: unknown) => {
        const i = item as Record<string, unknown> | null;
        if (
          i === null ||
          typeof i !== "object" ||
          Object.keys(i).sort().join(",") !== "featured,skuReference" ||
          typeof i.featured !== "boolean"
        )
          return fail("Invalid");
        return { skuReference: ref(i.skuReference), featured: i.featured };
      });
      if (new Set(items.map((item) => item.skuReference)).size !== items.length)
        return fail("Invalid");
      const nameZh = optionalChinese(s.nameZh, 80, () => fail("Invalid"));
      return {
        sectionReference: s.sectionReference === null ? null : ref(s.sectionReference),
        code: sectionCode,
        name: text(s.name, 80),
        ...(nameZh === undefined ? {} : { nameZh }),
        items,
      };
    });
    if (
      new Set(sections.map((s) => s.code)).size !== sections.length ||
      new Set(sections.map((s) => s.name.toLowerCase())).size !== sections.length
    )
      return fail("Invalid");
    return {
      action: "SaveDraft",
      operationReference: ref(r.operationReference),
      menuReference: ref(r.menuReference),
      expectedAggregateVersion: version(r.expectedAggregateVersion),
      name: text(r.name, 120),
      sections,
    };
  }
  if (
    (r.action === "Revise" || r.action === "DiscardDraft") &&
    keys === "action,expectedAggregateVersion,menuReference,operationReference"
  )
    return {
      action: r.action,
      operationReference: ref(r.operationReference),
      menuReference: ref(r.menuReference),
      expectedAggregateVersion: version(r.expectedAggregateVersion),
    };
  if (r.action === "List" && keys === "action,menuReference,operationReference")
    return {
      action: "List",
      operationReference: ref(r.operationReference),
      menuReference: ref(r.menuReference),
    };
  if (r.action === "Submit" && keys === "action,menuReference,operationReference")
    return {
      action: "Submit",
      operationReference: ref(r.operationReference),
      menuReference: ref(r.menuReference),
    };
  if (
    (r.action === "Approve" || r.action === "Publish") &&
    keys ===
      "action,expectedVersion,menuReference,menuVersionReference,operationReference,snapshotDigest"
  )
    return {
      action: r.action,
      operationReference: ref(r.operationReference),
      menuReference: ref(r.menuReference),
      menuVersionReference: ref(r.menuVersionReference),
      expectedVersion: version(r.expectedVersion),
      snapshotDigest: digestOf(r.snapshotDigest),
    };
  if (
    r.action === "Approve" &&
    (r.approvalMode === "SoleOperator" || r.approvalMode === "SingleStoreListing") &&
    keys ===
      "action,approvalMode,expectedVersion,menuReference,menuVersionReference,operationReference,snapshotDigest"
  )
    return {
      action: "Approve",
      operationReference: ref(r.operationReference),
      menuReference: ref(r.menuReference),
      menuVersionReference: ref(r.menuVersionReference),
      expectedVersion: version(r.expectedVersion),
      snapshotDigest: digestOf(r.snapshotDigest),
      approvalMode: r.approvalMode,
    };
  if (
    r.action === "Rebuild" &&
    keys === "action,menuReference,operationReference,publishOperationReference"
  )
    return {
      action: "Rebuild",
      operationReference: ref(r.operationReference),
      menuReference: ref(r.menuReference),
      publishOperationReference: ref(r.publishOperationReference),
    };
  return fail("Invalid");
}

const catalogErrors: Partial<Record<CatalogError["code"], MerchantMenuError["code"]>> = {
  CATALOG_PERMISSION_DENIED: "PermissionDenied",
  CATALOG_VERSION_CONFLICT: "Conflict",
  CATALOG_IDEMPOTENCY_CONFLICT: "Conflict",
  CATALOG_LIFECYCLE_CONFLICT: "Lifecycle",
  CATALOG_INPUT_INVALID: "Invalid",
  CATALOG_UNAVAILABLE: "NotFound",
  CATALOG_CODE_CONFLICT: "Invalid",
  CATALOG_INDEPENDENT_APPROVAL_REQUIRED: "ApprovalRequired",
};

/**
 * WP-2423 (v15 run of cb3f6f2a): what customers will see for each item of a frozen review snapshot
 * (description and photo, exactly as reviewed), and what changed against the snapshot customers
 * see now. Built only from Catalog's frozen review content; nothing is re-read from live drafts.
 */
export type CustomerViewDescriptionChange = "Added" | "Changed" | "Removed";
export type CustomerViewPhotoChange = "Added" | "Replaced" | "Removed" | "DescriptionChanged";
export interface CustomerViewPhoto {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly altText: string;
}
export interface CustomerViewItem {
  readonly placementReference: string;
  readonly skuReference: string;
  readonly sectionName: string;
  readonly name: string;
  readonly description: string | null;
  readonly photo: CustomerViewPhoto | null;
  /** Null when there is no published menu to compare with. */
  readonly newOnMenu: boolean | null;
  readonly descriptionChange: CustomerViewDescriptionChange | null;
  readonly photoChange: CustomerViewPhotoChange | null;
  /** What customers see now, for a changed or removed description or photo. */
  readonly before: {
    readonly description: string | null;
    readonly photo: CustomerViewPhoto | null;
  } | null;
}
export interface MenuCustomerView {
  readonly frozenAt: string;
  /** When the menu customers see now was published; null when nothing is published to compare. */
  readonly comparedWithPublishedAt: string | null;
  readonly items: readonly CustomerViewItem[];
  readonly removedFromMenu: readonly { readonly skuReference: string; readonly name: string }[];
}
export function menuCustomerView(input: {
  readonly locale: string;
  readonly current: { readonly content: ReviewedMenuContent; readonly createdAt: string };
  readonly published: {
    readonly content: ReviewedMenuContent;
    readonly publishedAt: string;
  } | null;
}): MenuCustomerView {
  const pick = (values: Readonly<Record<string, string>>, defaultLocale: string) =>
    values[input.locale] ?? values[defaultLocale] ?? Object.values(values)[0] ?? null;
  const look = (presentation: PublishedSellablePresentation | undefined, defaultLocale: string) => {
    const description =
      presentation === undefined ? null : pick(presentation.localizedDescriptions, defaultLocale);
    const photo = presentation?.photo ?? null;
    const thumbnail = photo?.renditions.find(
      (rendition) => rendition.width === 320 && rendition.contentType === "image/jpeg",
    );
    return {
      description: description === null || description.trim() === "" ? null : description,
      photo:
        photo === null || thumbnail === undefined
          ? null
          : {
              url: thumbnail.path,
              width: thumbnail.width,
              height: thumbnail.height,
              altText: pick(photo.localizedAltText, defaultLocale) ?? "",
            },
      imageReference: photo === null ? null : String(photo.imageReference),
    };
  };
  const published = new Map<
    string,
    { readonly name: string; readonly look: ReturnType<typeof look> }
  >();
  if (input.published !== null) {
    const locale = input.published.content.defaultLocale;
    for (const section of input.published.content.sections)
      for (const item of section.sellables)
        if (item.presentationRole !== "Hidden" && !published.has(String(item.sellableReference)))
          published.set(String(item.sellableReference), {
            name: pick(item.localizedNames, locale) ?? "",
            look: look(item.presentation, locale),
          });
  }
  const locale = input.current.content.defaultLocale;
  const onMenu = new Set<string>();
  const sections = [...input.current.content.sections].sort((a, b) => a.sortOrder - b.sortOrder);
  const items = sections.flatMap((section) =>
    [...section.sellables]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .filter((item) => item.presentationRole !== "Hidden")
      .map((item): CustomerViewItem => {
        const sku = String(item.sellableReference);
        onMenu.add(sku);
        const now = look(item.presentation, locale);
        const was = input.published === null ? undefined : published.get(sku);
        const descriptionChange: CustomerViewDescriptionChange | null =
          was === undefined || was.look.description === now.description
            ? null
            : was.look.description === null
              ? "Added"
              : now.description === null
                ? "Removed"
                : "Changed";
        const photoChange: CustomerViewPhotoChange | null =
          was === undefined
            ? null
            : was.look.photo === null
              ? now.photo === null
                ? null
                : "Added"
              : now.photo === null
                ? "Removed"
                : was.look.imageReference !== now.imageReference
                  ? "Replaced"
                  : was.look.photo.altText !== now.photo.altText
                    ? "DescriptionChanged"
                    : null;
        return {
          placementReference: String(item.placementReference),
          skuReference: sku,
          sectionName: pick(section.localizedNames, locale) ?? "",
          name: pick(item.localizedNames, locale) ?? "",
          description: now.description,
          photo: now.photo,
          newOnMenu: input.published === null ? null : was === undefined,
          descriptionChange,
          photoChange,
          before:
            was === undefined || (descriptionChange === null && photoChange === null)
              ? null
              : {
                  description: descriptionChange === null ? null : was.look.description,
                  photo: photoChange === null ? null : was.look.photo,
                },
        };
      }),
  );
  return {
    frozenAt: input.current.createdAt,
    comparedWithPublishedAt: input.published?.publishedAt ?? null,
    items,
    removedFromMenu: [...published.entries()]
      .filter(([sku]) => !onMenu.has(sku))
      .map(([skuReference, value]) => ({ skuReference, name: value.name })),
  };
}

/**
 * WP-2423 item 8 ⑥: where "List it" goes on from — the menu's current version is already the
 * latest release (Listed), is being edited (Submit), is in review (Approve), is approved (Publish),
 * or is somewhere listing cannot go on from (Stuck: e.g. archived without a release of it).
 */
export function nextMenuListingStep(summary: {
  readonly currentVersionReference: string;
  readonly publication: { readonly state: string } | null;
  readonly latestRelease: { readonly menuVersionReference: string } | null;
}): "Listed" | "Submit" | "Approve" | "Publish" | "Stuck" {
  const state = summary.publication?.state ?? null;
  if (
    (state === null || state === "Published" || state === "Archived") &&
    summary.latestRelease !== null &&
    summary.latestRelease.menuVersionReference === summary.currentVersionReference
  )
    return "Listed";
  if (state === null) return "Submit";
  if (state === "InReview") return "Approve";
  if (state === "Approved") return "Publish";
  return "Stuck";
}

export function createMerchantMenus(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  references: { next(): string };
  currencyMetadata: CurrencyMetadataSnapshot;
  locale: string;
  /** Test seam: the Brand scope resolver (defaults to the current session's Brand scope). */
  resolveScope?: ReturnType<typeof createMerchantBrandScope>;
}) {
  const resolveScope = options.resolveScope ?? createMerchantBrandScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const ptx = (tx: unknown) => tx as ProductLifecycleTransaction;
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
      mayRead: await may("catalog.menu.read"),
      mayEdit: await may("catalog.menu.update"),
      maySubmit: await may("catalog.menu.submit"),
      mayApprove: await may("catalog.menu.approve"),
      mayPublish: await may("catalog.menu.publish"),
    };
    if (!permissions.mayRead) fail("PermissionDenied");
    return {
      scope,
      decision,
      owner: {
        tenantReference: String(scope.tenantReference),
        brandReference: String(scope.context.brand.brandReference),
        storeReference: String(scope.selectedStoreReference),
      },
      timeZone: scope.selectedStoreTimeZone,
      actor: String(scope.actorReference),
      permissions,
    };
  }
  type Scope = Awaited<ReturnType<typeof scopeFor>>;
  const brandScope = (tx: unknown, brand: string) =>
    ptx(tx).query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      brand,
    ]);
  const draft = async (tx: unknown, s: Scope, menu: string) =>
    createPostgresMenuDraftSource({
      brandReference: s.owner.brandReference,
      transactions: { run: (work) => work(ptx(tx)) },
      authorize: async () => true,
    }).load(menu, () => options.persistence.now());
  const name = (names: Readonly<Record<string, string>>, fallback: string) =>
    names[options.locale] ?? Object.values(names)[0] ?? fallback;
  /** Selling sizes with product names and this Store's current price (cents) when it has one. */
  const sellables = async (tx: unknown, s: Scope) => {
    const skus = await listBrandSkuChoices(ptx(tx) as never, s.owner);
    const assignment = await currentStorePriceBook(ptx(tx) as never, s.owner);
    const bookPrices = async (priceBookReference: string) => {
      const found = new Map<string, string>();
      const book = await createPostgresPriceBookRepository({
        brandReference: s.owner.brandReference,
        currencyMetadata: options.currencyMetadata,
        transactions: { run: (work) => work(ptx(tx) as never) },
        authorize: async (_tx, input) => !input.write,
        appendEvent: async () => {
          throw new Error("MENU_READ_ONLY");
        },
      }).load(priceBookReference as never);
      for (const entry of book?.entries ?? [])
        if (entry.scopeKind === "Brand" && entry.channelCode === null && entry.orderType === null)
          found.set(entry.sellableReference, entry.amount.amountMinor.toString());
      return found;
    };
    const prices =
      assignment === null
        ? new Map<string, string>()
        : await bookPrices(assignment.priceBookReference);
    // WP-2423 item 8 ⑥: prices waiting in the open price book draft (listed with the menu).
    const draft = (await listBrandPriceBooks(ptx(tx) as never, s.owner))
      .filter((book) => book.lifecycle === "Draft")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const waiting =
      draft === undefined ? new Map<string, string>() : await bookPrices(draft.priceBookReference);
    // WP-2423 (v15 2026-10-16): customers at this Store see a menu item only where it is offered
    // here (Item availability). Sold out still counts as offered: it comes back by itself.
    const rules = await listStoreAvailabilityRules(ptx(tx), s.owner);
    const at = options.persistence.now();
    await brandScope(tx, s.owner.brandReference);
    return skus.map((sku) => {
      const status = itemAvailability(rules, s.owner, sku.skuReference, at).status;
      return {
        skuReference: sku.skuReference,
        skuCode: sku.skuCode,
        // WP-2423 item 8 ⑥: the dish (product) the size belongs to, for its editor.
        productReference: sku.productReference,
        productName: name(sku.productLocalizedNames, ""),
        // WP-2423 item 8 ⑥: the dish's Chinese name ("" when none), for the one-page menu.
        productNameZh: chineseOf(sku.productLocalizedNames),
        sizeName: name(sku.localizedNames, sku.skuCode),
        active: sku.active,
        priceMinor: prices.get(sku.skuReference) ?? null,
        // A different price waiting to be listed (null: none).
        pendingPriceMinor:
          waiting.has(sku.skuReference) &&
          waiting.get(sku.skuReference) !== prices.get(sku.skuReference)
            ? (waiting.get(sku.skuReference) ?? null)
            : null,
        offeredHere: status !== "NotOffered" && status !== "Unavailable",
      };
    });
  };
  /**
   * WP-2423 item 8 ⑥: where each size's allergens come from — declared by staff in this page (the
   * generated recipe, with what was declared), a real recipe, or nothing yet — the allergen list
   * staff choose from, and whether the Brand keeps stock (then generated recipes should be
   * replaced by real ones; the page asks, it never mixes the two).
   */
  const dishAllergens = async (tx: unknown, s: Scope) => {
    const rtx = tx as unknown as RecipeAuthoringTransaction;
    const scope = {
      brandReference: s.owner.brandReference,
      storeReference: s.owner.storeReference,
    };
    const at = options.persistence.now();
    const registry = await currentAllergenRegistry(ptx(tx) as never, s.owner);
    const sources = await listStaffDeclaredAllergenSources(rtx, scope);
    const declarations = new Map(
      (await listCurrentIngredientDeclarations(ptx(tx) as never, s.owner, at))
        .filter((d) => d.registryVersionReference === registry?.registryVersionReference)
        .map((d) => [d.itemReference, d]),
    );
    const recipes = await listRecipes(rtx, scope, at);
    const items = await listInventoryRecipeIngredientFacts(ptx(tx) as never, s.owner);
    const generatedItems = new Set(sources.map((x) => x.itemReference));
    const bySku = new Map<
      string,
      {
        readonly source: "StaffDeclared" | "Recipe" | "None";
        readonly declared: readonly { allergenReference: string; classification: string }[];
      }
    >();
    const skus = new Set([
      ...recipes.flatMap((recipe) => recipe.bindings.map((binding) => binding.skuReference)),
      ...sources.flatMap((source) => (source.skuReference === null ? [] : [source.skuReference])),
    ]);
    for (const sku of skus) {
      const kind = sizeRecipeSource(recipes, sources, sku);
      const item = sources.find((x) => x.subject === "Dish" && x.skuReference === sku);
      if (kind !== "None")
        bySku.set(sku, {
          source: kind,
          declared:
            kind === "StaffDeclared" && item !== undefined
              ? (declarations.get(item.itemReference)?.allergens ?? []).map((a) => ({
                  allergenReference: a.allergenReference,
                  classification: a.classification,
                }))
              : [],
        });
    }
    await brandScope(tx, s.owner.brandReference);
    return {
      bySku,
      choices: (registry?.entries ?? []).map((entry) => ({
        allergenReference: entry.allergenReference,
        name: name(entry.localizedNames, entry.code),
        nameZh: chineseOf(entry.localizedNames),
      })),
      keepsStock: items.some(
        (item) => item.active && item.stockTracked && !generatedItems.has(item.itemReference),
      ),
    };
  };
  /** Names a review gap for staff in a fresh read (the failed review's transaction is gone). */
  const describeGap = (
    sessionCookie: unknown,
    sessionReference: string,
    gap: MenuReviewGap,
  ): Promise<MenuReviewProblem> =>
    options.persistence.transactions.run((tx) =>
      withRememberedBrandAuthorization(tx, async () => {
        const s = await scopeFor(tx, sessionCookie, sessionReference);
        const sku = (await listBrandSkuChoices(ptx(tx) as never, s.owner)).find(
          (item) => item.skuReference === gap.skuReference,
        );
        const option =
          gap.optionReference === null
            ? undefined
            : (await listBrandOptionSets(ptx(tx), s.owner))
                .flatMap((set) => set.draft.options)
                .find((item) => String(item.optionReference) === gap.optionReference);
        const ingredient =
          gap.ingredientReference === null
            ? undefined
            : (await listInventoryRecipeIngredientFacts(ptx(tx) as never, s.owner)).find(
                (item) => item.itemReference === gap.ingredientReference,
              );
        await brandScope(tx, s.owner.brandReference);
        return {
          missing: gap.missing,
          productName: sku ? name(sku.productLocalizedNames, sku.skuCode) : null,
          sizeName: sku ? name(sku.localizedNames, sku.skuCode) : null,
          optionName: option ? name(option.localizedNames, "") || null : null,
          quantity: gap.quantity,
          ingredientName: ingredient
            ? name(ingredient.localizedNames, ingredient.internalCode)
            : null,
        };
      }),
    );
  const unpricedOptions = async (tx: unknown, s: Scope, aggregate: MenuAggregate) => {
    const missing = await unpricedMenuOptions(ptx(tx) as never, {
      owner: s.owner,
      currencyMetadata: options.currencyMetadata,
      observedAt: options.persistence.now(),
      menu: aggregate.draft,
    });
    await brandScope(tx, s.owner.brandReference);
    return missing;
  };
  const menuView = (aggregate: MenuAggregate) => ({
    menuReference: aggregate.menuReference,
    internalCode: aggregate.internalCode,
    aggregateVersion: aggregate.aggregateVersion,
    versionReference: aggregate.draft.versionReference,
    name: name(aggregate.draft.localizedNames, aggregate.internalCode),
    storeReferences: aggregate.draft.storeReferences,
    channelCodes: aggregate.draft.channelCodes,
    orderTypeCodes: aggregate.draft.orderTypeCodes,
    sections: [...aggregate.draft.sections]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((section) => ({
        sectionReference: section.sectionReference,
        code: section.internalCode,
        name: name(section.localizedNames, section.internalCode),
        nameZh: chineseOf(section.localizedNames),
        items: [...section.placements]
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((placement) => ({
            placementReference: placement.placementReference,
            skuReference: placement.sellableReference,
            featured: placement.presentationRole === "Featured",
          })),
      })),
  });

  /**
   * WP-2423: for a version frozen for review (in review, approved or published), what customers will
   * see per item from its review snapshot, compared with the release customers see now when that is
   * another version. Read through Catalog's review content store (Brand scope, read-only).
   */
  const customerViewOf = async (
    tx: unknown,
    s: Scope,
    summary: Awaited<ReturnType<typeof listBrandMenus>>[number],
  ): Promise<MenuCustomerView | null> => {
    const publication = summary.publication;
    if (publication === null || publication.state === "Archived") return null;
    const store = createPostgresMenuReviewContentStore({
      brandReference: s.owner.brandReference,
      menuReference: summary.menuReference,
      authorize: async () => true,
    });
    const at = options.persistence.now();
    const current = await store.read(
      ptx(tx),
      summary.currentVersionReference,
      publication.snapshotDigest,
      at,
    );
    if (current === null) return null;
    const release = summary.latestRelease;
    const released =
      release === null || release.menuVersionReference === summary.currentVersionReference
        ? null
        : await store.read(ptx(tx), release.menuVersionReference, release.snapshotDigest, at);
    return menuCustomerView({
      locale: options.locale,
      current: { content: current.content, createdAt: current.createdAt },
      published:
        released === null || release === null
          ? null
          : { content: released.content, publishedAt: release.createdAt },
    });
  };

  const query = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    menuReference: string | null;
  }) => {
    const current = await session(input);
    return retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
          const menus = await listBrandMenus(ptx(tx) as never, s.owner);
          const base = {
            sourceAsOf: options.persistence.now(),
            viewer: s.actor,
            permissions: s.permissions,
            menus,
          };
          if (input.menuReference === null) return { screenId: "CAT-MENU-LIST" as const, ...base };
          const summary = menus.find((menu) => menu.menuReference === input.menuReference);
          if (summary === undefined) return fail("NotFound");
          const loaded = await draft(tx, s, input.menuReference);
          if (loaded === null) return fail("NotFound");
          const submitter =
            summary.publication === null
              ? null
              : ((
                  await ptx(tx).query(
                    "SELECT actor_reference::text actor FROM platform_audit.audit_record WHERE brand_id=$1 AND action_code='CATALOG_MENU_SUBMITREVIEW' AND target_id=$2 ORDER BY occurred_at DESC LIMIT 1",
                    [s.owner.brandReference, summary.currentVersionReference],
                  )
                ).rows[0]?.actor ?? null);
          // WP-2423 Q19: the submitter who may approve sees whether they may approve alone and why.
          const gate =
            submitter === s.actor && s.permissions.mayApprove
              ? await merchantBrandSoleOperatorGate(tx as never, {
                  tenantReference: s.owner.tenantReference,
                  brandReference: s.owner.brandReference,
                  storeReference: s.owner.storeReference,
                  actorReference: s.actor,
                  permissionCode: "catalog.menu.approve",
                  observedAt: options.persistence.now(),
                  allowed: async () =>
                    (await s.decision("catalog.menu.approve"))?.effect === "Allow",
                })
              : null;
          // Whether the viewer may offer items at this Store (Item availability) from here.
          const mayOfferHere = (await s.decision(availabilityPermission))?.effect === "Allow";
          const customerView = await customerViewOf(tx, s, summary);
          await brandScope(tx, s.owner.brandReference);
          return {
            screenId: "CAT-MENU-BUILDER" as const,
            ...base,
            menu: menuView(loaded.aggregate),
            publication: summary.publication,
            latestRelease: summary.latestRelease,
            // WP-2423 item 8 ⑥ (v15 2026-10-28 finding a): where "List it" would go on from, as
            // the server decides it — "Listed" when guests already see this version.
            listingStep: nextMenuListingStep(summary),
            submittedBy: typeof submitter === "string" ? submitter : null,
            soleOperator:
              gate === null
                ? null
                : {
                    status: gate.status,
                    otherApprovers: gate.otherApprovers,
                    verifiedUntil: gate.verifiedUntil,
                  },
            ...(await (async () => {
              const allergens = await dishAllergens(tx, s);
              return {
                sellables: (await sellables(tx, s)).map((sku) => ({
                  ...sku,
                  allergens: allergens.bySku.get(sku.skuReference) ?? {
                    source: "None" as const,
                    declared: [],
                  },
                })),
                allergenChoices: allergens.choices,
                keepsStock: allergens.keepsStock,
              };
            })()),
            mayOfferHere,
            customerView,
            allergenRegistry: (await currentAllergenRegistry(ptx(tx) as never, s.owner)) !== null,
          };
        }),
      ),
    );
  };

  const publication = createMerchantMenuPublicationCommand({
    merchant: options.persistence,
    authentication: options.authentication,
    reviewCreation: {
      budget: { maximumConfigurations: 10000, maximumSearchSteps: 1000000 },
      reference: (purpose, operation) => derivedReference(operation, "review:" + purpose),
    },
    reviewApproval: {
      reference: (purpose, operation) => derivedReference(operation, "approval:" + purpose),
      validUntil: (input) => input.validationValidUntil,
    },
    binding: async (tx, input) => {
      const row = (
        await tx.query<{ digest: string }>(
          "SELECT snapshot_digest digest FROM rms_catalog.menu_review_content WHERE brand_id=$1 AND menu_id=$2 AND menu_version_id=$3 ORDER BY snapshot_digest LIMIT 2",
          [input.brandReference, input.menuReference, input.menuVersionReference],
        )
      ).rows;
      if (row.length !== 1 || !row[0]) return null;
      const record = await createPostgresMenuReviewContentStore({
        brandReference: input.brandReference,
        menuReference: input.menuReference,
        authorize: async () => true,
      }).read(tx, input.menuVersionReference, row[0].digest, options.persistence.now());
      return record === null
        ? null
        : {
            lifecycleReference: record.lifecycleReference,
            snapshotDigest: record.snapshotDigest,
            configurationDigest: record.configurationDigest,
          };
    },
    reference: (purpose, operation) => derivedReference(operation, "publication:" + purpose),
    ...(options.resolveScope === undefined ? {} : { resolveScope: options.resolveScope }),
  });

  /** Projects a publication's MenuPublished event into the customer menu (idempotent). */
  const project = async (
    sessionCookie: unknown,
    sessionReference: string,
    publishOperation: string,
  ) =>
    retryTransactionConflict(() =>
      options.persistence.transactions.run((tx) =>
        withRememberedBrandAuthorization(tx, async () => {
          const s = await scopeFor(tx, sessionCookie, sessionReference);
          if (!s.permissions.mayPublish) fail("PermissionDenied");
          await brandScope(tx, s.owner.brandReference);
          const envelope = await loadOutboxEnvelope(
            tx as unknown as ConsumerTransaction,
            derivedReference(publishOperation, "publication:Event"),
          );
          if (envelope === null) return fail("NotFound");
          const result = await createPostgresPublishedMenuConsumerService({
            brandReference: s.owner.brandReference,
            authorize: async () => true,
            generateGeneration: () => derivedReference(publishOperation, "projection"),
            now: () => options.persistence.now(),
          }).consume(tx as unknown as ConsumerTransaction, envelope);
          return result;
        }),
      ),
    );

  /**
   * WP-2423 item 8 ⑥ DEC-SINGLE-STORE-MENU: "List it" at a single store. Each step is the
   * ordinary command (its own transaction and checks), with an operation reference derived from
   * the listing's, so a retry after a lost answer goes on from the step the menu is at and never
   * repeats one. Needs submit, approve and publish permission; the approval is the submitter's own
   * as a single-store listing (refused unless the Brand has exactly one store).
   */
  const list = async (
    input: { sessionCookie: unknown; csrf: unknown },
    body: { readonly operationReference: string; readonly menuReference: string },
    sessionReference: string,
  ) => {
    const step = (action: string) => derivedReference(body.operationReference, "list:" + action);
    let changed = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const summary = await retryTransactionConflict(() =>
        options.persistence.transactions.run((tx) =>
          withRememberedBrandAuthorization(tx, async () => {
            const s = await scopeFor(tx, input.sessionCookie, sessionReference);
            if (!s.permissions.maySubmit || !s.permissions.mayApprove || !s.permissions.mayPublish)
              fail("PermissionDenied");
            return (await listBrandMenus(ptx(tx) as never, s.owner)).find(
              (candidate) => candidate.menuReference === body.menuReference,
            );
          }),
        ),
      );
      if (summary === undefined) return fail("NotFound");
      const publication = summary.publication;
      const next = nextMenuListingStep(summary);
      if (next === "Listed")
        return { status: changed ? "Listed" : "AlreadyListed", menuReference: body.menuReference };
      const facts = {
        menuReference: body.menuReference,
        menuVersionReference: String(summary.currentVersionReference),
        expectedVersion: publication?.lifecycleVersion ?? 0,
        snapshotDigest: String(publication?.snapshotDigest ?? ""),
      };
      if (next === "Submit")
        await command({
          ...input,
          body: {
            action: "Submit",
            operationReference: step("submit"),
            menuReference: body.menuReference,
          },
        });
      else if (next === "Approve")
        await command({
          ...input,
          body: {
            action: "Approve",
            operationReference: step("approve"),
            ...facts,
            approvalMode: "SingleStoreListing",
          },
        });
      else if (next === "Publish")
        await command({
          ...input,
          body: { action: "Publish", operationReference: step("publish"), ...facts },
        });
      else return fail("Lifecycle");
      changed = true;
    }
    return fail("Lifecycle");
  };

  const command = async (input: {
    sessionCookie: unknown;
    csrf: unknown;
    body: unknown;
  }): Promise<unknown> => {
    const body = parseMenuCommandBody(input.body);
    const current = await session(input);
    if (body.action === "List") return list(input, body, current.sessionReference);
    try {
      if (body.action === "Submit" || body.action === "Approve" || body.action === "Publish") {
        // Facts the publication command needs that the client does not supply.
        const prepared = await retryTransactionConflict(() =>
          options.persistence.transactions.run((tx) =>
            withRememberedBrandAuthorization(tx, async () => {
              const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
              const allowed =
                body.action === "Submit"
                  ? s.permissions.maySubmit
                  : body.action === "Approve"
                    ? s.permissions.mayApprove
                    : s.permissions.mayPublish;
              if (!allowed) fail("PermissionDenied");
              if (body.action !== "Submit") return { s, loaded: null, registry: null };
              const loaded = await draft(tx, s, body.menuReference);
              const registry = await currentAllergenRegistry(ptx(tx) as never, s.owner);
              if (loaded === null) return fail("NotFound");
              if (registry === null) return fail("ReviewBlocked");
              if (
                (
                  await menuItemsWithoutTax(ptx(tx) as never, {
                    owner: s.owner,
                    observedAt: options.persistence.now(),
                    menu: loaded.aggregate.draft,
                  })
                ).length > 0
              )
                fail("TaxNotCovered");
              await brandScope(tx, s.owner.brandReference);
              if ((await unpricedOptions(tx, s, loaded.aggregate)).length > 0)
                fail("OptionPriceMissing");
              if (
                (
                  await menuOptionsWithoutRecipes(ptx(tx) as never, {
                    owner: s.owner,
                    observedAt: options.persistence.now(),
                    menu: loaded.aggregate.draft,
                  })
                ).length > 0
              )
                fail("OptionRecipeMissing");
              await brandScope(tx, s.owner.brandReference);
              return { s, loaded, registry };
            }),
          ),
        );
        const { loaded, registry } = prepared;
        const commandBody =
          body.action === "Submit"
            ? loaded === null || registry === null
              ? fail("ReviewBlocked")
              : {
                  action: "CreateReview",
                  operationReference: body.operationReference,
                  menuReference: body.menuReference,
                  menuVersionReference: loaded.aggregate.draft.versionReference,
                  configurationDigest: loaded.configurationDigest,
                  registryVersionReference: registry.registryVersionReference,
                  expectedVersion: 1,
                }
            : {
                action: body.action,
                operationReference: body.operationReference,
                menuReference: body.menuReference,
                menuVersionReference: body.menuVersionReference,
                expectedVersion: body.expectedVersion,
                snapshotDigest: body.snapshotDigest,
                effectivePeriod:
                  body.action === "Publish"
                    ? {
                        timeZone: prepared.s.timeZone,
                        effectiveFrom: localBoundary(
                          options.persistence.now(),
                          prepared.s.timeZone,
                        ),
                        effectiveUntil: null,
                      }
                    : null,
              };
        const result = await publication({
          sessionCookie: input.sessionCookie,
          csrf: input.csrf,
          command: commandBody,
          ...(body.action === "Approve" && body.approvalMode !== undefined
            ? { approvalMode: body.approvalMode }
            : {}),
        });
        if (body.action === "Publish")
          return {
            ...result,
            projection: await project(
              input.sessionCookie,
              current.sessionReference,
              body.operationReference,
            ),
          };
        return result;
      }
      if (body.action === "Rebuild")
        return {
          projection: await project(
            input.sessionCookie,
            current.sessionReference,
            body.publishOperationReference,
          ),
        };
      if (body.action !== "SaveDraft" && body.action !== "Revise" && body.action !== "DiscardDraft")
        return fail("Invalid");
      const edit = body;
      return await retryTransactionConflict(() =>
        options.persistence.transactions.run((tx) =>
          withRememberedBrandAuthorization(tx, async () => {
            const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
            if (!s.permissions.mayEdit) fail("PermissionDenied");
            const at = options.persistence.now();
            const brand = s.owner.brandReference;
            const menus = createPostgresMenuDraftStore({
              brandReference: brand,
              transactions: { run: (work) => work(ptx(tx)) },
              now: () => options.persistence.now(),
              authorize: async () => true,
            });
            // A retried operation returns its recorded result.
            const recorded = await menus.resolveOperation(
              parseCatalogReference(edit.operationReference),
            );
            if (recorded !== null) {
              if (recorded.aggregate.menuReference !== edit.menuReference) fail("Conflict");
              return { status: "AlreadyApplied", menu: menuView(recorded.aggregate) };
            }
            const service = createCategoryMenuService({
              menus,
              categories: {} as never,
              facts: {
                validateStores: async (value) =>
                  value.storeReferences.every((store) => store === s.owner.storeReference),
                validateCategories: async (value) => value.categoryReferences.length === 0,
                validateSellables: async (value) => {
                  const active = new Set(
                    (await listBrandSkuChoices(ptx(tx) as never, s.owner))
                      .filter((sku) => sku.active)
                      .map((sku) => sku.skuReference),
                  );
                  return value.sellableReferences.every((sku) => active.has(sku));
                },
              },
              references: {
                generate: () => options.references.next(),
                hashIntent: (value) =>
                  parseCatalogHash(createHash("sha256").update(value).digest("hex")),
                equals: (a, b) => a === b,
              },
              authorization: {
                authorize: async (request) => {
                  const permission = await s.decision("catalog.menu.manage");
                  if (permission?.effect !== "Allow") return null;
                  await brandScope(tx, brand);
                  return {
                    tenantContext: s.scope.context,
                    permission,
                    audit: {
                      auditId: derivedReference(edit.operationReference, "audit"),
                      brandId: brand,
                      actor: { type: "User", reference: s.actor },
                      actionCode: "CATALOG_MENU_" + request.action.toUpperCase(),
                      targetType: "CatalogMenu",
                      targetId: request.aggregateReference,
                      correlationId: edit.operationReference,
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
            if (edit.action === "DiscardDraft") {
              // Only an open (unsubmitted) draft of a Menu that has a release; otherwise there is
              // nothing to go back to, or the version is in review (withdraw it first).
              const summary = (await listBrandMenus(ptx(tx) as never, s.owner)).find(
                (candidate) => candidate.menuReference === edit.menuReference,
              );
              if (summary === undefined) return fail("NotFound");
              if (summary.aggregateVersion !== edit.expectedAggregateVersion) fail("Conflict");
              if (
                summary.publication !== null ||
                summary.latestRelease === null ||
                summary.latestRelease.menuVersionReference === summary.currentVersionReference
              )
                fail("NotDiscardable");
              await brandScope(tx, brand);
              const result = await service.discardMenuDraft({
                menuReference: edit.menuReference,
                expectedAggregateVersion: edit.expectedAggregateVersion,
                operationReference: edit.operationReference,
                requestedAt: at,
              });
              return { status: result.status, menu: menuView(result.aggregate) };
            }
            if (edit.action === "Revise") {
              const result = await service.reviseMenu({
                menuReference: edit.menuReference,
                expectedAggregateVersion: edit.expectedAggregateVersion,
                operationReference: edit.operationReference,
                requestedAt: at,
              });
              return { status: result.status, menu: menuView(result.aggregate) };
            }
            // Read under the Menu's writer lock (taken by the Menu store, after the operation lock
            // above), so two saves of the same Menu serialize: the second reads the first's result
            // and is answered as a conflict.
            const currentMenu = await menus.load(parseCatalogReference(edit.menuReference));
            if (currentMenu === null) return fail("NotFound");
            if (currentMenu.aggregateVersion !== edit.expectedAggregateVersion) fail("Conflict");
            const locale = currentMenu.draft.defaultLocale;
            const sections = edit.sections.map((input, sortOrder) => {
              const existing =
                input.sectionReference === null
                  ? undefined
                  : currentMenu.draft.sections.find(
                      (section) => section.sectionReference === input.sectionReference,
                    );
              if (input.sectionReference !== null && existing === undefined) fail("Invalid");
              if (existing !== undefined && existing.internalCode !== input.code) fail("Invalid");
              const sectionReference =
                existing?.sectionReference ??
                parseCatalogReference(
                  derivedReference(edit.operationReference, "section:" + input.code),
                );
              return {
                sectionReference,
                menuReference: currentMenu.menuReference,
                brandReference: currentMenu.brandReference,
                internalCode: input.code,
                localizedNames: withChinese(
                  { ...(existing?.localizedNames ?? {}), [locale]: input.name },
                  input.nameZh,
                ),
                sortOrder,
                categoryReferences: existing?.categoryReferences ?? [],
                placements: input.items.map((item, itemOrder) => {
                  const role = item.featured ? "Featured" : "Standard";
                  const kept = existing?.placements.find(
                    (p) => p.sellableReference === item.skuReference && p.presentationRole === role,
                  );
                  return {
                    placementReference:
                      kept?.placementReference ??
                      parseCatalogReference(
                        derivedReference(
                          edit.operationReference,
                          "placement:" + input.code + ":" + item.skuReference + ":" + role,
                        ),
                      ),
                    menuReference: currentMenu.menuReference,
                    sectionReference,
                    brandReference: currentMenu.brandReference,
                    sellableReference: item.skuReference,
                    sellableType: "Sku" as const,
                    presentationRole: role,
                    sortOrder: itemOrder,
                    pinned: kept?.pinned ?? false,
                    localizedNameOverrides: kept?.localizedNameOverrides ?? {},
                    createdAt: kept?.createdAt ?? at,
                    createdByActorReference: kept?.createdByActorReference ?? s.actor,
                  };
                }),
              };
            });
            const stores = [
              ...new Set([...currentMenu.draft.storeReferences, s.owner.storeReference]),
            ];
            const result = await service.replaceMenuDraft({
              menuReference: currentMenu.menuReference,
              expectedAggregateVersion: currentMenu.aggregateVersion,
              operationReference: edit.operationReference,
              requestedAt: at,
              draft: {
                ...currentMenu.draft,
                localizedNames: { ...currentMenu.draft.localizedNames, [locale]: edit.name },
                storeReferences: stores,
                sections,
                updatedAt: at,
              },
            });
            return { status: result.status, menu: menuView(result.aggregate) };
          }),
        ),
      );
    } catch (error) {
      if (error instanceof MerchantMenuError) throw error;
      if (error instanceof MenuReviewGapError)
        throw new MerchantMenuError(
          "ReviewBlocked",
          await describeGap(input.sessionCookie, current.sessionReference, error.gap).catch(
            () => null,
          ),
        );
      if (error instanceof MerchantSingleStoreListingError)
        return fail(error.code === "NotSingleStore" ? "NotSingleStore" : "PermissionDenied");
      if (error instanceof MerchantSoleOperatorGateError)
        return fail(
          error.code === "NotInEffect" ? "SoleOperatorNotInEffect" : "NeedsReverification",
        );
      if (error instanceof CatalogError) {
        if (error.code === "CATALOG_LIFECYCLE_CONFLICT" && body.action === "SaveDraft")
          return fail("Frozen");
        if (error.code === "CATALOG_LIFECYCLE_CONFLICT" && body.action === "Revise")
          return fail("NotRevisable");
        if (error.code === "CATALOG_LIFECYCLE_CONFLICT" && body.action === "DiscardDraft")
          return fail("NotDiscardable");
        if (error.code === "CATALOG_DEPENDENCY_UNAVAILABLE" && body.action === "Submit")
          return fail("ReviewBlocked");
        if (error.code === "CATALOG_PERMISSION_DENIED" && body.action === "Approve")
          return fail("ApprovalRequired");
        return fail(catalogErrors[error.code] ?? "Invalid");
      }
      throw error;
    }
  };
  return { query, command };
}
