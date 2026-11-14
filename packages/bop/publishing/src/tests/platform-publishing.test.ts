import { describe, expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  createPublishingReleaseRecord,
  parsePlatformPublishingScope,
  parsePlatformPublishingLifecycleRecord,
  parsePlatformPublishingValidationEvidence,
  parsePlatformPublishingApprovalEvidence,
  parsePlatformPublishingReleaseRecord,
  parsePlatformPublishingCommand,
  platformPublishingCommandDigest,
  validatePlatformPublishingTransition,
  type PublishingLifecycleRecord,
} from "../index.js";

const id = (n: number) => `018f2000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const author = id(1),
  submitter = id(2),
  approver = id(3),
  family = id(4),
  lifecycle = id(5);
const snapshot = id(6),
  validationId = id(7),
  approvalId = id(8),
  releaseId = id(9);
const scope = { kind: "Platform", brandReference: null, storeReference: null };
const time = (minute: number) => `2026-10-06T12:${String(minute).padStart(2, "0")}:00.000Z`;
const digest = `sha256:${"a".repeat(64)}`;
const draft = {
  lifecycleId: lifecycle,
  familyReference: family,
  configurationType: "PLATFORM_BRAND_TEMPLATE",
  purposeCode: "PLATFORM_BRAND_TEMPLATE",
  snapshotReference: snapshot,
  snapshotDigest: digest,
  scope,
  version: 1,
  state: "Draft",
  validationEvidenceReference: null,
  approvalEvidenceReference: null,
  createdAt: time(0),
  changedAt: time(0),
  authoredActorReference: author,
  submittedActorReference: null,
  reviewValidUntil: null,
};
const validation = {
  evidenceReference: validationId,
  snapshotReference: snapshot,
  snapshotDigest: digest,
  scope,
  result: "Pass",
  checkedAt: time(1),
  validUntil: time(30),
  checkCodes: ["TEMPLATE_POLICY_VALID"],
};
const review = {
  ...draft,
  version: 2,
  state: "InReview",
  changedAt: time(2),
  validationEvidenceReference: validationId,
  submittedActorReference: submitter,
  reviewValidUntil: time(30),
};
const approval = {
  evidenceReference: approvalId,
  reviewLifecycleId: lifecycle,
  reviewVersion: 2,
  snapshotReference: snapshot,
  snapshotDigest: digest,
  scope,
  decision: "Accepted",
  approvedActorReference: approver,
  approvedAt: time(3),
  validUntil: time(30),
  authoredActorReference: author,
  submittedActorReference: submitter,
};
const approved = {
  ...review,
  version: 3,
  state: "Approved",
  changedAt: time(3),
  approvalEvidenceReference: approvalId,
};
const published = { ...approved, version: 4, state: "Published", changedAt: time(4) };
const release = {
  releaseId,
  familyReference: family,
  configurationType: "PLATFORM_BRAND_TEMPLATE",
  purposeCode: "PLATFORM_BRAND_TEMPLATE",
  snapshotReference: snapshot,
  snapshotDigest: digest,
  scope,
  sequence: 1,
  sourceLifecycleId: lifecycle,
  kind: "Publish",
  previousReleaseId: null,
  createdAt: time(4),
};
function command(operation: string, current: unknown, next: unknown, at: string, actor = author) {
  return {
    profile: "PlatformPublishingCommandV1",
    operation,
    operationReference: id(10),
    currentActorReference: actor,
    expectedVersion: (current as { version: number } | null)?.version ?? 1,
    current,
    next,
    validationEvidence: operation === "CreateDraft" ? null : validation,
    approvalEvidence: operation === "CreateDraft" || operation === "SubmitReview" ? null : approval,
    release: operation === "Publish" ? release : null,
    previousRelease: null,
    rollbackTarget: null,
    occurredAt: at,
  };
}
const create = () => command("CreateDraft", null, draft, time(0));
const submit = () => command("SubmitReview", draft, review, time(2), submitter);
const approve = () => command("Approve", review, approved, time(3), approver);
const publish = () => command("Publish", approved, published, time(4), approver);

describe("global Platform Brand template Publishing contract", () => {
  it("validates actual supplied author, submitter, independent approver and release lineage", () => {
    for (const value of [create(), submit(), approve(), publish()]) {
      const parsed = validatePlatformPublishingTransition(value);
      expect(parsed.next.scope).toEqual(scope);
      expect(Object.isFrozen(parsed)).toBe(true);
      expect(Object.isFrozen(parsed.next.scope)).toBe(true);
      expect(Object.hasOwn(parsed, "tenantReference")).toBe(false);
    }
    const archived = { ...published, version: 5, state: "Archived", changedAt: time(40) };
    expect(
      validatePlatformPublishingTransition(command("Archive", published, archived, time(40))).next
        .state,
    ).toBe("Archived");
  });
  it("rejects author or submitter approving and mismatched actual current Actor", () => {
    for (const actor of [author, submitter]) {
      expect(() =>
        validatePlatformPublishingTransition({
          ...approve(),
          currentActorReference: actor,
          approvalEvidence: { ...approval, approvedActorReference: actor },
        }),
      ).toThrow();
    }
    expect(() =>
      validatePlatformPublishingTransition({ ...approve(), currentActorReference: id(20) }),
    ).toThrow();
    expect(() =>
      validatePlatformPublishingTransition({
        ...submit(),
        next: { ...review, submittedActorReference: author },
      }),
    ).toThrow();
    expect(() =>
      validatePlatformPublishingTransition({
        ...create(),
        next: { ...draft, authoredActorReference: submitter },
      }),
    ).toThrow();
  });
  it("retains the author of the same immutable snapshot across draft revisions", () => {
    const revised = { ...draft, version: 2, changedAt: time(1) };
    expect(
      validatePlatformPublishingTransition(command("CreateDraft", draft, revised, time(1))).next
        .authoredActorReference,
    ).toBe(author);
    expect(() =>
      validatePlatformPublishingTransition(
        command(
          "CreateDraft",
          draft,
          { ...revised, authoredActorReference: submitter },
          time(1),
          submitter,
        ),
      ),
    ).toThrow();
    expect(
      validatePlatformPublishingTransition(
        command(
          "CreateDraft",
          draft,
          {
            ...revised,
            snapshotReference: id(40),
            snapshotDigest: `sha256:${"b".repeat(64)}`,
            authoredActorReference: submitter,
          },
          time(1),
          submitter,
        ),
      ).next.authoredActorReference,
    ).toBe(submitter);
  });
  it("bounds validation by the recorded submission and approval chronology", () => {
    expect(() =>
      validatePlatformPublishingTransition({
        ...approve(),
        validationEvidence: { ...validation, checkedAt: time(3) },
      }),
    ).toThrow();
    expect(
      validatePlatformPublishingTransition({
        ...approve(),
        validationEvidence: { ...validation, checkedAt: review.changedAt },
      }).operation,
    ).toBe("Approve");
    const archived = { ...published, version: 5, state: "Archived", changedAt: time(40) };
    const archive = command("Archive", published, archived, time(40));
    for (const value of [publish(), archive]) {
      expect(() =>
        validatePlatformPublishingTransition({
          ...value,
          validationEvidence: { ...validation, checkedAt: time(4) },
        }),
      ).toThrow();
      expect(
        validatePlatformPublishingTransition({
          ...value,
          validationEvidence: { ...validation, checkedAt: approval.approvedAt },
        }).operation,
      ).toBe(value.operation);
      expect(() =>
        validatePlatformPublishingTransition({
          ...value,
          approvalEvidence: {
            ...approval,
            approvedAt: value.operation === "Publish" ? "2026-10-06T12:03:30.000Z" : time(5),
          },
        }),
      ).toThrow();
    }
    expect(validatePlatformPublishingTransition(archive).next.reviewValidUntil).toBe(time(30));
  });
  it("keeps the original review deadline separate from authorization and refuses expiry", () => {
    expect(() =>
      validatePlatformPublishingTransition({
        ...approve(),
        approvalEvidence: { ...approval, validUntil: time(4) },
      }),
    ).toThrow();
    expect(() =>
      validatePlatformPublishingTransition({
        ...approve(),
        next: { ...approved, reviewValidUntil: time(40) },
        approvalEvidence: { ...approval, validUntil: time(40) },
      }),
    ).toThrow();
    expect(() =>
      validatePlatformPublishingTransition({
        ...submit(),
        occurredAt: time(30),
        next: { ...review, changedAt: time(30) },
      }),
    ).toThrow();
    expect(() =>
      validatePlatformPublishingTransition({
        ...approve(),
        occurredAt: time(30),
        next: { ...approved, changedAt: time(30) },
        approvalEvidence: { ...approval, approvedAt: time(30) },
      }),
    ).toThrow();
    expect(() =>
      validatePlatformPublishingTransition({
        ...publish(),
        occurredAt: time(30),
        next: { ...published, changedAt: time(30) },
        release: { ...release, createdAt: time(30) },
      }),
    ).toThrow();
  });
  it("binds every evidence reference, immutable snapshot digest, family and review version", () => {
    const cases = [
      {
        ...submit(),
        validationEvidence: { ...validation, snapshotDigest: `sha256:${"b".repeat(64)}` },
      },
      { ...submit(), validationEvidence: { ...validation, checkedAt: time(3) } },
      { ...approve(), approvalEvidence: { ...approval, reviewVersion: 1 } },
      { ...approve(), approvalEvidence: { ...approval, authoredActorReference: id(30) } },
      { ...publish(), release: { ...release, familyReference: id(30) } },
      { ...publish(), release: { ...release, sourceLifecycleId: id(30) } },
      { ...publish(), next: { ...published, snapshotReference: id(30) } },
      { ...create(), next: { ...draft, purposeCode: "OTHER_TEMPLATE" } },
      command(
        "CreateDraft",
        draft,
        { ...draft, version: 2, changedAt: time(1), snapshotDigest: `sha256:${"b".repeat(64)}` },
        time(1),
      ),
    ];
    for (const value of cases) expect(() => validatePlatformPublishingTransition(value)).toThrow();
  });
  it("requires release sequences and a historical same-family rollback target", () => {
    const previous = {
      ...release,
      releaseId: id(31),
      sequence: 2,
      previousReleaseId: releaseId,
      snapshotReference: id(32),
      createdAt: time(5),
    };
    const rollbackRelease = {
      ...release,
      releaseId: id(33),
      kind: "Rollback",
      sequence: 3,
      previousReleaseId: previous.releaseId,
      createdAt: time(6),
    };
    const rollback = {
      ...publish(),
      operation: "Rollback",
      next: { ...published, changedAt: time(6) },
      occurredAt: time(6),
      release: rollbackRelease,
      previousRelease: previous,
      rollbackTarget: release,
    };
    expect(validatePlatformPublishingTransition(rollback).release?.sequence).toBe(3);
    expect(() =>
      validatePlatformPublishingTransition({ ...rollback, rollbackTarget: previous }),
    ).toThrow();
    expect(() =>
      validatePlatformPublishingTransition({
        ...rollback,
        rollbackTarget: { ...release, familyReference: id(34) },
      }),
    ).toThrow();
    expect(() =>
      validatePlatformPublishingTransition({
        ...rollback,
        release: { ...rollbackRelease, sequence: 4 },
      }),
    ).toThrow();
    expect(() =>
      validatePlatformPublishingTransition({ ...publish(), rollbackTarget: release }),
    ).toThrow();
  });
  it("closes descriptors and arrays without invoking getters and detaches frozen records", () => {
    let accessed = false;
    const accessor = { ...create() };
    Object.defineProperty(accessor, "next", {
      enumerable: true,
      get() {
        accessed = true;
        return draft;
      },
    });
    expect(() => parsePlatformPublishingCommand(accessor)).toThrow();
    expect(accessed).toBe(false);
    expect(() => parsePlatformPublishingScope({ ...scope, tenantReference: id(40) })).toThrow();
    expect(() => parsePlatformPublishingScope({ ...scope, brandReference: id(40) })).toThrow();
    expect(() =>
      parsePlatformPublishingValidationEvidence({ ...validation, checkCodes: new Array(1) }),
    ).toThrow();
    const getterArray = ["TEMPLATE_POLICY_VALID"];
    Object.defineProperty(getterArray, "0", {
      enumerable: true,
      get() {
        accessed = true;
        return "TEMPLATE_POLICY_VALID";
      },
    });
    expect(() =>
      parsePlatformPublishingValidationEvidence({ ...validation, checkCodes: getterArray }),
    ).toThrow();
    expect(accessed).toBe(false);
    const original = structuredClone(submit());
    const parsed = validatePlatformPublishingTransition(original);
    if (original.validationEvidence === null) throw new Error("Submit evidence missing");
    original.validationEvidence.checkCodes[0] = "OTHER_CHECK";
    expect(parsed.validationEvidence?.checkCodes).toEqual(["TEMPLATE_POLICY_VALID"]);
    expect(Object.isFrozen(parsed.validationEvidence?.checkCodes)).toBe(true);
  });
  it("hashes the full parsed original command canonically including Actor and operation identity", () => {
    const input = submit(),
      parsed = parsePlatformPublishingCommand(input);
    const expected = `sha256:${sha256Hex(canonicalizeRfc8785(parsed))}`;
    expect(platformPublishingCommandDigest(input)).toBe(expected);
    expect(
      platformPublishingCommandDigest(Object.fromEntries(Object.entries(input).reverse())),
    ).toBe(expected);
    expect(platformPublishingCommandDigest({ ...input, operationReference: id(50) })).not.toBe(
      expected,
    );
    expect(platformPublishingCommandDigest({ ...input, currentActorReference: id(50) })).not.toBe(
      expected,
    );
  });
  it("keeps existing public Brand and Store parsers closed against Platform scope", () => {
    expect(() =>
      createPublishingScope(scope as unknown as Parameters<typeof createPublishingScope>[0]),
    ).toThrow();
    const {
      authoredActorReference: _author,
      submittedActorReference: _submitter,
      reviewValidUntil: _deadline,
      ...oldLifecycle
    } = draft;
    expect([_author, _submitter, _deadline]).toEqual([author, null, null]);
    expect(() =>
      createPublishingLifecycleRecord(oldLifecycle as unknown as PublishingLifecycleRecord),
    ).toThrow();
    expect(() =>
      createPublishingValidationEvidence(
        validation as unknown as Parameters<typeof createPublishingValidationEvidence>[0],
      ),
    ).toThrow();
    const {
      authoredActorReference: _approvalAuthor,
      submittedActorReference: _approvalSubmitter,
      ...oldApproval
    } = approval;
    expect([_approvalAuthor, _approvalSubmitter]).toEqual([author, submitter]);
    expect(() =>
      createPublishingApprovalEvidence(
        oldApproval as unknown as Parameters<typeof createPublishingApprovalEvidence>[0],
      ),
    ).toThrow();
    expect(() =>
      createPublishingReleaseRecord(
        release as unknown as Parameters<typeof createPublishingReleaseRecord>[0],
      ),
    ).toThrow();
    for (const brandScope of [
      { kind: "Brand", brandReference: id(60), storeReference: null },
      { kind: "Store", brandReference: id(60), storeReference: id(61) },
    ]) {
      expect(() =>
        createPublishingScope(brandScope as Parameters<typeof createPublishingScope>[0]),
      ).not.toThrow();
    }
    expect(parsePlatformPublishingLifecycleRecord(draft).scope.kind).toBe("Platform");
    expect(parsePlatformPublishingApprovalEvidence(approval).scope.kind).toBe("Platform");
    expect(parsePlatformPublishingReleaseRecord(release).scope.kind).toBe("Platform");
  });
});
