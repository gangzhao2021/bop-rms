import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createBrandConfigurationVersion,
  parseBrandConfigurationEditableContent,
} from "../contracts/brand-administration.js";
import {
  parseBrandConfigurationCommand,
  parseBrandConfigurationResolve,
  parseBrandConfigurationRevision,
  parseBrandConfigurationReceipt,
  parseBrandConfigurationCurrent,
  parseBrandConfigurationHistory,
  createBrandConfigurationRevision,
  assertBrandConfigurationRevisionDigests,
  brandConfigurationIntentDigest,
} from "../contracts/brand-configuration-operation.js";
const id = (n: number) => `01902502-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T10:00:00.000Z",
  later = "2026-10-06T10:01:00.000Z",
  hash = "sha256:" + "a".repeat(64);
const scope = { tenantReference: id(1), brandReference: id(2), actorReference: id(3) };
const fields = () => ({
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA", "fr-CA"],
  mediaThemeReference: null,
  catalogSourceReference: id(4),
  platformTemplateReference: id(5),
  overrideAllowedFieldCodes: ["DISPLAY.THEME"],
  hardRequirementFieldCodes: ["SECURITY.REAUTH"],
  effectiveFrom: at,
  effectiveUntil: null,
  reasonCode: "INITIAL_CONFIGURATION",
});
const configuration = (patch: Record<string, unknown> = {}) =>
  createBrandConfigurationVersion({
    configurationVersionReference: id(10),
    brandReference: id(2),
    configurationVersion: 1,
    lifecycle: "Draft",
    ...fields(),
    supersedesVersionReference: null,
    authoredByReference: id(3),
    approvedByReference: null,
    approvalEvidenceReference: null,
    publicationReference: null,
    createdAt: at,
    updatedAt: at,
    dataClassification: "ConfigurationMetadata",
    ...patch,
  });
const request = (patch: Record<string, unknown> = {}) => ({
  profile: "TenantBrandConfigurationCommandV1",
  ...scope,
  command: "SaveConfigurationDraft",
  operationReference: id(11),
  expectedBrandVersion: 1,
  expectedHead: null,
  configuration: fields(),
  reviewValidUntil: null,
  purposeCode: "BRAND_CONFIGURATION",
  ...patch,
});
const refs = {
  canonicalize: (value: unknown) => JSON.stringify(value),
  hashIntent: (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex"),
};
const revision = (patch: Record<string, unknown> = {}) =>
  createBrandConfigurationRevision(
    {
      profile: "TenantBrandConfigurationRevisionV1",
      ...scope,
      revision: 1,
      brandVersion: 1,
      command: "SaveConfigurationDraft",
      operationReference: id(11),
      configuration: configuration(),
      submittedByReference: null,
      publishing: null,
      auditReference: id(12),
      createdAt: at,
      recordedAt: at,
      dataClassification: "ConfigurationMetadata",
      ...patch,
    },
    refs,
  );
const receipt = (patch: Record<string, unknown> = {}) => ({
  profile: "TenantBrandConfigurationOperationV1",
  ...scope,
  command: "SaveConfigurationDraft",
  operationReference: id(11),
  expectedBrandVersion: 1,
  expectedHead: null,
  purposeCode: "BRAND_CONFIGURATION",
  intentDigest: brandConfigurationIntentDigest(request(), refs),
  originalCommand: request(),
  outcome: "Committed",
  snapshot: revision(),
  auditReference: id(12),
  occurredAt: at,
  dataClassification: "ConfigurationMetadata",
  ...patch,
});
describe("Brand ordinary stable original contracts", () => {
  it("keeps Save original independent of generated result identities", () => {
    const parsed = parseBrandConfigurationCommand(request());
    expect(Object.keys(parsed.configuration ?? {})).toHaveLength(10);
    expect(brandConfigurationIntentDigest(request(), refs)).toBe(
      brandConfigurationIntentDigest(request(), refs),
    );
    expect(
      parseBrandConfigurationReceipt(receipt()).snapshot?.configuration
        .configurationVersionReference,
    ).toBe(id(10));
  });
  it.each(["SubmitConfiguration", "ApproveConfiguration", "PublishConfiguration"])(
    "binds %s only to immutable head",
    (command) => {
      const value = request({
        command,
        reviewValidUntil: command === "SubmitConfiguration" ? later : null,
        configuration: null,
        expectedHead: { revision: 1, configurationVersionReference: id(10), sourceDigest: hash },
      });
      expect(parseBrandConfigurationCommand(value).configuration).toBeNull();
      expect(() =>
        parseBrandConfigurationCommand({ ...value, configuration: configuration() }),
      ).toThrow();
      expect(() => parseBrandConfigurationCommand({ ...value, expectedHead: null })).toThrow();
    },
  );
  it.each([
    { configurationVersionReference: id(20) },
    { authoredByReference: id(20) },
    { approvedByReference: id(20) },
    { createdAt: at },
    { dataClassification: "ConfigurationMetadata" },
  ])("rejects injected Save governance %#", (patch) => {
    expect(() =>
      parseBrandConfigurationCommand(request({ configuration: { ...fields(), ...patch } })),
    ).toThrow();
  });
  it.each([
    { defaultLocale: "en" },
    { supportedLocales: ["fr-CA"] },
    { supportedLocales: ["en-CA", "en-CA"] },
    { hardRequirementFieldCodes: ["DISPLAY.THEME"] },
    { effectiveUntil: at },
    { catalogSourceReference: "unknown" },
  ])("retains existing editable value rules %#", (patch) => {
    expect(() => parseBrandConfigurationEditableContent({ ...fields(), ...patch })).toThrow();
  });
  it("rejects accessors without invoking them and detaches nested arrays", () => {
    let read = 0;
    const content = fields();
    Object.defineProperty(content, "defaultLocale", {
      enumerable: true,
      get() {
        read++;
        return "en-CA";
      },
    });
    expect(() => parseBrandConfigurationCommand(request({ configuration: content }))).toThrow();
    expect(read).toBe(0);
    const original = fields(),
      parsed = parseBrandConfigurationCommand(request({ configuration: original }));
    original.supportedLocales.push("es-CA");
    expect(parsed.configuration?.supportedLocales).toEqual(["en-CA", "fr-CA"]);
    expect(Object.isFrozen(parsed.configuration?.supportedLocales)).toBe(true);
  });
  it("rejects sparse arrays, symbols and over-budget original payloads", () => {
    const sparse = new Array(2);
    sparse[0] = "en-CA";
    expect(() =>
      parseBrandConfigurationCommand(
        request({ configuration: { ...fields(), supportedLocales: sparse } }),
      ),
    ).toThrow();
    expect(() =>
      parseBrandConfigurationCommand({ ...request(), [Symbol("extra")]: true }),
    ).toThrow();
    expect(() =>
      parseBrandConfigurationCommand(
        request({ configuration: { ...fields(), reasonCode: "X".repeat(140000) } }),
      ),
    ).toThrow();
  });
  it("recomputes semantic and full revision digests separately", () => {
    const draft = revision();
    const submitted = revision({
      revision: 2,
      command: "SubmitConfiguration",
      configuration: configuration({ lifecycle: "PendingApproval", updatedAt: later }),
      submittedByReference: id(3),
      publishing: {
        familyReference: id(30),
        lifecycleReference: id(31),
        lifecycleVersion: 2,
        mutationOperationReference: id(32),
        validationEvidenceReference: id(33),
        approvalEvidenceReference: null,
        publicationReference: null,
      },
      recordedAt: later,
    });
    expect(draft.contentDigest).toBe(submitted.contentDigest);
    expect(draft.sourceDigest).not.toBe(submitted.sourceDigest);
    expect(assertBrandConfigurationRevisionDigests(submitted, refs)).toEqual(submitted);
    expect(() =>
      assertBrandConfigurationRevisionDigests({ ...submitted, sourceDigest: hash }, refs),
    ).toThrow();
  });
  it("requires independent author and actual original submitter for approval", () => {
    const config = configuration({
      lifecycle: "Approved",
      approvedByReference: id(21),
      approvalEvidenceReference: id(22),
      updatedAt: later,
    });
    const value = revision({
      actorReference: id(21),
      revision: 3,
      command: "ApproveConfiguration",
      configuration: config,
      submittedByReference: id(20),
      publishing: {
        familyReference: id(30),
        lifecycleReference: id(31),
        lifecycleVersion: 3,
        mutationOperationReference: id(32),
        validationEvidenceReference: id(33),
        approvalEvidenceReference: id(22),
        publicationReference: null,
      },
      recordedAt: later,
    });
    expect(parseBrandConfigurationRevision(value).submittedByReference).toBe(id(20));
    expect(() =>
      parseBrandConfigurationRevision({ ...value, submittedByReference: id(21) }),
    ).toThrow();
    expect(() =>
      parseBrandConfigurationRevision({
        ...value,
        publishing: { ...value.publishing, approvalEvidenceReference: id(99) },
      }),
    ).toThrow();
  });
  it("parses payload-free Abandoned without manufacturing editable values", () => {
    const value = receipt({ outcome: "Abandoned", snapshot: null, originalCommand: null });
    expect(parseBrandConfigurationReceipt(value).snapshot).toBeNull();
    const resolve = {
      ...request(),
      profile: "TenantBrandConfigurationResolveV1",
      intentDigest: hash,
    };
    const { configuration: omitted, reviewValidUntil: omittedDeadline, ...input } = resolve;
    void omittedDeadline;
    void omitted;
    expect(parseBrandConfigurationResolve(input).intentDigest).toBe(hash);
    expect(() =>
      parseBrandConfigurationReceipt({ ...value, originalCommand: request() }),
    ).toThrow();
  });
  it.each([
    { actorReference: id(90) },
    { auditReference: id(90) },
    { occurredAt: later },
    { expectedBrandVersion: 2 },
    { snapshot: revision({ configuration: configuration({ defaultLocale: "fr-CA" }) }) },
  ])("rejects foreign or altered committed provenance %#", (patch) => {
    expect(() => parseBrandConfigurationReceipt(receipt(patch))).toThrow();
  });
  it("allows historical author distinct from reader without current publication claims", () => {
    const current = {
      profile: "TenantBrandConfigurationCurrentV1",
      ...scope,
      actorReference: id(90),
      current: revision(),
      observedAt: at,
      validUntil: "2026-10-06T10:00:05.000Z",
      currentPublication: "NotEvaluated",
    };
    expect(parseBrandConfigurationCurrent(current).current?.actorReference).toBe(id(3));
    expect(() =>
      parseBrandConfigurationCurrent({ ...current, validUntil: "2026-10-06T10:00:05.001Z" }),
    ).toThrow();
    expect(() =>
      parseBrandConfigurationCurrent({ ...current, currentPublication: "Verified" }),
    ).toThrow();
  });
  it("allows first governance revision to continue a genuine legacy configuration version", () => {
    const snapshot = revision({
      configuration: configuration({ configurationVersion: 2, supersedesVersionReference: id(77) }),
    });
    expect(parseBrandConfigurationReceipt(receipt({ snapshot })).snapshot?.revision).toBe(1);
    expect(
      parseBrandConfigurationReceipt(receipt({ snapshot })).snapshot?.configuration
        .configurationVersion,
    ).toBe(2);
    expect(() =>
      parseBrandConfigurationReceipt(
        receipt({
          snapshot: {
            ...snapshot,
            configuration: { ...snapshot.configuration, supersedesVersionReference: null },
          },
        }),
      ),
    ).toThrow();
  });
  it("requires descending complete bounded history cursor", () => {
    const first = revision(),
      second = revision({
        revision: 2,
        operationReference: id(50),
        recordedAt: later,
        configuration: configuration({ updatedAt: later }),
      });
    const page = {
      profile: "TenantBrandConfigurationHistoryV1",
      ...scope,
      actorReference: id(90),
      beforeRevision: null,
      entries: [second, first],
      nextBeforeRevision: 1,
      observedAt: later,
      validUntil: "2026-10-06T10:01:05.000Z",
      currentPublication: "NotEvaluated",
    };
    expect(parseBrandConfigurationHistory(page).entries).toHaveLength(2);
    expect(() => parseBrandConfigurationHistory({ ...page, entries: [first, second] })).toThrow();
    expect(() => parseBrandConfigurationHistory({ ...page, nextBeforeRevision: 2 })).toThrow();
    expect(() =>
      parseBrandConfigurationHistory({ ...page, entries: [second, first, first] }),
    ).toThrow();
  });
  it("requires an explicit finite Submit review bound and forbids it on other commands", () => {
    const submit = request({
      command: "SubmitConfiguration",
      configuration: null,
      expectedHead: { revision: 1, configurationVersionReference: id(10), sourceDigest: hash },
      reviewValidUntil: later,
    });
    expect(parseBrandConfigurationCommand(submit).reviewValidUntil).toBe(later);
    for (const reviewValidUntil of [
      null,
      undefined,
      "2026-10-06T10:01:00Z",
      "2026-10-06T10:01:00.000001Z",
      "invalid",
    ]) {
      expect(() => parseBrandConfigurationCommand({ ...submit, reviewValidUntil })).toThrow();
    }
    expect(() => parseBrandConfigurationCommand(request({ reviewValidUntil: later }))).toThrow();
    expect(brandConfigurationIntentDigest(submit, refs)).not.toBe(
      brandConfigurationIntentDigest(
        { ...submit, reviewValidUntil: "2026-10-06T10:02:00.000Z" },
        refs,
      ),
    );
  });

  it("binds a committed Submit record to its original finite business deadline without checking today", () => {
    const expectedHead = { revision: 1, configurationVersionReference: id(10), sourceDigest: hash };
    const originalCommand = request({
      command: "SubmitConfiguration",
      configuration: null,
      expectedHead,
      reviewValidUntil: "2026-10-06T10:02:00.000Z",
    });
    const snapshot = revision({
      revision: 2,
      command: "SubmitConfiguration",
      configuration: configuration({ lifecycle: "PendingApproval", updatedAt: later }),
      submittedByReference: id(3),
      publishing: {
        familyReference: id(30),
        lifecycleReference: id(31),
        lifecycleVersion: 2,
        mutationOperationReference: id(11),
        validationEvidenceReference: id(33),
        approvalEvidenceReference: null,
        publicationReference: null,
      },
      recordedAt: later,
    });
    const value = receipt({
      command: "SubmitConfiguration",
      expectedHead,
      originalCommand,
      intentDigest: brandConfigurationIntentDigest(originalCommand, refs),
      snapshot,
      occurredAt: later,
    });
    expect(parseBrandConfigurationReceipt(value).originalCommand?.reviewValidUntil).toBe(
      "2026-10-06T10:02:00.000Z",
    );
    expect(() =>
      parseBrandConfigurationReceipt({
        ...value,
        originalCommand: { ...originalCommand, reviewValidUntil: later },
      }),
    ).toThrow();
  });
});
