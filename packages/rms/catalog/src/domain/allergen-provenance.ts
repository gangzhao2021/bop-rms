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
export interface MenuAllergenPath {
  readonly sellableReference: CatalogReference;
  readonly productVersionReference: CatalogReference;
  readonly evidenceReferences: readonly CatalogReference[];
  readonly optionEvidenceReferences: Readonly<Record<string, readonly CatalogReference[]>>;
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
export interface SellableAllergenDisclosure {
  readonly registryVersionReference: CatalogReference;
  readonly items: readonly AllergenDisclosureItem[];
  readonly allergenFreeClaim: false;
  readonly assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED";
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

function registryEntry(value: AllergenRegistryEntry, defaultLocale: string): AllergenRegistryEntry {
  return Object.freeze({
    allergenReference: parseCatalogReference(value.allergenReference),
    code: parseCatalogCode(value.code),
    localizedNames: parseLocalizedNames(value.localizedNames, defaultLocale),
  });
}

function sourceEvidence(value: AllergenSourceEvidence, at: string): AllergenSourceEvidence {
  if (
    !["Ingredient", "Recipe", "Product", "Option"].includes(value.subjectKind) ||
    !["Approved", "Invalidated", "Conflicting"].includes(value.status) ||
    !Array.isArray(value.assertions) ||
    value.assertions.length < 1
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
    snapshot.registry.map((entry) => registryEntry(entry, defaultLocale)),
  );
  if (
    registry.length < 1 ||
    !unique(registry.map((entry) => entry.allergenReference)) ||
    !unique(registry.map((entry) => entry.code))
  )
    blocked();
  const registryByReference = new Map(registry.map((entry) => [entry.allergenReference, entry]));
  const evidence = Object.freeze(
    snapshot.evidence.map((entry) => sourceEvidence(entry, checkedAt)),
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
    const allReferences = [...path.evidenceReferences];
    for (const [optionReference, references] of Object.entries(path.optionEvidenceReferences)) {
      parseCatalogReference(optionReference);
      if (!Array.isArray(references) || references.length < 1) blocked();
      allReferences.push(...references);
    }
    if (!unique(allReferences)) blocked();
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
    disclosures[sellableReference] = Object.freeze({
      registryVersionReference,
      items: Object.freeze(items),
      allergenFreeClaim: false,
      assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
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
