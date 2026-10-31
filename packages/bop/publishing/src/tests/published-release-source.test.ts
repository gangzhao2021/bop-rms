import { describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  parseRecordedPublishingMutation,
} from "../index.js";

// Real owning parser/resolver over a controlled SQL transport: v1 published then
// superseded by v2 in the same family. Not database or IAM evidence.
const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const v1At = "2026-09-20T10:00:00.000Z";
const v1PublishedAt = "2026-09-20T10:00:01.000Z";
const v2At = "2026-10-11T10:00:00.000Z";
const v2PublishedAt = "2026-10-11T10:00:01.000Z";
const until = (at: string) => new Date(Date.parse(at) + 2000).toISOString();
const observedAt = "2026-10-12T10:00:00.000Z";
const scope = createPublishingScope({
  kind: "Store",
  brandReference: id(2),
  storeReference: id(3),
});
const foreign = createPublishingScope({
  kind: "Store",
  brandReference: id(2),
  storeReference: id(77),
});

function chain(n: 1 | 2) {
  const base = n === 1 ? 0 : 50;
  const at = n === 1 ? v1At : v2At;
  const publishedAt = n === 1 ? v1PublishedAt : v2PublishedAt;
  const fp = "sha256:" + (n === 1 ? "a" : "b").repeat(64);
  const lifecycleId = id(5 + base),
    snapshot = id(6 + base);
  const draft = {
    lifecycleId,
    familyReference: id(4),
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    snapshotReference: snapshot,
    snapshotDigest: fp,
    scope,
    version: 1,
    state: "Draft",
    validationEvidenceReference: null as string | null,
    approvalEvidenceReference: null as string | null,
    createdAt: at,
    changedAt: at,
  };
  const review = {
    ...draft,
    version: 2,
    state: "InReview",
    validationEvidenceReference: id(20 + base),
  };
  const approved = {
    ...review,
    version: 3,
    state: "Approved",
    approvalEvidenceReference: id(21 + base),
  };
  const published = { ...approved, version: 4, state: "Published", changedAt: publishedAt };
  const validation = {
    evidenceReference: id(20 + base),
    snapshotReference: snapshot,
    snapshotDigest: fp,
    scope,
    result: "Pass",
    checkedAt: at,
    validUntil: until(at),
    checkCodes: ["STORE_CONTENT"],
  };
  const approval = {
    evidenceReference: id(21 + base),
    reviewLifecycleId: lifecycleId,
    reviewVersion: 2,
    snapshotReference: snapshot,
    snapshotDigest: fp,
    scope,
    decision: "Accepted",
    approvedActorReference: id(8),
    approvedAt: at,
    validUntil: until(at),
  };
  const release = {
    releaseId: id(30 + base),
    familyReference: id(4),
    configurationType: "STORE_CONFIGURATION",
    purposeCode: "STORE_CONFIGURATION",
    snapshotReference: snapshot,
    snapshotDigest: fp,
    scope,
    sequence: n,
    sourceLifecycleId: lifecycleId,
    kind: "Publish",
    previousReleaseId: n === 1 ? null : id(30),
    createdAt: publishedAt,
  };
  return [draft, review, approved, published].map((next, index) => ({
    operation: ["CreateDraft", "SubmitReview", "Approve", "Publish"][index],
    expectedVersion: index === 0 ? 1 : index,
    idempotencyKey: id(100 + base + index),
    current: index === 0 ? null : [draft, review, approved][index - 1],
    next,
    release: index === 3 ? release : null,
    supersededReleaseId: index === 3 && n === 2 ? id(30) : null,
    rollbackTargetReleaseId: null,
    validationEvidence: index === 1 || index === 3 ? validation : null,
    approvalEvidence: index === 2 || index === 3 ? approval : null,
    audit: {
      auditId: id(110 + base + index),
      brandId: id(2),
      storeId: id(3),
      actor: { type: "User", reference: index === 2 ? id(8) : id(7) },
      actionCode: [
        "PUBLISHING_DRAFT_CREATED",
        "PUBLISHING_REVIEW_SUBMITTED",
        "PUBLISHING_REVIEW_APPROVED",
        "PUBLISHING_RELEASE_PUBLISHED",
      ][index],
      targetType: "PublishingLifecycle",
      targetId: lifecycleId,
      reasonCode: "SYNTHETIC_TEST",
      correlationId: id(120 + base + index),
      occurredAt: index === 3 ? publishedAt : at,
      sourceChannel: "MERCHANT_WEB",
      dataClassification: "Confidential",
      retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
      retentionPolicyVersion: 1,
    },
  }));
}
type Record = ReturnType<typeof chain>[number];
function hash(value: unknown) {
  const parsed = parseRecordedPublishingMutation(value);
  return (
    "sha256:" +
    sha256Hex(canonicalizeRfc8785({ ...parsed, audit: { ...parsed.audit, auditId: null } }))
  );
}
const packet = (record: Record, intent?: string) => ({
  mutation_json: record,
  intent_hash: intent ?? hash(record),
  audit_id: record.audit.auditId,
});
function setup(change?: (v1: Record[], v2: Record[]) => void, archivedAt?: string) {
  const v1 = chain(1),
    v2 = chain(2);
  change?.(v1, v2);
  const all = [...v1, ...v2];
  const archive = archivedAt
    ? {
        ...v1[3],
        operation: "Archive",
        expectedVersion: 4,
        current: v1[3]?.next,
        idempotencyKey: id(199),
        next: { ...v1[3]?.next, version: 5, state: "Archived", changedAt: archivedAt },
        release: null,
        validationEvidence: null,
        approvalEvidence: null,
        audit: {
          ...v1[3]?.audit,
          auditId: id(198),
          actionCode: "PUBLISHING_RELEASE_ARCHIVED",
          occurredAt: archivedAt,
        },
      }
    : null;
  // Fails setup (not the resolver) if the controlled Archive record is not a valid owning record.
  if (archive) hash(archive);
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    if (sql.includes("ORDER BY release_sequence DESC LIMIT 1")) {
      const head = v2[3];
      return { rows: head ? [packet(head)] : [] };
    }
    if (sql.includes("AND release_id=$5")) {
      return {
        rows: all
          .filter(
            (r) =>
              r.release &&
              r.release.releaseId === values[4] &&
              r.release.familyReference === values[3],
          )
          .map((r) => packet(r)),
      };
    }
    if (sql.includes("AND changed_at <= $5 ORDER BY lifecycle_version DESC LIMIT 1")) {
      const candidates = [...all, ...(archive ? [archive as Record] : [])].filter(
        (r) => r.next.lifecycleId === values[3] && String(r.next.changedAt) <= String(values[4]),
      );
      const latest = candidates.sort((a, b) => b.next.version - a.next.version)[0];
      return { rows: latest ? [packet(latest)] : [] };
    }
    if (sql.includes("ORDER BY lifecycle_version DESC LIMIT 1")) {
      const latest = all.filter((r) => r.next.lifecycleId === values[3]).at(-1);
      return { rows: latest ? [packet(latest)] : [] };
    }
    if (sql.includes("lifecycle_version ASC LIMIT 5")) {
      return {
        rows: all
          .filter((r) => r.next.lifecycleId === values[3] && r.next.version <= Number(values[4]))
          .map((r) => packet(r)),
      };
    }
    return { rows: [] };
  });
  const tx = { query };
  const run = vi.fn();
  async function runner<T>(work: (value: typeof tx) => Promise<T>): Promise<T> {
    run();
    return work(tx);
  }
  return {
    query,
    run,
    store: createPostgresPublishingMutationStore({ run: runner }, id(1), scope),
  };
}
const v1Request = () => ({
  familyReference: id(4),
  configurationType: "STORE_CONFIGURATION",
  purposeCode: "STORE_CONFIGURATION",
  snapshotReference: id(6),
  publicationReference: id(30),
  observedAt,
});
const v1Independent = () => ({
  familyReference: id(4),
  lifecycleReference: id(5),
  configurationType: "STORE_CONFIGURATION",
  purposeCode: "STORE_CONFIGURATION",
  snapshotReference: id(6),
  snapshotDigest: "sha256:" + "a".repeat(64),
  requiredCheckCodes: ["STORE_CONTENT"],
  observedAt,
  publicationReference: id(30),
});
const refused = { code: "PUBLISHING_INPUT_INVALID" };

describe("as-published release for historical reads", () => {
  it("current release is the newest release, so a superseded snapshot is not current", async () => {
    const { store } = setup();
    const current = await store.resolveCurrentRelease({
      familyReference: id(4),
      configurationType: "STORE_CONFIGURATION",
      purposeCode: "STORE_CONFIGURATION",
      observedAt,
    });
    expect(current.release.releaseId).toBe(id(80));
    expect(current.release.snapshotReference).not.toBe(id(6));
  });
  it("resolves the superseded release that actually published the snapshot", async () => {
    const { store, query, run } = setup();
    const result = await store.resolvePublishedRelease(v1Request());
    expect(result.release.releaseId).toBe(id(30));
    expect(result.release.snapshotReference).toBe(id(6));
    expect(result.lifecycle.state).toBe("Published");
    expect(result.lifecycle.version).toBe(4);
    expect(result.approvalEvidence.evidenceReference).toBe(id(21));
    expect(result.validationEvidence.evidenceReference).toBe(id(20));
    expect(result.auditReference).toBe(id(113));
    expect(result.observedAt).toBe(observedAt);
    expect(Object.isFrozen(result)).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    const lock = query.mock.calls.findIndex(([sql]) => sql.includes("IN SHARE MODE"));
    const read = query.mock.calls.findIndex(([sql]) => sql.includes("AND release_id=$5"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(lock);
    // Never consults the family head.
    expect(query.mock.calls.some(([sql]) => sql.includes("release_sequence DESC"))).toBe(false);
  });
  it("also resolves the newest release as published", async () => {
    const { store } = setup();
    const result = await store.resolvePublishedRelease({
      ...v1Request(),
      snapshotReference: id(56),
      publicationReference: id(80),
    });
    expect(result.release.releaseId).toBe(id(80));
  });
  it.each<[string, Partial<ReturnType<typeof v1Request>>]>([
    ["a snapshot published by a different release", { snapshotReference: id(56) }],
    ["a configuration never released", { snapshotReference: id(99), publicationReference: id(99) }],
    ["a foreign family", { familyReference: id(98) }],
    ["a different purpose", { purposeCode: "OTHER_PURPOSE" }],
    ["observation before the release was created", { observedAt: "2026-09-20T10:00:00.500Z" }],
  ])("refuses %s", async (_label, change) => {
    await expect(
      setup().store.resolvePublishedRelease({ ...v1Request(), ...change }),
    ).rejects.toMatchObject(refused);
  });
  it.each<[string, (v1: Record[]) => void]>([
    [
      "tampered release digest",
      (v1) => {
        const release = v1[3]?.release;
        if (release) release.snapshotDigest = "sha256:" + "c".repeat(64);
      },
    ],
    [
      "foreign release scope",
      (v1) => {
        const release = v1[3]?.release;
        if (release) release.scope = foreign;
      },
    ],
    [
      "approval evidence for another digest",
      (v1) => {
        const approval = v1[3]?.approvalEvidence;
        if (approval) approval.snapshotDigest = "sha256:" + "c".repeat(64);
      },
    ],
    [
      "rejected validation",
      (v1) => {
        const validation = v1[3]?.validationEvidence;
        if (validation) validation.result = "Fail";
      },
    ],
  ])("refuses hash-consistent %s", async (_label, change) => {
    await expect(setup(change).store.resolvePublishedRelease(v1Request())).rejects.toMatchObject(
      refused,
    );
  });
  it("refuses a corrupt recorded intent hash", async () => {
    const { store, query } = setup();
    const original = query.getMockImplementation();
    query.mockImplementation(async (sql: string, values: readonly unknown[]) => {
      const result = await original?.(sql, values);
      if (sql.includes("AND release_id=$5") && result)
        return {
          rows: result.rows.map((r) => ({ ...r, intent_hash: "sha256:" + "0".repeat(64) })),
        };
      return result ?? { rows: [] };
    });
    await expect(store.resolvePublishedRelease(v1Request())).rejects.toMatchObject(refused);
  });
  it("refuses a lifecycle archived before observation but keeps earlier history", async () => {
    await expect(
      setup(undefined, "2026-10-01T00:00:00.000Z").store.resolvePublishedRelease(v1Request()),
    ).rejects.toMatchObject(refused);
    await expect(
      setup(undefined, "2026-10-01T00:00:00.000Z").store.resolvePublishedRelease({
        ...v1Request(),
        observedAt: "2026-09-25T00:00:00.000Z",
      }),
    ).resolves.toMatchObject({ release: { releaseId: id(30) } });
  });
  it("rejects open or accessor requests without invoking the runner", async () => {
    const { store, run } = setup();
    const getter = vi.fn(() => id(4));
    const input = v1Request();
    Object.defineProperty(input, "familyReference", { enumerable: true, get: getter });
    await expect(store.resolvePublishedRelease(input)).rejects.toMatchObject(refused);
    await expect(
      store.resolvePublishedRelease({ ...v1Request(), current: true } as ReturnType<
        typeof v1Request
      >),
    ).rejects.toMatchObject(refused);
    expect(run).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("recorded independence behind the as-published release", () => {
  it("current variant refuses a superseded snapshot", async () => {
    const request: Partial<ReturnType<typeof v1Independent>> = v1Independent();
    delete request.publicationReference;
    await expect(
      setup().store.resolveCurrentReleaseIndependentApproval(request),
    ).rejects.toMatchObject(refused);
  });
  it("verifies the original independent review behind a superseded release", async () => {
    const result = await setup().store.resolvePublishedReleaseIndependentApproval(v1Independent());
    expect(result.recordedIndependence).toBe("Verified");
    expect(result.currentRelease.release.releaseId).toBe(id(30));
    expect(result.approvedByActorReference).toBe(id(8));
    expect(result.authoredByActorReference).toBe(id(7));
    const { digest, ...body } = result;
    expect(digest).toBe("sha256:" + sha256Hex(canonicalizeRfc8785(body)));
  });
  it.each([
    { ...v1Independent(), publicationReference: id(80) },
    { ...v1Independent(), snapshotDigest: "sha256:" + "c".repeat(64) },
    { ...v1Independent(), requiredCheckCodes: ["OTHER_CHECK"] },
    { ...v1Independent(), observedAt: "2026-09-20T10:00:00.500Z" },
  ])("refuses pins that do not match the as-published release/history", async (input) => {
    await expect(
      setup().store.resolvePublishedReleaseIndependentApproval(input),
    ).rejects.toMatchObject(refused);
  });
  it("refuses self-approval in the original history", async () => {
    await expect(
      setup((v1) => {
        const created = v1[0];
        if (created) created.audit.actor.reference = id(8);
      }).store.resolvePublishedReleaseIndependentApproval(v1Independent()),
    ).rejects.toMatchObject(refused);
  });
  it("rejects missing, extra or accessor fields without invoking the runner", async () => {
    const { store, run } = setup();
    const missing: Partial<ReturnType<typeof v1Independent>> = v1Independent();
    delete missing.publicationReference;
    await expect(store.resolvePublishedReleaseIndependentApproval(missing)).rejects.toMatchObject(
      refused,
    );
    await expect(
      store.resolvePublishedReleaseIndependentApproval({ ...v1Independent(), extra: true }),
    ).rejects.toMatchObject(refused);
    const getter = vi.fn(() => id(30));
    const accessor = v1Independent();
    Object.defineProperty(accessor, "snapshotReference", { enumerable: true, get: getter });
    await expect(store.resolvePublishedReleaseIndependentApproval(accessor)).rejects.toMatchObject(
      refused,
    );
    expect(run).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });
});
