import { describe, expect, it } from "vitest";

import {
  CatalogError,
  allergenDisclosureForChoice,
  parseCatalogReference,
  parseSellableAllergenDisclosure,
  createMenuAllergenValidationService,
  transitionMenuPublication,
  validateMenuAllergenProvenance,
  type MenuAllergenProvenanceSnapshot,
  type MenuAllergenValidationCommand,
} from "../index.js";

const id = (n: number) => `018f7700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T16:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;

function snapshot(): MenuAllergenProvenanceSnapshot {
  return {
    brandReference: id(1) as never,
    menuVersionReference: id(2) as never,
    snapshotDigest: digest as never,
    registryVersionReference: id(3) as never,
    defaultLocale: "en-CA",
    registry: [
      {
        allergenReference: id(4) as never,
        code: "MILK" as never,
        localizedNames: { "en-CA": "Milk", "fr-CA": "Lait" },
      },
      {
        allergenReference: id(5) as never,
        code: "PEANUT" as never,
        localizedNames: { "en-CA": "Peanut", "fr-CA": "Arachide" },
      },
    ],
    evidence: [
      {
        evidenceReference: id(6) as never,
        subjectReference: id(7) as never,
        subjectKind: "Recipe",
        sourceVersionReference: id(8) as never,
        supplierReference: null,
        documentDigest: digest as never,
        reviewedAt: at as never,
        validUntil: "2026-08-03T16:00:00.000Z" as never,
        status: "Approved",
        assertions: [{ allergenReference: id(4) as never, classification: "CrossContactPossible" }],
      },
      {
        evidenceReference: id(9) as never,
        subjectReference: id(10) as never,
        subjectKind: "Option",
        sourceVersionReference: id(11) as never,
        supplierReference: id(12) as never,
        documentDigest: digest as never,
        reviewedAt: at as never,
        validUntil: "2026-08-04T16:00:00.000Z" as never,
        status: "Approved",
        assertions: [
          { allergenReference: id(4) as never, classification: "Contains" },
          { allergenReference: id(5) as never, classification: "CrossContactPossible" },
        ],
      },
    ],
    paths: [
      {
        sellableReference: id(13) as never,
        productVersionReference: id(14) as never,
        evidenceReferences: [id(6) as never],
        optionEvidenceReferences: { [id(15)]: [id(9) as never] },
      },
    ],
  };
}

function service(value = snapshot()) {
  return createMenuAllergenValidationService({
    facts: {
      async load() {
        return value;
      },
    },
    references: {
      generate() {
        return id(16) as never;
      },
    },
  });
}

const command = {
  brandReference: id(1),
  menuVersionReference: id(2),
  snapshotDigest: digest,
  requestedAt: at,
} as MenuAllergenValidationCommand;

describe("WP-1028 Pilot allergen provenance", () => {
  it("pins source versions and computes the base plus Option allergen union", async () => {
    const result = await service().validate(command);
    expect(result.disclosures[id(13)]).toMatchObject({
      registryVersionReference: id(3),
      allergenFreeClaim: false,
      assistanceCode: "ALLERGEN_ASSISTANCE_REQUIRED",
      items: [
        { code: "MILK", classification: "Contains" },
        { code: "PEANUT", classification: "CrossContactPossible" },
      ],
    });
    expect(result.validation).toMatchObject({
      result: "Pass",
      validUntil: "2026-08-03T16:00:00.000Z",
      checkCodes: [
        "INGREDIENT_PROVENANCE_PINNED",
        "ALLERGEN_SOURCES_VERIFIED",
        "ALLERGEN_OPTION_UNION_VERIFIED",
        "ALLERGEN_DISCLOSURE_READY",
      ],
    });
  });

  it("provides exact evidence that unlocks Submit Review for the same Menu snapshot", async () => {
    const result = await service().validate(command);
    expect(
      transitionMenuPublication({
        operation: "SubmitReview",
        current: {
          lifecycleId: id(17),
          familyReference: id(18),
          configurationType: "MENU",
          purposeCode: "CUSTOMER_ORDERING",
          snapshotReference: id(2),
          snapshotDigest: digest,
          scope: { kind: "Brand", brandReference: id(1), storeReference: null },
          version: 1,
          state: "Draft",
          validationEvidenceReference: null,
          approvalEvidenceReference: null,
          createdAt: at,
          changedAt: at,
        } as never,
        validation: result.validation,
        approval: null,
        at,
      }),
    ).toMatchObject({ state: "InReview", validationEvidenceReference: id(16) });
  });

  it("blocks unknown or invalidated sources instead of inferring absence", async () => {
    const unverifiedBase = snapshot();
    const unverified = {
      ...unverifiedBase,
      evidence: [
        {
          ...unverifiedBase.evidence[0],
          assertions: [{ allergenReference: id(4), classification: "Unverified" }],
        },
        ...unverifiedBase.evidence.slice(1),
      ],
    } as MenuAllergenProvenanceSnapshot;
    await expect(service(unverified).validate(command)).rejects.toBeInstanceOf(CatalogError);
    const invalidatedBase = snapshot();
    const invalidated = {
      ...invalidatedBase,
      evidence: [
        { ...invalidatedBase.evidence[0], status: "Invalidated" },
        ...invalidatedBase.evidence.slice(1),
      ],
    } as MenuAllergenProvenanceSnapshot;
    await expect(service(invalidated).validate(command)).rejects.toBeInstanceOf(CatalogError);
    const conflictingBase = snapshot();
    const conflicting = {
      ...conflictingBase,
      evidence: [
        { ...conflictingBase.evidence[0], status: "Conflicting" },
        ...conflictingBase.evidence.slice(1),
      ],
    } as MenuAllergenProvenanceSnapshot;
    await expect(service(conflicting).validate(command)).rejects.toBeInstanceOf(CatalogError);
  });

  it("blocks unresolved Option paths and exact-snapshot mismatches", async () => {
    const missingBase = snapshot();
    const path = missingBase.paths[0];
    if (path === undefined) throw new Error("expected path");
    const missing = {
      ...missingBase,
      paths: [
        {
          ...path,
          optionEvidenceReferences: { [id(15)]: [id(99) as never] },
        },
      ],
    } as MenuAllergenProvenanceSnapshot;
    await expect(service(missing).validate(command)).rejects.toBeInstanceOf(CatalogError);
    await expect(
      service().validate({
        ...command,
        snapshotDigest: `sha256:${"b".repeat(64)}`,
      } as never),
    ).rejects.toBeInstanceOf(CatalogError);
  });
});

it("unions shared source evidence across base and options but rejects repeats within one path", async () => {
  const ref = (n: number) => parseCatalogReference(id(n));
  const value = snapshot();
  const path = value.paths[0];
  if (!path) throw new Error("fixture");
  const shared = {
    ...value,
    paths: [
      {
        ...path,
        optionEvidenceReferences: {
          [ref(15)]: [ref(6), ref(9)],
          [ref(20)]: [ref(9)],
        },
      },
    ],
  } as MenuAllergenProvenanceSnapshot;
  const result = await service(shared).validate(command);
  expect(result.disclosures[id(13)]?.items).toHaveLength(2);
  await expect(
    service({
      ...shared,
      paths: [{ ...path, evidenceReferences: [ref(6), ref(6)] }],
    } as MenuAllergenProvenanceSnapshot).validate(command),
  ).rejects.toBeInstanceOf(CatalogError);
  await expect(
    service({
      ...shared,
      paths: [
        {
          ...path,
          optionEvidenceReferences: { [ref(15)]: [ref(9), ref(9)] },
        },
      ],
    } as MenuAllergenProvenanceSnapshot).validate(command),
  ).rejects.toBeInstanceOf(CatalogError);
});

describe("WP-2423 ⑪ allergens for the chosen options", () => {
  const withChoices = (choiceEvidence: unknown) => {
    const value = snapshot();
    return {
      ...value,
      paths: [{ ...value.paths[0], choiceEvidence }],
    } as unknown as MenuAllergenProvenanceSnapshot;
  };
  // Without the option the item has only the base recipe's evidence; with it, both.
  const choices = {
    options: [id(15)],
    outcomes: [[id(6)], [id(6), id(9)], [id(9), id(6)]],
    sets: [[0], [1, 0]],
  };

  it("discloses exactly what each reviewed set of chosen options contains", async () => {
    const disclosure = (await service(withChoices(choices)).validate(command)).disclosures[id(13)];
    if (!disclosure) throw new Error("fixture");
    // The union for the menu card is unchanged.
    expect(disclosure.items.map((item) => [item.code, item.classification])).toEqual([
      ["MILK", "Contains"],
      ["PEANUT", "CrossContactPossible"],
    ]);
    // Equal outcomes are stored once.
    expect(disclosure.byChoice?.outcomes).toHaveLength(2);
    expect(
      allergenDisclosureForChoice(disclosure, [])?.map((item) => [item.code, item.classification]),
    ).toEqual([["MILK", "CrossContactPossible"]]);
    expect(
      allergenDisclosureForChoice(disclosure, [id(15), id(15)])?.map((item) => [
        item.code,
        item.classification,
        item.localizedNames["fr-CA"],
      ]),
    ).toEqual([
      ["MILK", "Contains", "Lait"],
      ["PEANUT", "CrossContactPossible", "Arachide"],
    ]);
    // An option or set the review did not cover never narrows the disclosure.
    expect(allergenDisclosureForChoice(disclosure, [id(99)])).toBeNull();
    const older = Object.fromEntries(
      Object.entries(disclosure).filter(([key]) => key !== "byChoice"),
    ) as unknown as typeof disclosure;
    expect(allergenDisclosureForChoice(older, [])).toBeNull();
    // The published projection keeps it.
    const stored = parseSellableAllergenDisclosure(JSON.parse(JSON.stringify(disclosure)), "en-CA");
    expect(stored.byChoice).toEqual(disclosure.byChoice);
  });

  it("refuses per-choice evidence that does not match the reviewed path", async () => {
    for (const invalid of [
      { ...choices, options: [id(99)] },
      { ...choices, outcomes: [[id(98)]] },
      { ...choices, sets: [[0], [1, 0], [0]] },
      { ...choices, sets: [[5]] },
      { ...choices, sets: [[0, 1]] },
      { ...choices, sets: [] },
    ])
      await expect(service(withChoices(invalid)).validate(command)).rejects.toBeInstanceOf(
        CatalogError,
      );
  });
});

describe("WP-2423 item 12: what each choice declares by itself", () => {
  const owned = (optionOwnEvidence: unknown) => {
    const value = snapshot();
    return {
      ...value,
      paths: value.paths.map((path) => ({ ...path, optionOwnEvidence })),
    } as MenuAllergenProvenanceSnapshot;
  };
  const validate = (value: MenuAllergenProvenanceSnapshot) =>
    validateMenuAllergenProvenance({
      snapshot: value,
      evidenceReference: id(16),
      checkedAt: at,
    }).disclosures[id(13)];

  it("states each choice's own allergens at their strongest, sorted, and survives storage", () => {
    const disclosure = validate(owned({ [id(15)]: [id(6), id(9)] }));
    // Milk is "may contain" in the base's evidence and "contains" in the choice's: contains wins.
    expect(disclosure?.byOption).toEqual({
      [id(15)]: [
        { code: "MILK", classification: "Contains" },
        { code: "PEANUT", classification: "CrossContactPossible" },
      ],
    });
    const stored = JSON.parse(JSON.stringify(disclosure)) as NonNullable<typeof disclosure>;
    expect(parseSellableAllergenDisclosure(stored, "en-CA").byOption).toEqual(disclosure?.byOption);
  });

  it("an evidence record with no assertions states none of the listed allergens", () => {
    const value = owned({ [id(15)]: [id(9)] });
    const none = {
      ...value,
      evidence: value.evidence.map((item) =>
        item.evidenceReference === id(9) ? { ...item, assertions: [] } : item,
      ),
    };
    expect(validate(none)?.byOption).toEqual({ [id(15)]: [] });
  });

  it("items and paths without the fact carry none", () => {
    expect(validate(snapshot())?.byOption).toBeUndefined();
  });

  it("blocks a choice the path doesn't cover and evidence the path didn't pin", () => {
    for (const bad of [
      { [id(99)]: [id(9)] },
      { [id(15)]: [id(99)] },
      { [id(15)]: [] },
      { [id(15)]: [id(9), id(9)] },
      {},
      [],
      null,
    ])
      expect(() => validate(owned(bad))).toThrow(CatalogError);
  });

  it("refuses a stored disclosure whose choice names an allergen it doesn't list", () => {
    const disclosure = validate(owned({ [id(15)]: [id(9)] }));
    if (disclosure === undefined) throw new Error("disclosure");
    for (const bad of [
      { [id(15)]: [{ code: "SOY", classification: "Contains" }] },
      { [id(15)]: [{ code: "MILK", classification: "Unverified" }] },
      { "not-a-reference": [] },
      {},
    ])
      expect(() =>
        parseSellableAllergenDisclosure({ ...disclosure, byOption: bad } as never, "en-CA"),
      ).toThrow(CatalogError);
  });
});
