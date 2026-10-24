import { t } from "./i18n/i18n.js";
import { parseSoleOperatorGate, type SoleOperatorGateView } from "./SoleOperatorSelfApproval.js";
/** WP-2423 / DEC-MENU-REVISION: CAT-MENU-LIST / CAT-MENU-BUILDER view contract and same-origin client. */
export type MenuErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Conflict"
  | "Frozen"
  | "NotRevisable"
  | "NotDiscardable"
  | "ReviewBlocked"
  | "OptionPriceMissing"
  | "TaxNotCovered"
  | "OptionRecipeMissing"
  | "ApprovalRequired"
  | "Lifecycle"
  | "Invalid"
  | "SoleOperatorNotInEffect"
  | "NeedsReverification"
  | "Offline"
  | "Unavailable";
export class MenuPageError extends Error {
  constructor(
    readonly code: MenuErrorCode,
    /** WP-2423 (v15 2026-10-22): what a blocked review found missing, when the server knows. */
    readonly problem: MenuReviewProblem | null = null,
  ) {
    super(t("Menus are unavailable"));
    this.name = "MenuPageError";
  }
}
export interface MenuReviewProblem {
  readonly missing:
    "Recipe" | "SubRecipe" | "OptionRecipe" | "AllergenDeclaration" | "AllergenList";
  readonly productName: string | null;
  readonly sizeName: string | null;
  readonly optionName: string | null;
  readonly quantity: number | null;
  readonly ingredientName: string | null;
}
const missingKinds = new Set<MenuReviewProblem["missing"]>([
  "Recipe",
  "SubRecipe",
  "OptionRecipe",
  "AllergenDeclaration",
  "AllergenList",
]);
const optionalText = (value: unknown) =>
  typeof value === "string" && value.trim() && value.length <= 200 ? value.trim() : null;
export function parseMenuReviewProblem(value: unknown): MenuReviewProblem | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (!missingKinds.has(raw.missing as MenuReviewProblem["missing"])) return null;
  const quantity = raw.quantity;
  return {
    missing: raw.missing as MenuReviewProblem["missing"],
    productName: optionalText(raw.productName),
    sizeName: optionalText(raw.sizeName),
    optionName: optionalText(raw.optionName),
    quantity:
      typeof quantity === "number" && Number.isSafeInteger(quantity) && quantity >= 1
        ? quantity
        : null,
    ingredientName: optionalText(raw.ingredientName),
  };
}
/** The blocked review in staff words: which item, size, option or ingredient, and where to fix it. */
export function menuReviewProblemText(problem: MenuReviewProblem): string {
  const item =
    problem.productName === null
      ? t("An item on this menu")
      : problem.sizeName === null || problem.sizeName === problem.productName
        ? problem.productName
        : `${problem.productName} — ${problem.sizeName}`;
  const option =
    problem.optionName === null
      ? null
      : problem.quantity !== null && problem.quantity > 1
        ? `${problem.optionName} × ${problem.quantity}`
        : problem.optionName;
  switch (problem.missing) {
    case "Recipe":
      return `${item} has no published recipe for this menu's Stores. Publish one under Recipes and assign it to this size, then submit again.`;
    case "SubRecipe":
      return `A recipe used in ${item} is not published. Publish it under Recipes, then submit again.`;
    case "OptionRecipe":
      return `${item}: the option ${option ?? "chosen"} has no published recipe change. Set, review and publish it under Option recipes, then submit again.`;
    case "AllergenDeclaration": {
      const ingredient =
        problem.ingredientName === null
          ? t("An ingredient")
          : t("The ingredient {ingredientName}", { ingredientName: problem.ingredientName });
      const where =
        option === null ? item : t("{item} with {option}", { item: item, option: option });
      return t(
        "{ingredient} in {where} has no current allergen declaration. Record or renew it under Allergens, then submit again.",
        { ingredient: ingredient, where: where },
      );
    }
    case "AllergenList":
      return "The Brand allergen list this menu uses is not approved. Approve it under Allergens, then submit again.";
  }
}
export interface MenuPublicationStatus {
  readonly lifecycleReference: string;
  readonly lifecycleVersion: number;
  readonly state: string;
  readonly snapshotDigest: string;
  readonly changedAt: string;
}
export interface MenuReleaseSummary {
  readonly releaseReference: string;
  readonly sequence: number;
  readonly menuVersionReference: string;
  readonly createdAt: string;
}
/** WP-2423: a photo as customers see it (thumbnail of the reviewed photo, with its description). */
export interface MenuCustomerPhoto {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly altText: string;
}
export interface MenuCustomerViewItem {
  readonly placementReference: string;
  readonly skuReference: string;
  readonly sectionName: string;
  readonly name: string;
  readonly description: string | null;
  readonly photo: MenuCustomerPhoto | null;
  readonly newOnMenu: boolean | null;
  readonly descriptionChange: "Added" | "Changed" | "Removed" | null;
  readonly photoChange: "Added" | "Replaced" | "Removed" | "DescriptionChanged" | null;
  readonly before: {
    readonly description: string | null;
    readonly photo: MenuCustomerPhoto | null;
  } | null;
}
/** WP-2423: what customers will see, frozen in the review snapshot, against the published menu. */
export interface MenuCustomerView {
  readonly frozenAt: string;
  readonly comparedWithPublishedAt: string | null;
  readonly items: readonly MenuCustomerViewItem[];
  readonly removedFromMenu: readonly { readonly skuReference: string; readonly name: string }[];
}
export interface MenuSummary {
  readonly menuReference: string;
  readonly internalCode: string;
  readonly aggregateVersion: number;
  readonly currentVersionReference: string;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly placements: number;
  readonly publication: MenuPublicationStatus | null;
  readonly latestRelease: MenuReleaseSummary | null;
}
interface MenuViewBase {
  readonly sourceAsOf: string;
  readonly viewer: string;
  readonly permissions: {
    readonly mayRead: boolean;
    readonly mayEdit: boolean;
    readonly maySubmit: boolean;
    readonly mayApprove: boolean;
    readonly mayPublish: boolean;
  };
  readonly menus: readonly MenuSummary[];
}
export interface MenuListView extends MenuViewBase {
  readonly screenId: "CAT-MENU-LIST";
}
export interface MenuSellable {
  readonly skuReference: string;
  readonly skuCode: string;
  readonly productName: string;
  readonly sizeName: string;
  readonly active: boolean;
  readonly priceMinor: string | null;
  /** WP-2423: offered at the selected Store (Item availability); customers here see it only then.
   * Absent from older views: treated as offered. */
  readonly offeredHere?: boolean;
}
export interface MenuBuilderView extends MenuViewBase {
  readonly screenId: "CAT-MENU-BUILDER";
  readonly menu: {
    readonly menuReference: string;
    readonly internalCode: string;
    readonly aggregateVersion: number;
    readonly versionReference: string;
    readonly name: string;
    readonly storeReferences: readonly string[];
    readonly channelCodes: readonly string[];
    readonly orderTypeCodes: readonly string[];
    readonly sections: readonly {
      readonly sectionReference: string;
      readonly code: string;
      readonly name: string;
      /** Owner 2026-10-23: the Simplified Chinese name customers see ("" or absent when none). */
      readonly nameZh?: string;
      readonly items: readonly {
        readonly placementReference: string;
        readonly skuReference: string;
        readonly featured: boolean;
      }[];
    }[];
  };
  readonly publication: MenuPublicationStatus | null;
  readonly latestRelease: MenuReleaseSummary | null;
  readonly submittedBy: string | null;
  /** WP-2423 Q19: present for a submitter who may approve: may they approve alone, and why not. */
  readonly soleOperator: SoleOperatorGateView | null;
  readonly sellables: readonly MenuSellable[];
  /** WP-2423: whether the viewer may offer items at this Store from the menu page. */
  readonly mayOfferHere?: boolean;
  readonly allergenRegistry: boolean;
  /** WP-2423: present once the version is frozen for review; absent from older views. */
  readonly customerView?: MenuCustomerView | null;
}
export interface MenuSectionInput {
  readonly sectionReference: string | null;
  readonly code: string;
  readonly name: string;
  readonly nameZh: string;
  readonly items: readonly { readonly skuReference: string; readonly featured: boolean }[];
}
export type MenuCommand =
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
      /** WP-2423 Q19: the submitter approves alone as sole operator (Approve only). */
      readonly approvalMode?: "SoleOperator";
    }
  | {
      readonly action: "Rebuild";
      readonly operationReference: string;
      readonly menuReference: string;
      readonly publishOperationReference: string;
    };
export interface MenuClient {
  load(menuReference: string | null): Promise<unknown>;
  command?(command: MenuCommand): Promise<unknown>;
}
const object = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
export function parseMenuListView(value: unknown): MenuListView {
  const r = object(value);
  if (r === null || r.screenId !== "CAT-MENU-LIST" || !Array.isArray(r.menus))
    throw new Error("MENU_PAGE_INVALID");
  return r as unknown as MenuListView;
}
export function parseMenuBuilderView(value: unknown): MenuBuilderView {
  const r = object(value);
  const menu = object(r?.menu);
  if (
    r === null ||
    r.screenId !== "CAT-MENU-BUILDER" ||
    menu === null ||
    !Array.isArray(menu.sections) ||
    !Array.isArray(r.sellables)
  )
    throw new Error("MENU_PAGE_INVALID");
  return {
    ...r,
    soleOperator: parseSoleOperatorGate(r.soleOperator),
    customerView: parseMenuCustomerView(r.customerView),
  } as unknown as MenuBuilderView;
}
const photoPath = /^\/media\/images\/[0-9a-f]{64}\.(?:jpg|webp)$/u;
const dimension = (value: unknown) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 20_000;
const text = (value: unknown) => (typeof value === "string" ? value : null);
function parseCustomerPhoto(value: unknown): MenuCustomerPhoto | null {
  const photo = object(value);
  if (
    photo === null ||
    typeof photo.url !== "string" ||
    !photoPath.test(photo.url) ||
    !dimension(photo.width) ||
    !dimension(photo.height) ||
    typeof photo.altText !== "string"
  )
    return null;
  return {
    url: photo.url,
    width: photo.width as number,
    height: photo.height as number,
    altText: photo.altText,
  };
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T | null =>
  values.includes(value as T) ? (value as T) : null;
/** Lenient on display, strict on what reaches the DOM: only public photo paths are rendered. */
export function parseMenuCustomerView(value: unknown): MenuCustomerView | null {
  const view = object(value);
  if (view === null || typeof view.frozenAt !== "string" || !Array.isArray(view.items)) return null;
  const items = view.items.flatMap((candidate: unknown): MenuCustomerViewItem[] => {
    const item = object(candidate);
    if (
      item === null ||
      typeof item.placementReference !== "string" ||
      typeof item.skuReference !== "string" ||
      typeof item.name !== "string"
    )
      return [];
    const before = object(item.before);
    return [
      {
        placementReference: item.placementReference,
        skuReference: item.skuReference,
        sectionName: text(item.sectionName) ?? "",
        name: item.name,
        description: text(item.description),
        photo: parseCustomerPhoto(item.photo),
        newOnMenu: typeof item.newOnMenu === "boolean" ? item.newOnMenu : null,
        descriptionChange: oneOf(item.descriptionChange, ["Added", "Changed", "Removed"] as const),
        photoChange: oneOf(item.photoChange, [
          "Added",
          "Replaced",
          "Removed",
          "DescriptionChanged",
        ] as const),
        before:
          before === null
            ? null
            : { description: text(before.description), photo: parseCustomerPhoto(before.photo) },
      },
    ];
  });
  return {
    frozenAt: view.frozenAt,
    comparedWithPublishedAt: text(view.comparedWithPublishedAt),
    items,
    removedFromMenu: (Array.isArray(view.removedFromMenu) ? view.removedFromMenu : []).flatMap(
      (candidate: unknown) => {
        const removed = object(candidate);
        return removed !== null &&
          typeof removed.skuReference === "string" &&
          typeof removed.name === "string"
          ? [{ skuReference: removed.skuReference, name: removed.name }]
          : [];
      },
    ),
  };
}
/** Plain words for what changed for customers, e.g. "1 new item, 2 photos changed". */
export function customerViewChangeSummary(view: MenuCustomerView): string | null {
  if (view.comparedWithPublishedAt === null) return null;
  const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
  const newItems = view.items.filter((item) => item.newOnMenu === true).length;
  const descriptions = view.items.filter((item) => item.descriptionChange !== null).length;
  const photos = view.items.filter((item) => item.photoChange !== null).length;
  const parts = [
    newItems ? count(newItems, t("new item"), t("new items")) : "",
    descriptions ? count(descriptions, t("description changed"), t("descriptions changed")) : "",
    photos ? count(photos, t("photo changed"), t("photos changed")) : "",
    view.removedFromMenu.length
      ? count(view.removedFromMenu.length, t("item removed"), t("items removed"))
      : "",
  ].filter(Boolean);
  return parts.length === 0
    ? t("No changes to items, descriptions or photos.")
    : parts.join(", ") + ".";
}
export const descriptionChangeText = {
  Added: t("New description"),
  Changed: t("Description changed"),
  Removed: t("Description removed"),
} as const;
export const photoChangeText = {
  Added: t("New photo"),
  Replaced: t("Photo replaced"),
  Removed: t("Photo removed"),
  DescriptionChanged: t("Photo description changed"),
} as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const parseMenuRouteReference = (value: string | undefined): string | null =>
  value !== undefined && uuid.test(value) ? value : null;
export const sectionCode = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/[^A-Za-z0-9_]/gu, "")
    .replace(/^[^A-Za-z]+|_+$/gu, "")
    .toUpperCase()
    .slice(0, 40);
/** WP-2423: plain names for a menu's sales channels and order types (never the internal codes). */
const channelNames: Readonly<Record<string, string>> = {
  CUSTOMER_PWA: t("Customer ordering app"),
  POS: "Counter",
};
const orderTypeNames: Readonly<Record<string, string>> = {
  DINE_IN: "Dine-in",
  PICKUP: "Pickup",
};
const plainCode = (code: string) =>
  code.charAt(0) + code.slice(1).toLowerCase().replaceAll("_", " ");
export const channelText = (codes: readonly string[]) =>
  codes.map((code) => channelNames[code] ?? plainCode(code)).join(", ");
export const orderTypeText = (codes: readonly string[]) =>
  codes.map((code) => orderTypeNames[code] ?? plainCode(code)).join(", ");
/** Items placed on the menu that customers at this Store cannot see because they are not offered
 * here, in menu order, without repeats. */
export function itemsNotOfferedHere(view: MenuBuilderView): readonly MenuSellable[] {
  const sellables = new Map(view.sellables.map((item) => [item.skuReference, item]));
  const seen = new Set<string>();
  const hidden: MenuSellable[] = [];
  for (const section of view.menu.sections)
    for (const item of section.items) {
      const sellable = sellables.get(item.skuReference);
      if (sellable === undefined || sellable.offeredHere !== false || seen.has(item.skuReference))
        continue;
      seen.add(item.skuReference);
      hidden.push(sellable);
    }
  return hidden;
}
/** Where the current version stands: editable, in review, approved or published. */
export function menuStage(publication: MenuPublicationStatus | null) {
  if (publication === null) return "Editing" as const;
  if (publication.state === "Published") return "Published" as const;
  if (publication.state === "Approved") return "Approved" as const;
  if (publication.state === "Archived") return "Archived" as const;
  return "InReview" as const;
}
/**
 * How staff change a menu version that can no longer be edited (DEC-MENU-REVISION): the server
 * copies the current version into a new draft. A published version gets a revision; a version in
 * review or approved but not yet published is withdrawn to change it (there is no other way back
 * to editing) and must be reviewed again. A version being edited is changed in place.
 */
export function menuRevisionAction(
  stage: ReturnType<typeof menuStage>,
  hasPublishedMenu: boolean,
): { readonly label: string; readonly note: string; readonly done: string } | null {
  const customers = hasPublishedMenu
    ? t(" Customers keep seeing the published menu meanwhile.")
    : "";
  if (stage === "Editing") return null;
  if (stage === "InReview" || stage === "Approved")
    return {
      label: t("Withdraw to make changes"),
      note:
        (stage === "InReview"
          ? t(
              "Takes this version out of review and opens a copy to edit; it must be submitted for review again.",
            )
          : t(
              "Sets this approved version aside unpublished and opens a copy to edit; it must be submitted and approved again.",
            )) + customers,
      done: t("Withdrawn. Edit the new draft and submit it for review again."),
    };
  return {
    label: t("Start a revision"),
    note: hasPublishedMenu
      ? t("Customers keep seeing the published menu until the revision is published.")
      : t("Opens a copy to edit; it must be submitted for review and published again."),
    done: t("A new version was started from this one; edit it and submit it for review."),
  };
}
/**
 * WP-2423 (v15 2026-10-16): an open draft of a menu that has been published can be discarded by
 * whoever may edit menus; the menu goes back to its last published version and customers see no
 * change. A version in review is withdrawn first; a never-published menu has nothing to go back to.
 */
export function mayDiscardDraft(view: MenuBuilderView): boolean {
  return (
    view.permissions.mayEdit &&
    menuStage(view.publication) === "Editing" &&
    view.latestRelease !== null &&
    view.latestRelease.menuVersionReference !== view.menu.versionReference
  );
}
export const priceText = (minor: string | null) =>
  minor === null
    ? null
    : (minor.length <= 2 ? "0" : minor.slice(0, -2)) + "." + minor.padStart(2, "0").slice(-2);
export const unavailableMenuClient: MenuClient = {
  load: async () => {
    throw new MenuPageError("Unavailable");
  },
};
const codes = new Set<MenuErrorCode>([
  "PermissionDenied",
  "NotFound",
  "Conflict",
  "Frozen",
  "NotRevisable",
  "NotDiscardable",
  "ReviewBlocked",
  "OptionPriceMissing",
  "TaxNotCovered",
  "OptionRecipeMissing",
  "ApprovalRequired",
  "Lifecycle",
  "Invalid",
  "SoleOperatorNotInEffect",
  "NeedsReverification",
]);
export function createMenuClient(csrf: string, fetcher: typeof fetch = fetch): MenuClient {
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
      throw new MenuPageError("Offline");
    }
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const code = String(payload?.error) as MenuErrorCode;
      throw new MenuPageError(
        codes.has(code) ? code : response.status === 403 ? "PermissionDenied" : "Unavailable",
        code === "ReviewBlocked"
          ? parseMenuReviewProblem((payload as { problem?: unknown } | null)?.problem)
          : null,
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: (menuReference) => post("/merchant/commerce/menus/query", { menuReference }),
    command: (command) => post("/merchant/commerce/menus/command", command),
  };
}
