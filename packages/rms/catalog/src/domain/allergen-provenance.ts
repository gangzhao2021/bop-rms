import {
  createPublishingValidationEvidence,
  parsePublishingDigest,
  type PublishingDigest,
  type PublishingValidationEvidence,
} from "@bop/publishing";
import {
  CatalogError,
  parseCatalogCode,
  parseCatalogInstant,
  parseCatalogLocale,
  parseCatalogReference,
  parseLocalizedNames,
} from "./product.js";
import type { CatalogCode, CatalogInstant, CatalogReference } from "./product.js";

export const allergenClassifications = ["Contains", "CrossContactPossible", "Unverified"] as const;
export type AllergenClassification = (typeof allergenClassifications)[number];
export interface AllergenRegistryEntry {
  readonly allergenReference: CatalogReference;
  readonly code: CatalogCode;
  readonly localizedNames: Readonly<Record<string, string>>;
}
export interface AllergenAssertion {
  readonly allergenReference: CatalogReference;
  readonly classification: AllergenClassification;
}
export interface AllergenSourceEvidence {
  readonly evidenceReference: CatalogReference;
  readonly subjectReference: CatalogReference;
  readonly subjectKind: "Ingredient" | "Recipe" | "Product" | "Option";
  readonly sourceVersionReference: CatalogReference;
  readonly supplierReference: CatalogReference | null;
  readonly documentDigest: PublishingDigest;
  readonly reviewedAt: CatalogInstant;
  readonly validUntil: CatalogInstant;
  readonly status: "Approved" | "Invalidated" | "Conflicting";
  readonly assertions: readonly AllergenAssertion[];
}
/**
 * WP-2423 ⑪: the evidence of every distinct set of chosen options a review resolved, compact.
 * `sets` entries are `[outcome, ...optionIndexes]` (option indexes ascending, into `options`);
 * `outcomes` are evidence reference lists. Quantity never changes the ingredients used, so one
 * entry per set of chosen options covers every quantity.
 */
export interface MenuAllergenChoiceEvidence {
  readonly options: readonly CatalogReference[];
  readonly outcomes: readonly (readonly CatalogReference[])[];
  readonly sets: readonly (readonly number[])[];
}
export interface MenuAllergenPath {
  readonly sellableReference: CatalogReference;
  readonly productVersionReference: CatalogReference;
  readonly evidenceReferences: readonly CatalogReference[];
  readonly optionEvidenceReferences: Readonly<Record<string, readonly CatalogReference[]>>;
  /** Absent on reviews made before per-choice disclosure. */
  readonly choiceEvidence?: MenuAllergenChoiceEvidence;
}
export interface MenuAllergenProvenanceSnapshot {
  readonly brandReference: CatalogReference;
  readonly menuVersionReference: CatalogReference;
  readonly snapshotDigest: PublishingDigest;
  readonly registryVersionReference: CatalogReference;
  readonly defaultLocale: string;
  readonly registry: readonly AllergenRegistryEntry[];
  readonly evidence: readonly AllergenSourceEvidence[];
  readonly paths: readonly MenuAllergenPath[];
}
export interface AllergenDisclosureItem {
  readonly allergenReference: CatalogReference;
  readonly code: CatalogCode;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly classification: Exclude<AllergenClassification, "Unverified">;
}
/** One allergen of a choice outcome; its names are those of the same code in `items`. */
export interface AllergenChoiceItem {
  readonly code: CatalogCode;
  readonly classification: Exclude<AllergenClassification, "Unverified">;
}
/**
 * WP-2423 ⑪: what the item contains for each reviewed set of chosen options. `sets` entries are
 * `[outcome, ...optionIndexes]`; equal outcomes are stored once.
 */
export interface AllergenChoiceDisclosure {
  readonly options: readonly CatalogReference[];
  readonly outcomes: readonly (readonly AllergenChoiceItem[])[];
  readonly sets: readonly (readonly number[])[];
}
export interface SellableAllergenDisclosure {
  readonly registryVersionReference: CatalogReference;
  /** Everything the item may contain across all its choices. */
  readonly items: readonly AllergenDisclosureItem[];
  readonly allergenFreeClaim: false;
  readonly assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED";
  /** Absent on menus reviewed before per-choice disclosure, or for items without options. */
  readonly byChoice?: AllergenChoiceDisclosure;
}
export interface MenuAllergenValidationResult {
  readonly validation: PublishingValidationEvidence;
  readonly disclosures: Readonly<Record<string, SellableAllergenDisclosure>>;
}
export interface MenuAllergenValidationCommand {
  readonly brandReference: CatalogReference;
  readonly menuVersionReference: CatalogReference;
  readonly snapshotDigest: PublishingDigest;
  readonly requestedAt: CatalogInstant;
}

function blocked(): never {
  throw new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
}

function unique<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}

export function parseAllergenRegistryEntry(
  value: AllergenRegistryEntry,
  defaultLocale: string,
): AllergenRegistryEntry {
  return Object.freeze({
    allergenReference: parseCatalogReference(value.allergenReference),
    code: parseCatalogCode(value.code),
    localizedNames: parseLocalizedNames(value.localizedNames, defaultLocale),
  });
}

export function parseAllergenSourceEvidence(
  value: AllergenSourceEvidence,
  at: string,
): AllergenSourceEvidence {
  if (
    !["Ingredient", "Recipe", "Product", "Option"].includes(value.subjectKind) ||
    !["Approved", "Invalidated", "Conflicting"].includes(value.status) ||
    // DEC-ALLERGEN-DECLARATIONS: no assertions states the subject contains none of the registry's
    // allergens; the owning reader admits that only for declarations bound to that registry.
    !Array.isArray(value.assertions)
  )
    blocked();
  const reviewedAt = parseCatalogInstant(value.reviewedAt);
  const validUntil = parseCatalogInstant(value.validUntil);
  if (
    value.status !== "Approved" ||
    Date.parse(reviewedAt) > Date.parse(at) ||
    Date.parse(validUntil) <= Date.parse(at)
  )
    blocked();
  const assertions = Object.freeze(
    value.assertions.map((assertion) => {
      if (
        !(["Contains", "CrossContactPossible", "Unverified"] as const).includes(
          assertion.classification,
        )
      )
        blocked();
      return Object.freeze({
        allergenReference: parseCatalogReference(assertion.allergenReference),
        classification: assertion.classification,
      });
    }),
  );
  if (
    !unique(assertions.map((assertion) => assertion.allergenReference)) ||
    assertions.some((assertion) => assertion.classification === "Unverified")
  )
    blocked();
  return Object.freeze({
    evidenceReference: parseCatalogReference(value.evidenceReference),
    subjectReference: parseCatalogReference(value.subjectReference),
    subjectKind: value.subjectKind,
    sourceVersionReference: parseCatalogReference(value.sourceVersionReference),
    supplierReference:
      value.supplierReference === null ? null : parseCatalogReference(value.supplierReference),
    documentDigest: parsePublishingDigest(value.documentDigest),
    reviewedAt,
    validUntil,
    status: "Approved",
    assertions,
  });
}

function strongest(
  current: Exclude<AllergenClassification, "Unverified"> | undefined,
  next: Exclude<AllergenClassification, "Unverified">,
) {
  return current === "Contains" || next === "Contains" ? "Contains" : "CrossContactPossible";
}

const MAXIMUM_CHOICE_SETS = 10000;

/** Shared shape checks of `[outcome, ...optionIndexes]` set entries. */
function parseChoiceSets(value: unknown, outcomes: number, options: number) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAXIMUM_CHOICE_SETS) blocked();
  const keys = new Set<string>();
  return Object.freeze(
    value.map((entry: unknown) => {
      if (!Array.isArray(entry) || entry.length < 1) blocked();
      const numbers = entry as unknown[];
      if (!numbers.every((item) => Number.isSafeInteger(item) && (item as number) >= 0)) blocked();
      const [outcome, ...chosen] = numbers as number[];
      if (outcome === undefined || outcome >= outcomes) blocked();
      for (const [index, option] of chosen.entries()) {
        const previous = chosen[index - 1];
        if (option >= options || (previous !== undefined && option <= previous)) blocked();
      }
      const key = chosen.join(",");
      if (keys.has(key)) blocked();
      keys.add(key);
      return Object.freeze([outcome, ...chosen]);
    }),
  );
}

function parseChoiceEvidence(
  value: MenuAllergenChoiceEvidence,
  evidence: ReadonlySet<CatalogReference>,
  coveredOptions: ReadonlySet<string>,
): MenuAllergenChoiceEvidence {
  if (
    value === null ||
    typeof value !== "object" ||
    !Array.isArray(value.options) ||
    !Array.isArray(value.outcomes) ||
    value.outcomes.length < 1
  )
    blocked();
  const options = Object.freeze(value.options.map((item) => parseCatalogReference(item)));
  if (
    !unique(options) ||
    options.some((item, index) => index > 0 && item <= (options[index - 1] as string)) ||
    options.some((item) => !coveredOptions.has(item))
  )
    blocked();
  const outcomes = Object.freeze(
    value.outcomes.map((outcome) => {
      if (!Array.isArray(outcome) || outcome.length < 1) blocked();
      const references = Object.freeze(outcome.map((item) => parseCatalogReference(item)));
      if (!unique(references) || references.some((item) => !evidence.has(item))) blocked();
      return references;
    }),
  );
  return Object.freeze({
    options,
    outcomes,
    sets: parseChoiceSets(value.sets, outcomes.length, options.length),
  });
}

function parseChoiceDisclosure(
  value: AllergenChoiceDisclosure,
  codes: ReadonlySet<string>,
): AllergenChoiceDisclosure {
  if (
    value === null ||
    typeof value !== "object" ||
    !Array.isArray(value.options) ||
    !Array.isArray(value.outcomes) ||
    value.outcomes.length < 1
  )
    blocked();
  const options = Object.freeze(value.options.map((item) => parseCatalogReference(item)));
  if (!unique(options)) blocked();
  const outcomes = Object.freeze(
    value.outcomes.map((outcome) => {
      if (!Array.isArray(outcome)) blocked();
      const items = Object.freeze(
        outcome.map((item) => {
          if (
            item === null ||
            typeof item !== "object" ||
            (item.classification !== "Contains" && item.classification !== "CrossContactPossible")
          )
            blocked();
          const code = parseCatalogCode(item.code);
          if (!codes.has(code)) blocked();
          return Object.freeze({ code, classification: item.classification });
        }),
      );
      if (!unique(items.map((item) => item.code))) blocked();
      return items;
    }),
  );
  return Object.freeze({
    options,
    outcomes,
    sets: parseChoiceSets(value.sets, outcomes.length, options.length),
  });
}

/**
 * WP-2423 ⑪: what the item contains with exactly these chosen options (quantities do not
 * matter), as reviewed for the published menu; null when the menu has no per-choice disclosure
 * or this set was not reviewed — the caller then shows `items` and says choices may add more.
 */
export function allergenDisclosureForChoice(
  disclosure: SellableAllergenDisclosure,
  optionReferences: readonly string[],
): readonly AllergenDisclosureItem[] | null {
  const byChoice = disclosure.byChoice;
  if (byChoice === undefined) return null;
  const indexes: number[] = [];
  for (const reference of new Set(optionReferences)) {
    const index = byChoice.options.indexOf(reference as CatalogReference);
    if (index < 0) return null;
    indexes.push(index);
  }
  const key = indexes.sort((a, b) => a - b).join(",");
  const entry = byChoice.sets.find((set) => set.slice(1).join(",") === key);
  const outcome = entry === undefined ? undefined : byChoice.outcomes[entry[0] as number];
  if (outcome === undefined) return null;
  const named = new Map(disclosure.items.map((item) => [item.code, item]));
  return Object.freeze(
    outcome.map((item) => {
      const base = named.get(item.code);
      if (base === undefined) return blocked();
      return Object.freeze({ ...base, classification: item.classification });
    }),
  );
}

export function parseSellableAllergenDisclosure(
  value: SellableAllergenDisclosure,
  defaultLocale: string,
): SellableAllergenDisclosure {
  if (
    value === null ||
    typeof value !== "object" ||
    value.allergenFreeClaim !== false ||
    value.assistanceCode !== "ALLERGEN_ASSISTANCE_REQUIRED" ||
    !Array.isArray(value.items)
  )
    blocked();
  const items = Object.freeze(
    value.items.map((item) => {
      if (item.classification !== "Contains" && item.classification !== "CrossContactPossible")
        blocked();
      return Object.freeze({
        allergenReference: parseCatalogReference(item.allergenReference),
        code: parseCatalogCode(item.code),
        localizedNames: parseLocalizedNames(item.localizedNames, defaultLocale),
        classification: item.classification,
      });
    }),
  );
  if (
    !unique(items.map((item) => item.allergenReference)) ||
    !unique(items.map((item) => item.code))
  )
    blocked();
  return Object.freeze({
    registryVersionReference: parseCatalogReference(value.registryVersionReference),
    items,
    allergenFreeClaim: false,
    assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
    ...(value.byChoice === undefined
      ? {}
      : {
          byChoice: parseChoiceDisclosure(value.byChoice, new Set(items.map((item) => item.code))),
        }),
  });
}

export function validateMenuAllergenProvenance(input: {
  readonly snapshot: MenuAllergenProvenanceSnapshot;
  readonly evidenceReference: string;
  readonly checkedAt: string;
}): MenuAllergenValidationResult {
  const checkedAt = parseCatalogInstant(input.checkedAt);
  const snapshot = input.snapshot;
  const defaultLocale = parseCatalogLocale(snapshot.defaultLocale);
  const brandReference = parseCatalogReference(snapshot.brandReference);
  const menuVersionReference = parseCatalogReference(snapshot.menuVersionReference);
  const snapshotDigest = parsePublishingDigest(snapshot.snapshotDigest);
  const registryVersionReference = parseCatalogReference(snapshot.registryVersionReference);
  if (
    !Array.isArray(snapshot.registry) ||
    !Array.isArray(snapshot.evidence) ||
    !Array.isArray(snapshot.paths)
  )
    blocked();
  const registry = Object.freeze(
    snapshot.registry.map((entry) => parseAllergenRegistryEntry(entry, defaultLocale)),
  );
  if (
    registry.length < 1 ||
    !unique(registry.map((entry) => entry.allergenReference)) ||
    !unique(registry.map((entry) => entry.code))
  )
    blocked();
  const registryByReference = new Map(registry.map((entry) => [entry.allergenReference, entry]));
  const evidence = Object.freeze(
    snapshot.evidence.map((entry) => parseAllergenSourceEvidence(entry, checkedAt)),
  );
  if (!unique(evidence.map((entry) => entry.evidenceReference))) blocked();
  const evidenceByReference = new Map(evidence.map((entry) => [entry.evidenceReference, entry]));
  const disclosures: Record<string, SellableAllergenDisclosure> = {};
  for (const path of snapshot.paths) {
    const sellableReference = parseCatalogReference(path.sellableReference);
    parseCatalogReference(path.productVersionReference);
    if (
      disclosures[sellableReference] !== undefined ||
      !Array.isArray(path.evidenceReferences) ||
      path.evidenceReferences.length < 1 ||
      path.optionEvidenceReferences === null ||
      typeof path.optionEvidenceReferences !== "object" ||
      Array.isArray(path.optionEvidenceReferences)
    )
      blocked();
    if (!unique(path.evidenceReferences)) blocked();
    const allReferences = new Set(path.evidenceReferences);
    for (const [optionReference, references] of Object.entries(path.optionEvidenceReferences)) {
      parseCatalogReference(optionReference);
      if (!Array.isArray(references) || references.length < 1 || !unique(references)) blocked();
      for (const reference of references) allReferences.add(reference);
    }
    const union = new Map<
      ReturnType<typeof parseCatalogReference>,
      Exclude<AllergenClassification, "Unverified">
    >();
    for (const reference of allReferences) {
      const source = evidenceByReference.get(parseCatalogReference(reference));
      if (source === undefined) blocked();
      for (const assertion of source.assertions) {
        if (!registryByReference.has(assertion.allergenReference)) blocked();
        const classification = assertion.classification as Exclude<
          AllergenClassification,
          "Unverified"
        >;
        union.set(
          assertion.allergenReference,
          strongest(union.get(assertion.allergenReference), classification),
        );
      }
    }
    const items: AllergenDisclosureItem[] = [...union.entries()]
      .map(([allergenReference, classification]) => {
        const entry = registryByReference.get(allergenReference);
        if (entry === undefined) return blocked();
        return Object.freeze({ ...entry, classification });
      })
      .sort((left, right) => left.code.localeCompare(right.code));
    let byChoice: AllergenChoiceDisclosure | undefined;
    if (path.choiceEvidence !== undefined) {
      const choice = parseChoiceEvidence(
        path.choiceEvidence,
        allReferences as ReadonlySet<CatalogReference>,
        new Set(Object.keys(path.optionEvidenceReferences)),
      );
      // Each evidence outcome as allergens; equal allergen outcomes are stored once.
      const outcomes: (readonly AllergenChoiceItem[])[] = [];
      const outcomeIndex = new Map<string, number>();
      const remap = choice.outcomes.map((references) => {
        const found = new Map<CatalogReference, Exclude<AllergenClassification, "Unverified">>();
        for (const reference of references) {
          const source = evidenceByReference.get(reference);
          if (source === undefined) return blocked();
          for (const assertion of source.assertions)
            found.set(
              assertion.allergenReference,
              strongest(
                found.get(assertion.allergenReference),
                assertion.classification as Exclude<AllergenClassification, "Unverified">,
              ),
            );
        }
        const outcome = Object.freeze(
          [...found.entries()]
            .map(([allergenReference, classification]) => {
              const entry = registryByReference.get(allergenReference);
              if (entry === undefined) return blocked();
              return Object.freeze({ code: entry.code, classification });
            })
            .sort((left, right) => left.code.localeCompare(right.code)),
        );
        const key = JSON.stringify(outcome);
        const existing = outcomeIndex.get(key);
        if (existing !== undefined) return existing;
        outcomeIndex.set(key, outcomes.length);
        outcomes.push(outcome);
        return outcomes.length - 1;
      });
      byChoice = Object.freeze({
        options: choice.options,
        outcomes: Object.freeze(outcomes),
        sets: Object.freeze(
          choice.sets.map(([outcome, ...chosen]) =>
            Object.freeze([remap[outcome as number] as number, ...chosen]),
          ),
        ),
      });
    }
    disclosures[sellableReference] = Object.freeze({
      registryVersionReference,
      items: Object.freeze(items),
      allergenFreeClaim: false,
      assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
      ...(byChoice === undefined ? {} : { byChoice }),
    });
  }
  if (snapshot.paths.length < 1) blocked();
  const validUntil = evidence.reduce(
    (earliest, item) =>
      Date.parse(item.validUntil) < Date.parse(earliest) ? item.validUntil : earliest,
    evidence[0]?.validUntil ?? blocked(),
  );
  return Object.freeze({
    validation: createPublishingValidationEvidence({
      evidenceReference: parseCatalogReference(input.evidenceReference) as never,
      snapshotReference: menuVersionReference as never,
      snapshotDigest,
      scope: { kind: "Brand", brandReference: brandReference as never, storeReference: null },
      result: "Pass",
      checkedAt: checkedAt as never,
      validUntil: validUntil as never,
      checkCodes: [
        "INGREDIENT_PROVENANCE_PINNED",
        "ALLERGEN_SOURCES_VERIFIED",
        "ALLERGEN_OPTION_UNION_VERIFIED",
        "ALLERGEN_DISCLOSURE_READY",
      ] as never,
    }),
    disclosures: Object.freeze(disclosures),
  });
}
