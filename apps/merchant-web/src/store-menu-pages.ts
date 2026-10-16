import { parseSoleOperatorGate, type SoleOperatorGateView } from "./SoleOperatorSelfApproval.js";
/** WP-2423 / DEC-MENU-REVISION: CAT-MENU-LIST / CAT-MENU-BUILDER view contract and same-origin client. */
export type MenuErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "Conflict"
  | "Frozen"
  | "NotRevisable"
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
  constructor(readonly code: MenuErrorCode) {
    super("Menus are unavailable");
    this.name = "MenuPageError";
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
}
export interface MenuSectionInput {
  readonly sectionReference: string | null;
  readonly code: string;
  readonly name: string;
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
  } as unknown as MenuBuilderView;
}
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
  CUSTOMER_PWA: "Customer ordering app",
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
  const customers = hasPublishedMenu ? " Customers keep seeing the published menu meanwhile." : "";
  if (stage === "Editing") return null;
  if (stage === "InReview" || stage === "Approved")
    return {
      label: "Withdraw to make changes",
      note:
        (stage === "InReview"
          ? "Takes this version out of review and opens a copy to edit; it must be submitted for review again."
          : "Sets this approved version aside unpublished and opens a copy to edit; it must be submitted and approved again.") +
        customers,
      done: "Withdrawn. Edit the new draft and submit it for review again.",
    };
  return {
    label: "Start a revision",
    note: hasPublishedMenu
      ? "Customers keep seeing the published menu until the revision is published."
      : "Opens a copy to edit; it must be submitted for review and published again.",
    done: "A new version was started from this one; edit it and submit it for review.",
  };
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
      );
    }
    return response.json() as Promise<unknown>;
  };
  return {
    load: (menuReference) => post("/merchant/commerce/menus/query", { menuReference }),
    command: (command) => post("/merchant/commerce/menus/command", command),
  };
}
