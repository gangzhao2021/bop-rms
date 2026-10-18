import { describe, it, expect, vi } from "vitest";
import { validateAuditRecord } from "@bop/audit";
import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  parseRecordedPublishingMutation,
  publishingRecordedMutationDigest,
  optionPriceRuleConfigurationType,
  optionPriceRulePublicationPurpose,
  type CommitPublishingMutationInput,
  type PublishingTransaction,
  type OptionPriceRuleReviewHeldSource,
} from "../index.js";
const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T10:00:00.000Z",
  until = "2026-09-11T11:00:00.000Z",
  hash = "sha256:" + "a".repeat(64);
const scope = createPublishingScope({ kind: "Brand", brandReference: id(2), storeReference: null });
const pins = { snapshotReference: id(4), snapshotDigest: hash, observedAt: at };
// Synthetic controlled SQL packets parsed by real owner contracts; no native IAM claim.
function history(
  lifecycle = id(5),
  draftActor = id(8),
  submitActor = id(8),
  approveActor = id(9),
  referenceOffset = 0,
) {
  const base = {
    lifecycleId: lifecycle,
    familyReference: id(3),
    configurationType: optionPriceRuleConfigurationType,
    purposeCode: optionPriceRulePublicationPurpose,
    snapshotReference: id(4),
    snapshotDigest: hash,
    scope,
    createdAt: at,
    changedAt: at,
  };
  const draft = {
      ...base,
      version: 1,
      state: "Draft",
      validationEvidenceReference: null,
      approvalEvidenceReference: null,
    },
    review = {
      ...base,
      version: 2,
      state: "InReview",
      validationEvidenceReference: id(6 + referenceOffset),
      approvalEvidenceReference: null,
    },
    approved = {
      ...base,
      version: 3,
      state: "Approved",
      validationEvidenceReference: id(6 + referenceOffset),
      approvalEvidenceReference: id(7 + referenceOffset),
    };
  const validation = {
    evidenceReference: id(6 + referenceOffset),
    snapshotReference: id(4),
    snapshotDigest: hash,
    scope,
    result: "Pass",
    checkedAt: at,
    validUntil: until,
    checkCodes: ["OPTION_PRICE_DRAFT"],
  };
  const approval = {
    evidenceReference: id(7 + referenceOffset),
    reviewLifecycleId: lifecycle,
    reviewVersion: 2,
    snapshotReference: id(4),
    snapshotDigest: hash,
    scope,
    decision: "Accepted",
    approvedActorReference: approveActor,
    approvedAt: at,
    validUntil: until,
  };
  const states = [draft, review, approved],
    actors = [draftActor, submitActor, approveActor];
  return states.map((next, index) =>
    parseRecordedPublishingMutation({
      operation: ["CreateDraft", "SubmitReview", "Approve"][index],
      expectedVersion: index === 0 ? 1 : index,
      idempotencyKey: id(20 + index + referenceOffset),
      current: index === 0 ? null : states[index - 1],
      next,
      release: null,
      supersededReleaseId: null,
      rollbackTargetReleaseId: null,
      validationEvidence: index === 1 ? validation : null,
      approvalEvidence: index === 2 ? approval : null,
      audit: validateAuditRecord(
        {
          auditId: id(30 + index + referenceOffset),
          brandId: id(2),
          actor: { type: "User", reference: actors[index] },
          actionCode: [
            "PUBLISHING_DRAFT_CREATED",
            "PUBLISHING_REVIEW_SUBMITTED",
            "PUBLISHING_REVIEW_APPROVED",
          ][index],
          targetType: "PublishingLifecycle",
          targetId: lifecycle,
          reasonCode: "SYNTHETIC_REVIEW",
          correlationId: id(40),
          occurredAt: at,
          sourceChannel: "INTERNAL_TEST",
          dataClassification: "Confidential",
          retentionPolicyCode: "PUBLISHING_LIFECYCLE_AUDIT",
          retentionPolicyVersion: 1,
        },
        Date.parse(at),
      ),
    }),
  );
}
function fixture(records: CommitPublishingMutationInput[] = history()) {
  let isolation = "read committed",
    corrupt = false;
  const events: string[] = [];
  const query = vi.fn(async (sql: string) => {
    events.push(sql);
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation }] };
    if (sql.startsWith("SELECT set_config") || sql.startsWith("LOCK TABLE")) return { rows: [] };
    if (sql.startsWith("SELECT mutation_json"))
      return {
        rows: records.map((record) => ({
          mutation_json: record,
          intent_hash: corrupt
            ? "sha256:" + "b".repeat(64)
            : publishingRecordedMutationDigest(record),
          audit_id: record.audit.auditId,
        })),
      };
    throw Error("Unexpected synthetic owner query");
  });
  const tx: PublishingTransaction = { query };
  const store = createPostgresPublishingMutationStore(
    { run: async (work) => work(tx) },
    id(1),
    scope,
  );
  return {
    store,
    tx,
    query,
    events,
    corrupt: () => {
      corrupt = true;
    },
    repeatable: () => {
      isolation = "repeatable read";
    },
  };
}
describe("held OptionPrice rule review discovery", () => {
  it.each(["Read", "Write"] as const)(
    "takes Publishing %s lock before the actual Pricing callback",
    async (mode) => {
      const f = fixture();
      await f.store.withOptionPriceReview({ familyReference: id(3), mode }, async (held) => {
        f.events.push("ACTUAL_PRICING_READ_CALLBACK");
        const result = await held.readForDraft(pins);
        expect(result.outcome).toBe("Recorded");
        if (result.outcome !== "Recorded") throw Error("Missing source");
        expect(result.latest.next.state).toBe("Approved");
        expect(result.draft.audit.actor).toEqual({ type: "User", reference: id(8) });
        expect(result.approval?.approvalEvidence?.approvedActorReference).toBe(id(9));
        expect(Object.isFrozen(result)).toBe(true);
      });
      const lock = f.events.findIndex((sql) =>
        sql.includes(mode === "Write" ? "IN SHARE ROW EXCLUSIVE MODE" : "IN SHARE MODE"),
      );
      expect(lock).toBeGreaterThan(-1);
      expect(lock).toBeLessThan(f.events.indexOf("ACTUAL_PRICING_READ_CALLBACK"));
    },
  );
  it("reports truthful absence without a synthetic Draft or abandonment", async () => {
    const f = fixture([]);
    expect(
      await f.store.withOptionPriceReview({ familyReference: id(3), mode: "Read" }, (held) =>
        held.readForDraft(pins),
      ),
    ).toEqual({ outcome: "Absent", familyReference: id(3), ...pins });
  });
  it("returns recorded original expiry without renewing it for current observation", async () => {
    const f = fixture();
    const r = await f.store.withOptionPriceReview(
      { familyReference: id(3), mode: "Read" },
      (held) => held.readForDraft({ ...pins, observedAt: "2026-09-12T10:00:00.000Z" }),
    );
    if (r.outcome !== "Recorded") throw Error("Missing source");
    expect(r.approval?.approvalEvidence?.validUntil).toBe(until);
  });
  it.each([
    [id(8), id(9), id(8)],
    [id(8), id(8), id(8)],
  ])(
    "refuses approval by actual Publishing Draft author or submitter",
    async (draft, submit, approve) => {
      const f = fixture(history(id(5), draft, submit, approve));
      await expect(
        f.store.withOptionPriceReview({ familyReference: id(3), mode: "Read" }, (held) =>
          held.readForDraft(pins),
        ),
      ).rejects.toThrow();
    },
  );
  it("refuses broken current/next continuity even with recomputed actual hashes", async () => {
    const records = history(),
      review = records[1];
    if (!review) throw Error("Missing review");
    records[1] = parseRecordedPublishingMutation({
      ...review,
      current: { ...review.current, lifecycleId: id(77) },
    });
    const f = fixture(records);
    await expect(
      f.store.withOptionPriceReview({ familyReference: id(3), mode: "Read" }, (held) =>
        held.readForDraft(pins),
      ),
    ).rejects.toThrow();
  });
  it("refuses ambiguous active lifecycle histories", async () => {
    const f = fixture([...history(), ...history(id(55), id(8), id(8), id(9), 100)]);
    await expect(
      f.store.withOptionPriceReview({ familyReference: id(3), mode: "Read" }, (held) =>
        held.readForDraft(pins),
      ),
    ).rejects.toThrow();
  });
  it("refuses foreign scope and corrupt recorded identity", async () => {
    const f = fixture();
    f.corrupt();
    await expect(
      f.store.withOptionPriceReview({ familyReference: id(3), mode: "Read" }, (held) =>
        held.readForDraft(pins),
      ),
    ).rejects.toThrow();
    const records = history().map((record) =>
      parseRecordedPublishingMutation({
        ...record,
        next: {
          ...record.next,
          scope: { kind: "Brand", brandReference: id(88), storeReference: null },
        },
      }),
    );
    const foreign = fixture(records);
    await expect(
      foreign.store.withOptionPriceReview({ familyReference: id(3), mode: "Read" }, (held) =>
        held.readForDraft(pins),
      ),
    ).rejects.toThrow();
  });
  it("poisons the held callback if a source error is swallowed", async () => {
    const f = fixture();
    f.corrupt();
    await expect(
      f.store.withOptionPriceReview({ familyReference: id(3), mode: "Write" }, async (held) => {
        try {
          await held.readForDraft(pins);
        } catch {
          /* Consumer cannot promote a refused source. */
        }
        return "fake-success";
      }),
    ).rejects.toThrow();
  });
  it("captures query identity and rejects use after owning callback", async () => {
    const f = fixture();
    let captured: OptionPriceRuleReviewHeldSource | undefined;
    await f.store.withOptionPriceReview({ familyReference: id(3), mode: "Read" }, async (held) => {
      captured = held;
      return held.readForDraft(pins);
    });
    if (!captured) throw Error("Missing held source");
    await expect(captured.readForDraft(pins)).rejects.toThrow();
    const g = fixture();
    await expect(
      g.store.withOptionPriceReview({ familyReference: id(3), mode: "Read" }, async (held) => {
        g.tx.query = async () => ({ rows: [] });
        return held.readForDraft(pins);
      }),
    ).rejects.toThrow();
  });
  it("rejects nonmonotonic source observation and unsuitable isolation", async () => {
    const f = fixture();
    await expect(
      f.store.withOptionPriceReview({ familyReference: id(3), mode: "Read" }, async (held) => {
        await held.readForDraft(pins);
        return held.readForDraft({ ...pins, observedAt: "2026-09-11T09:59:59.000Z" });
      }),
    ).rejects.toThrow();
    const g = fixture();
    g.repeatable();
    await expect(
      g.store.withOptionPriceReview({ familyReference: id(3), mode: "Read" }, (held) =>
        held.readForDraft(pins),
      ),
    ).rejects.toThrow();
  });
  it("rejects nonclosed request/accessors before SQL", async () => {
    const f = fixture(),
      get = vi.fn(() => id(3)),
      request = { familyReference: id(3), mode: "Read" as const };
    Object.defineProperty(request, "familyReference", { get, enumerable: true });
    await expect(
      f.store.withOptionPriceReview(request, (held) => held.readForDraft(pins)),
    ).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  });
});
