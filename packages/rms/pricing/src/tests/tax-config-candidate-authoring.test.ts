import { describe, expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { input } from "./price-quote.fixture.js";
import { createTaxConfigurationSnapshot } from "../domain/tax-configuration.js";
import { parsePricingReference, parsePricingDigest } from "../domain/money-tax-contract.js";
import {
  parseTaxConfigAuthoringState,
  parseTaxConfigAuthoringScope,
} from "../contracts/tax-config-authoring.js";
import {
  parseTaxConfigMaterialVersion,
  taxConfigMaterialContentDigest,
} from "../contracts/tax-config-material.js";
import { createTaxPublicationCandidate } from "../contracts/tax-config-publication-candidate.js";
import {
  parseTaxConfigCandidateCommand,
  parseTaxConfigCandidateResolve,
  taxConfigCandidateIntentDigest,
  createTaxConfigCandidateRecord,
  parseTaxConfigCandidateRecord,
  assertTaxConfigCandidateSources,
  parseTaxConfigCandidateOperation,
  parseTaxConfigCandidateCurrent,
  parseTaxConfigCandidateSummary,
  parseTaxConfigCandidateRoster,
} from "../contracts/tax-config-candidate-authoring.js";

// Controlled source packets, not current IAM, professional applicability or publication proof.
const id = (n: number) =>
  parsePricingReference(`01902602-0017-7000-8000-${n.toString(16).padStart(12, "0")}`);
const hash = (v: unknown) => parsePricingDigest("sha256:" + sha256Hex(canonicalizeRfc8785(v)));
const copy = (v: unknown) => JSON.parse(JSON.stringify(v));
const preparedAt = "2026-10-01T16:00:00.000Z";
const observedAt = "2026-10-01T16:00:01.000Z";
const validUntil = "2026-10-01T16:00:05.000Z";
function fixture() {
  const original = input().taxConfiguration;
  const { snapshotDigest: originalDigest, ...source } = original;
  expect(originalDigest).toMatch(/^sha256:/u);
  const body = {
    ...source,
    lifecycle: "Draft" as const,
    registrationEvidence: null,
    professionalEvidence: null,
  };
  const snapshot = createTaxConfigurationSnapshot({ ...body, snapshotDigest: hash(body) });
  const scope = parseTaxConfigAuthoringScope({
    tenantReference: id(1),
    brandReference: snapshot.brandReference,
    storeReference: snapshot.storeReference,
    actorReference: id(2),
  });
  const draft = parseTaxConfigAuthoringState({
    profile: "TaxConfigAuthoringStateV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    draftAuthorActorReference: id(3),
    snapshot,
  });
  const content = {
    operatingEntityProfileVersionReference: id(50),
    operatingEntityTaxReference: null,
    jurisdictionCode: "CA-ON",
    applicability: "Applicable",
    sourceIssuedAt: "2026-09-01T00:00:00.000Z",
    effectiveFrom: "2026-09-01T00:00:00.000Z",
    effectiveUntil: null,
    declaredSourceDigest: null,
  };
  const registration = parseTaxConfigMaterialVersion({
    profile: "TaxConfigMaterialVersionV1",
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    materialReference: id(5),
    versionReference: id(6),
    revision: 1,
    previousVersionReference: null,
    materialKind: "RegistrationApplicability",
    content,
    contentDigest: taxConfigMaterialContentDigest(content, "RegistrationApplicability"),
    recordedByActorReference: id(4),
    createdAt: "2026-09-01T00:00:00.000Z",
    recordedAt: "2026-09-01T00:00:00.000Z",
    dataClassification: "Confidential",
    status: "Recorded",
    qualification: "NotEvaluated",
  });
  const registrationMaterial = {
    materialReference: registration.materialReference,
    versionReference: registration.versionReference,
    contentDigest: registration.contentDigest,
  };
  const candidate = createTaxPublicationCandidate({
    draft,
    targetVersionReference: id(9),
    sourceRuleBindings: snapshot.rules.map((rule, i) => ({
      sourceRuleReference: rule.ruleReference,
      targetRuleReference: id(100 + i),
    })),
    registrationMaterial,
  });
  const command = parseTaxConfigCandidateCommand({
    action: "PrepareCandidate",
    operationReference: id(12),
    configurationReference: snapshot.configurationReference,
    expectedDraft: candidate.content.baseDraft,
    registrationMaterial,
  });
  const allocation = {
    scope,
    command,
    candidate,
    draft,
    registrationMaterial: registration,
    preparedAt,
    auditReference: id(10),
    eventReference: id(11),
  };
  const record = createTaxConfigCandidateRecord(allocation);
  const operation = parseTaxConfigCandidateOperation({
    profile: "TaxConfigCandidateOperationV1",
    ...scope,
    ...command,
    command,
    intentDigest: taxConfigCandidateIntentDigest(scope, command),
    outcome: "Committed",
    result: record,
    auditReference: record.auditReference,
    eventReference: record.eventReference,
    occurredAt: preparedAt,
  });
  const current = {
    profile: "TaxConfigCandidateCurrentV1",
    ...scope,
    configurationReference: command.configurationReference,
    targetVersionReference: candidate.content.targetVersionReference,
    record,
    observedAt,
    validUntil,
    qualification: "NotEvaluated",
  };
  const summary = parseTaxConfigCandidateSummary({
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    configurationReference: command.configurationReference,
    targetVersionReference: candidate.content.targetVersionReference,
    targetAggregateVersion: candidate.content.targetAggregateVersion,
    targetVersionNumber: candidate.content.targetVersionNumber,
    contentDigest: candidate.contentDigest,
    baseDraft: command.expectedDraft,
    registrationMaterial,
    preparedByActorReference: scope.actorReference,
    operationReference: command.operationReference,
    preparedAt,
    status: "Recorded",
    qualification: "NotEvaluated",
  });
  const roster = {
    profile: "TaxConfigCandidateRosterV1",
    ...scope,
    configurationReference: command.configurationReference,
    afterCandidate: null,
    entries: [summary],
    nextAfterCandidate: null,
    observedAt,
    validUntil,
    qualification: "NotEvaluated",
  };
  return {
    scope,
    draft,
    registration,
    candidate,
    command,
    allocation,
    record,
    operation,
    current,
    summary,
    roster,
  };
}
describe("Tax candidate preparation public protocol", () => {
  it("keeps the closed browser command allocation-free and hashes the full original scope", () => {
    const f = fixture();
    expect(Object.keys(f.command)).toHaveLength(5);
    expect(f.command).not.toHaveProperty("targetVersionReference");
    expect(taxConfigCandidateIntentDigest(f.scope, f.command)).toBe(
      hash({ scope: f.scope, command: f.command }),
    );
    for (const key of [
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
    ] as const)
      expect(taxConfigCandidateIntentDigest({ ...f.scope, [key]: id(80) }, f.command)).not.toBe(
        f.operation.intentDigest,
      );
    for (const extra of [
      "targetVersionReference",
      "rules",
      "currencyMetadata",
      "approval",
      "professionalEvidence",
      "authority",
    ])
      expect(() => parseTaxConfigCandidateCommand({ ...f.command, [extra]: id(80) })).toThrow();
  });
  it("retains exactly original Draft and Registration metadata in payload-free Resolve", () => {
    const f = fixture(),
      resolve = parseTaxConfigCandidateResolve({
        ...f.command,
        intentDigest: f.operation.intentDigest,
      });
    expect(Object.keys(resolve)).toHaveLength(6);
    expect(resolve.expectedDraft).toEqual(f.command.expectedDraft);
    expect(resolve.registrationMaterial).toEqual(f.command.registrationMaterial);
    expect(resolve).not.toHaveProperty("candidate");
    expect(() =>
      parseTaxConfigCandidateResolve({ ...resolve, content: f.candidate.content }),
    ).toThrow();
    expect(
      taxConfigCandidateIntentDigest(f.scope, {
        ...f.command,
        registrationMaterial: { ...f.command.registrationMaterial, versionReference: id(81) },
      }),
    ).not.toBe(f.operation.intentDigest);
  });
  it("binds actual complete Draft and immutable Registration before recording preparation", () => {
    const f = fixture();
    expect(assertTaxConfigCandidateSources(f.record, f.draft, f.registration)).toEqual(f.record);
    expect(f.record.candidate).toEqual(f.candidate);
    expect(f.record.status).toBe("Recorded");
    expect(f.record.qualification).toBe("NotEvaluated");
    expect(f.record.preparedByActorReference).not.toBe(f.draft.draftAuthorActorReference);
    expect(f.record).not.toHaveProperty("professionalEvidence");
    expect(f.record).not.toHaveProperty("approval");
  });
  it("refuses stale expected Draft pins and a changed actual source rule body", () => {
    const f = fixture();
    expect(() =>
      createTaxConfigCandidateRecord({
        ...f.allocation,
        command: {
          ...f.command,
          expectedDraft: {
            ...f.command.expectedDraft,
            aggregateVersion: f.command.expectedDraft.aggregateVersion + 1,
          },
        },
      }),
    ).toThrow();
    const changed = copy(f.draft);
    changed.snapshot.rules[0].rate = "0.14";
    const { snapshotDigest: previous, ...body } = changed.snapshot;
    expect(previous).toBe(f.draft.snapshot.snapshotDigest);
    changed.snapshot.snapshotDigest = hash(body);
    expect(() => assertTaxConfigCandidateSources(f.record, changed, f.registration)).toThrow();
    const invented = copy(f.draft);
    invented.snapshot.rules[0].rate = "0.14";
    expect(() => assertTaxConfigCandidateSources(f.record, invented, f.registration)).toThrow();
  });
  it("requires Registration kind, exact actual material digest/version/scope and source chronology", () => {
    const f = fixture();
    for (const change of [
      { versionReference: id(82) },
      { materialReference: id(82) },
      { tenantReference: id(82) },
      { materialKind: "ProfessionalReport" },
      { contentDigest: hash({ wrong: true }) },
      { createdAt: validUntil, recordedAt: validUntil },
    ])
      expect(() =>
        assertTaxConfigCandidateSources(f.record, f.draft, { ...f.registration, ...change }),
      ).toThrow();
    expect(() =>
      createTaxConfigCandidateRecord({ ...f.allocation, preparedAt: "2026-08-01T00:00:00.000Z" }),
    ).toThrow();
  });
  it("rejects exhausted int4 bases, nonintegers, missing pins and unknown actions", () => {
    const f = fixture();
    for (const value of [0, -1, 1.1, Number.NaN, 2147483647, Number.MAX_SAFE_INTEGER])
      for (const key of ["aggregateVersion", "versionNumber"])
        expect(() =>
          parseTaxConfigCandidateCommand({
            ...f.command,
            expectedDraft: { ...f.command.expectedDraft, [key]: value },
          }),
        ).toThrow();
    expect(() => parseTaxConfigCandidateCommand({ ...f.command, action: "Publish" })).toThrow();
    expect(() =>
      parseTaxConfigCandidateCommand({ ...f.command, registrationMaterial: null }),
    ).toThrow();
  });
  it("detaches and deeply freezes inputs without invoking nested accessors", () => {
    const f = fixture(),
      raw = copy(f.operation),
      actual = parseTaxConfigCandidateOperation(raw);
    raw.result.candidate.content.rules[0].rate = "0.14";
    expect(actual.result?.candidate.content.rules).toEqual(f.candidate.content.rules);
    expect(Object.isFrozen(actual.result?.candidate.content.rules)).toBe(true);
    let invoked = false;
    const getter = { ...f.command };
    Object.defineProperty(getter, "expectedDraft", {
      enumerable: true,
      get() {
        invoked = true;
        return f.command.expectedDraft;
      },
    });
    expect(() => parseTaxConfigCandidateCommand(getter)).toThrow();
    expect(invoked).toBe(false);
    const nested = copy(f.record);
    Object.defineProperty(nested.candidate.content.rules, "0", {
      enumerable: true,
      get() {
        invoked = true;
        return f.candidate.content.rules[0];
      },
    });
    expect(() => parseTaxConfigCandidateRecord(nested)).toThrow();
    expect(invoked).toBe(false);
  });
  it("checks candidate RFC bytes/digest and rejects sparse arrays, prototype and size attacks", () => {
    const f = fixture(),
      digestAttack = copy(f.record);
    digestAttack.candidate.content.rules[0].rate = "0.14";
    expect(() => parseTaxConfigCandidateRecord(digestAttack)).toThrow();
    const sparse = copy(f.record);
    delete sparse.candidate.content.rules[0];
    expect(() => parseTaxConfigCandidateRecord(sparse)).toThrow();
    const extra = { ...f.record, payload: "x".repeat(300000) };
    expect(() => parseTaxConfigCandidateRecord(extra)).toThrow();
    expect(() =>
      parseTaxConfigCandidateCommand(Object.assign(Object.create(null), f.command)),
    ).toThrow();
  });
  it("requires committed Original actor, operation, metadata pins, Audit/Event and original time", () => {
    const f = fixture();
    expect(parseTaxConfigCandidateOperation(f.operation)).toEqual(f.operation);
    for (const change of [
      { actorReference: id(83) },
      { operationReference: id(83) },
      { auditReference: id(83) },
      { eventReference: null },
      { occurredAt: observedAt },
      { intentDigest: hash({ wrong: true }) },
      { command: null },
      { result: null },
      { configurationReference: id(83) },
    ])
      expect(() => parseTaxConfigCandidateOperation({ ...f.operation, ...change })).toThrow();
    expect(() =>
      parseTaxConfigCandidateOperation({
        ...f.operation,
        registrationMaterial: {
          ...f.command.registrationMaterial,
          contentDigest: hash({ wrong: true }),
        },
      }),
    ).toThrow();
  });
  it("records durable Abandoned with the exact same original pins/hash and no result/event", () => {
    const f = fixture(),
      abandoned = {
        ...f.operation,
        outcome: "Abandoned",
        command: null,
        result: null,
        eventReference: null,
      };
    const actual = parseTaxConfigCandidateOperation(abandoned);
    expect(actual.result).toBeNull();
    expect(actual.intentDigest).toBe(f.operation.intentDigest);
    for (const change of [
      { command: f.command },
      { result: f.record },
      { eventReference: id(83) },
      { intentDigest: hash({ wrong: true }) },
    ])
      expect(() => parseTaxConfigCandidateOperation({ ...abandoned, ...change })).toThrow();
  });
  it("preserves historical preparation by another actor without claiming today's Draft is unchanged", () => {
    const f = fixture();
    const view = parseTaxConfigCandidateCurrent({ ...f.current, actorReference: id(84) });
    expect(view.actorReference).not.toBe(view.record?.preparedByActorReference);
    expect(view.record?.candidate.content.baseDraft).toEqual(f.command.expectedDraft);
    expect(view.qualification).toBe("NotEvaluated");
    expect(view).not.toHaveProperty("currentDraftMatches");
  });
  it("keeps true absence closed and bounds current/historical observation to five seconds", () => {
    const f = fixture();
    expect(
      parseTaxConfigCandidateCurrent({ ...f.current, targetVersionReference: null, record: null })
        .record,
    ).toBeNull();
    for (const change of [
      { targetVersionReference: null },
      { record: null },
      { targetVersionReference: id(85) },
      { storeReference: id(85) },
      { observedAt: "2026-10-01T15:59:59.999Z" },
      { validUntil: observedAt },
      { validUntil: "2026-10-01T16:00:06.001Z" },
      { qualification: "Pass" },
    ])
      expect(() => parseTaxConfigCandidateCurrent({ ...f.current, ...change })).toThrow();
  });
  it("keeps roster projections free of candidate bodies, material contents and qualification claims", () => {
    const f = fixture(),
      parsed = parseTaxConfigCandidateRoster(f.roster);
    expect(parsed.entries[0]).toEqual(f.summary);
    expect(Object.keys(f.summary)).toHaveLength(15);
    for (const key of ["candidate", "rules", "content", "professionalEvidence", "audit"])
      expect(() => parseTaxConfigCandidateSummary({ ...f.summary, [key]: f.candidate })).toThrow();
    expect(() =>
      parseTaxConfigCandidateSummary({
        ...f.summary,
        targetAggregateVersion: f.summary.targetAggregateVersion + 1,
      }),
    ).toThrow();
  });
  it("binds bounded roster pagination to sorted real target identities and exact scopes", () => {
    const f = fixture(),
      entries = Array.from({ length: 20 }, (_, i) => ({
        ...f.summary,
        targetVersionReference: id(200 + i),
      }));
    const next = entries.at(-1)?.targetVersionReference;
    if (!next) throw new Error("missing fixture cursor");
    expect(
      parseTaxConfigCandidateRoster({ ...f.roster, entries, nextAfterCandidate: next })
        .nextAfterCandidate,
    ).toBe(next);
    for (const change of [
      { entries: [...entries, { ...f.summary, targetVersionReference: id(300) }] },
      { entries: [f.summary, f.summary] },
      { entries: entries.toReversed() },
      { afterCandidate: entries[0]?.targetVersionReference, entries },
      { entries: [{ ...f.summary, tenantReference: id(86) }] },
      { nextAfterCandidate: f.summary.targetVersionReference },
    ])
      expect(() => parseTaxConfigCandidateRoster({ ...f.roster, ...change })).toThrow();
    expect(parseTaxConfigCandidateRoster({ ...f.roster, entries: [] }).entries).toHaveLength(0);
  });
});
