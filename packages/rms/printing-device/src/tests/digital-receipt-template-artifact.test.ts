import { describe, expect, it, vi } from "vitest";
import { digitalReceiptRequiredFields } from "../contracts/digital-receipt-template.js";
import {
  parseDigitalReceiptTemplateArtifactContent,
  parseDigitalReceiptTemplateArtifactVersion,
  parseDigitalReceiptTemplateArtifactSave,
  parseDigitalReceiptTemplateArtifactResolve,
  parseDigitalReceiptTemplateArtifactReceipt,
  parseDigitalReceiptTemplateArtifactCurrent,
  type DigitalReceiptTemplateArtifactKind,
} from "../contracts/digital-receipt-template-artifact.js";
const id = (n: number) => `0190ed11-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T14:00:00.000Z",
  later = "2026-10-05T14:00:01.000Z",
  until = "2026-10-05T14:00:05.000Z";
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const actorScope = { ...scope, actorReference: id(4) };
const digest = "sha256:" + "a".repeat(64);
function content(kind: DigitalReceiptTemplateArtifactKind = "Layout") {
  return kind === "Layout"
    ? {
        profile: "AccessibleDigitalReceiptLayoutV1",
        dataContractVersion: 1,
        renderEngineVersion: 1,
        outputProfile: "AccessibleDigitalReceipt",
        requiredFields: [...digitalReceiptRequiredFields],
      }
    : {
        profile: "DigitalReceiptRequiredFieldRuleV1",
        dataContractVersion: 1,
        requiredFields: [...digitalReceiptRequiredFields],
        professionalReviewStatus: "NotEvaluated",
        legalConclusion: "NotEvaluated",
      };
}
function snapshot(kind: DigitalReceiptTemplateArtifactKind = "Layout") {
  return {
    profile: "DigitalReceiptTemplateArtifactV1",
    ...scope,
    artifactKind: kind,
    artifactReference: id(10),
    revision: 1,
    authoredByReference: id(4),
    previousArtifactReference: null,
    content: content(kind),
    createdAt: at,
    updatedAt: at,
    dataClassification: "Internal",
  };
}
function save(kind: DigitalReceiptTemplateArtifactKind = "Layout") {
  return {
    profile: "DigitalReceiptTemplateArtifactSaveV1",
    ...actorScope,
    artifactKind: kind,
    operationReference: id(20),
    expectedArtifactReference: null,
    expectedRevision: 0,
    content: content(kind),
    purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
  };
}
function receipt(kind: DigitalReceiptTemplateArtifactKind = "Layout") {
  return {
    profile: "DigitalReceiptTemplateArtifactReceiptV1",
    ...actorScope,
    artifactKind: kind,
    operationReference: id(20),
    intentDigest: digest,
    expectedArtifactReference: null,
    expectedRevision: 0,
    outcome: "Committed",
    snapshot: snapshot(kind),
    auditReference: id(21),
    occurredAt: at,
  };
}
function current() {
  return {
    profile: "DigitalReceiptTemplateArtifactsCurrentV1",
    ...actorScope,
    layout: snapshot(),
    compliance: snapshot("Compliance"),
    observedAt: at,
    validUntil: until,
    sourceQualification: "NotEvaluated",
  };
}
const invalid = (work: () => unknown) => expect(work).toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
describe("digital receipt software artifact contracts", () => {
  it.each(["Layout", "Compliance"] as const)(
    "parses closed %s software content, Save, original snapshot and terminal receipt",
    (kind) => {
      expect(parseDigitalReceiptTemplateArtifactContent(content(kind), kind)).toEqual(
        content(kind),
      );
      expect(parseDigitalReceiptTemplateArtifactSave(save(kind)).artifactKind).toBe(kind);
      expect(parseDigitalReceiptTemplateArtifactVersion(snapshot(kind)).revision).toBe(1);
      expect(parseDigitalReceiptTemplateArtifactReceipt(receipt(kind)).snapshot?.content).toEqual(
        content(kind),
      );
    },
  );
  it("retains professional/legal NotEvaluated while software fields are present", () => {
    expect(
      parseDigitalReceiptTemplateArtifactContent(content("Compliance"), "Compliance"),
    ).toMatchObject({ professionalReviewStatus: "NotEvaluated", legalConclusion: "NotEvaluated" });
    expect(parseDigitalReceiptTemplateArtifactCurrent(current()).sourceQualification).toBe(
      "NotEvaluated",
    );
  });
  it("does not retain mutable content or field-array aliases", () => {
    const input = save(),
      parsed = parseDigitalReceiptTemplateArtifactSave(input);
    input.content.requiredFields.pop();
    input.expectedRevision = 7;
    expect(parsed.expectedRevision).toBe(0);
    expect(parsed.content.requiredFields).toEqual(digitalReceiptRequiredFields);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.content)).toBe(true);
    expect(Object.isFrozen(parsed.content.requiredFields)).toBe(true);
  });
  it("keeps revision-one creation and exact successive parent while old version stays immutable", () => {
    const first = parseDigitalReceiptTemplateArtifactVersion(snapshot());
    const next = parseDigitalReceiptTemplateArtifactVersion({
      ...snapshot(),
      artifactReference: id(11),
      revision: 2,
      previousArtifactReference: first.artifactReference,
      authoredByReference: id(8),
      updatedAt: later,
    });
    expect(next.createdAt).toBe(first.createdAt);
    expect(next.previousArtifactReference).toBe(first.artifactReference);
    expect(first.artifactReference).toBe(id(10));
    expect(first.revision).toBe(1);
  });
  it("permits another authorized current reader without replacing the historical writer", () => {
    const result = parseDigitalReceiptTemplateArtifactCurrent({
      ...current(),
      actorReference: id(90),
    });
    expect(result.actorReference).toBe(id(90));
    expect(result.layout?.authoredByReference).toBe(id(4));
  });
  it("allows genuine current absence and payload-free Abandoned original pins", () => {
    expect(
      parseDigitalReceiptTemplateArtifactCurrent({ ...current(), layout: null, compliance: null }),
    ).toMatchObject({ layout: null, compliance: null });
    const { content: ignored, ...identity } = save();
    void ignored;
    const resolve = parseDigitalReceiptTemplateArtifactResolve({
      ...identity,
      profile: "DigitalReceiptTemplateArtifactResolveV1",
      intentDigest: digest,
    });
    expect(resolve).not.toHaveProperty("content");
    expect(
      parseDigitalReceiptTemplateArtifactReceipt({
        ...receipt(),
        outcome: "Abandoned",
        snapshot: null,
      }),
    ).toMatchObject({ outcome: "Abandoned", snapshot: null, intentDigest: digest });
  });
  it("accepts exact successor committed pins with this actual writer and original time", () => {
    const next = {
      ...snapshot(),
      artifactReference: id(11),
      revision: 2,
      previousArtifactReference: id(10),
      updatedAt: later,
    };
    expect(
      parseDigitalReceiptTemplateArtifactReceipt({
        ...receipt(),
        expectedArtifactReference: id(10),
        expectedRevision: 1,
        snapshot: next,
        occurredAt: later,
      }).snapshot?.artifactReference,
    ).toBe(id(11));
  });
  it.each([
    { expectedArtifactReference: id(10), expectedRevision: 0 },
    { expectedArtifactReference: null, expectedRevision: 1 },
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { expectedRevision: 2147483648 },
    { expectedArtifactReference: id(10), expectedRevision: 2147483647 },
    { purposeCode: "PUBLISHING_RELEASE" },
    { artifactKind: "Printer" },
  ])("refuses incompatible Save CAS/purpose/kind", (patch) => {
    invalid(() => parseDigitalReceiptTemplateArtifactSave({ ...save(), ...patch }));
  });
  it.each([
    { revision: 0 },
    { revision: 2147483648 },
    { revision: 2 },
    { previousArtifactReference: id(10) },
    { updatedAt: later },
    { createdAt: later },
    { dataClassification: "Public" },
    { profile: "DigitalReceiptTemplateArtifactV2" },
  ])("refuses invalid snapshot revision/parent/creation/history metadata", (patch) => {
    invalid(() => parseDigitalReceiptTemplateArtifactVersion({ ...snapshot(), ...patch }));
  });
  it.each(["tenantReference", "brandReference", "storeReference"] as const)(
    "refuses snapshot %s mismatch in receipt and current",
    (key) => {
      const bad = { ...snapshot(), [key]: id(99) };
      invalid(() => parseDigitalReceiptTemplateArtifactReceipt({ ...receipt(), snapshot: bad }));
      invalid(() => parseDigitalReceiptTemplateArtifactCurrent({ ...current(), layout: bad }));
    },
  );
  it.each([
    { authoredByReference: id(99) },
    { artifactKind: "Compliance", content: content("Compliance") },
    { revision: 2, previousArtifactReference: id(99) },
    { updatedAt: later },
  ])("refuses substituted committed snapshot", (patch) => {
    invalid(() =>
      parseDigitalReceiptTemplateArtifactReceipt({
        ...receipt(),
        snapshot: { ...snapshot(), ...patch },
      }),
    );
  });
  it.each([
    { outcome: "Abandoned" },
    { outcome: "Committed", snapshot: null },
    { outcome: "Absent", snapshot: null },
    { intentDigest: "a".repeat(64) },
    { occurredAt: later },
    { actorReference: id(99) },
  ])("refuses incoherent terminal or original identity", (patch) => {
    invalid(() => parseDigitalReceiptTemplateArtifactReceipt({ ...receipt(), ...patch }));
  });
  it.each(["2026-10-05T14:00:00.000Z", "2026-10-05T13:59:59.999Z", "2026-10-05T14:00:05.001Z"])(
    "refuses current invalid or extended lease %s",
    (validUntil) => {
      invalid(() => parseDigitalReceiptTemplateArtifactCurrent({ ...current(), validUntil }));
    },
  );
  it("refuses current kind substitution and snapshots authored after observation", () => {
    invalid(() =>
      parseDigitalReceiptTemplateArtifactCurrent({ ...current(), layout: snapshot("Compliance") }),
    );
    const future = {
      ...snapshot(),
      revision: 2,
      artifactReference: id(11),
      previousArtifactReference: id(10),
      updatedAt: later,
    };
    invalid(() => parseDigitalReceiptTemplateArtifactCurrent({ ...current(), layout: future }));
    invalid(() =>
      parseDigitalReceiptTemplateArtifactCurrent({
        ...current(),
        sourceQualification: "Qualified",
      }),
    );
  });
  it.each(["Layout", "Compliance"] as const)(
    "requires canonical full13 field order for %s",
    (kind) => {
      const base = content(kind);
      for (const requiredFields of [
        [...digitalReceiptRequiredFields].reverse(),
        digitalReceiptRequiredFields.slice(1),
        [...digitalReceiptRequiredFields.slice(1), "Total"],
        [...digitalReceiptRequiredFields.slice(1), "Account"],
      ])
        invalid(() =>
          parseDigitalReceiptTemplateArtifactContent({ ...base, requiredFields }, kind),
        );
      invalid(() =>
        parseDigitalReceiptTemplateArtifactContent(
          content(kind === "Layout" ? "Compliance" : "Layout"),
          kind,
        ),
      );
    },
  );
  it.each([
    { professionalReviewStatus: "Approved" },
    { legalConclusion: "Compliant" },
    { approvalReference: id(99) },
    { html: "<script>" },
    { credential: "synthetic" },
    { scope: "Global" },
    { validUntil: until },
  ])("rejects legal/approval/HTML/authority injections", (patch) => {
    invalid(() =>
      parseDigitalReceiptTemplateArtifactContent(
        { ...content("Compliance"), ...patch },
        "Compliance",
      ),
    );
  });
  it.each([
    { dataContractVersion: 2 },
    { renderEngineVersion: 2 },
    { outputProfile: "ThermalPrinter" },
    { conditionalSections: [] },
  ])("rejects unsupported Layout contract fields", (patch) => {
    invalid(() => parseDigitalReceiptTemplateArtifactContent({ ...content(), ...patch }, "Layout"));
  });
  it("refuses UUID4 and noncanonical or invalid UTC timestamps", () => {
    invalid(() =>
      parseDigitalReceiptTemplateArtifactSave({
        ...save(),
        operationReference: "0190ed11-0000-4000-8000-000000000001",
      }),
    );
    for (const updatedAt of [
      "2026-10-05T14:00:00Z",
      "2026-10-05T14:00:00.000+00:00",
      "2026-02-30T14:00:00.000Z",
    ])
      invalid(() => parseDigitalReceiptTemplateArtifactVersion({ ...snapshot(), updatedAt }));
  });
  it("refuses extra, hidden, inherited or accessor fields without evaluating getters", () => {
    const getter = vi.fn(() => content()),
      input = save();
    Object.defineProperty(input, "content", { enumerable: true, get: getter });
    invalid(() => parseDigitalReceiptTemplateArtifactSave(input));
    expect(getter).not.toHaveBeenCalled();
    invalid(() => parseDigitalReceiptTemplateArtifactSave({ ...save(), approved: true }));
    invalid(() => parseDigitalReceiptTemplateArtifactSave(Object.create(save())));
    const hidden = save();
    Object.defineProperty(hidden, "expectedRevision", { value: 0, enumerable: false });
    invalid(() => parseDigitalReceiptTemplateArtifactSave(hidden));
  });
  it("refuses sparse, accessor and augmented arrays without invoking getters", () => {
    const sparse = [...digitalReceiptRequiredFields];
    delete sparse[0];
    invalid(() =>
      parseDigitalReceiptTemplateArtifactContent(
        { ...content(), requiredFields: sparse },
        "Layout",
      ),
    );
    const getter = vi.fn(() => "Issuer"),
      accessor = [...digitalReceiptRequiredFields];
    Object.defineProperty(accessor, "0", { enumerable: true, get: getter });
    invalid(() =>
      parseDigitalReceiptTemplateArtifactContent(
        { ...content(), requiredFields: accessor },
        "Layout",
      ),
    );
    expect(getter).not.toHaveBeenCalled();
    const augmented = Object.assign([...digitalReceiptRequiredFields], { claim: "Approved" });
    invalid(() =>
      parseDigitalReceiptTemplateArtifactContent(
        { ...content(), requiredFields: augmented },
        "Layout",
      ),
    );
  });
});
