import { createPostgresMerchantOrganizationSource, listBrandStoreReferences } from "@bop/tenant";
import {
  brandOwnerAuthority,
  merchantBrandApprovalHolders,
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
  listAllergenRegistryEntryReferences,
  listCurrentIngredientDeclarations,
  listSellableAllergenChangesSince,
  listStoreAvailabilityRules,
  parseCatalogHash,
  parseCatalogReference,
  optionBindingDefaultRules,
  productOptionBindingRule,
  rebuiltProductOptionBinding,
  type MenuAggregate,
  type OptionSetAggregate,
  type ProductOptionBinding,
  type ProductLifecycleTransaction,
  type PublishedSellablePresentation,
  type ReviewedMenuContent,
} from "@rms/catalog";
import {
  createPostgresPriceBookRepository,
  currentStorePriceBook,
  listBrandPriceBooks,
  listPriceBookDraftPurposes,
  type CurrencyMetadataSnapshot,
} from "@rms/pricing";
import { listInventoryRecipeIngredientFacts } from "@rms/inventory";
import {
  listRecipes,
  listStaffDeclaredAllergenSources,
  type RecipeAuthoringTransaction,
} from "@rms/recipe";
import {
  MenuReviewGapError,
  MenuReviewStoppedError,
  type MenuReviewGap,
} from "./menu-recipe-allergen-source.js";
import { withRememberedBrandAuthorization } from "./merchant-brand-transaction-authorization.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { createMerchantMenuPublicationCommand } from "./merchant-menu-publication-command.js";
import { menuListingGaps, unpricedMenuOptions, type MenuListingGap } from "./menu-option-gates.js";
import { menuReviewBudget, menuReviewBudgetExceededAt } from "./menu-review-preparation-source.js";
import { itemAvailability } from "./merchant-availability.js";
import { localBoundary } from "./merchant-prices.js";
import { derivedReference } from "./merchant-products.js";
import { sizeRecipeSource } from "./merchant-dish-allergens.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import { chineseOf, optionalChinese, withChinese } from "./merchant-chinese-text.js";
import {
  brandPriceDigest,
  storeBook,
  storePricePermission,
  storePrices,
} from "./merchant-store-prices.js";
import { retryTransactionConflict } from "./transaction-conflict-retry.js";
import { onlyRefusal } from "./merchant-failure.js";

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
      /** WP-2423 item 11: a Store's kitchen would not receive this menu's orders. */
      | "KitchenNotReady"
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
    /** WP-2423 item 14: why a review stopped when staff can do nothing about it, for the log only
     * (the code as raised and the failure behind it); it never reaches the page. */
    readonly stoppedBy: { readonly reason: string; readonly cause: unknown } | null = null,
  ) {
    super(code);
    this.name = "MerchantMenuError";
  }
}
/** A menu review gap in staff terms: names only, never references or internal codes. */
export interface MenuReviewProblem {
  /** "Stopped": nothing was named missing; `reason` says why it stopped, from a closed list
   * (WP-2423 item 14; v15 2026-10-29). "Tax": an item is not taxed at one of the menu's Stores
   * (listing gates, 2026-10-31).
   * "TooManyChoices": the item has more choice combinations than one review checks (WP-2423). */
  readonly missing:
    MenuReviewGap["missing"] | "Stopped" | "Tax" | "Kitchen" | "KitchenDish" | "TooManyChoices";
  /** WP-2423 item 11: the Store whose kitchen setup fixes it. */
  readonly storeReference?: string;
  readonly reason?: string;
  readonly productName: string | null;
  readonly sizeName: string | null;
  readonly optionName: string | null;
  readonly quantity: number | null;
  readonly ingredientName: string | null;
  /** The Store the gap is at, for a listing gate at a menu served at several Stores. */
  readonly storeName?: string | null;
}
const fail = (code: MerchantMenuError["code"]): never => {
  throw new MerchantMenuError(code);
};
/**
 * WP-2423 item 14: why a listing review stopped, as the page may name it: the causes staff can act
 * on, in their own words there. Anything else is "Unexpected": staff are told to try again, and the
 * code as raised goes to the log with the failure behind it (v15 2026-10-29 sent it to the page).
 */
const namedStopReasons: ReadonlySet<string> = new Set([
  "NoAllergenList",
  "AllergenListChanged",
  "AllergenEvidenceDiffers",
  "NoAllergenEvidence",
  "NoDraft",
  "NotAuthorized",
  "NoConfiguration",
  // A dish's choice group no longer fits it, and saving the dish fixes it (an option archived):
  // the Owner fixes it on the dish. Trying again never would.
  "ChoiceGroup",
  // WP-2423 (v15 2026-11-05): a dish's choice group has no default guests can start with that
  // is still offered: only Option sets can fix it (offer it again, or let another be the default).
  "ChoiceGroupDefault",
]);
export function menuStopReason(reason: string): string {
  const last = reason.split(":").at(-1) ?? "";
  return namedStopReasons.has(last) ? last : "Unexpected";
}
const stoppedError = (
  reason: string,
  cause: unknown,
  at: {
    readonly productName: string | null;
    readonly sizeName: string | null;
    /** For a choice group: the group's staff name. */
    readonly optionName?: string | null;
  } = {
    productName: null,
    sizeName: null,
  },
) => {
  const named = menuStopReason(reason);
  return new MerchantMenuError(
    "ReviewBlocked",
    {
      missing: "Stopped",
      reason: named,
      productName: at.productName,
      sizeName: at.sizeName,
      optionName: at.optionName ?? null,
      quantity: null,
      ingredientName: null,
    },
    named === "Unexpected" ? { reason: reason.slice(0, 120), cause } : null,
  );
};
const stopped = (reason: string, cause?: unknown): never => {
  throw stoppedError(reason, cause);
};
/**
 * WP-2423 (v15 2026-11-05): where a stored binding that breaks its option set is fixed. The
 * binding is rebuilt as Save dish rebuilds it, against the set's current version (the version Save
 * dish reads, never the one the binding is pinned to), without options archived since. If that
 * still leaves no offered default, only Option sets can fix it ("ChoiceGroupDefault"); otherwise
 * opening the dish, checking its choices and saving it does ("ChoiceGroup").
 */
export function choiceGroupReason(
  binding: ProductOptionBinding | null,
  current: OptionSetAggregate | undefined,
): "ChoiceGroup" | "ChoiceGroupDefault" {
  if (binding === null || current === undefined) return "ChoiceGroup";
  const usable = binding.enabledOptionReferences.filter((reference) =>
    current.draft.options.some(
      (option) => option.optionReference === reference && option.lifecycle !== "Archived",
    ),
  );
  const rebuilt = rebuiltProductOptionBinding(
    {
      ...binding,
      enabledOptionReferences: usable,
      minimumSelectionOverride: null,
      maximumSelectionOverride: null,
    },
    current,
  );
  const rule = productOptionBindingRule(rebuilt, current);
  return rule !== null && optionBindingDefaultRules.has(rule)
    ? "ChoiceGroupDefault"
    : "ChoiceGroup";
}
/** A dish whose choice group broke a rule, in staff names, and where it is fixed. */
export interface ChoiceGroupAt {
  readonly productName: string | null;
  readonly sizeName: string | null;
  readonly optionName: string | null;
  readonly reason: "ChoiceGroup" | "ChoiceGroupDefault";
}
/**
 * The page's answer to a Catalog refusal of a menu command. "Submit" and "Check" (List it's
 * listing check) name a dish's choice group that breaks a rule, and say a review that could not
 * read something stopped (logged, "try again"); they never answer "Invalid", whose text is about
 * section names.
 */
export function menuCatalogError(
  error: CatalogError,
  action: MenuCommandBody["action"],
  choiceGroup: ChoiceGroupAt | null,
): MerchantMenuError {
  const reviewing = action === "Submit" || action === "Check";
  if (error.code === "CATALOG_LIFECYCLE_CONFLICT" && action === "SaveDraft")
    return new MerchantMenuError("Frozen");
  if (error.code === "CATALOG_LIFECYCLE_CONFLICT" && action === "Revise")
    return new MerchantMenuError("NotRevisable");
  if (error.code === "CATALOG_LIFECYCLE_CONFLICT" && action === "DiscardDraft")
    return new MerchantMenuError("NotDiscardable");
  // WP-2423 item 14: a product's choice group binding names the rule it breaks, and the item:
  // the dish and its group are named, and the Owner told where it is fixed.
  if (
    error.code === "CATALOG_DEPENDENCY_UNAVAILABLE" &&
    reviewing &&
    typeof (error as { rule?: unknown }).rule === "string"
  )
    return stoppedError(choiceGroup?.reason ?? "ChoiceGroup", error, {
      productName: choiceGroup?.productName ?? null,
      sizeName: choiceGroup?.sizeName ?? null,
      optionName: choiceGroup?.optionName ?? null,
    });
  // v15 2026-10-29: the review stopped on something it could not read; say where.
  if (error.code === "CATALOG_DEPENDENCY_UNAVAILABLE" && reviewing)
    return stoppedError(action + ":Unavailable@" + throwSite(error), error);
  if (error.code === "CATALOG_PERMISSION_DENIED" && action === "Approve")
    return new MerchantMenuError("ApprovalRequired");
  if (error.code === "CATALOG_PERMISSION_DENIED") return new MerchantMenuError("PermissionDenied");
  // A listing check refused for any other reason is not the menu's sections: it stopped.
  if (action === "Check")
    return stoppedError("Check:" + error.code + "@" + throwSite(error), error);
  return new MerchantMenuError(catalogErrors[error.code] ?? "Invalid");
}
/** Where an error was raised: the first source file and line past its `fail` helper. */
export function throwSite(error: unknown): string {
  const frames = (error instanceof Error ? (error.stack ?? "") : "").split("\n").slice(1);
  for (const frame of frames) {
    if (/\bat (fail|invalid|unavailable|dependency)\b/u.test(frame)) continue;
    const match = /([A-Za-z0-9_.-]+\.(?:ts|js|mjs)):(\d+):\d+\)?\s*$/u.exec(frame);
    if (match) return match[1] + ":" + match[2];
  }
  return "unknown";
}
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
      /**
       * WP-2423 item 8 ⑥ part 4 (v15 2026-10-29 finding c): would the menu's listing be refused
       * for what the menu itself lacks (tax, choice recipes, the allergen list)? Checked by
       * "List it" before it publishes any price, so prices never go live with a menu that can't.
       * Choice prices are not checked here: "List it" publishes them first.
       */
      readonly action: "Check";
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
  if (r.action === "Check" && keys === "action,menuReference")
    return { action: "Check", menuReference: ref(r.menuReference) };
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
  /** WP-2423 item 14: a listing review stopped for a reason staff can't act on: log it. */
  onUnexpectedStop?: (reason: string, cause: unknown) => void;
}) {
  const resolveScope = options.resolveScope ?? createMerchantBrandScope(options.persistence);
  type Tx = Parameters<Parameters<typeof options.persistence.transactions.run>[0]>[0];
  const ptx = (tx: unknown) => tx as ProductLifecycleTransaction;
  const session = (input: { sessionCookie: unknown; csrf: unknown }) =>
    options.authentication
      .authorize({ sessionCookie: input.sessionCookie, csrf: input.csrf })
      .catch(onlyRefusal(() => fail("PermissionDenied")));
  async function scopeFor(tx: Tx, sessionCookie: unknown, sessionReference: string) {
    const scope = await resolveScope(tx, sessionCookie, sessionReference).catch(
      onlyRefusal(() => fail("PermissionDenied")),
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
    const loadBook = (priceBookReference: string) =>
      createPostgresPriceBookRepository({
        brandReference: s.owner.brandReference,
        currencyMetadata: options.currencyMetadata,
        transactions: { run: (work) => work(ptx(tx) as never) },
        authorize: async (_tx, input) => !input.write,
        appendEvent: async () => {
          throw new Error("MENU_READ_ONLY");
        },
      }).load(priceBookReference as never);
    // DEC-BRAND-MULTI-STORE segment 9 / WP-2423 M70: the Brand price and this Store's own price,
    // where it has one (what the Store charges is its own, else the Brand's).
    const current = storePrices(
      assignment === null ? null : await loadBook(assignment.priceBookReference),
      s.owner.storeReference,
    );
    // WP-2423 item 8 ⑥ / M71: Brand prices waiting in the menu's own price draft (listed with the
    // menu); a price change started on the Prices page is not this page's.
    const books = await listBrandPriceBooks(ptx(tx) as never, s.owner);
    const purposes = await listPriceBookDraftPurposes(ptx(tx) as never, s.owner);
    const open = new Set(
      books.filter((book) => book.lifecycle === "Draft").map((book) => book.priceBookReference),
    );
    const draftPurpose = purposes.find(
      (p) => p.purpose === "MenuListing" && open.has(p.priceBookReference),
    );
    const draftBook =
      draftPurpose === undefined ? null : await loadBook(draftPurpose.priceBookReference);
    const waiting = storePrices(draftBook, s.owner.storeReference).brand;
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
        // What this Store charges now.
        priceMinor: current.charged(sku.skuReference),
        // WP-2423 M70: the Brand price and this Store's own price (null: it charges the Brand's).
        brandPriceMinor: current.brand.get(sku.skuReference) ?? null,
        storePriceMinor: current.own.get(sku.skuReference) ?? null,
        // A different Brand price waiting to be listed (null: none).
        pendingBrandPriceMinor:
          waiting.has(sku.skuReference) &&
          waiting.get(sku.skuReference) !== current.brand.get(sku.skuReference)
            ? (waiting.get(sku.skuReference) ?? null)
            : null,
        // What this Store will charge once listed, when it differs (its own price stays its own).
        pendingPriceMinor:
          waiting.has(sku.skuReference) &&
          !current.own.has(sku.skuReference) &&
          waiting.get(sku.skuReference) !== current.charged(sku.skuReference)
            ? (waiting.get(sku.skuReference) ?? null)
            : null,
        offeredHere: status !== "NotOffered" && status !== "Unavailable",
      };
    });
  };
  /**
   * WP-2423 M71: what "List it" will publish of prices — the menu's own price draft, the version
   * the review confirms, each price from → to, whether it was started by someone else, and whether
   * another price change went live since it was started — and how many price changes started on
   * the Prices page stay there (never listed from here).
   */
  const priceListing = async (tx: unknown, s: Scope) => {
    // WP-2423 M70: where this person may change a dish's price from the menu page.
    const stores = await listBrandStoreReferences(ptx(tx) as never, s.owner);
    const severalStores = stores.length > 1 && stores.includes(s.owner.storeReference);
    const mayManage = (await s.decision("pricing.price-book.manage"))?.effect === "Allow";
    const mayThisStore =
      severalStores &&
      ((await s.scope.authorizeStoreAction(storePricePermission))?.effect === "Allow" ||
        (await s.decision(storePricePermission))?.effect === "Allow");
    const mayAllStores =
      mayManage &&
      (!severalStores ||
        (
          await merchantBrandApprovalHolders(tx as never, {
            brandReference: s.owner.brandReference,
            permissionCode: brandOwnerAuthority,
            observedAt: options.persistence.now(),
          })
        ).includes(s.actor));
    await brandScope(tx, s.owner.brandReference);
    const pricePowers = { severalStores, mayAllStores, mayThisStore };
    const books = await listBrandPriceBooks(ptx(tx) as never, s.owner);
    const purposes = await listPriceBookDraftPurposes(ptx(tx) as never, s.owner);
    const open = new Map(
      books.filter((book) => book.lifecycle === "Draft").map((b) => [b.priceBookReference, b]),
    );
    const own = purposes.filter((p) => open.has(p.priceBookReference));
    const menuDraft = own.find((p) => p.purpose === "MenuListing");
    const otherChanges = own.filter((p) => p.purpose === "PriceChange").length;
    if (menuDraft === undefined) {
      await brandScope(tx, s.owner.brandReference);
      return { pricePowers, priceDraft: null, priceChangesOnPricesPage: otherChanges };
    }
    const summary = open.get(menuDraft.priceBookReference);
    const live = await storeBook(ptx(tx) as never, s.owner, options.currencyMetadata);
    const draftBook = await createPostgresPriceBookRepository({
      brandReference: s.owner.brandReference,
      currencyMetadata: options.currencyMetadata,
      transactions: { run: (work) => work(ptx(tx) as never) },
      authorize: async (_tx, input) => !input.write,
      appendEvent: async () => {
        throw new Error("MENU_READ_ONLY");
      },
    }).load(menuDraft.priceBookReference as never);
    await brandScope(tx, s.owner.brandReference);
    const from = storePrices(live?.snapshot ?? null, s.owner.storeReference).brand;
    const to = storePrices(draftBook, s.owner.storeReference).brand;
    const liveDigest = brandPriceDigest(live?.snapshot ?? null);
    return {
      pricePowers,
      priceDraft: {
        priceBookReference: menuDraft.priceBookReference,
        aggregateVersion: summary?.aggregateVersion ?? 0,
        startedByViewer: menuDraft.actorReference === s.actor,
        movedSinceStart:
          menuDraft.sourceBrandDigest !== null &&
          live !== null &&
          liveDigest !== menuDraft.sourceBrandDigest &&
          liveDigest !== brandPriceDigest(draftBook),
        prices: [...to]
          .filter(([sku, amount]) => from.get(sku) !== amount)
          .map(([skuReference, toMinor]) => ({
            skuReference,
            fromMinor: from.get(skuReference) ?? null,
            toMinor,
          })),
      },
      priceChangesOnPricesPage: otherChanges,
    };
  };
  /**
   * WP-2423 item 8 ⑥: where each size's allergens come from — declared by staff in this page (the
   * generated recipe, with what was declared), a real recipe, or nothing yet — the allergen list
   * staff choose from, and whether the Brand keeps stock (then generated recipes should be
   * replaced by real ones; the page asks, it never mixes the two).
   */
  const dishAllergens = async (
    tx: unknown,
    s: Scope,
    /** WP-2423 (M77, M167): the menu version guests see now (null: not listed yet). */
    listedVersion: string | null = null,
  ) => {
    const rtx = tx as unknown as RecipeAuthoringTransaction;
    const scope = {
      brandReference: s.owner.brandReference,
      storeReference: s.owner.storeReference,
    };
    const at = options.persistence.now();
    const registry = await currentAllergenRegistry(ptx(tx) as never, s.owner);
    const sources = await listStaffDeclaredAllergenSources(rtx, scope);
    // WP-2423 (M76): each item's latest declaration, whichever list it answered. An allergen added
    // to the list since was never answered for the dish, so it is sent as unanswered, never as No.
    const declarations = new Map(
      (await listCurrentIngredientDeclarations(ptx(tx) as never, s.owner, at)).map((d) => [
        d.itemReference,
        d,
      ]),
    );
    const current = new Set((registry?.entries ?? []).map((entry) => entry.allergenReference));
    const answeredOn = await listAllergenRegistryEntryReferences(
      ptx(tx) as never,
      s.owner,
      [...declarations.values()]
        .map((d) => d.registryVersionReference)
        .filter((version) => version !== registry?.registryVersionReference),
    );
    const unansweredFor = (itemReference: string | undefined): readonly string[] => {
      const declaration = itemReference === undefined ? undefined : declarations.get(itemReference);
      if (declaration === undefined) return [...current];
      if (declaration.registryVersionReference === registry?.registryVersionReference) return [];
      const answered = answeredOn.get(declaration.registryVersionReference) ?? new Set<string>();
      return [...current].filter((allergen) => !answered.has(allergen));
    };
    const recipes = await listRecipes(rtx, scope, at);
    const items = await listInventoryRecipeIngredientFacts(ptx(tx) as never, s.owner);
    const generatedItems = new Set(sources.map((x) => x.itemReference));
    const bySku = new Map<
      string,
      {
        readonly source: "StaffDeclared" | "Recipe" | "None";
        readonly declared: readonly { allergenReference: string; classification: string }[];
        /** WP-2423 item 8 ⑥ part 4: the item holding the staff declaration (a combo choice adds it). */
        readonly itemReference: string | null;
        /** WP-2423 item 8 ⑦: declared to use no stock ingredients (a charge such as tea). */
        readonly noIngredients: boolean;
        /**
         * WP-2423 (M76): allergens on the current list the staff declaration never answered (added
         * to the list since, or the declaration ran out); staff answer them before it is declared.
         */
        readonly unanswered: readonly string[];
        /**
         * WP-2423 (M77, M167): a recipe bound or ended since the menu was listed changed what the
         * dish contains; guests and the kitchen already read it with the listed allergens, and
         * listing the menu again makes it the reviewed list. Absent otherwise.
         */
        readonly changedByRecipe?: true;
      }
    >();
    const skus = new Set([
      ...recipes.flatMap((recipe) => recipe.bindings.map((binding) => binding.skuReference)),
      ...sources.flatMap((source) => (source.skuReference === null ? [] : [source.skuReference])),
    ]);
    const changed = new Set<string>();
    if (listedVersion !== null) {
      const all = [...skus];
      for (let at = 0; at < all.length; at += 200)
        for (const change of (
          await listSellableAllergenChangesSince(
            ptx(tx) as never,
            s.owner,
            all.slice(at, at + 200).map((skuReference) => ({
              menuVersionReference: listedVersion,
              skuReference,
            })),
          )
        ).values())
          changed.add(change.skuReference);
    }
    for (const sku of skus) {
      const kind = sizeRecipeSource(recipes, sources, sku, s.owner.storeReference);
      const item = sources.find((x) => x.subject === "Dish" && x.skuReference === sku);
      if (kind !== "None")
        bySku.set(sku, {
          source: kind,
          declared:
            kind === "StaffDeclared" && item !== undefined
              ? (declarations.get(item.itemReference)?.allergens ?? [])
                  .filter((a) => current.has(a.allergenReference))
                  .map((a) => ({
                    allergenReference: a.allergenReference,
                    classification: a.classification,
                  }))
              : [],
          itemReference: kind === "StaffDeclared" ? (item?.itemReference ?? null) : null,
          noIngredients: kind === "StaffDeclared" && item?.label === "NoIngredientsDeclaredByStaff",
          unanswered:
            kind === "StaffDeclared" && item?.label !== "NoIngredientsDeclaredByStaff"
              ? unansweredFor(item?.itemReference)
              : [],
          ...(changed.has(sku) ? { changedByRecipe: true as const } : {}),
        });
    }
    await brandScope(tx, s.owner.brandReference);
    // WP-2423 M69: sizes whose allergens come from a recipe bound at this Store (a Store's own
    // recipe answers them too, although the dish editor shows the Brand's).
    const recipeHere = new Set(
      recipes.flatMap((recipe) =>
        recipe.bindings
          .filter((b) => b.storeReference === s.owner.storeReference)
          .map((b) => b.skuReference),
      ),
    );
    return {
      bySku,
      recipeHere,
      choices: (registry?.entries ?? []).map((entry) => ({
        allergenReference: entry.allergenReference,
        // WP-2423 (M75): the registry code, so staff screens name it in the chosen language.
        code: entry.code,
        name: name(entry.localizedNames, entry.code),
        nameZh: chineseOf(entry.localizedNames),
      })),
      keepsStock: items.some(
        (item) => item.active && item.stockTracked && !generatedItems.has(item.itemReference),
      ),
    };
  };
  /** Names a review gap for staff in a fresh read (the failed review's transaction is gone). */
  /** A dish whose choice group breaks a rule: its names and the group's, and whether saving fixes it. */
  const describeChoiceGroup = (
    sessionCookie: unknown,
    sessionReference: string,
    skuReference: string | null,
    binding: ProductOptionBinding | null,
  ): Promise<ChoiceGroupAt> =>
    options.persistence.transactions.run((tx) =>
      withRememberedBrandAuthorization(tx, async () => {
        const s = await scopeFor(tx, sessionCookie, sessionReference);
        const sku =
          skuReference === null
            ? undefined
            : (await listBrandSkuChoices(ptx(tx) as never, s.owner)).find(
                (item) => item.skuReference === skuReference,
              );
        // The set's current version: the one Save dish rebuilds the binding against.
        const set =
          binding === null
            ? undefined
            : (await listBrandOptionSets(ptx(tx), s.owner)).find(
                (item) => item.optionSetReference === binding.optionSetReference,
              );
        await brandScope(tx, s.owner.brandReference);
        return {
          productName: sku ? name(sku.productLocalizedNames, sku.skuCode) : null,
          sizeName: sku ? name(sku.localizedNames, sku.skuCode) : null,
          optionName: set ? name(set.draft.localizedNames, "") || null : null,
          reason: choiceGroupReason(binding, set),
        };
      }),
    );
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
  /**
   * DEC-BRAND-MULTI-STORE-ONE-INSTALLATION (coordinator 2026-10-31): tax and option recipes at
   * every Store the menu serves; the first gap is refused with the Store, item, size and option
   * named (staff words, never references). Leaves the transaction in the Brand's scope.
   */
  const listingGate = async (tx: unknown, s: Scope, aggregate: MenuAggregate) => {
    const at = options.persistence.now();
    const gaps = await menuListingGaps(ptx(tx) as never, {
      owner: s.owner,
      observedAt: at,
      menu: aggregate.draft,
    });
    const gap: MenuListingGap | undefined =
      gaps.find((item) => item.missing === "Kitchen") ??
      gaps.find((item) => item.missing === "Tax") ??
      gaps[0];
    if (gap === undefined) {
      await brandScope(tx, s.owner.brandReference);
      return;
    }
    const sku = (await listBrandSkuChoices(ptx(tx) as never, s.owner)).find(
      (item) => item.skuReference === gap.skuReference,
    );
    const option =
      gap.optionReference === null
        ? undefined
        : (await listBrandOptionSets(ptx(tx), s.owner))
            .flatMap((set) => set.draft.options)
            .find((item) => String(item.optionReference) === gap.optionReference);
    // The Store's name, read in that Store's scope; a Store that cannot be read is left unnamed.
    const storeName = await createPostgresMerchantOrganizationSource(ptx(tx) as never, {
      brandReference: s.owner.brandReference,
      storeReference: gap.storeReference,
      observedAt: at,
    })
      .getStore(gap.storeReference as never)
      .then(
        (store) => store?.displayName ?? null,
        () => null,
      );
    await brandScope(tx, s.owner.brandReference);
    const kitchen = gap.missing === "Kitchen" || gap.missing === "KitchenDish";
    throw new MerchantMenuError(
      kitchen ? "KitchenNotReady" : gap.missing === "Tax" ? "TaxNotCovered" : "OptionRecipeMissing",
      {
        missing: gap.missing,
        productName: sku ? name(sku.productLocalizedNames, sku.skuCode) : null,
        sizeName: sku ? name(sku.localizedNames, sku.skuCode) : null,
        optionName: option ? name(option.localizedNames, "") || null : null,
        quantity: null,
        ingredientName: null,
        storeName,
        // WP-2423 item 11: where staff fix it (Store setup at that Store).
        ...(kitchen ? { storeReference: gap.storeReference } : {}),
      },
    );
  };
  /**
   * WP-2423 DEC-MERCHANT-LOCK-SCOPE: a menu whose review would run past its budget is refused before
   * anything of it is listed, the item named: a drink whose ten toppings each change its recipe has
   * more combinations than one review checks, and finding that out only at Submit left its new
   * prices live and showed staff a code. Counted as the review counts: a drink whose choices change
   * nothing (a milk tea's sizes, sugar, ice and toppings) uses one check per option, not per set.
   * Leaves the Brand's scope.
   */
  const reviewBudgetGate = async (tx: unknown, s: Scope, aggregate: MenuAggregate) => {
    const over = await menuReviewBudgetExceededAt(ptx(tx) as never, {
      brandReference: s.owner.brandReference,
      actorReference: s.actor,
      menu: aggregate.draft,
      observedAt: options.persistence.now(),
      authorize: async () => s.permissions.maySubmit,
    });
    if (over === null) {
      await brandScope(tx, s.owner.brandReference);
      return;
    }
    const sku = (await listBrandSkuChoices(ptx(tx) as never, s.owner)).find(
      (item) => item.skuReference === over,
    );
    await brandScope(tx, s.owner.brandReference);
    throw new MerchantMenuError("ReviewBlocked", {
      missing: "TooManyChoices",
      productName: sku ? name(sku.productLocalizedNames, sku.skuCode) : null,
      sizeName: sku ? name(sku.localizedNames, sku.skuCode) : null,
      optionName: null,
      quantity: null,
      ingredientName: null,
    });
  };
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
          // DEC-BRAND-MULTI-STORE segment 9: whether the Brand has several Stores, and whether
          // this menu serves the selected one (the Brand Owner adds a Store to it when it opens).
          const brandStores = await listBrandStoreReferences(ptx(tx) as never, s.owner);
          await brandScope(tx, s.owner.brandReference);
          return {
            screenId: "CAT-MENU-BUILDER" as const,
            ...base,
            stores: {
              severalStores: brandStores.length > 1,
              servesHere: loaded.aggregate.draft.storeReferences.some(
                (store) => String(store) === s.owner.storeReference,
              ),
            },
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
              const allergens = await dishAllergens(
                tx,
                s,
                summary.latestRelease?.menuVersionReference ?? null,
              );
              return {
                sellables: (await sellables(tx, s)).map((sku) => ({
                  ...sku,
                  allergens: allergens.bySku.get(sku.skuReference) ?? {
                    source: "None" as const,
                    declared: [],
                    itemReference: null,
                    noIngredients: false,
                    unanswered: [],
                  },
                  // WP-2423 M69: whether its allergens are answered at all ("List it" waits).
                  allergensAnswered:
                    (allergens.bySku.get(sku.skuReference)?.source ?? "None") !== "None" ||
                    allergens.recipeHere.has(sku.skuReference),
                })),
                allergenChoices: allergens.choices,
                keepsStock: allergens.keepsStock,
              };
            })()),
            mayOfferHere,
            ...(await priceListing(tx, s)),
            customerView,
            allergenRegistry: (await currentAllergenRegistry(ptx(tx) as never, s.owner)) !== null,
          };
        }),
      ),
    );
  };

  /** A publication's MenuPublished event into the customer menu (idempotent), on this transaction. */
  const projectEvent = async (
    tx: Parameters<typeof brandScope>[0],
    brandReference: string,
    publishOperation: string,
  ) => {
    await brandScope(tx, brandReference);
    const envelope = await loadOutboxEnvelope(
      tx as unknown as ConsumerTransaction,
      derivedReference(publishOperation, "publication:Event"),
    );
    if (envelope === null) return fail("NotFound");
    return createPostgresPublishedMenuConsumerService({
      brandReference,
      authorize: async () => true,
      generateGeneration: () => derivedReference(publishOperation, "projection"),
      now: () => options.persistence.now(),
    }).consume(tx as unknown as ConsumerTransaction, envelope);
  };
  const publication = createMerchantMenuPublicationCommand({
    merchant: options.persistence,
    projectPublished: (tx, input) =>
      projectEvent(tx, input.brandReference, input.operationReference),
    authentication: options.authentication,
    reviewCreation: {
      budget: menuReviewBudget,
      reference: (purpose, operation) => derivedReference(operation, "review:" + purpose),
    },
    reviewApproval: {
      reference: (purpose, operation) => derivedReference(operation, "approval:" + purpose),
      validUntil: (input) => input.validationValidUntil,
    },
    binding: async (tx, input) => {
      // The review content is the Brand's (read without a Store), whatever this transaction read
      // before (v15 2026-10-29: the approval found no review while a Store was still selected).
      await brandScope(tx, input.brandReference);
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

  /** Replays a publication's projection in its own transaction (the Rebuild command). */
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
          return projectEvent(tx, s.owner.brandReference, publishOperation);
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
    if (body.action === "Check")
      return checkListing().catch((error: unknown) => mapCommandError(error));
    try {
      return await commandBody();
    } catch (error) {
      return mapCommandError(error);
    }
    function checkListing() {
      return retryTransactionConflict(() =>
        options.persistence.transactions.run((tx) =>
          withRememberedBrandAuthorization(tx, async () => {
            const s = await scopeFor(tx, input.sessionCookie, current.sessionReference);
            if (!s.permissions.maySubmit) fail("PermissionDenied");
            const summary = (await listBrandMenus(ptx(tx) as never, s.owner)).find(
              (candidate) => candidate.menuReference === body.menuReference,
            );
            if (summary === undefined) return fail("NotFound");
            // A listing already under way (submitted) goes on from where it is.
            if (nextMenuListingStep(summary) !== "Submit") return { status: "Ready" as const };
            const loaded = await draft(tx, s, body.menuReference);
            if (loaded === null) return fail("NotFound");
            if ((await currentAllergenRegistry(ptx(tx) as never, s.owner)) === null)
              return stopped("Check:NoAllergenList");
            await listingGate(tx, s, loaded.aggregate);
            await reviewBudgetGate(tx, s, loaded.aggregate);
            return { status: "Ready" as const };
          }),
        ),
      );
    }
    async function commandBody(): Promise<unknown> {
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
              if (registry === null) return stopped("Submit:NoAllergenList");
              if ((await unpricedOptions(tx, s, loaded.aggregate)).length > 0)
                fail("OptionPriceMissing");
              await listingGate(tx, s, loaded.aggregate);
              await reviewBudgetGate(tx, s, loaded.aggregate);
              return { s, loaded, registry };
            }),
          ),
        );
        const { loaded, registry } = prepared;
        const commandBody =
          body.action === "Submit"
            ? loaded === null || registry === null
              ? stopped(loaded === null ? "Submit:NoDraft" : "Submit:NoAllergenList")
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
        // Each step's command is the same on a rerun (a stable operation reference, the same period):
        // beside a busy merchant the step tries again instead of failing the owner's listing.
        return await retryTransactionConflict(() =>
          publication({
            sessionCookie: input.sessionCookie,
            csrf: input.csrf,
            command: commandBody,
            ...(body.action === "Approve" && body.approvalMode !== undefined
              ? { approvalMode: body.approvalMode }
              : {}),
          }),
        );
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
            const brandStores = await listBrandStoreReferences(ptx(tx) as never, s.owner);
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
                // DEC-BRAND-MULTI-STORE segment 9: a Brand menu serves Stores of the Brand.
                validateStores: async (value) =>
                  value.storeReferences.every(
                    (store) => store === s.owner.storeReference || brandStores.includes(store),
                  ),
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
    }
    async function mapCommandError(error: unknown): Promise<never> {
      if (error instanceof MerchantMenuError) throw error;
      if (error instanceof MenuReviewStoppedError) {
        // v15 2026-10-29: where and why the review stopped (the item named, the reason a code).
        const at =
          error.skuReference === null
            ? null
            : await describeGap(input.sessionCookie, current.sessionReference, {
                skuReference: error.skuReference,
                storeReference: "",
                missing: "Recipe",
                optionReference: null,
                quantity: null,
                ingredientReference: null,
              }).catch(() => null);
        throw stoppedError(error.reason, error, {
          productName: at?.productName ?? null,
          sizeName: at?.sizeName ?? null,
        });
      }
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
        const rule = typeof (error as { rule?: unknown }).rule === "string";
        const sku = (error as { sellableReference?: unknown }).sellableReference;
        const binding = (error as { binding?: unknown }).binding;
        const choiceGroup =
          rule &&
          error.code === "CATALOG_DEPENDENCY_UNAVAILABLE" &&
          (body.action === "Submit" || body.action === "Check")
            ? await describeChoiceGroup(
                input.sessionCookie,
                current.sessionReference,
                typeof sku === "string" ? sku : null,
                typeof binding === "object" && binding !== null
                  ? (binding as ProductOptionBinding)
                  : null,
              ).catch(() => null)
            : null;
        throw menuCatalogError(error, body.action, choiceGroup);
      }
      throw error;
    }
  };
  return {
    query,
    command: (input: { sessionCookie: unknown; csrf: unknown; body: unknown }) =>
      command(input).catch((error: unknown) => {
        if (error instanceof MerchantMenuError && error.stoppedBy !== null)
          options.onUnexpectedStop?.(error.stoppedBy.reason, error.stoppedBy.cause);
        throw error;
      }),
  };
}
