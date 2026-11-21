import { describe, expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildPlatformPublishingSource,
  parsePlatformPublishingSource,
  parsePlatformPublishingSourceScope,
  parsePlatformPublishingRequest,
  parsePlatformPublishingOriginal,
  platformPublishingIntentDigest,
  parsePlatformPublishingResolve,
  parsePlatformPublishingReceipt,
  parsePlatformPublishingCurrent,
  parsePlatformPublishingExact,
  parsePlatformPublishingHistory,
  type PlatformPublishingSource,
} from "../contracts/platform-publishing-source.js";

const id = (n: number) => `01902628-0030-7000-8000-${n.toString(16).padStart(12, "0")}`;
const time = (minute: number) => `2026-10-06T12:${String(minute).padStart(2, "0")}:00.000Z`;
const contentDigest = `sha256:${"a".repeat(64)}`,
  templateSourceDigest = `sha256:${"b".repeat(64)}`;
const actorScope = (actor = id(1)) =>
  parsePlatformPublishingSourceScope({
    kind: "Platform",
    actorReference: actor,
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
  });
const pureScope = { kind: "Platform", brandReference: null, storeReference: null };
function body(source: PlatformPublishingSource) {
  const { sourceDigest, ...rest } = source;
  void sourceDigest;
  return rest;
}
function head(source: PlatformPublishingSource) {
  return {
    lifecycleReference: source.command.next.lifecycleId,
    version: source.command.next.version,
    sourceDigest: source.sourceDigest,
  };
}
function fixtures() {
  const next = {
    lifecycleId: id(4),
    familyReference: id(5),
    configurationType: "PLATFORM_BRAND_TEMPLATE",
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
    snapshotReference: id(6),
    snapshotDigest: contentDigest,
    scope: pureScope,
    version: 1,
    state: "Draft",
    validationEvidenceReference: null,
    approvalEvidenceReference: null,
    createdAt: time(0),
    changedAt: time(0),
    authoredActorReference: id(1),
    submittedActorReference: null,
    reviewValidUntil: null,
  };
  const request = {
    profile: "PlatformPublishingRequestV1",
    operation: "CreateDraft",
    operationReference: id(10),
    templateReference: id(5),
    templateVersionReference: id(6),
    contentDigest,
    templateSourceDigest,
    expectedLifecycle: null,
    reviewValidUntil: null,
    reasonCode: "OPERATOR_REQUESTED",
  };
  const command = {
    profile: "PlatformPublishingCommandV1",
    operation: "CreateDraft",
    operationReference: id(10),
    currentActorReference: id(1),
    expectedVersion: 1,
    current: null,
    next,
    validationEvidence: null,
    approvalEvidence: null,
    release: null,
    previousRelease: null,
    rollbackTarget: null,
    occurredAt: time(0),
  };
  const create = (
    n: number,
    scope: ReturnType<typeof actorScope>,
    input: unknown,
    cmd: unknown,
  ) => {
    const original = parsePlatformPublishingOriginal({
      profile: "PlatformPublishingOriginalV1",
      scope,
      request: input,
    });
    return buildPlatformPublishingSource({
      profile: "PlatformPublishingSourceV1",
      sequence: n,
      templateSourceDigest,
      originalCommand: original,
      intentDigest: platformPublishingIntentDigest(original),
      command: cmd,
      auditReference: id(100 + n),
    });
  };
  const draft = create(1, actorScope(), request, command);
  const validation = {
    evidenceReference: id(20),
    snapshotReference: id(6),
    snapshotDigest: contentDigest,
    scope: pureScope,
    result: "Pass",
    checkedAt: time(1),
    validUntil: time(30),
    checkCodes: ["TEMPLATE_POLICY_VALID"],
  };
  const reviewNext = {
    ...next,
    version: 2,
    state: "InReview",
    validationEvidenceReference: id(20),
    changedAt: time(2),
    submittedActorReference: id(2),
    reviewValidUntil: time(30),
  };
  const review = create(
    2,
    actorScope(id(2)),
    {
      ...request,
      operation: "SubmitReview",
      operationReference: id(11),
      expectedLifecycle: head(draft),
      reviewValidUntil: time(30),
    },
    {
      ...command,
      operation: "SubmitReview",
      operationReference: id(11),
      currentActorReference: id(2),
      expectedVersion: 1,
      current: next,
      next: reviewNext,
      validationEvidence: validation,
      occurredAt: time(2),
    },
  );
  const approval = {
    evidenceReference: id(21),
    reviewLifecycleId: id(4),
    reviewVersion: 2,
    snapshotReference: id(6),
    snapshotDigest: contentDigest,
    scope: pureScope,
    decision: "Accepted",
    approvedActorReference: id(3),
    authoredActorReference: id(1),
    submittedActorReference: id(2),
    approvedAt: time(3),
    validUntil: time(30),
  };
  const approvedNext = {
    ...reviewNext,
    version: 3,
    state: "Approved",
    approvalEvidenceReference: id(21),
    changedAt: time(3),
  };
  const approved = create(
    3,
    actorScope(id(3)),
    {
      ...request,
      operation: "Approve",
      operationReference: id(12),
      expectedLifecycle: head(review),
    },
    {
      ...command,
      operation: "Approve",
      operationReference: id(12),
      currentActorReference: id(3),
      expectedVersion: 2,
      current: reviewNext,
      next: approvedNext,
      validationEvidence: validation,
      approvalEvidence: approval,
      occurredAt: time(3),
    },
  );
  const release = {
    releaseId: id(22),
    familyReference: id(5),
    configurationType: "PLATFORM_BRAND_TEMPLATE",
    purposeCode: "PLATFORM_BRAND_TEMPLATE",
    snapshotReference: id(6),
    snapshotDigest: contentDigest,
    scope: pureScope,
    sequence: 1,
    sourceLifecycleId: id(4),
    kind: "Publish",
    previousReleaseId: null,
    createdAt: time(4),
  };
  const publishedNext = { ...approvedNext, version: 4, state: "Published", changedAt: time(4) };
  const published = create(
    4,
    actorScope(id(3)),
    {
      ...request,
      operation: "Publish",
      operationReference: id(13),
      expectedLifecycle: head(approved),
    },
    {
      ...command,
      operation: "Publish",
      operationReference: id(13),
      currentActorReference: id(3),
      expectedVersion: 3,
      current: approvedNext,
      next: publishedNext,
      validationEvidence: validation,
      approvalEvidence: approval,
      release,
      occurredAt: time(4),
    },
  );
  const archived = create(
    5,
    actorScope(id(3)),
    {
      ...request,
      operation: "Archive",
      operationReference: id(14),
      expectedLifecycle: head(published),
    },
    {
      ...command,
      operation: "Archive",
      operationReference: id(14),
      currentActorReference: id(3),
      expectedVersion: 4,
      current: publishedNext,
      next: { ...publishedNext, version: 5, state: "Archived", changedAt: time(35) },
      validationEvidence: validation,
      approvalEvidence: approval,
      occurredAt: time(35),
    },
  );
  return { draft, review, approved, published, archived };
}
const committed = (source: PlatformPublishingSource) => ({
  profile: "PlatformPublishingReceiptV1",
  ...source.originalCommand.scope,
  operationReference: source.originalCommand.request.operationReference,
  intentDigest: source.intentDigest,
  outcome: "Committed",
  originalCommand: source.originalCommand,
  source,
  auditReference: source.auditReference,
  occurredAt: source.command.occurredAt,
});
const current = (
  source: PlatformPublishingSource | null,
  release: PlatformPublishingSource | null = null,
) => ({
  profile: "PlatformPublishingCurrentV1",
  scope: actorScope(id(9)),
  templateReference: id(5),
  lifecycleReference: null,
  current: source,
  currentRelease: release,
  observedAt: time(36),
  validUntil: "2026-10-06T12:36:05.000Z",
});

describe("Platform Publishing ordinary source contract", () => {
  it("accepts all five owning results and preserves an expired historical Archive", () => {
    const f = fixtures();
    for (const source of Object.values(f))
      expect(parsePlatformPublishingSource(source)).toEqual(source);
    expect(f.archived.command.next.reviewValidUntil).toBe(time(30));
    expect(f.archived.command.occurredAt).toBe(time(35));
    expect(f.review.originalCommand.request.reviewValidUntil).toBe(time(30));
  });
  it("keeps browser intent closed and never accepts Actor, evidence, time or Rollback", () => {
    const r = fixtures().draft.originalCommand.request;
    for (const key of [
      "actorReference",
      "occurredAt",
      "current",
      "next",
      "validationEvidence",
      "approvalEvidence",
      "release",
    ])
      expect(() => parsePlatformPublishingRequest({ ...r, [key]: null })).toThrow();
    expect(() => parsePlatformPublishingRequest({ ...r, operation: "Rollback" })).toThrow();
    expect(() => parsePlatformPublishingRequest({ ...r, reviewValidUntil: time(30) })).toThrow();
    expect(() =>
      parsePlatformPublishingRequest({ ...r, operation: "Approve", expectedLifecycle: null }),
    ).toThrow();
    const review = fixtures().review.originalCommand.request;
    expect(() => parsePlatformPublishingRequest({ ...review, reviewValidUntil: null })).toThrow();
  });
  it("does not evaluate getters, hidden keys or inherited request data", () => {
    const r = fixtures().draft.originalCommand.request;
    let reads = 0;
    const accessor = { ...r };
    Object.defineProperty(accessor, "reasonCode", {
      enumerable: true,
      get() {
        reads++;
        return "OPERATOR_REQUESTED";
      },
    });
    expect(() => parsePlatformPublishingRequest(accessor)).toThrow();
    expect(reads).toBe(0);
    expect(() => parsePlatformPublishingRequest(Object.create(r))).toThrow();
    const hidden = { ...r };
    Object.defineProperty(hidden, "secret", { value: "hidden" });
    expect(() => parsePlatformPublishingRequest(hidden)).toThrow();
  });
  it("binds full canonical intent to actual server Actor, purpose, pins and reason", () => {
    const original = fixtures().draft.originalCommand;
    expect(platformPublishingIntentDigest(original)).toBe(
      `sha256:${sha256Hex(canonicalizeRfc8785(original))}`,
    );
    expect(platformPublishingIntentDigest({ ...original, scope: actorScope(id(9)) })).not.toBe(
      platformPublishingIntentDigest(original),
    );
    for (const change of [
      { reasonCode: "DIFFERENT_REASON" },
      { templateSourceDigest: `sha256:${"c".repeat(64)}` },
      { templateVersionReference: id(30) },
    ])
      expect(
        platformPublishingIntentDigest({
          ...original,
          request: { ...original.request, ...change },
        }),
      ).not.toBe(platformPublishingIntentDigest(original));
    expect(() =>
      parsePlatformPublishingOriginal({
        ...original,
        scope: { ...original.scope, purposeCode: "OTHER_PURPOSE" },
      }),
    ).toThrow();
  });
  it("rejects recomputed source hashes when actual command Actor or immutable pins disagree", () => {
    const s = fixtures().draft,
      b = body(s);
    expect(() =>
      buildPlatformPublishingSource({
        ...b,
        command: { ...s.command, currentActorReference: id(9) },
      }),
    ).toThrow();
    expect(() =>
      buildPlatformPublishingSource({ ...b, templateSourceDigest: `sha256:${"c".repeat(64)}` }),
    ).toThrow();
    expect(() =>
      buildPlatformPublishingSource({
        ...b,
        command: { ...s.command, next: { ...s.command.next, snapshotReference: id(30) } },
      }),
    ).toThrow();
    expect(() => parsePlatformPublishingSource({ ...s, auditReference: id(30) })).toThrow();
    expect(() => parsePlatformPublishingSource({ ...s, sequence: 2 })).toThrow();
  });
  it("requires original CAS identity and the explicit original business deadline", () => {
    const s = fixtures().review,
      b = body(s);
    for (const change of [
      {
        expectedLifecycle: {
          ...s.originalCommand.request.expectedLifecycle,
          lifecycleReference: id(30),
        },
      },
      { reviewValidUntil: time(29) },
    ]) {
      const original = parsePlatformPublishingOriginal({
        ...s.originalCommand,
        request: { ...s.originalCommand.request, ...change },
      });
      expect(() =>
        buildPlatformPublishingSource({
          ...b,
          originalCommand: original,
          intentDigest: platformPublishingIntentDigest(original),
        }),
      ).toThrow();
    }
  });
  it("accepts exact old-head CAS for a distinct new cycle without rewriting old InReview", () => {
    const f = fixtures(),
      old = f.review,
      d = f.draft;
    const original = parsePlatformPublishingOriginal({
      ...d.originalCommand,
      request: {
        ...d.originalCommand.request,
        operationReference: id(31),
        expectedLifecycle: head(old),
        templateVersionReference: id(32),
      },
    });
    const newSource = buildPlatformPublishingSource({
      ...body(d),
      sequence: 3,
      originalCommand: original,
      intentDigest: platformPublishingIntentDigest(original),
      command: {
        ...d.command,
        operationReference: id(31),
        next: { ...d.command.next, lifecycleId: id(33), snapshotReference: id(32) },
      },
    });
    expect(newSource.command.current).toBeNull();
    expect(old.command.next.state).toBe("InReview");
    expect(() =>
      buildPlatformPublishingSource({
        ...body(newSource),
        command: {
          ...newSource.command,
          next: { ...newSource.command.next, lifecycleId: old.command.next.lifecycleId },
        },
      }),
    ).toThrow();
  });
  it("accepts complete Committed receipts but rejects altered actor/op/Audit/time/original", () => {
    const receipt = committed(fixtures().published);
    expect(parsePlatformPublishingReceipt(receipt).source).toEqual(receipt.source);
    for (const change of [
      { actorReference: id(9) },
      { operationReference: id(30) },
      { auditReference: id(30) },
      { occurredAt: time(5) },
      { originalCommand: fixtures().draft.originalCommand },
      { source: null },
      { intentDigest: `sha256:${"c".repeat(64)}` },
    ])
      expect(() => parsePlatformPublishingReceipt({ ...receipt, ...change })).toThrow();
  });
  it("supports genuine unknown-body Abandoned without fabricating or recomputing an original", () => {
    const resolve = parsePlatformPublishingResolve({
      profile: "PlatformPublishingResolveV1",
      operationReference: id(40),
      intentDigest: `sha256:${"c".repeat(64)}`,
    });
    const receipt = {
      profile: "PlatformPublishingReceiptV1",
      ...actorScope(),
      operationReference: resolve.operationReference,
      intentDigest: resolve.intentDigest,
      outcome: "Abandoned",
      originalCommand: null,
      source: null,
      auditReference: id(41),
      occurredAt: time(0),
    };
    expect(parsePlatformPublishingReceipt(receipt).outcome).toBe("Abandoned");
    expect(() =>
      parsePlatformPublishingReceipt({
        ...receipt,
        originalCommand: fixtures().draft.originalCommand,
      }),
    ).toThrow();
    expect(() =>
      parsePlatformPublishingResolve({ ...resolve, reasonCode: "UNKNOWN_BODY" }),
    ).toThrow();
  });
  it("allows a current reader different from historical author and original operator", () => {
    const f = fixtures(),
      packet = current(f.published, f.published);
    const parsed = parsePlatformPublishingCurrent(packet, actorScope(id(9)), packet.observedAt);
    expect(parsed.scope.actorReference).toBe(id(9));
    expect(parsed.current?.originalCommand.scope.actorReference).toBe(id(3));
    expect(() => parsePlatformPublishingCurrent(packet, actorScope(), packet.observedAt)).toThrow();
  });
  it("holds separate selected Draft and later old-cycle Published release and explicit cycle lookup", () => {
    const f = fixtures(),
      draft = f.draft,
      original = parsePlatformPublishingOriginal({
        ...draft.originalCommand,
        request: {
          ...draft.originalCommand.request,
          operationReference: id(50),
          expectedLifecycle: head(f.review),
          templateVersionReference: id(51),
        },
      });
    const selected = buildPlatformPublishingSource({
      ...body(draft),
      sequence: 3,
      originalCommand: original,
      intentDigest: platformPublishingIntentDigest(original),
      command: {
        ...draft.command,
        operationReference: id(50),
        next: { ...draft.command.next, lifecycleId: id(52), snapshotReference: id(51) },
      },
    });
    const release = buildPlatformPublishingSource({ ...body(f.published), sequence: 5 });
    const packet = current(selected, release);
    expect(
      parsePlatformPublishingCurrent(packet, packet.scope, packet.observedAt).currentRelease
        ?.sequence,
    ).toBe(5);
    const oldCycle = {
      ...current(selected),
      lifecycleReference: f.review.command.next.lifecycleId,
      current: f.review,
    };
    expect(
      parsePlatformPublishingCurrent(oldCycle, packet.scope, packet.observedAt).current?.command
        .next.state,
    ).toBe("InReview");
    const publishedCycle = {
      ...packet,
      lifecycleReference: f.published.command.next.lifecycleId,
      current: release,
    };
    expect(
      parsePlatformPublishingCurrent(publishedCycle, packet.scope, packet.observedAt).current
        ?.command.next.state,
    ).toBe("Published");
    const unknown = { ...packet, lifecycleReference: id(99), current: null };
    expect(
      parsePlatformPublishingCurrent(unknown, packet.scope, packet.observedAt).current,
    ).toBeNull();
    expect(() =>
      parsePlatformPublishingCurrent(
        { ...oldCycle, lifecycleReference: id(99) },
        packet.scope,
        packet.observedAt,
      ),
    ).toThrow();
  });
  it("requires true Published current release and refuses a matching archived lifecycle", () => {
    const f = fixtures();
    const differentSameSequence = buildPlatformPublishingSource({
      ...body(f.published),
      auditReference: id(99),
    });
    expect(parsePlatformPublishingSource(differentSameSequence)).toEqual(differentSameSequence);
    expect(() =>
      parsePlatformPublishingCurrent(
        current(f.published, differentSameSequence),
        actorScope(id(9)),
        time(36),
      ),
    ).toThrow();
    expect(() =>
      parsePlatformPublishingCurrent(current(f.approved, f.approved), actorScope(id(9)), time(36)),
    ).toThrow();
    expect(() =>
      parsePlatformPublishingCurrent(current(f.archived, f.published), actorScope(id(9)), time(36)),
    ).toThrow();
    expect(
      parsePlatformPublishingCurrent(current(f.archived), actorScope(id(9)), time(36))
        .currentRelease,
    ).toBeNull();
  });
  it("enforces exact five-second half-open read lease and rejects future observed/source facts", () => {
    const p = current(fixtures().draft);
    expect(
      parsePlatformPublishingCurrent(p, p.scope, "2026-10-06T12:36:04.999Z").current,
    ).not.toBeNull();
    expect(() => parsePlatformPublishingCurrent(p, p.scope, p.validUntil)).toThrow();
    expect(() =>
      parsePlatformPublishingCurrent(
        { ...p, validUntil: "2026-10-06T12:36:05.001Z" },
        p.scope,
        p.observedAt,
      ),
    ).toThrow();
    expect(() => parsePlatformPublishingCurrent(p, p.scope, time(35))).toThrow();
    expect(() =>
      parsePlatformPublishingCurrent(
        {
          ...p,
          current: fixtures().archived,
          observedAt: time(34),
          validUntil: "2026-10-06T12:34:05.000Z",
        },
        p.scope,
        time(34),
      ),
    ).toThrow();
  });
  it("bounds exact reads to requested family and sequence while allowing absent source", () => {
    const s = fixtures().review,
      p = {
        profile: "PlatformPublishingExactV1",
        scope: actorScope(id(9)),
        templateReference: id(5),
        sequence: 2,
        source: s,
        observedAt: time(36),
        validUntil: "2026-10-06T12:36:05.000Z",
      };
    expect(parsePlatformPublishingExact(p, p.scope, p.observedAt).source).toEqual(s);
    expect(
      parsePlatformPublishingExact({ ...p, source: null }, p.scope, p.observedAt).source,
    ).toBeNull();
    expect(() =>
      parsePlatformPublishingExact({ ...p, sequence: 1 }, p.scope, p.observedAt),
    ).toThrow();
    expect(() =>
      parsePlatformPublishingExact({ ...p, templateReference: id(30) }, p.scope, p.observedAt),
    ).toThrow();
  });
  it("keeps bounded history descending, closed, dense and detached with truthful pagination", () => {
    const f = fixtures(),
      items = [f.published, f.approved, f.review, f.draft],
      p = {
        profile: "PlatformPublishingHistoryV1",
        scope: actorScope(id(9)),
        templateReference: id(5),
        beforeSequence: null,
        items,
        hasMore: false,
        nextBeforeSequence: null,
        observedAt: time(36),
        validUntil: "2026-10-06T12:36:05.000Z",
      };
    const parsed = parsePlatformPublishingHistory(p, p.scope, p.observedAt);
    items.pop();
    expect(parsed.items).toHaveLength(4);
    expect(Object.isFrozen(parsed.items)).toBe(true);
    expect(Object.isFrozen(parsed.items[0]?.command.next)).toBe(true);
    expect(() =>
      parsePlatformPublishingHistory(
        { ...p, items: [f.review, f.approved] },
        p.scope,
        p.observedAt,
      ),
    ).toThrow();
    expect(() =>
      parsePlatformPublishingHistory({ ...p, items: [f.review, f.review] }, p.scope, p.observedAt),
    ).toThrow();
    expect(() =>
      parsePlatformPublishingHistory(
        { ...p, items: [f.review], beforeSequence: 2 },
        p.scope,
        p.observedAt,
      ),
    ).toThrow();
    expect(() =>
      parsePlatformPublishingHistory(
        { ...p, hasMore: true, nextBeforeSequence: 1 },
        p.scope,
        p.observedAt,
      ),
    ).toThrow();
    expect(() =>
      parsePlatformPublishingHistory({ ...p, items: new Array(1) }, p.scope, p.observedAt),
    ).toThrow();
    const history = [f.draft];
    for (let n = 2; n <= 21; n++) {
      const prior = history[history.length - 1];
      if (!prior) throw new Error("Missing genuine history fixture");
      const original = parsePlatformPublishingOriginal({
        ...prior.originalCommand,
        request: {
          ...prior.originalCommand.request,
          operationReference: id(200 + n),
          expectedLifecycle: head(prior),
          templateVersionReference: id(300 + n),
        },
      });
      history.push(
        buildPlatformPublishingSource({
          ...body(prior),
          sequence: n,
          originalCommand: original,
          intentDigest: platformPublishingIntentDigest(original),
          auditReference: id(400 + n),
          command: {
            ...prior.command,
            operationReference: id(200 + n),
            expectedVersion: prior.command.next.version,
            current: prior.command.next,
            next: { ...prior.command.next, version: n, snapshotReference: id(300 + n) },
          },
        }),
      );
    }
    const page = history.slice(1).reverse();
    expect(
      parsePlatformPublishingHistory(
        { ...p, items: page, hasMore: true, nextBeforeSequence: 2 },
        p.scope,
        p.observedAt,
      ).nextBeforeSequence,
    ).toBe(2);
    expect(() =>
      parsePlatformPublishingHistory({ ...p, items: [...page, f.draft] }, p.scope, p.observedAt),
    ).toThrow();
  });
});
