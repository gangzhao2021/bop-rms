export interface MenuJourneyContext {
  readonly publicStoreReference: string;
  readonly channel: "DineIn" | "Pickup";
  readonly locale: string;
  readonly brandDisplayName: string;
  readonly storeDisplayName: string;
  /**
   * M116: the Store isn't taking orders now (closed, or paused for a while); its menu is only to
   * look at: no visit, no cart, nothing to add.
   */
  readonly closed?: MenuClosedStore | undefined;
}

/** M116: why a Store's menu is only to look at, and when it opens next. */
export interface MenuClosedStore {
  readonly paused: boolean;
  readonly nextOpening: { readonly localDate: string; readonly startLocalTime: string } | null;
  readonly localDate: string | null;
}

export interface MenuAllergenItem {
  readonly name: string;
  readonly classification: "Contains" | "CrossContactPossible";
}

export interface MenuOptionRule {
  /** The option set's name ("Milk"); null for menus published before names were included. */
  readonly name: string | null;
  readonly activationOptionReferences?: readonly string[];
  readonly minimumSelections: number;
  readonly maximumSelections: number;
  /**
   * WP-2423 item 8 ⑥ part 4: a part of a combo — it starts with nothing chosen and each dish in it
   * shows its allergens.
   */
  readonly comboPart?: true;
  readonly options: readonly {
    readonly optionReference: string;
    readonly name: string;
    readonly maximumQuantity: number;
    readonly conflictOptionReferences: readonly string[];
    /** The choice the dish is configured to start with; never started with while not offered. */
    readonly selectedByDefault: boolean;
    readonly defaultQuantity?: number;
    /** WP-2423 (cart-unsellable-dishes): present only when the Store doesn't offer it right now. */
    readonly offeredNow?: false;
    /** WP-2423 (M22, M24): not offered now because it is sold out at the Store today. */
    readonly soldOut?: true;
    /** What one adds now ("0.75" CAD); null when the Store has not priced it yet. */
    readonly price: { readonly amount: string; readonly currency: string } | null;
  }[];
}

export interface MenuPhotoRendition {
  /** Same-origin, content-hashed path: /media/images/<sha256>.jpg|webp */
  readonly url: string;
  readonly contentType: "image/jpeg" | "image/webp";
  readonly width: number;
  readonly height: number;
}

export interface MenuPhoto {
  /** Staff-written description of the photo, in the menu locale. */
  readonly altText: string;
  /** Intrinsic size of the largest rendition; used for the aspect ratio. */
  readonly width: number;
  readonly height: number;
  readonly renditions: readonly MenuPhotoRendition[];
}

export interface MenuSellable {
  readonly sellableReference: string;
  /**
   * The published Product version. Sizes (SKUs) of one Product share it, which is how the menu shows
   * them as one item with a size choice; absent for menus built without it (previews).
   */
  readonly productVersionReference?: string;
  readonly name: string;
  /** Staff-written plain-text description, in the menu locale; null when none is published. */
  readonly description: string | null;
  /** The published product photo; null when none is published. */
  readonly photo: MenuPhoto | null;
  readonly presentationRole: "Standard" | "Featured" | "Promotional" | "Sponsored";
  readonly pinned: boolean;
  /** WP-2423 8.6: SoldOut while the Store has marked it sold out. */
  readonly availability: "Available" | "SoldOut";
  /** WP-2423 DEC-ALCOHOL: the dish contains alcohol; OutsideHours can't be ordered right now. */
  readonly alcohol?: "OnSale" | "LastCall" | "OutsideHours";
  /** The Store's base price before options and tax, when it has one. */
  readonly price: { readonly amount: string; readonly currency: string } | null;
  /** Everything the item may contain across all its choices. */
  readonly allergens: readonly MenuAllergenItem[];
  /**
   * WP-2423 ⑪: what the item contains for each reviewed set of chosen options (`sets` entries are
   * `[outcome, ...optionIndexes]`); absent for older menus.
   */
  readonly allergensByChoice?: {
    readonly options: readonly string[];
    readonly outcomes: readonly (readonly MenuAllergenItem[])[];
    readonly sets: readonly (readonly number[])[];
  };
  /**
   * WP-2423 item 12: what each dish of a combo part declares by itself. A dish missing here (or an
   * older menu) says nothing, and the guest is told to ask staff.
   */
  readonly allergensByOption?: Readonly<Record<string, readonly MenuAllergenItem[]>>;
  /**
   * WP-2423 (M77, M167): the kitchen's recipe changed since the menu was listed; the allergens
   * above already include what it adds, and the guest is asked to check with staff.
   */
  readonly allergensJustUpdated?: true;
  readonly optionRules: readonly MenuOptionRule[];
}

export interface MenuView {
  readonly name: string;
  readonly locale: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly sections: readonly {
    readonly sectionReference: string;
    readonly name: string;
    readonly sellables: readonly MenuSellable[];
  }[];
}

export type MenuLoadResult =
  | Readonly<{ kind: "Found"; menu: MenuView }>
  | Readonly<{ kind: "PermissionDenied" }>
  | Readonly<{ kind: "NotFound" }>
  | Readonly<{ kind: "Stale" }>
  | Readonly<{ kind: "Unavailable" }>
  | Readonly<{ kind: "Offline" }>;

export interface CustomerMenuClient {
  load(
    input?: Readonly<{ searchTerm?: string; sectionReference?: string }>,
  ): Promise<MenuLoadResult>;
}
