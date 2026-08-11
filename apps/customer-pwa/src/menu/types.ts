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
  readonly minimumSelections: number;
  readonly maximumSelections: number;
  readonly enabledOptionCount: number;
  readonly defaultOptionCount: number;
}

export interface MenuSellable {
  readonly sellableReference: string;
  readonly name: string;
  readonly presentationRole: "Standard" | "Featured" | "Promotional" | "Sponsored";
  readonly pinned: boolean;
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
  | Readonly<{ kind: "NotFound" }>
  | Readonly<{ kind: "Stale" }>
  | Readonly<{ kind: "Unavailable" }>
  | Readonly<{ kind: "Offline" }>;

export interface CustomerMenuClient {
  load(
    input?: Readonly<{ searchTerm?: string; sectionReference?: string }>,
  ): Promise<MenuLoadResult>;
}
