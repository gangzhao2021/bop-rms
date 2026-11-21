import { expect, it, vi } from "vitest";
import { materializeFullOptionSetCreation } from "../contracts/option-set-full-create.js";
import {
  parseFullOptionSetEditCommand,
  materializeFullOptionSetEdit,
} from "../contracts/option-set-full-edit.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const initialAt = "2026-10-04T00:00:00.000Z",
  at = "2026-10-04T00:00:01.000Z";
function fixture() {
  const additional = {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: [
      {
        stableCode: "OLD",
        quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
        media: null,
        pricingRule: null,
        consumption: {
          kind: "Inventory",
          reference: id(60),
          versionReference: id(61),
          quantity: "1",
          unitCode: "GRAM",
        },
        triggeredOptionSetVersionReference: null,
      },
    ],
    conditionalRules: [],
    conflictRules: [],
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: {
        instant: initialAt,
        localDateTime: initialAt.slice(0, 23),
        utcOffsetMinutes: 0,
      },
      effectiveUntil: null,
    },
  };
  const core = {
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic choices" },
    localizedDescriptions: {},
    displayStyle: "MultiChoice",
    minimumSelection: 0,
    maximumSelection: 2,
    allowRepeatedOption: false,
    perOptionMaximumQuantity: 1,
    maximumTotalQuantity: 2,
  };
  const option = {
    stableCode: "OLD",
    lifecycle: "Active",
    localizedNames: { "en-CA": "Synthetic old" },
    localizedDescriptions: {},
    sortOrder: 0,
    defaultEligible: true,
    triggeredOptionSetReference: null,
    conflictOptionCodes: [],
  };
  const original = materializeFullOptionSetCreation(
    {
      internalCode: "CHOICES",
      draft: { ...core, options: [option] },
      additionalContent: additional,
      operationReference: id(30),
      occurredAt: initialAt,
      reasonCode: "INITIAL_CONFIGURATION",
    },
    {
      brandReference: id(10),
      actorReference: id(40),
      allocations: {
        optionSetReference: id(1),
        versionReference: id(2),
        options: [{ stableCode: "OLD", optionReference: id(3) }],
      },
    },
  );
  const command = {
    optionSetReference: id(1),
    expectedAggregateVersion: 1,
    draft: {
      ...core,
      options: [
        {
          ...option,
          stableCode: "NEW",
          localizedNames: { "en-CA": "Synthetic new" },
          defaultEligible: false,
          identity: { kind: "New" },
        },
      ],
    },
    additionalContent: {
      ...additional,
      optionDetails: [
        {
          stableCode: "NEW",
          quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
          media: null,
          pricingRule: null,
          consumption: null,
          triggeredOptionSetVersionReference: null,
        },
      ],
    },
    archiveOptionReferences: [id(3)],
    operationReference: id(31),
    occurredAt: at,
    reasonCode: "CONFIGURATION_EDIT",
  };
  const allocation = [{ stableCode: "NEW", optionReference: id(4) }];
  return { original, command, allocation };
}
function requiredValue<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  if (value === undefined) throw new Error("required synthetic fixture item missing");
  return value;
}

it("appends server identity and archives original identity with immutable metadata and complete details", () => {
  const f = fixture(),
    result = materializeFullOptionSetEdit(f.command, f.original.content, {
      actorReference: id(41),
      newOptions: f.allocation,
    });
  const added = requiredValue(
    result.content.sourceAggregate.draft.options.find((o) => o.stableCode === "NEW"),
  );
  const archived = requiredValue(
    result.content.sourceAggregate.draft.options.find((o) => o.stableCode === "OLD"),
  );
  expect(added).toMatchObject({
    optionReference: id(4),
    createdAt: at,
    createdByActorReference: id(41),
  });
  expect(archived).toMatchObject({
    optionReference: id(3),
    lifecycle: "Archived",
    defaultEligible: false,
    createdAt: initialAt,
    createdByActorReference: id(40),
  });
  expect(result.content.sourceAggregate.draft.createdAt).toBe(initialAt);
  expect(result.content.sourceAggregate.createdByActorReference).toBe(id(40));
  expect(result.content.optionDetails.find((d) => d.optionReference === id(3))).toEqual(
    f.original.content.optionDetails[0],
  );
  expect(result.content.scopeSet).toEqual(f.original.content.scopeSet);
  expect(result.referenceEligibility).toBe("NotEvaluated");
});
it("has allocation-free canonical original intent and rejects caller-specified New UUID/creation fields", () => {
  const f = fixture(),
    parsed = parseFullOptionSetEditCommand(f.command);
  for (const option of parsed.draft.options) {
    expect(option.identity).toEqual({ kind: "New" });
    expect(option).not.toHaveProperty("optionReference");
  }
  expect(parseFullOptionSetEditCommand(parsed)).toEqual(parsed);
  for (const field of ["optionReference", "createdAt", "createdByActorReference"]) {
    const option = requiredValue(f.command.draft.options[0]);
    expect(() =>
      parseFullOptionSetEditCommand({
        ...f.command,
        draft: { ...f.command.draft, options: [{ ...option, [field]: id(99) }] },
      }),
    ).toThrow();
  }
  expect(() =>
    parseFullOptionSetEditCommand({
      ...f.command,
      draft: {
        ...f.command.draft,
        options: [
          {
            ...requiredValue(f.command.draft.options[0]),
            identity: { kind: "New", optionReference: id(99) },
          },
        ],
      },
    }),
  ).toThrow();
});
it("rejects an omitted, duplicate, unknown or re-keyed original identity", () => {
  const f = fixture();
  expect(() =>
    materializeFullOptionSetEdit(
      { ...f.command, archiveOptionReferences: [] },
      f.original.content,
      { actorReference: id(41), newOptions: f.allocation },
    ),
  ).toThrow();
  expect(() =>
    parseFullOptionSetEditCommand({ ...f.command, archiveOptionReferences: [id(3), id(3)] }),
  ).toThrow();
  expect(() =>
    materializeFullOptionSetEdit(
      { ...f.command, archiveOptionReferences: [id(99)] },
      f.original.content,
      { actorReference: id(41), newOptions: f.allocation },
    ),
  ).toThrow();
  const renamed = {
    ...f.command,
    archiveOptionReferences: [],
    draft: {
      ...f.command.draft,
      options: [
        {
          ...requiredValue(f.command.draft.options[0]),
          identity: { kind: "Existing", optionReference: id(3) },
        },
      ],
    },
  };
  expect(() =>
    materializeFullOptionSetEdit(renamed, f.original.content, {
      actorReference: id(41),
      newOptions: [],
    }),
  ).toThrow();
});
it("Inactive remains an explicitly retained identity; original creation metadata cannot be supplied or changed", () => {
  const f = fixture(),
    option = requiredValue(f.command.draft.options[0]);
  const command = {
    ...f.command,
    archiveOptionReferences: [],
    draft: {
      ...f.command.draft,
      options: [
        {
          ...option,
          stableCode: "OLD",
          lifecycle: "Inactive",
          defaultEligible: false,
          identity: { kind: "Existing", optionReference: id(3) },
        },
      ],
    },
    additionalContent: {
      ...f.command.additionalContent,
      optionDetails: f.command.additionalContent.optionDetails.map((d) => ({
        ...d,
        stableCode: "OLD",
      })),
    },
  };
  const result = materializeFullOptionSetEdit(command, f.original.content, {
    actorReference: id(41),
    newOptions: [],
  });
  expect(result.content.sourceAggregate.draft.options[0]).toMatchObject({
    optionReference: id(3),
    lifecycle: "Inactive",
    createdAt: initialAt,
    createdByActorReference: id(40),
  });
});
it.each([
  { allocation: [] },
  { allocation: [{ stableCode: "NEW", optionReference: id(3) }] },
  { allocation: [{ stableCode: "OTHER", optionReference: id(4) }] },
  { allocation: [{ stableCode: "NEW", optionReference: id(2) }] },
])("rejects incomplete or colliding server allocations", ({ allocation }) => {
  const f = fixture();
  expect(() =>
    materializeFullOptionSetEdit(f.command, f.original.content, {
      actorReference: id(41),
      newOptions: allocation,
    }),
  ).toThrow();
});
it("rejects missing complete details, conflicting full rules and accessors without invoking them", () => {
  const f = fixture();
  expect(() =>
    parseFullOptionSetEditCommand({
      ...f.command,
      additionalContent: { ...f.command.additionalContent, optionDetails: [] },
    }),
  ).toThrow();
  const getter = vi.fn(() => f.command.draft);
  const value = { ...f.command };
  Object.defineProperty(value, "draft", { enumerable: true, get: getter });
  expect(() => parseFullOptionSetEditCommand(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("the total bound counts archived identities instead of silently dropping them", () => {
  const f = fixture();
  const options = Array.from({ length: 100 }, (_, n) => ({
    ...requiredValue(f.command.draft.options[0]),
    stableCode: "NEW_" + n,
    sortOrder: n,
  }));
  const command = {
    ...f.command,
    draft: { ...f.command.draft, options },
    additionalContent: {
      ...f.command.additionalContent,
      optionDetails: options.map((o) => ({
        ...requiredValue(f.command.additionalContent.optionDetails[0]),
        stableCode: o.stableCode,
      })),
    },
  };
  expect(() => parseFullOptionSetEditCommand(command)).toThrow();
});

it("a disabled retained option cannot remain default-eligible", () => {
  const f = fixture(),
    template = requiredValue(f.command.draft.options[0]);
  const command = {
    ...f.command,
    archiveOptionReferences: [],
    draft: {
      ...f.command.draft,
      options: [
        {
          ...template,
          identity: { kind: "Existing", optionReference: id(3) },
          stableCode: "OLD",
          lifecycle: "Inactive",
          defaultEligible: true,
        },
      ],
    },
    additionalContent: {
      ...f.command.additionalContent,
      optionDetails: f.command.additionalContent.optionDetails.map((detail) => ({
        ...detail,
        stableCode: "OLD",
      })),
    },
  };
  expect(() =>
    materializeFullOptionSetEdit(command, f.original.content, {
      actorReference: id(41),
      newOptions: [],
    }),
  ).toThrow();
});
it("full additional rules reject a required combination that is also forbidden", () => {
  const f = fixture(),
    first = requiredValue(f.command.draft.options[0]),
    second = { ...first, stableCode: "TWO", sortOrder: 1 };
  const command = {
    ...f.command,
    draft: { ...f.command.draft, options: [first, second] },
    additionalContent: {
      ...f.command.additionalContent,
      optionDetails: [
        requiredValue(f.command.additionalContent.optionDetails[0]),
        { ...requiredValue(f.command.additionalContent.optionDetails[0]), stableCode: "TWO" },
      ],
      conditionalRules: [
        { ruleReference: id(91), whenAllSelectedCodes: ["NEW"], requiredOptionCodes: ["TWO"] },
      ],
      conflictRules: [{ ruleReference: id(92), forbiddenTogetherCodes: ["NEW", "TWO"] }],
    },
  };
  expect(() =>
    materializeFullOptionSetEdit(command, f.original.content, {
      actorReference: id(41),
      newOptions: [...f.allocation, { stableCode: "TWO", optionReference: id(5) }],
    }),
  ).toThrow();
});
