export interface MenuJourneyContext {
  readonly publicStoreReference: string;
  readonly channel: "DineIn" | "Pickup";
  readonly locale: string;
  readonly brandDisplayName: string;
  readonly storeDisplayName: string;
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
  readonly options: readonly {
    readonly optionReference: string;
    readonly name: string;
    readonly maximumQuantity: number;
    readonly conflictOptionReferences: readonly string[];
    readonly selectedByDefault: boolean;
    readonly defaultQuantity?: number;
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
  /** The Store's base price before options and tax, when it has one. */
  readonly price: { readonly amount: string; readonly currency: string } | null;
  readonly allergens: readonly MenuAllergenItem[];
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
