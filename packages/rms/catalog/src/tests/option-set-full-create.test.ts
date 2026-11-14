import { expect, it, vi } from "vitest";
import {
  parseFullOptionSetCreateCommand,
  materializeFullOptionSetCreation,
} from "../contracts/option-set-full-create.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T12:00:00.000Z";
function fixture() {
  const command = {
    internalCode: "MILK",
    draft: {
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic choices" },
      localizedDescriptions: {},
      displayStyle: "MultiChoice",
      minimumSelection: 0,
      maximumSelection: 3,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 3,
      options: ["OAT", "SOY", "DAIRY"].map((stableCode, sortOrder) => ({
        stableCode,
        sortOrder,
        lifecycle: "Draft",
        localizedNames: { "en-CA": stableCode },
        localizedDescriptions: {},
        defaultEligible: true,
        triggeredOptionSetReference: null,
        conflictOptionCodes: stableCode === "OAT" ? ["DAIRY"] : [],
      })),
    },
    additionalContent: {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: ["OAT", "SOY", "DAIRY"].map((stableCode) => ({
        stableCode,
        quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
        media: null,
        pricingRule: null,
        consumption: null,
        triggeredOptionSetVersionReference: null,
      })),
      conditionalRules: [
        { ruleReference: id(40), whenAllSelectedCodes: ["OAT"], requiredOptionCodes: ["SOY"] },
      ],
      conflictRules: [{ ruleReference: id(41), forbiddenTogetherCodes: ["OAT", "DAIRY"] }],
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    },
    operationReference: id(50),
    occurredAt: at,
    reasonCode: "INITIAL_CONFIGURATION",
  };
  const server = {
    brandReference: id(10),
    actorReference: id(11),
    allocations: {
      optionSetReference: id(1),
      versionReference: id(2),
      options: [
        { stableCode: "OAT", optionReference: id(3) },
        { stableCode: "SOY", optionReference: id(4) },
        { stableCode: "DAIRY", optionReference: id(5) },
      ],
    },
  };
  return { command, server };
}
it("maps local codes exactly to server identities and complete original Draft rules", () => {
  const f = fixture(),
    p = materializeFullOptionSetCreation(f.command, f.server),
    root = p.content.sourceAggregate;
  expect(root.aggregateVersion).toBe(1);
  expect(root.createdByActorReference).toBe(id(11));
  expect(root.draft.options.map((o) => o.optionReference)).toEqual([id(3), id(4), id(5)]);
  expect(root.draft.options[0]?.conflictOptionReferences).toEqual([id(5)]);
  expect(p.content.conditionalRules[0]?.requiredOptionReferences).toEqual([id(4)]);
  expect(p.content.conflictRules[0]?.forbiddenTogether).toEqual([id(3), id(5)]);
  expect(p.referenceEligibility).toBe("NotEvaluated");
  f.command.draft.localizedNames["en-CA"] = "Later copy";
  f.server.allocations.options[0] = { stableCode: "OAT", optionReference: id(99) };
  expect(root.draft.localizedNames["en-CA"]).toBe("Synthetic choices");
  expect(root.draft.options[0]?.optionReference).toBe(id(3));
});
it("normalizes local code ordering without changing intent for reordered template arrays", () => {
  const f = fixture(),
    parsed = parseFullOptionSetCreateCommand(f.command);
  f.command.draft.options.reverse();
  f.command.additionalContent.optionDetails.reverse();
  expect(parseFullOptionSetCreateCommand(f.command)).toEqual(parsed);
});
it("does not execute nested accessors", () => {
  const f = fixture(),
    getter = vi.fn();
  Object.defineProperty(f.command.draft, "localizedNames", { enumerable: true, get: getter });
  expect(() => parseFullOptionSetCreateCommand(f.command)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
for (const [label, mutate] of [
  [
    "persistent Set ID",
    (c: Record<string, unknown>) => {
      c.optionSetReference = id(99);
    },
  ],
  [
    "Ready assertion",
    (c: Record<string, unknown>) => {
      c.referenceEligibility = "Ready";
    },
  ],
  [
    "version ID",
    (c: Record<string, unknown>) => {
      (c.draft as Record<string, unknown>).versionReference = id(99);
    },
  ],
] as const)
  it("refuses caller " + label, () => {
    const f = fixture();
    mutate(f.command);
    expect(() => materializeFullOptionSetCreation(f.command, f.server)).toThrow();
  });
for (const mode of [
  "duplicate-code",
  "unknown-conflict",
  "self-conflict",
  "missing-detail",
  "duplicate-detail",
  "unknown-condition",
  "contradiction",
  "invalid-lifecycle",
  "quantity",
  "duplicate-sort",
  "bad-pin",
  "extra-option-id",
  "duplicate-rule",
  "invalid-period",
  "101-options",
] as const)
  it("refuses " + mode, () => {
    const f = fixture(),
      a = f.command.draft.options[0],
      b = f.command.draft.options[1],
      d = f.command.additionalContent.optionDetails[0];
    if (!a || !b || !d) throw new Error("missing synthetic fixture");
    switch (mode) {
      case "duplicate-code":
        b.stableCode = a.stableCode;
        break;
      case "unknown-conflict":
        a.conflictOptionCodes = ["UNKNOWN"];
        break;
      case "self-conflict":
        a.conflictOptionCodes = ["OAT"];
        break;
      case "missing-detail":
        f.command.additionalContent.optionDetails.pop();
        break;
      case "duplicate-detail":
        d.stableCode = "SOY";
        break;
      case "unknown-condition":
        f.command.additionalContent.conditionalRules[0] = {
          ruleReference: id(40),
          whenAllSelectedCodes: ["UNKNOWN"],
          requiredOptionCodes: ["SOY"],
        };
        break;
      case "contradiction":
        f.command.additionalContent.conditionalRules[0] = {
          ruleReference: id(40),
          whenAllSelectedCodes: ["OAT"],
          requiredOptionCodes: ["DAIRY"],
        };
        break;
      case "invalid-lifecycle":
        a.lifecycle = "Unsupported";
        break;
      case "quantity":
        d.quantityRule.maximumQuantity = 2;
        break;
      case "duplicate-sort":
        b.sortOrder = a.sortOrder;
        break;
      case "bad-pin":
        Object.assign(d, { pricingRule: { reference: id(9), versionReference: "opaque" } });
        break;
      case "extra-option-id":
        Object.assign(a, { optionReference: id(9) });
        break;
      case "duplicate-rule":
        f.command.additionalContent.conflictRules[0] = {
          ruleReference: id(40),
          forbiddenTogetherCodes: ["OAT", "DAIRY"],
        };
        break;
      case "invalid-period":
        f.command.additionalContent.effectivePeriod.timeZone = "Invalid/Synthetic";
        break;
      case "101-options":
        f.command.draft.options = Array.from({ length: 101 }, (_, i) => ({
          ...a,
          stableCode: "OPTION_" + i,
          sortOrder: i,
        }));
        break;
    }
    expect(() => materializeFullOptionSetCreation(f.command, f.server)).toThrow();
  });
for (const mode of [
  "repeat-id",
  "root-version-alias",
  "missing",
  "extra",
  "wrong-code",
  "invalid-id",
] as const)
  it("refuses server allocation " + mode, () => {
    const f = fixture(),
      a = f.server.allocations.options[0],
      b = f.server.allocations.options[1];
    if (!a || !b) throw new Error("missing fixture");
    if (mode === "repeat-id") b.optionReference = a.optionReference;
    if (mode === "root-version-alias")
      f.server.allocations.versionReference = f.server.allocations.optionSetReference;
    if (mode === "missing") f.server.allocations.options.pop();
    if (mode === "extra")
      f.server.allocations.options.push({ stableCode: "EXTRA", optionReference: id(99) });
    if (mode === "wrong-code") a.stableCode = "UNKNOWN";
    if (mode === "invalid-id") a.optionReference = "opaque";
    expect(() => materializeFullOptionSetCreation(f.command, f.server)).toThrow();
  });

it("keeps Inactive eligibility metadata without claiming a selected default or readiness", () => {
  const f = fixture();
  const o = f.command.draft.options[0];
  if (!o) throw new Error("missing fixture");
  o.lifecycle = "Inactive";
  expect(materializeFullOptionSetCreation(f.command, f.server).referenceEligibility).toBe(
    "NotEvaluated",
  );
});
it("rejects oversized UTF8 authoring before materialization", () => {
  const f = fixture();
  const o = f.command.draft.options[0];
  if (!o) throw new Error("missing fixture");
  f.command.draft.options = Array.from({ length: 100 }, (_, i) => ({
    ...o,
    stableCode: "OPTION_" + i,
    sortOrder: i,
    localizedNames: {
      "en-CA": "Synthetic",
      ...Object.fromEntries(Array.from({ length: 8 }, (_, j) => ["locale" + j, "x".repeat(2048)])),
    },
  }));
  expect(() => parseFullOptionSetCreateCommand(f.command)).toThrow();
});
