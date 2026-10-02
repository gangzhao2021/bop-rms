import { parsePublishingReference, parsePublishingVersion } from "@bop/publishing";
import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  applyCatalogProductCandidateValidation,
  type ProductCandidateValidationBinding,
} from "../application/product-candidate-validation.js";
import {
  parseProductPublicationCommand,
  parseProductPublicationValidation,
} from "../contracts/product-publication.js";
import { parseCatalogInstant } from "../index.js";
import { productPublicationCheckCodes } from "../domain/product-publication.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T11:00:00.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function fixture() {
  const command = parseProductPublicationCommand({
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(4),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 1,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: "sha256:" + "a".repeat(64),
    configurationDigest: "sha256:" + "b".repeat(64),
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC",
  });
  const validation = parseProductPublicationValidation({
    evidenceReference: id(7),
    productAggregateVersion: 1,
    contentDigest: command.contentDigest,
    configurationDigest: command.configurationDigest,
    scopeDigest: hash(command.scopeSet),
    periodDigest: hash(command.effectivePeriod),
    policyReference: id(8),
    policyVersion: 1,
    approvalPolicy: "Required",
    checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
    warningAcknowledgement: null,
    checkedAt: at,
    validUntil: "2026-10-02T11:00:30.000Z",
  });
  const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(5),
    versionReference: id(6),
    aggregateVersion: 1,
    contentDigest: command.contentDigest,
    configurationDigest: command.configurationDigest,
    originalIntentDigest: hash(command),
    policyReference: parsePublishingReference(id(8)),
    policyVersion: parsePublishingVersion(1),
    observedAt: parseCatalogInstant(at),
    validUntil: parseCatalogInstant("2026-10-02T11:00:05.000Z"),
    check: { code: "UniqueScope" as const, outcome: "HardError" as const },
  };
  return {
    command,
    validation,
    scope: {
      ...scope,
      skuPrerequisite: "NoActiveMember" as const,
      variantMappingPrerequisite: "NoExplicitUnmappedCombination" as const,
      optionSelectionPrerequisite: "NoExplicitDefaultBoundsViolation" as const,
      optionRulePrerequisite: "NoMechanicalContradiction" as const,
      internalCodeCheck: { code: "InternalCode" as const, outcome: "Pass" as const },
    },
    apply: (
      s: ProductCandidateValidationBinding = {
        ...scope,
        skuPrerequisite: "NoActiveMember",
        variantMappingPrerequisite: "NoExplicitUnmappedCombination",
        optionSelectionPrerequisite: "NoExplicitDefaultBoundsViolation",
        optionRulePrerequisite: "NoMechanicalContradiction",
        internalCodeCheck: { code: "InternalCode", outcome: "Pass" },
      },
      v = validation,
      now = at,
    ) => applyCatalogProductCandidateValidation(command, v, s, now),
  };
}

it("records missing Active SKU despite a supplied Pass, preserving other checks and evidence", () => {
  const f = fixture(),
    result = f.apply();
  expect(result.checks.find((x) => x.code === "PublishableSku")?.outcome).toBe("HardError");
  expect(result.checks.find((x) => x.code === "HardErrorsCleared")?.outcome).toBe("HardError");
  expect(result.validUntil).toBe(f.scope.validUntil);
  for (const check of f.validation.checks.filter(
    (x) => !["UniqueScope", "PublishableSku", "HardErrorsCleared"].includes(x.code),
  ))
    expect(result.checks).toContainEqual(check);
  expect(result.evidenceReference).toBe(f.validation.evidenceReference);
  expect(result.warningAcknowledgement).toBe(f.validation.warningAcknowledgement);
  expect(f.validation.checks.every((x) => x.outcome === "Pass")).toBe(true);
});
it.each(["Pass", "Warning", "HardError"] as const)(
  "Active presence never promotes independent %s",
  (outcome) => {
    const f = fixture(),
      v = parseProductPublicationValidation({
        ...f.validation,
        checks: f.validation.checks.map((x) => ({
          ...x,
          outcome:
            x.code === "PublishableSku"
              ? outcome
              : x.code === "HardErrorsCleared" && outcome === "HardError"
                ? "HardError"
                : "Pass",
        })),
      });
    const result = f.apply(
      {
        ...f.scope,
        check: { code: "UniqueScope", outcome: "Pass" },
        skuPrerequisite: "ActiveMemberPresent",
      },
      v,
    );
    expect(result.checks.find((x) => x.code === "PublishableSku")?.outcome).toBe(outcome);
  },
);
it("preserves unrelated acknowledged Warning with original Actor/Reason and independent HardError", () => {
  const f = fixture(),
    v = parseProductPublicationValidation({
      ...f.validation,
      checks: f.validation.checks.map((x) => ({
        ...x,
        outcome:
          x.code === "MediaReady"
            ? "Warning"
            : x.code === "TaxResolution" || x.code === "HardErrorsCleared"
              ? "HardError"
              : "Pass",
      })),
      warningAcknowledgement: {
        actorReference: id(3),
        reasonCode: "SYNTHETIC",
        warningCodes: ["MediaReady"],
      },
    }),
    result = f.apply(f.scope, v);
  expect(result.warningAcknowledgement).toEqual(v.warningAcknowledgement);
  expect(result.checks.find((x) => x.code === "TaxResolution")?.outcome).toBe("HardError");
});
it("cannot reinterpret an acknowledged SKU Warning as a HardError override", () => {
  const f = fixture(),
    v = parseProductPublicationValidation({
      ...f.validation,
      checks: f.validation.checks.map((x) => ({
        ...x,
        outcome: x.code === "PublishableSku" ? "Warning" : "Pass",
      })),
      warningAcknowledgement: {
        actorReference: id(3),
        reasonCode: "SYNTHETIC",
        warningCodes: ["PublishableSku"],
      },
    });
  expect(() => f.apply(f.scope, v)).toThrow();
});
it.each([
  "tenantReference",
  "brandReference",
  "productReference",
  "versionReference",
  "contentDigest",
  "configurationDigest",
  "originalIntentDigest",
  "policyReference",
] as const)("refuses foreign %s before merging", (key) => {
  const f = fixture();
  expect(() => f.apply({ ...f.scope, [key]: id(99) })).toThrow();
});
it.each(["aggregateVersion", "policyVersion"] as const)("refuses changed %s", (key) => {
  const f = fixture();
  expect(() => f.apply({ ...f.scope, [key]: 2 })).toThrow();
});
it.each(["2026-10-02T10:59:59.999Z", "2026-10-02T11:00:05.000Z"])(
  "refuses future/exclusive expired %s",
  (now) => {
    expect(() => fixture().apply(undefined, undefined, now)).toThrow();
  },
);
it.each([undefined, "Pass", "Unknown"])(
  "refuses missing/qualification-like SKU prerequisite %s",
  (value) => {
    const f = fixture();
    expect(() => f.apply({ ...f.scope, skuPrerequisite: value } as never)).toThrow();
  },
);
it("refuses accessor/extra packet/incomplete receipt and non Validate without invoking accessors", () => {
  const f = fixture(),
    get = vi.fn();
  expect(() =>
    f.apply(Object.defineProperty({ ...f.scope }, "skuPrerequisite", { get, enumerable: true })),
  ).toThrow();
  expect(get).not.toHaveBeenCalled();
  expect(() => f.apply({ ...f.scope, extra: true } as never)).toThrow();
  expect(() =>
    applyCatalogProductCandidateValidation(f.command, { ...f.validation, checks: [] }, f.scope, at),
  ).toThrow();
  expect(() =>
    applyCatalogProductCandidateValidation(
      { ...f.command, action: "SubmitReview" },
      f.validation,
      f.scope,
      at,
    ),
  ).toThrow();
});

it("merges actual owning InternalCode conflict without clearing independent outcomes", () => {
  const f = fixture(),
    result = f.apply({
      ...f.scope,
      skuPrerequisite: "ActiveMemberPresent",
      check: { code: "UniqueScope", outcome: "Pass" },
      internalCodeCheck: { code: "InternalCode", outcome: "HardError" },
    });
  expect(result.checks.find((x) => x.code === "InternalCode")?.outcome).toBe("HardError");
  expect(result.checks.find((x) => x.code === "HardErrorsCleared")?.outcome).toBe("HardError");
  expect(result.evidenceReference).toBe(f.validation.evidenceReference);
  expect(result.checks.find((x) => x.code === "PublishableSku")?.outcome).toBe("Pass");
});
it.each([
  undefined,
  { code: "InternalCode", outcome: "Warning" },
  { code: "InternalCode", outcome: "Pass", extra: true },
  { code: "PublishableSku", outcome: "Pass" },
])("refuses absent/malformed/foreign code check %s", (value) => {
  const f = fixture();
  expect(() => f.apply({ ...f.scope, internalCodeCheck: value } as never)).toThrow();
});
it("requires independent code placeholder and refuses its getter without invoking it", () => {
  const f = fixture(),
    get = vi.fn();
  expect(() =>
    f.apply({
      ...f.scope,
      internalCodeCheck: Object.defineProperty({ code: "InternalCode" }, "outcome", {
        get,
        enumerable: true,
      }),
    } as never),
  ).toThrow();
  expect(get).not.toHaveBeenCalled();
  const v = parseProductPublicationValidation({
    ...f.validation,
    checks: f.validation.checks.map((x) => ({
      ...x,
      outcome: x.code === "InternalCode" || x.code === "HardErrorsCleared" ? "HardError" : "Pass",
    })),
  });
  expect(() => f.apply(f.scope, v)).toThrow();
});

it("unmapped actual combination overrides supplied mapping Pass with HardError, independent of Active SKU", () => {
  const f = fixture(),
    r = f.apply({
      ...f.scope,
      skuPrerequisite: "ActiveMemberPresent",
      variantMappingPrerequisite: "UnmappedCombinationPresent",
      check: { code: "UniqueScope", outcome: "Pass" },
    });
  expect(r.checks.find((c) => c.code === "VariantMapping")?.outcome).toBe("HardError");
  expect(r.checks.find((c) => c.code === "HardErrorsCleared")?.outcome).toBe("HardError");
  expect(r.checks.find((c) => c.code === "PublishableSku")?.outcome).toBe("Pass");
  expect(r.evidenceReference).toBe(f.validation.evidenceReference);
});
it.each(["Pass", "Warning", "HardError"] as const)(
  "no explicit unmapped combination never promotes independent mapping %s",
  (outcome) => {
    const f = fixture(),
      v = parseProductPublicationValidation({
        ...f.validation,
        checks: f.validation.checks.map((c) => ({
          ...c,
          outcome:
            c.code === "VariantMapping"
              ? outcome
              : c.code === "HardErrorsCleared" && outcome === "HardError"
                ? "HardError"
                : "Pass",
        })),
      });
    const r = f.apply(
      {
        ...f.scope,
        skuPrerequisite: "ActiveMemberPresent",
        check: { code: "UniqueScope", outcome: "Pass" },
      },
      v,
    );
    expect(r.checks.find((c) => c.code === "VariantMapping")?.outcome).toBe(outcome);
  },
);
it.each([undefined, "Unavailable", "Pass", "Ready"])(
  "refuses missing or unavailable mapping prerequisite %s",
  (value) => {
    const f = fixture();
    expect(() => f.apply({ ...f.scope, variantMappingPrerequisite: value } as never)).toThrow();
  },
);
it("refuses mapping getter and never rewrites an acknowledged Warning into a hard-error override", () => {
  const f = fixture(),
    get = vi.fn();
  expect(() =>
    f.apply(
      Object.defineProperty({ ...f.scope }, "variantMappingPrerequisite", {
        get,
        enumerable: true,
      }),
    ),
  ).toThrow();
  expect(get).not.toHaveBeenCalled();
  const v = parseProductPublicationValidation({
    ...f.validation,
    checks: f.validation.checks.map((c) => ({
      ...c,
      outcome: c.code === "VariantMapping" ? "Warning" : "Pass",
    })),
    warningAcknowledgement: {
      actorReference: f.command.actorReference,
      reasonCode: "SYNTHETIC",
      warningCodes: ["VariantMapping"],
    },
  });
  expect(() =>
    f.apply(
      {
        ...f.scope,
        skuPrerequisite: "ActiveMemberPresent",
        variantMappingPrerequisite: "UnmappedCombinationPresent",
        check: { code: "UniqueScope", outcome: "Pass" },
      },
      v,
    ),
  ).toThrow();
  expect(v.warningAcknowledgement?.reasonCode).toBe("SYNTHETIC");
});
it("explicit default violation overrides supplied Option Pass without SKU or Variant negative confounds", () => {
  const f = fixture(),
    r = f.apply({
      ...f.scope,
      skuPrerequisite: "ActiveMemberPresent",
      optionSelectionPrerequisite: "ExplicitDefaultBoundsViolated",
      check: { code: "UniqueScope", outcome: "Pass" },
    });
  expect(r.checks.find((c) => c.code === "OptionSelection")?.outcome).toBe("HardError");
  expect(r.checks.find((c) => c.code === "HardErrorsCleared")?.outcome).toBe("HardError");
  expect(r.checks.find((c) => c.code === "VariantMapping")?.outcome).toBe("Pass");
  expect(r.checks.find((c) => c.code === "PublishableSku")?.outcome).toBe("Pass");
  expect(r.evidenceReference).toBe(f.validation.evidenceReference);
});
it.each(["Pass", "Warning", "HardError"] as const)(
  "no intrinsic Option contradiction never promotes independent %s",
  (outcome) => {
    const f = fixture(),
      v = parseProductPublicationValidation({
        ...f.validation,
        checks: f.validation.checks.map((c) => ({
          ...c,
          outcome:
            c.code === "OptionSelection"
              ? outcome
              : c.code === "HardErrorsCleared" && outcome === "HardError"
                ? "HardError"
                : "Pass",
        })),
      });
    const r = f.apply(
      {
        ...f.scope,
        skuPrerequisite: "ActiveMemberPresent",
        check: { code: "UniqueScope", outcome: "Pass" },
      },
      v,
    );
    expect(r.checks.find((c) => c.code === "OptionSelection")?.outcome).toBe(outcome);
  },
);
it.each([undefined, "Unavailable", "Pass", "Satisfiable"])(
  "unknown Option prerequisite %s refuses",
  (value) => {
    const f = fixture();
    expect(() => f.apply({ ...f.scope, optionSelectionPrerequisite: value } as never)).toThrow();
  },
);
it("never executes Option getters or rewrites acknowledged Option Warning into an override", () => {
  const f = fixture(),
    get = vi.fn();
  expect(() =>
    f.apply(
      Object.defineProperty({ ...f.scope }, "optionSelectionPrerequisite", {
        get,
        enumerable: true,
      }),
    ),
  ).toThrow();
  expect(get).not.toHaveBeenCalled();
  const v = parseProductPublicationValidation({
    ...f.validation,
    checks: f.validation.checks.map((c) => ({
      ...c,
      outcome: c.code === "OptionSelection" ? "Warning" : "Pass",
    })),
    warningAcknowledgement: {
      actorReference: f.command.actorReference,
      reasonCode: "SYNTHETIC",
      warningCodes: ["OptionSelection"],
    },
  });
  expect(() =>
    f.apply(
      {
        ...f.scope,
        skuPrerequisite: "ActiveMemberPresent",
        optionSelectionPrerequisite: "ExplicitDefaultBoundsViolated",
        check: { code: "UniqueScope", outcome: "Pass" },
      },
      v,
    ),
  ).toThrow();
  expect(v.warningAcknowledgement?.reasonCode).toBe("SYNTHETIC");
});

it("actual graph Unsatisfiable downgrades Option independently of explicit bounds, SKU or Variant", () => {
  const f = fixture();
  const r = f.apply({
    ...f.scope,
    skuPrerequisite: "ActiveMemberPresent",
    optionRulePrerequisite: "Unsatisfiable",
    check: { code: "UniqueScope", outcome: "Pass" },
  });
  expect(r.checks.find((c) => c.code === "OptionSelection")?.outcome).toBe("HardError");
  expect(r.checks.find((c) => c.code === "HardErrorsCleared")?.outcome).toBe("HardError");
  expect(r.checks.find((c) => c.code === "PublishableSku")?.outcome).toBe("Pass");
  expect(r.checks.find((c) => c.code === "VariantMapping")?.outcome).toBe("Pass");
});
it.each([undefined, "Indeterminate", "Satisfiable", "Pass"])(
  "unknown mechanical Option status %s cannot qualify",
  (value) => {
    const f = fixture();
    expect(() => f.apply({ ...f.scope, optionRulePrerequisite: value } as never)).toThrow();
  },
);

it("mechanical status getters never execute or substitute a rule result", () => {
  const f = fixture(),
    getter = vi.fn();
  const packet = Object.defineProperty({ ...f.scope }, "optionRulePrerequisite", {
    get: getter,
    enumerable: true,
  });
  expect(() => f.apply(packet)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

function periodFixture(end: string | null) {
  const f = fixture();
  const start = new Date(Date.parse(at) - 1000).toISOString();
  const command = parseProductPublicationCommand({
    ...f.command,
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: start, localDateTime: start.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil:
        end === null
          ? null
          : { instant: end, localDateTime: end.slice(0, -1), utcOffsetMinutes: 0 },
    },
  });
  const validation = parseProductPublicationValidation({
    ...f.validation,
    periodDigest: hash(command.effectivePeriod),
  });
  const scope: ProductCandidateValidationBinding = {
    ...f.scope,
    skuPrerequisite: "ActiveMemberPresent",
    check: { code: "UniqueScope", outcome: "Pass" },
    originalIntentDigest: hash(command),
  };
  return {
    command,
    validation,
    scope,
    apply: (v = validation, now = at) =>
      applyCatalogProductCandidateValidation(command, v, scope, now),
  };
}

it.each([new Date(Date.parse(at) - 1).toISOString(), at])(
  "records ended half-open period %s despite supplied Pass",
  (end) => {
    const f = periodFixture(end),
      result = f.apply();
    expect(
      result.checks.filter((check) => check.outcome === "HardError").map((check) => check.code),
    ).toEqual(["EffectivePeriod", "HardErrorsCleared"]);
    expect(result.evidenceReference).toBe(f.validation.evidenceReference);
    expect(result.periodDigest).toBe(hash(f.command.effectivePeriod));
    expect(result.validUntil).toBe(f.scope.validUntil);
    expect(f.validation.checks.every((check) => check.outcome === "Pass")).toBe(true);
  },
);

it.each([null, new Date(Date.parse(at) + 1).toISOString()])(
  "preserves independent outcomes for not-ended period %s",
  (end) => {
    for (const outcome of ["Pass", "Warning", "HardError"] as const) {
      const f = periodFixture(end);
      const validation = parseProductPublicationValidation({
        ...f.validation,
        checks: f.validation.checks.map((check) => ({
          ...check,
          outcome:
            check.code === "EffectivePeriod" ||
            (check.code === "HardErrorsCleared" && outcome === "HardError")
              ? outcome
              : "Pass",
        })),
        warningAcknowledgement:
          outcome === "Warning"
            ? {
                actorReference: id(3),
                reasonCode: "SYNTHETIC_PERIOD",
                warningCodes: ["EffectivePeriod"],
              }
            : null,
      });
      const result = f.apply(validation);
      expect(result.checks.find((check) => check.code === "EffectivePeriod")?.outcome).toBe(
        outcome,
      );
      expect(result.warningAcknowledgement).toEqual(validation.warningAcknowledgement);
    }
  },
);

it("uses current validation instant rather than old receipt time for the period boundary", () => {
  const end = new Date(Date.parse(at) + 1000).toISOString(),
    f = periodFixture(end);
  expect(f.apply().checks.find((check) => check.code === "EffectivePeriod")?.outcome).toBe("Pass");
  expect(
    f.apply(f.validation, end).checks.find((check) => check.code === "EffectivePeriod")?.outcome,
  ).toBe("HardError");
});

it("never reinterprets an acknowledged ended-period Warning as an authorized HardError override", () => {
  const f = periodFixture(at),
    validation = parseProductPublicationValidation({
      ...f.validation,
      checks: f.validation.checks.map((check) => ({
        ...check,
        outcome: check.code === "EffectivePeriod" ? "Warning" : "Pass",
      })),
      warningAcknowledgement: {
        actorReference: id(3),
        reasonCode: "SYNTHETIC_PERIOD",
        warningCodes: ["EffectivePeriod"],
      },
    });
  expect(() => f.apply(validation)).toThrowError(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
  expect(validation.warningAcknowledgement?.reasonCode).toBe("SYNTHETIC_PERIOD");
});

it("retains unrelated Warning Actor and Reason when recording an ended period", () => {
  const f = periodFixture(at),
    validation = parseProductPublicationValidation({
      ...f.validation,
      checks: f.validation.checks.map((check) => ({
        ...check,
        outcome: check.code === "MediaReady" ? "Warning" : "Pass",
      })),
      warningAcknowledgement: {
        actorReference: id(3),
        reasonCode: "SYNTHETIC_MEDIA",
        warningCodes: ["MediaReady"],
      },
    }),
    result = f.apply(validation);
  expect(result.warningAcknowledgement).toEqual(validation.warningAcknowledgement);
  expect(result.checks.find((check) => check.code === "MediaReady")?.outcome).toBe("Warning");
  expect(result.checks.find((check) => check.code === "EffectivePeriod")?.outcome).toBe(
    "HardError",
  );
});

it.each(["zone", "offset", "order", "instant", "digest"])(
  "refuses malformed or unbound period %s instead of producing a check",
  (mode) => {
    const f = periodFixture(at);
    const period = {
      ...f.command.effectivePeriod,
      effectiveFrom: { ...f.command.effectivePeriod.effectiveFrom },
    };
    if (mode === "zone") Object.assign(period, { timeZone: "Unknown/Zone" });
    if (mode === "offset") Object.assign(period.effectiveFrom, { utcOffsetMinutes: 60 });
    if (mode === "order") Object.assign(period, { effectiveUntil: period.effectiveFrom });
    if (mode === "instant") Object.assign(period.effectiveFrom, { instant: "invalid" });
    const command = { ...f.command, effectivePeriod: period };
    const validation =
      mode === "digest"
        ? { ...f.validation, periodDigest: "sha256:" + "c".repeat(64) }
        : f.validation;
    expect(() =>
      applyCatalogProductCandidateValidation(command, validation, f.scope, at),
    ).toThrow();
  },
);
