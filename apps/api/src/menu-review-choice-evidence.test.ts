import { canonicalizeRfc8785 } from "@bop/audit";
import { allergenDisclosureForChoice, validateMenuAllergenProvenance } from "@rms/catalog";
import { expect, it } from "vitest";
import {
  compactMenuChoiceEvidence,
  publishableOptionOwnEvidence,
} from "./menu-review-preparation-source.js";

const id = (n: number) => `018f7700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-23T12:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;

it("WP-2423 ⑪: compacts each reviewed set of chosen options so the menu discloses exactly what it contains", () => {
  const [milk, gluten, nuts] = [id(1), id(2), id(3)];
  // Evidence: whole milk, espresso beans, oat milk, hazelnut syrup (synthetic).
  const [wholeMilk, beans, oat, hazelnut] = [id(10), id(11), id(12), id(13)];
  // Options: oat milk replaces whole milk; a hazelnut syrup pump adds the syrup.
  const [oatOption, syrupOption] = [id(20), id(21)];
  const choices = new Map([
    ["", { options: [], evidence: new Set([wholeMilk, beans]) }],
    [oatOption, { options: [oatOption], evidence: new Set([oat, beans]) }],
    [syrupOption, { options: [syrupOption], evidence: new Set([wholeMilk, beans, hazelnut]) }],
    [
      [oatOption, syrupOption].sort().join(","),
      { options: [oatOption, syrupOption].sort(), evidence: new Set([oat, beans, hazelnut]) },
    ],
  ]);
  const compact = compactMenuChoiceEvidence(choices);
  expect(compact.options).toEqual([oatOption, syrupOption].sort());
  expect(compact.sets).toHaveLength(4);
  const evidence = (reference: string, assertions: { allergen: string; kind: string }[]) => ({
    evidenceReference: reference,
    subjectReference: id(100 + Number.parseInt(reference.slice(-2), 16)),
    subjectKind: "Ingredient",
    sourceVersionReference: id(200 + Number.parseInt(reference.slice(-2), 16)),
    supplierReference: null,
    documentDigest: digest,
    reviewedAt: "2026-10-22T12:00:00.000Z",
    validUntil: "2027-10-22T12:00:00.000Z",
    status: "Approved",
    assertions: assertions.map((item) => ({
      allergenReference: item.allergen,
      classification: item.kind,
    })),
  });
  const { disclosures } = validateMenuAllergenProvenance({
    snapshot: {
      brandReference: id(30),
      menuVersionReference: id(31),
      snapshotDigest: digest,
      registryVersionReference: id(32),
      defaultLocale: "en-CA",
      registry: [
        { allergenReference: milk, code: "MILK", localizedNames: { "en-CA": "Milk" } },
        {
          allergenReference: gluten,
          code: "GLUTEN",
          localizedNames: { "en-CA": "Gluten sources" },
        },
        { allergenReference: nuts, code: "TREE_NUTS", localizedNames: { "en-CA": "Tree nuts" } },
      ],
      evidence: [
        evidence(wholeMilk, [{ allergen: milk, kind: "Contains" }]),
        evidence(beans, []),
        evidence(oat, [{ allergen: gluten, kind: "Contains" }]),
        evidence(hazelnut, [{ allergen: nuts, kind: "CrossContactPossible" }]),
      ],
      paths: [
        {
          sellableReference: id(40),
          productVersionReference: id(41),
          evidenceReferences: [wholeMilk, beans, oat, hazelnut].sort(),
          optionEvidenceReferences: {
            [oatOption]: [oat, beans, hazelnut].sort(),
            [syrupOption]: [wholeMilk, beans, oat, hazelnut].sort(),
          },
          choiceEvidence: compact,
        },
      ],
    } as never,
    evidenceReference: id(50),
    checkedAt: at,
  });
  const disclosure = disclosures[id(40)];
  if (!disclosure) throw new Error("disclosure");
  const shown = (chosen: string[]) =>
    allergenDisclosureForChoice(disclosure, chosen)?.map(
      (item) => `${item.code}:${item.classification}`,
    );
  // The menu card keeps the union of every choice.
  expect(disclosure.items.map((item) => item.code)).toEqual(["GLUTEN", "MILK", "TREE_NUTS"]);
  expect(shown([])).toEqual(["MILK:Contains"]);
  expect(shown([oatOption])).toEqual(["GLUTEN:Contains"]);
  expect(shown([syrupOption])).toEqual(["MILK:Contains", "TREE_NUTS:CrossContactPossible"]);
  expect(shown([syrupOption, oatOption])).toEqual([
    "GLUTEN:Contains",
    "TREE_NUTS:CrossContactPossible",
  ]);
  expect(shown([id(99)])).toBeUndefined();
});

it("WP-2423 item 12: a choice's own evidence reads the same however the recipe changes were read", () => {
  const [first, second, third, fourth] = [id(61), id(62), id(63), id(64)];
  const pinned = new Set([id(70), id(71), id(72)]);
  const one = publishableOptionOwnEvidence(
    new Map<string, ReadonlySet<string> | null>([
      [second, new Set([id(71), id(70)])],
      [first, new Set([id(72)])],
    ]),
    pinned,
  );
  const other = publishableOptionOwnEvidence(
    new Map<string, ReadonlySet<string> | null>([
      [first, new Set([id(72)])],
      [second, new Set([id(70), id(71)])],
    ]),
    pinned,
  );
  // The provenance feeds the dependency digest compared when the review is approved: any other
  // order would make listing fail now and then with a version conflict.
  expect(canonicalizeRfc8785(one)).toBe(canonicalizeRfc8785(other));
  expect(Object.keys(one ?? {})).toEqual([first, second]);
  expect(one?.[second]).toEqual([id(70), id(71)]);
  // No statement about a choice: no recipe change, a sub-recipe, or evidence nothing pinned.
  expect(
    publishableOptionOwnEvidence(
      new Map<string, ReadonlySet<string> | null>([
        [first, new Set()],
        [second, null],
        [third, new Set([id(99)])],
        [fourth, new Set([id(70)])],
      ]),
      pinned,
    ),
  ).toEqual({ [fourth]: [id(70)] });
  // None at all leaves the path as it was: an item with only such choices doesn't change.
  expect(publishableOptionOwnEvidence(new Map(), pinned)).toBeNull();
});
