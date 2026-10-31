import { expect, it } from "vitest";
import { compareCatalogOptionSetContent } from "../contracts/option-set-content-comparison.js";
import { materializeFullOptionSetCreation } from "../contracts/option-set-full-create.js";

const id = (n: number) => "01902421-9900-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-05T12:00:00.000Z";
function content() {
  return materializeFullOptionSetCreation(
    {
      internalCode: "SYNTHETIC_COMPARE",
      operationReference: id(30),
      occurredAt: at,
      reasonCode: "INITIAL_CONFIGURATION",
      draft: {
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic choices" },
        localizedDescriptions: {},
        displayStyle: "MultiChoice",
        minimumSelection: 0,
        maximumSelection: 1,
        allowRepeatedOption: false,
        perOptionMaximumQuantity: 1,
        maximumTotalQuantity: 1,
        options: [
          {
            stableCode: "A",
            lifecycle: "Active",
            localizedNames: { "en-CA": "Original" },
            localizedDescriptions: {},
            sortOrder: 0,
            defaultEligible: true,
            triggeredOptionSetReference: null,
            conflictOptionCodes: [],
          },
        ],
      },
      additionalContent: {
        profile: "CatalogOptionSetEditorContentV1",
        optionDetails: [
          {
            stableCode: "A",
            quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
            media: null,
            pricingRule: null,
            consumption: null,
            triggeredOptionSetVersionReference: null,
          },
        ],
        conditionalRules: [],
        conflictRules: [],
        scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: {
            instant: at,
            localDateTime: at.slice(0, 23),
            utcOffsetMinutes: 0,
          },
          effectiveUntil: null,
        },
      },
    },
    {
      brandReference: id(10),
      actorReference: id(40),
      allocations: {
        optionSetReference: id(1),
        versionReference: id(2),
        options: [{ stableCode: "A", optionReference: id(3) }],
      },
    },
  ).content;
}
it("distinguishes source revision from semantic business changes", () => {
  const left = content(),
    right = structuredClone(left);
  const later = "2026-10-05T12:00:01.000Z";
  Object.assign(right.sourceAggregate, { aggregateVersion: 2, updatedAt: later });
  Object.assign(right.sourceAggregate.draft, { updatedAt: later });
  const result = compareCatalogOptionSetContent({ left, right });
  expect(result.left.sourceDigest).not.toBe(result.right.sourceDigest);
  expect(result.businessContentChanged).toBe(false);
  expect(result.fields).toEqual([]);
  expect(result.options).toEqual([]);
  expect(result.referenceEligibility).toBe("NotEvaluated");
  expect(result.publicationStatus).toBe("NotEvaluated");
});
it("shows exact field values and changed Options by stable identity without modifying originals", () => {
  const left = content(),
    right = structuredClone(left);
  Object.assign(right.sourceAggregate.draft.localizedNames, { "en-CA": "Changed choices" });
  const option = right.sourceAggregate.draft.options[0];
  if (!option) throw new Error("Missing synthetic Option");
  Object.assign(option.localizedNames, { "en-CA": "Changed option" });
  const before = structuredClone(left);
  const result = compareCatalogOptionSetContent({ left, right });
  expect(result.fields).toEqual([
    {
      field: "localizedNames",
      left: { "en-CA": "Synthetic choices" },
      right: { "en-CA": "Changed choices" },
    },
  ]);
  expect(result.options).toMatchObject([
    {
      optionReference: id(3),
      change: "Changed",
      left: { localizedNames: { "en-CA": "Original" } },
      right: { localizedNames: { "en-CA": "Changed option" } },
    },
  ]);
  expect(result.businessContentChanged).toBe(true);
  expect(left).toEqual(before);
  expect(Object.isFrozen(result.options)).toBe(true);
});
it("includes additional configuration changes and identifies added and removed Option identities", () => {
  const left = content(),
    right = structuredClone(left);
  const option = right.sourceAggregate.draft.options[0];
  const detail = right.optionDetails[0];
  if (!option || !detail) throw new Error("Missing synthetic Option");
  Object.assign(option, { optionReference: id(4), stableCode: "B" });
  Object.assign(detail, { optionReference: id(4) });
  const result = compareCatalogOptionSetContent({ left, right });
  expect(result.options.map((item) => [item.optionReference, item.change])).toEqual([
    [id(3), "Removed"],
    [id(4), "Added"],
  ]);
  expect(result.fields.map((item) => item.field)).toEqual(["optionDetails"]);
});
it("refuses cross-Brand/set content and malformed snapshots or accessor input", () => {
  const left = content();
  for (const field of ["brandReference", "optionSetReference"] as const) {
    const right = structuredClone(left);
    Object.assign(right.sourceAggregate, { [field]: id(90) });
    for (const option of right.sourceAggregate.draft.options)
      Object.assign(option, { [field]: id(90) });
    expect(() => compareCatalogOptionSetContent({ left, right })).toThrow();
  }
  expect(() => compareCatalogOptionSetContent({ left, right: {} })).toThrow();
  const getter = {
    get left() {
      throw new Error("Getter must not run");
    },
    right: left,
  };
  expect(() => compareCatalogOptionSetContent(getter)).toThrow();
});

it("refuses contradictory immutable identity rather than displaying a fictional history change", () => {
  const left = content();
  const right = structuredClone(left);
  Object.assign(right.sourceAggregate, { internalCode: "DIFFERENT_IDENTITY" });
  expect(() => compareCatalogOptionSetContent({ left, right })).toThrow();
  const inconsistentOption = structuredClone(left);
  const option = inconsistentOption.sourceAggregate.draft.options[0];
  if (!option) throw new Error("Missing synthetic Option");
  Object.assign(option, { stableCode: "DIFFERENT_CODE" });
  expect(() => compareCatalogOptionSetContent({ left, right: inconsistentOption })).toThrow();
});
