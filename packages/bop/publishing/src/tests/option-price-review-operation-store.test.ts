import { expect, it, vi } from "vitest";
import { validateAuditRecord } from "@bop/audit";
import {
  createPostgresOptionPriceReviewOperationStore,
  OptionPriceReviewOriginalDeniedError,
  type OptionPriceReviewOperationStoreOptions,
} from "../infrastructure/persistence/option-price-review-operation-store.js";
import {
  parsePublishingOptionPriceReviewOperation,
  publishingOptionPriceReviewOperationDigest,
} from "../contracts/option-price-review-operation.js";
import {
  createPublishingLifecycleRecord,
  createPublishingScope,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  parsePublishingReference,
  parsePublishingDigest,
  parsePublishingVersion,
  parsePublishingCode,
  parsePublishingInstant,
} from "../contracts/publishing.js";
import {
  publishingRecordedMutationDigest,
  type PublishingTransaction,
} from "../infrastructure/persistence/publishing-mutation-store.js";
import type { CommitPublishingMutationInput } from "../application/ports/publishing-ports.js";
const id = (n: number) => "01902421-7000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = parsePublishingInstant("2026-09-11T12:00:00.000Z"),
  until = parsePublishingInstant("2026-09-11T12:00:05.000Z"),
  hash = parsePublishingDigest("sha256:" + "a".repeat(64));
const command = () =>
  parsePublishingOptionPriceReviewOperation({
    profile: "PublishingOptionPriceReviewOperationV1",
    tenantReference: id(1),
    brandReference: id(2),
    selectedStoreReference: id(3),
    actorReference: id(4),
    reasonCode: "AUTHORIZED_OPERATION",
    action: "SubmitReview",
    operationReference: id(5),
    ruleReference: id(6),
    draftVersionReference: id(7),
    expectedAggregateVersion: 1,
    draftSnapshotDigest: hash,
    validationValidUntil: "2026-09-12T12:00:00.000Z",
    approvalValidUntil: null,
    expectedLifecycle: null,
  });
const scope = createPublishingScope({ kind: "Brand", brandReference: id(2), storeReference: null });
function audit(
  action = "PUBLISHING_OPTION_PRICE_REVIEW_ABANDONED",
  operation = id(5),
  target = id(5),
  number = 9,
) {
  return validateAuditRecord({
    auditId: id(number),
    brandId: id(2),
    actor: { type: "User", reference: id(4) },
    actionCode: action,
    targetType:
      action === "PUBLISHING_OPTION_PRICE_REVIEW_ABANDONED"
        ? "PublishingOptionPriceReviewOperation"
        : "PublishingLifecycle",
    targetId: target,
    reasonCode:
      action === "PUBLISHING_OPTION_PRICE_REVIEW_ABANDONED" ? "AUTHORIZED_OPERATION" : action,
    correlationId: operation,
    occurredAt: at,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Confidential",
    retentionPolicyCode: "AUDIT_SECURITY",
    retentionPolicyVersion: 1,
  });
}
function mutations() {
  const draft = createPublishingLifecycleRecord({
    lifecycleId: parsePublishingReference(id(10)),
    familyReference: parsePublishingReference(id(6)),
    configurationType: parsePublishingCode("OPTION_PRICE_RULE"),
    purposeCode: parsePublishingCode("OPTION_PRICE_RULE_PUBLICATION"),
    snapshotReference: parsePublishingReference(id(7)),
    snapshotDigest: hash,
    scope,
    version: parsePublishingVersion(1),
    state: "Draft",
    validationEvidenceReference: null,
    approvalEvidenceReference: null,
    createdAt: at,
    changedAt: at,
  });
  const validation = createPublishingValidationEvidence({
    evidenceReference: parsePublishingReference(id(12)),
    snapshotReference: draft.snapshotReference,
    snapshotDigest: hash,
    scope,
    result: "Pass",
    checkedAt: at,
    validUntil: parsePublishingInstant("2026-09-12T12:00:00.000Z"),
    checkCodes: [parsePublishingCode("CURRENT_REFERENCES")],
  });
  const review = createPublishingLifecycleRecord({
    ...draft,
    version: parsePublishingVersion(2),
    state: "InReview",
    validationEvidenceReference: validation.evidenceReference,
  });
  const base = {
    release: null,
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    approvalEvidence: null,
  };
  const create: CommitPublishingMutationInput = {
    ...base,
    operation: "CreateDraft",
    expectedVersion: parsePublishingVersion(1),
    idempotencyKey: parsePublishingReference(id(11)),
    current: null,
    next: draft,
    validationEvidence: null,
    audit: audit("PUBLISHING_DRAFT_CREATED", id(11), id(10), 13),
  };
  const submit: CommitPublishingMutationInput = {
    ...base,
    operation: "SubmitReview",
    expectedVersion: parsePublishingVersion(1),
    idempotencyKey: parsePublishingReference(id(5)),
    current: draft,
    next: review,
    validationEvidence: validation,
    audit: audit("PUBLISHING_REVIEW_SUBMITTED", id(5), id(10), 14),
  };
  return { create, submit };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("required test guard");
  return value;
}
function validationOf(mutation: CommitPublishingMutationInput) {
  const validation = mutation.validationEvidence;
  if (validation === null) throw Error("actual fixture validation required");
  return validation;
}
function fixture(
  auditOverride?: OptionPriceReviewOperationStoreOptions["audit"]["create"],
  actualActor = id(4),
) {
  let time: string = at,
    denied = false,
    available = true,
    sequence = 1,
    expireAfterAudit = false;
  const records: CommitPublishingMutationInput[] = [],
    terminal: Record<string, unknown>[] = [],
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [],
    calls: string[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    calls.push(sql);
    if (sql.startsWith("INSERT INTO platform_audit.audit_record") && expireAfterAudit) time = until;
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation: "read committed" }] };
    if (sql.includes("operation_available")) return { rows: [{ available }] };
    if (sql.startsWith("SELECT outcome_code")) return { rows: terminal };
    if (sql.startsWith("INSERT INTO bop_publishing.option_price_review_operation")) {
      terminal.push({
        outcome_code: values[6],
        command_json: JSON.parse(String(values[8])),
        command_digest: values[7],
        recorded_at: values[9],
        audit_id: values[10],
        mutation_json: values[11] === null ? null : JSON.parse(String(values[11])),
        mutation_digest: values[12],
      });
      return { rows: [] };
    }
    if (sql.startsWith("SELECT operation_id FROM"))
      return { rows: records.length ? [{ operation_id: records.at(-1)?.idempotencyKey }] : [] };
    if (sql.startsWith("SELECT mutation_json,intent_hash,audit_id"))
      return {
        rows: records
          .filter((m) =>
            values.length === 7
              ? m.next.familyReference === values[2] &&
                m.next.snapshotReference === values[5] &&
                m.next.snapshotDigest === values[6]
              : m.idempotencyKey === values[3],
          )
          .map((m) => ({
            mutation_json: m,
            intent_hash: publishingRecordedMutationDigest(m),
            audit_id: m.audit.auditId,
          })),
      };
    if (sql.startsWith("SELECT mutation_json FROM"))
      return { rows: [...records].reverse().map((m) => ({ mutation_json: m })) };
    if (sql.startsWith("INSERT INTO bop_publishing.publishing_mutation_record")) {
      records.push(required(values[14]) as CommitPublishingMutationInput);
      return { rows: [] };
    }
    if (sql.includes("FROM platform_audit.audit_chain_head"))
      return {
        rows: [
          {
            next_sequence: String(sequence),
            previous_hash: sequence === 1 ? null : "b".repeat(64),
            recorded_at: time,
          },
        ],
      };
    if (sql.startsWith("UPDATE platform_audit.audit_chain_head"))
      return { rows: [{ next_sequence: String(++sequence) }] };
    return { rows: [] };
  });
  const tx: PublishingTransaction = { query };
  const options: OptionPriceReviewOperationStoreOptions = {
    tenantReference: id(1),
    brandReference: id(2),
    selectedStoreReference: id(3),
    actorReference: actualActor,
    clock: { now: () => time },
    originalValidUntil: until,
    audit: {
      create:
        auditOverride ??
        ((input) =>
          validateAuditRecord({
            ...audit(),
            actor: { type: "User", reference: actualActor },
            occurredAt: input.observedAt,
          })),
    },
    registerBeforeCommit: (_tx, guard, final) => {
      guards.push(guard);
      finals.push(final);
    },
    authority: {
      holdUntilTransactionCompletes: async (_tx, input) => {
        if (denied) throw new Error("controlled current permission denied");
        return { validUntil: input.validUntil };
      },
    },
  };
  const source = createPostgresOptionPriceReviewOperationStore(options);
  return {
    source,
    tx,
    options,
    records,
    terminal,
    guards,
    finals,
    calls,
    query,
    expireAfterAudit: () => {
      expireAfterAudit = true;
    },
    advance: (value: string) => {
      time = value;
    },
    deny: () => {
      denied = true;
    },
    hideCollision: () => {
      available = false;
    },
    finish: async () => {
      for (const guard of guards) await guard();
      for (const final of finals) final();
      source.assertFinalized(tx);
    },
  };
}

it("compound first Submit commits actual generic Draft+Review and final terminal on one borrowed host", async () => {
  const f = fixture(),
    m = mutations(),
    c = command();
  expect(await f.source.inspectOriginalOperation(f.tx, c)).toEqual({ outcome: "Absent" });
  const receipt = await f.source.withOriginalOperation(f.tx, c, async (original) => {
    if (original.outcome !== "Absent") throw Error("Absent required");
    await original.createDraft(m.create);
    return original.commit(m.submit);
  });
  expect(receipt.auditReference).toBe(m.submit.audit.auditId);
  expect(f.records.map((r) => r.operation)).toEqual(["CreateDraft", "SubmitReview"]);
  expect(f.terminal[0]?.mutation_json).toEqual(m.submit);
  await f.finish();
  expect(f.source.assertFinalized(f.tx)).toBe(until);
});
it("historical committed original returns actual immutable final mutation after business expiry without allocation", async () => {
  const f = fixture(),
    c = parsePublishingOptionPriceReviewOperation({
      ...command(),
      validationValidUntil: "2026-09-11T11:59:00.000Z",
    });
  const m = mutations().submit;
  // Genuine earlier stored evidence/action clocks, not a newly granted current proof.
  const old = parsePublishingInstant("2026-09-11T11:58:00.000Z"),
    end = parsePublishingInstant(c.validationValidUntil);
  if (m.current === null) throw Error("actual original Draft required");
  const current = createPublishingLifecycleRecord({ ...m.current, createdAt: old, changedAt: old });
  const mutation: CommitPublishingMutationInput = {
    ...m,
    current,
    next: createPublishingLifecycleRecord({ ...m.next, createdAt: old, changedAt: old }),
    validationEvidence: createPublishingValidationEvidence({
      ...validationOf(m),
      checkedAt: old,
      validUntil: end,
    }),
    audit: validateAuditRecord({ ...m.audit, occurredAt: old }, Date.parse(at)),
  };
  f.records.push(mutation);
  f.terminal.push({
    outcome_code: "Committed",
    command_json: c,
    command_digest: publishingOptionPriceReviewOperationDigest(c),
    recorded_at: old,
    audit_id: mutation.audit.auditId,
    mutation_json: mutation,
    mutation_digest: publishingRecordedMutationDigest(mutation),
  });
  const original = await f.source.inspectOriginalOperation(f.tx, c);
  expect(original.outcome).toBe("Committed");
  expect(original).toHaveProperty("mutation", mutation);
  expect(f.calls.some((sql) => sql.startsWith("INSERT"))).toBe(false);
  await f.finish();
});
it("terminal cannot masquerade as an original when actual mutation source is missing", async () => {
  const f = fixture(),
    c = command(),
    m = mutations().submit;
  f.terminal.push({
    outcome_code: "Committed",
    command_json: c,
    command_digest: publishingOptionPriceReviewOperationDigest(c),
    recorded_at: at,
    audit_id: m.audit.auditId,
    mutation_json: m,
    mutation_digest: publishingRecordedMutationDigest(m),
  });
  await expect(f.source.inspectOriginalOperation(f.tx, c)).rejects.toThrow();
  expect(() => f.source.assertFinalized(f.tx)).toThrow();
});
it("actual Audit abandonment is permanent exact terminal without Event or generic mutation", async () => {
  const f = fixture(),
    c = command();
  const original = await f.source.resolveOperation(f.tx, c);
  expect(original.outcome).toBe("Abandoned");
  expect(f.records).toHaveLength(0);
  expect(f.terminal).toHaveLength(1);
  expect(f.calls.some((sql) => sql.startsWith("INSERT INTO platform_audit.audit_record"))).toBe(
    true,
  );
  expect(f.calls.some((sql) => sql.includes("outbox"))).toBe(false);
  await f.finish();
  const replay = fixture();
  replay.terminal.push(required(f.terminal[0]));
  expect(await replay.source.inspectOriginalOperation(replay.tx, c)).toEqual(original);
  expect(replay.calls.some((sql) => sql.startsWith("INSERT"))).toBe(false);
  await replay.finish();
});
it.each([
  "actorReference",
  "selectedStoreReference",
  "draftSnapshotDigest",
  "validationValidUntil",
  "expectedAggregateVersion",
])("changed original %s cannot clear abandonment", async (field) => {
  const f = fixture(),
    c = command();
  f.terminal.push({
    outcome_code: "Abandoned",
    command_json: c,
    command_digest: publishingOptionPriceReviewOperationDigest(c),
    recorded_at: at,
    audit_id: id(9),
    mutation_json: null,
    mutation_digest: null,
  });
  const value =
    field === "expectedAggregateVersion"
      ? 2
      : field === "draftSnapshotDigest"
        ? "sha256:" + "b".repeat(64)
        : field === "validationValidUntil"
          ? "2026-09-13T12:00:00.000Z"
          : id(99);
  await expect(f.source.resolveOperation(f.tx, { ...c, [field]: value })).rejects.toThrow();
  expect(f.calls.some((sql) => sql.startsWith("INSERT"))).toBe(false);
});
it.each(["permission", "deadline", "query", "clock", "audit"])(
  "late %s withdrawal poisons actual final guards",
  async (kind) => {
    const f = fixture();
    await f.source.resolveOperation(f.tx, command());
    if (kind === "permission") f.deny();
    if (kind === "deadline") f.advance(until);
    if (kind === "query") f.tx.query = vi.fn(async () => ({ rows: [] }));
    if (kind === "clock") f.options.clock.now = () => at;
    if (kind === "audit")
      f.options.audit.create = (input) =>
        validateAuditRecord({ ...audit(), occurredAt: input.observedAt });
    await expect(f.finish()).rejects.toThrow();
    expect(() => f.source.assertFinalized(f.tx)).toThrow();
  },
);
it("all omitted/repeated/swallowed final guards and callback refusal prevent successful finalization", async () => {
  const f = fixture();
  await f.source.resolveOperation(f.tx, command());
  expect(() => f.source.assertFinalized(f.tx)).toThrow();
  expect(() => required(f.finals[0])()).toThrow();
  const g = fixture();
  await g.source.resolveOperation(g.tx, command());
  await required(g.guards[0])();
  await expect(required(g.guards[0])()).rejects.toThrow();
  expect(() => g.source.assertFinalized(g.tx)).toThrow();
  const h = fixture(),
    failure = Error("CURRENT_PERMISSION_DENIED");
  await h.source.inspectOriginalOperation(h.tx, command());
  await expect(
    h.source.withOriginalOperation(h.tx, command(), async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  await expect(h.finish()).rejects.toThrow();
});
it("hidden global operation collision never becomes Abandoned", async () => {
  const f = fixture();
  f.hideCollision();
  await expect(f.source.resolveOperation(f.tx, command())).rejects.toThrow(
    OptionPriceReviewOriginalDeniedError,
  );
  expect(f.terminal).toHaveLength(0);
});
it.each([false, true])(
  "distinguishes intact differing intent from corrupted original digest (%s)",
  async (corrupt) => {
    const f = fixture(),
      c = command();
    f.terminal.push({
      outcome_code: "Abandoned",
      command_json: c,
      command_digest: corrupt
        ? "sha256:" + "b".repeat(64)
        : publishingOptionPriceReviewOperationDigest(c),
      recorded_at: at,
      audit_id: id(9),
      mutation_json: null,
      mutation_digest: null,
    });
    const altered = { ...c, draftSnapshotDigest: "sha256:" + "c".repeat(64) };
    try {
      await f.source.resolveOperation(f.tx, altered);
      throw new Error("expected original refusal");
    } catch (error) {
      expect(error instanceof OptionPriceReviewOriginalDeniedError).toBe(!corrupt);
    }
    expect(f.calls.some((sql) => sql.startsWith("INSERT"))).toBe(false);
    await expect(f.finish()).rejects.toThrow();
  },
);
it.each(["missingCreate", "sameOperation", "wrongSnapshot", "wrongExpiry", "wrongReason"])(
  "compound %s refuses terminal and poisons swallowed writes",
  async (kind) => {
    const f = fixture(),
      m = mutations(),
      c = command();
    await f.source.inspectOriginalOperation(f.tx, c);
    await expect(
      f.source.withOriginalOperation(f.tx, c, async (original) => {
        if (original.outcome !== "Absent") throw Error("Absent required");
        if (kind !== "missingCreate")
          await original.createDraft(
            kind === "sameOperation"
              ? { ...m.create, idempotencyKey: c.operationReference }
              : m.create,
          );
        let submitted = m.submit;
        if (kind === "wrongSnapshot")
          submitted = {
            ...submitted,
            next: createPublishingLifecycleRecord({
              ...submitted.next,
              snapshotReference: parsePublishingReference(id(99)),
            }),
          };
        if (kind === "wrongExpiry")
          submitted = {
            ...submitted,
            validationEvidence: createPublishingValidationEvidence({
              ...validationOf(submitted),
              validUntil: parsePublishingInstant("2026-09-13T12:00:00.000Z"),
            }),
          };
        if (kind === "wrongReason")
          submitted = {
            ...submitted,
            audit: validateAuditRecord({ ...submitted.audit, reasonCode: "AUTHORIZED_OPERATION" }),
          };
        await original.commit(submitted).catch(() => undefined);
      }),
    ).rejects.toThrow();
    expect(f.terminal).toHaveLength(0);
    await expect(f.finish()).rejects.toThrow();
  },
);
it("writer cannot skip original arbitration or reuse different body after absence", async () => {
  const f = fixture();
  await expect(
    f.source.withOriginalOperation(f.tx, command(), async () => undefined),
  ).rejects.toThrow();
  const g = fixture();
  await g.source.inspectOriginalOperation(g.tx, command());
  await expect(
    g.source.withOriginalOperation(
      g.tx,
      { ...command(), expectedAggregateVersion: 2 },
      async () => undefined,
    ),
  ).rejects.toThrow();
});
it("expiry during Brand Audit refuses terminal append and original Audit callback substitution", async () => {
  const f = fixture();
  f.expireAfterAudit();
  await expect(f.source.resolveOperation(f.tx, command())).rejects.toThrow();
  expect(f.terminal).toHaveLength(0);
  await expect(f.finish()).rejects.toThrow();
});

function approvalMutation(actor = id(19)) {
  const m = mutations().submit,
    approval = createPublishingApprovalEvidence({
      evidenceReference: parsePublishingReference(id(20)),
      reviewLifecycleId: m.next.lifecycleId,
      reviewVersion: m.next.version,
      snapshotReference: m.next.snapshotReference,
      snapshotDigest: m.next.snapshotDigest,
      scope,
      decision: "Accepted",
      approvedActorReference: parsePublishingReference(actor),
      approvedAt: at,
      validUntil: parsePublishingInstant("2026-09-12T11:00:00.000Z"),
    });
  const mutation: CommitPublishingMutationInput = {
    ...m,
    operation: "Approve",
    idempotencyKey: parsePublishingReference(id(21)),
    expectedVersion: m.next.version,
    current: m.next,
    next: createPublishingLifecycleRecord({
      ...m.next,
      version: parsePublishingVersion(3),
      state: "Approved",
      approvalEvidenceReference: approval.evidenceReference,
    }),
    validationEvidence: null,
    approvalEvidence: approval,
    audit: validateAuditRecord({
      ...audit("PUBLISHING_REVIEW_APPROVED", id(21), id(10), 22),
      actor: { type: "User", reference: actor },
    }),
  };
  const c = parsePublishingOptionPriceReviewOperation({
    ...command(),
    actorReference: actor,
    action: "Approve",
    operationReference: id(21),
    approvalValidUntil: approval.validUntil,
    expectedLifecycle: {
      lifecycleReference: m.next.lifecycleId,
      version: 2,
      state: "InReview",
      latestMutationOperationReference: m.idempotencyKey,
    },
  });
  return { mutation, c };
}
it("independent Approve commits actual original review chain and exact captured business expiry", async () => {
  const f = fixture(undefined, id(19)),
    m = mutations(),
    { mutation, c } = approvalMutation();
  f.records.push(m.create, m.submit);
  await f.source.inspectOriginalOperation(f.tx, c);
  await f.source.withOriginalOperation(f.tx, c, async (original) => {
    if (original.outcome !== "Absent") throw Error("Absent required");
    return original.commit(mutation);
  });
  expect(f.records).toHaveLength(3);
  expect(f.terminal[0]?.mutation_json).toEqual(mutation);
  await f.finish();
});
it("actual original author/submitter cannot approve their own exact review", async () => {
  const f = fixture(),
    m = mutations(),
    { mutation, c } = approvalMutation(id(4));
  f.records.push(m.create, m.submit);
  await f.source.inspectOriginalOperation(f.tx, c);
  await expect(
    f.source.withOriginalOperation(f.tx, c, async (original) => {
      if (original.outcome !== "Absent") throw Error("Absent required");
      return original.commit(mutation);
    }),
  ).rejects.toThrow();
  expect(f.terminal).toHaveLength(0);
  await expect(f.finish()).rejects.toThrow();
});
it("source descriptor getters are not executed as terminal facts", async () => {
  const f = fixture(),
    getter = vi.fn(() => "Abandoned");
  const row = {};
  Object.defineProperty(row, "outcome_code", { enumerable: true, get: getter });
  f.terminal.push(row);
  await expect(f.source.inspectOriginalOperation(f.tx, command())).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
});
