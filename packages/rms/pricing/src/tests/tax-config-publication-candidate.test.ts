import { describe, expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { input } from "./price-quote.fixture.js";
import {
  parsePricingReference,
  parsePricingDigest,
  parsePricingCode,
} from "../domain/money-tax-contract.js";
import { createTaxConfigurationSnapshot } from "../domain/tax-configuration.js";
import { parseTaxConfigAuthoringState } from "../contracts/tax-config-authoring.js";
import {
  createTaxPublicationCandidate,
  parseTaxPublicationCandidate,
  parseTaxPublicationCandidateContent,
  assertTaxPublicationCandidateDraft,
  matchTaxPublicationCandidatePublishedSnapshot,
} from "../contracts/tax-config-publication-candidate.js";
const id = (n: number) =>
  parsePricingReference(`01913159-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const digest = (v: unknown) => parsePricingDigest("sha256:" + sha256Hex(canonicalizeRfc8785(v)));
const copy = (v: unknown) => JSON.parse(JSON.stringify(v));
function fixture() {
  const original = input().taxConfiguration;
  const body = {
    ...original,
    lifecycle: "Draft" as const,
    registrationEvidence: null,
    professionalEvidence: null,
  };
  const { snapshotDigest: old, ...preimage } = body;
  expect(old).toMatch(/^sha256:/u);
  const snapshot = createTaxConfigurationSnapshot({
    ...preimage,
    snapshotDigest: digest(preimage),
  });
  const draft = parseTaxConfigAuthoringState({
    profile: "TaxConfigAuthoringStateV1",
    tenantReference: id(1),
    brandReference: snapshot.brandReference,
    storeReference: snapshot.storeReference,
    draftAuthorActorReference: id(2),
    snapshot,
  });
  const allocation = {
    draft,
    targetVersionReference: id(3),
    sourceRuleBindings: snapshot.rules.map((r, i) => ({
      sourceRuleReference: r.ruleReference,
      targetRuleReference: id(20 + i),
    })),
    registrationMaterial: {
      materialReference: id(4),
      versionReference: id(5),
      contentDigest: digest({ material: "controlled declared registration" }),
    },
  };
  return { draft, allocation, candidate: createTaxPublicationCandidate(allocation) };
}
function published() {
  const f = fixture(),
    c = f.candidate.content,
    at = "2026-08-03T12:00:00.000Z";
  // Controlled evidence-format fixture only, not authenticated professional facts.
  const snapshot = createTaxConfigurationSnapshot({
    ...f.draft.snapshot,
    versionReference: c.targetVersionReference,
    aggregateVersion: c.targetAggregateVersion,
    versionNumber: c.targetVersionNumber,
    lifecycle: "Published",
    snapshotDigest: f.candidate.contentDigest,
    rules: c.rules,
    createdAt: at,
    registrationEvidence: {
      applicabilityReference: id(50),
      operatingEntityTaxReference: id(51),
      jurisdictionProfileReference: id(52),
      status: "Verified",
      validUntil: "2026-09-01T00:00:00.000Z",
    },
    professionalEvidence: {
      evidenceReference: id(53),
      snapshotReference: c.targetVersionReference,
      snapshotDigest: f.candidate.contentDigest,
      professionalReviewReference: id(54),
      fixtureSuiteReference: id(55),
      fixtureSuiteDigest: digest({ fixture: "controlled" }),
      result: "Pass",
      reviewedAt: "2026-08-03T11:00:00.000Z",
      validUntil: "2026-09-01T00:00:00.000Z",
    },
  });
  return { ...f, at, snapshot };
}
describe("Tax immutable publication candidate content", () => {
  it("allocates exact successor content with a nonrecursive RFC8785 digest", () => {
    const { candidate, draft } = fixture();
    expect(candidate.contentDigest).toBe(digest(candidate.content));
    expect(candidate.content.baseDraft.versionReference).toBe(draft.snapshot.versionReference);
    expect(candidate.content.targetAggregateVersion).toBe(draft.snapshot.aggregateVersion + 1);
    expect(candidate.content.targetVersionNumber).toBe(draft.snapshot.versionNumber + 1);
    expect(candidate.content).not.toHaveProperty("professionalEvidence");
    expect(candidate.content).not.toHaveProperty("createdAt");
    expect(candidate.content).not.toHaveProperty("contentDigest");
    expect(assertTaxPublicationCandidateDraft(candidate, draft)).toEqual(candidate);
  });
  it("preserves every source rule value and order with new one-to-one identities", () => {
    const { candidate, draft } = fixture();
    for (let i = 0; i < draft.snapshot.rules.length; i++) {
      expect(candidate.content.rules[i]).toEqual({
        ...draft.snapshot.rules[i],
        ruleReference: candidate.content.sourceRuleBindings[i]?.targetRuleReference,
      });
    }
    expect(candidate.content.sourceRuleBindings.map((b) => b.sourceRuleReference)).toEqual(
      draft.snapshot.rules.map((r) => r.ruleReference),
    );
  });
  it("rejects reordered source joins and duplicate target IDs in a multi-rule candidate", () => {
    const { draft, allocation } = fixture(),
      first = draft.snapshot.rules[0];
    if (!first) throw new Error("fixture rule missing");
    const { snapshotDigest: originalDigest, ...body } = draft.snapshot;
    expect(originalDigest).toMatch(/^sha256:/u);
    const nextBody = {
      ...body,
      rules: [
        first,
        {
          ...first,
          ruleReference: id(70),
          taxComponentCode: parsePricingCode("SECOND_COMPONENT"),
          calculationOrder: 2,
        },
      ],
    };
    const two = parseTaxConfigAuthoringState({
      ...draft,
      snapshot: { ...nextBody, snapshotDigest: digest(nextBody) },
    });
    const request = {
      ...allocation,
      draft: two,
      sourceRuleBindings: two.snapshot.rules.map((r, i) => ({
        sourceRuleReference: r.ruleReference,
        targetRuleReference: id(71 + i),
      })),
    };
    const candidate = createTaxPublicationCandidate(request),
      raw = copy(candidate);
    raw.content.rules.reverse();
    raw.content.sourceRuleBindings.reverse();
    raw.contentDigest = digest(raw.content);
    expect(() => assertTaxPublicationCandidateDraft(raw, two)).toThrow();
    expect(() =>
      createTaxPublicationCandidate({
        ...request,
        sourceRuleBindings: request.sourceRuleBindings.map((b) => ({
          ...b,
          targetRuleReference: id(71),
        })),
      }),
    ).toThrow();
  });
  it("binds selected immutable registration bytes without inferring their qualification", () => {
    const { allocation, candidate } = fixture();
    const next = createTaxPublicationCandidate({
      ...allocation,
      registrationMaterial: {
        ...allocation.registrationMaterial,
        contentDigest: digest({ changed: true }),
      },
    });
    expect(next.contentDigest).not.toBe(candidate.contentDigest);
    expect(next.content).not.toHaveProperty("registrationEvidence");
  });
  it("returns detached frozen content and leaves historical Draft bytes unchanged", () => {
    const { allocation, draft } = fixture(),
      before = canonicalizeRfc8785(draft),
      raw = copy(allocation),
      candidate = createTaxPublicationCandidate(raw);
    raw.registrationMaterial.contentDigest = digest({ changed: true });
    expect(candidate.content.registrationMaterial.contentDigest).toBe(
      allocation.registrationMaterial.contentDigest,
    );
    expect(Object.isFrozen(candidate.content.rules)).toBe(true);
    expect(Object.isFrozen(candidate.content.rules[0])).toBe(true);
    expect(canonicalizeRfc8785(draft)).toBe(before);
  });
  it("rejects unknown qualification/clock fields and altered digest", () => {
    const { candidate } = fixture();
    for (const extra of [
      { professionalEvidence: {} },
      { createdAt: "2026-08-03T12:00:00.000Z" },
      { contentDigest: candidate.contentDigest },
    ])
      expect(() =>
        parseTaxPublicationCandidateContent({ ...candidate.content, ...extra }),
      ).toThrow();
    expect(() =>
      parseTaxPublicationCandidate({ ...candidate, contentDigest: digest({ tampered: true }) }),
    ).toThrow();
  });
  it("rejects getters without invoking them and sparse/extended rule arrays", () => {
    const { allocation, candidate } = fixture();
    let calls = 0;
    const raw = { ...allocation };
    Object.defineProperty(raw, "targetVersionReference", {
      enumerable: true,
      get() {
        calls++;
        return id(3);
      },
    });
    expect(() => createTaxPublicationCandidate(raw)).toThrow();
    expect(calls).toBe(0);
    const sparse = copy(candidate.content);
    delete sparse.rules[0];
    expect(() => parseTaxPublicationCandidateContent(sparse)).toThrow();
    const extra = copy(candidate.content);
    extra.rules.extra = "bad";
    expect(() => parseTaxPublicationCandidateContent(extra)).toThrow();
  });
  it("rejects reused rule/version allocations and missing source joins", () => {
    const { allocation, draft } = fixture();
    expect(() =>
      createTaxPublicationCandidate({
        ...allocation,
        targetVersionReference: draft.snapshot.versionReference,
      }),
    ).toThrow();
    expect(() =>
      createTaxPublicationCandidate({ ...allocation, sourceRuleBindings: [] }),
    ).toThrow();
    expect(() =>
      createTaxPublicationCandidate({
        ...allocation,
        sourceRuleBindings: allocation.sourceRuleBindings.map((b) => ({
          ...b,
          targetRuleReference: b.sourceRuleReference,
        })),
      }),
    ).toThrow();
    expect(() =>
      createTaxPublicationCandidate({
        ...allocation,
        sourceRuleBindings: allocation.sourceRuleBindings.map((b) => ({
          ...b,
          sourceRuleReference: id(99),
        })),
      }),
    ).toThrow();
  });
  it("refuses candidate target rate/context inventions even with a recalculated hash", () => {
    const { candidate, draft } = fixture();
    const raw = copy(candidate);
    raw.content.rules[0].rate = "0.17";
    raw.contentDigest = digest(raw.content);
    expect(() => assertTaxPublicationCandidateDraft(raw, draft)).toThrow();
    raw.content.rules[0].rate = candidate.content.rules[0]?.rate;
    raw.content.rules[0].taxClassificationReference = id(80);
    raw.contentDigest = digest(raw.content);
    expect(() => assertTaxPublicationCandidateDraft(raw, draft)).toThrow();
  });
  it("refuses changed base root, scope, currency or effective period", () => {
    const { candidate, draft } = fixture();
    for (const change of [
      { snapshot: { ...draft.snapshot, aggregateVersion: draft.snapshot.aggregateVersion + 1 } },
      { tenantReference: id(81) },
      {
        snapshot: {
          ...draft.snapshot,
          currencyMetadata: { ...draft.snapshot.currencyMetadata, metadataVersion: 2 },
        },
      },
      {
        snapshot: {
          ...draft.snapshot,
          effectivePeriod: {
            ...draft.snapshot.effectivePeriod,
            effectiveUntil: {
              instant: "2026-08-05T04:00:00.000Z",
              localDateTime: "2026-08-05T00:00:00.000",
              utcOffsetMinutes: -240,
            },
          },
        },
      },
    ])
      expect(() =>
        assertTaxPublicationCandidateDraft(candidate, { ...draft, ...change }),
      ).toThrow();
  });
  it("requires exact successor numbering and closed registration material", () => {
    const { candidate } = fixture();
    expect(() =>
      parseTaxPublicationCandidateContent({
        ...candidate.content,
        targetAggregateVersion: candidate.content.baseDraft.aggregateVersion + 2,
      }),
    ).toThrow();
    expect(() =>
      parseTaxPublicationCandidateContent({
        ...candidate.content,
        targetVersionNumber: candidate.content.baseDraft.versionNumber,
      }),
    ).toThrow();
    expect(() =>
      parseTaxPublicationCandidateContent({
        ...candidate.content,
        registrationMaterial: { ...candidate.content.registrationMaterial, status: "Verified" },
      }),
    ).toThrow();
  });
  it("matches delayed Published content while binding the actual publish time separately", () => {
    const { candidate, snapshot, at } = published();
    expect(matchTaxPublicationCandidatePublishedSnapshot(candidate, snapshot, at)).toEqual(
      snapshot,
    );
    expect(snapshot.professionalEvidence?.snapshotDigest).toBe(candidate.contentDigest);
    expect(() =>
      matchTaxPublicationCandidatePublishedSnapshot(
        candidate,
        snapshot,
        "2026-08-03T12:00:00.001Z",
      ),
    ).toThrow();
  });
  it("does not infer material applicability or professional approval from content parity", () => {
    const { candidate, snapshot, at } = published();
    expect(snapshot.registrationEvidence?.applicabilityReference).not.toBe(
      candidate.content.registrationMaterial.materialReference,
    );
    expect(matchTaxPublicationCandidatePublishedSnapshot(candidate, snapshot, at)).toEqual(
      snapshot,
    );
    expect(() =>
      matchTaxPublicationCandidatePublishedSnapshot(
        candidate,
        { ...snapshot, professionalEvidence: null },
        at,
      ),
    ).toThrow();
  });
  it("rejects Published content drift despite reused target digest and evidence", () => {
    const { candidate, snapshot, at } = published();
    expect(() =>
      matchTaxPublicationCandidatePublishedSnapshot(
        candidate,
        { ...snapshot, rules: snapshot.rules.map((r) => ({ ...r, rate: "0.17" })) },
        at,
      ),
    ).toThrow();
    expect(() =>
      matchTaxPublicationCandidatePublishedSnapshot(
        candidate,
        { ...snapshot, versionReference: id(90) },
        at,
      ),
    ).toThrow();
    expect(() =>
      matchTaxPublicationCandidatePublishedSnapshot(
        candidate,
        { ...snapshot, lifecycle: "Draft" },
        at,
      ),
    ).toThrow();
  });
});
