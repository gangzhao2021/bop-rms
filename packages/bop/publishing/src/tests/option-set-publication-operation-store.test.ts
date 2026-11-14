import { expect, it, vi } from "vitest";
import { validateAuditRecord } from "@bop/audit";
import {
  createPostgresOptionSetPublicationOperationStore,
  type OptionSetPublicationOperationStoreOptions,
} from "../infrastructure/persistence/option-set-publication-operation-store.js";
import {
  parsePublishingOptionSetPublicationOperation,
  publishingOptionSetPublicationOperationDigest,
} from "../contracts/option-set-publication-operation.js";
import {
  createPublishingLifecycleRecord,
  createPublishingScope,
  createPublishingValidationEvidence,
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
  parsePublishingOptionSetPublicationOperation({
    profile: "PublishingOptionSetPublicationOperationV1",
    tenantReference: id(1),
    brandReference: id(2),
    selectedStoreReference: id(3),
    actorReference: id(4),
    reasonCode: "AUTHORIZED_OPERATION",
    action: "SubmitReview",
    operationReference: id(5),
    optionSetReference: id(6),
    versionReference: id(7),
    expectedAggregateVersion: 1,
    sourceDigest: hash,
    contentDigest: hash,
    configurationDigest: hash,
    expectedReview: null,
    expectedLifecycle: null,
  });
const scope = createPublishingScope({ kind: "Brand", brandReference: id(2), storeReference: null });
function audit(
  action = "PUBLISHING_OPTION_SET_OPERATION_ABANDONED",
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
      action === "PUBLISHING_OPTION_SET_OPERATION_ABANDONED"
        ? "PublishingOptionSetOperation"
        : "PublishingLifecycle",
    targetId: target,
    reasonCode: "AUTHORIZED_OPERATION",
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
    configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
    purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
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
    validUntil: until,
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
function fixture(auditOverride?: OptionSetPublicationOperationStoreOptions["audit"]["create"]) {
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
    if (sql.startsWith("INSERT INTO bop_publishing.option_set_publication_operation")) {
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
    if (sql.startsWith("SELECT mutation_json,intent_hash,audit_id"))
      return {
        rows: records
          .filter((m) => m.idempotencyKey === values[3])
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
  const options: OptionSetPublicationOperationStoreOptions = {
    tenantReference: id(1),
    brandReference: id(2),
    selectedStoreReference: id(3),
    actorReference: id(4),
    optionSetPolicyFamilyReference: id(30),
    clock: { now: () => time },
    originalValidUntil: until,
    audit: {
      create:
        auditOverride ??
        ((input) => validateAuditRecord({ ...audit(), occurredAt: input.observedAt })),
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
  const source = createPostgresOptionSetPublicationOperationStore(options);
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
    },
  };
}
it("first ordinary Submit creates Draft and final Review on one host, auto-appends final identity after real Audit", async () => {
  const f = fixture(),
    m = mutations();
  await f.source.inspectOriginalOperation(f.tx, command());
  const receipt = await f.source.withOriginalOperation(f.tx, command(), async (original) => {
    if (original.outcome !== "Absent") throw new Error("expected absent");
    await original.createDraft(m.create);
    return original.commit(m.submit);
  });
  expect(receipt.auditReference).toBe(m.submit.audit.auditId);
  expect(f.records.map((m) => m.operation)).toEqual(["CreateDraft", "SubmitReview"]);
  expect(f.terminal).toHaveLength(1);
  expect(f.terminal[0]?.mutation_json).toEqual(m.submit);
  expect(f.calls.findIndex((sql) => sql.includes("SHARE ROW EXCLUSIVE"))).toBeLessThan(
    f.calls.findIndex((sql) => sql.startsWith("SELECT mutation_json")),
  );
  expect(
    f.calls.findIndex((sql) => sql.startsWith("INSERT INTO platform_audit.audit_record")),
  ).toBeLessThan(
    f.calls.findIndex((sql) =>
      sql.startsWith("INSERT INTO bop_publishing.option_set_publication_operation"),
    ),
  );
  await f.finish();
});
it("first Submit preserves distinct canonical inner Draft and outer Review audit reasons", async () => {
  const f = fixture(),
    m = mutations(),
    c = parsePublishingOptionSetPublicationOperation({
      ...command(),
      reasonCode: "PUBLISHING_REVIEW_SUBMITTED",
    });
  const create = {
    ...m.create,
    audit: validateAuditRecord({ ...m.create.audit, reasonCode: "PUBLISHING_DRAFT_CREATED" }),
  };
  const submit = {
    ...m.submit,
    audit: validateAuditRecord({ ...m.submit.audit, reasonCode: c.reasonCode }),
  };
  await f.source.inspectOriginalOperation(f.tx, c);
  await f.source.withOriginalOperation(f.tx, c, async (original) => {
    if (original.outcome !== "Absent") throw new Error("expected absent");
    await original.createDraft(create);
    return original.commit(submit);
  });
  await f.finish();
  expect(f.records.map((m) => m.audit.reasonCode)).toEqual([
    "PUBLISHING_DRAFT_CREATED",
    "PUBLISHING_REVIEW_SUBMITTED",
  ]);
  expect(f.terminal[0]?.mutation_json).toEqual(submit);
});
it("an unrelated inner Draft audit reason cannot enter the original Submit host", async () => {
  const f = fixture(),
    m = mutations();
  await f.source.inspectOriginalOperation(f.tx, command());
  await expect(
    f.source.withOriginalOperation(f.tx, command(), async (original) => {
      if (original.outcome !== "Absent") throw new Error("expected absent");
      await original.createDraft({
        ...m.create,
        audit: validateAuditRecord({ ...m.create.audit, reasonCode: "UNRELATED_DRAFT_REASON" }),
      });
      return original.commit(m.submit);
    }),
  ).rejects.toThrow();
  expect(f.records).toHaveLength(0);
  expect(f.terminal).toHaveLength(0);
});
it("committed original replay uses the original full receipt without allocation, requalification or Audit", async () => {
  const f = fixture(),
    m = mutations().submit,
    c = command();
  f.terminal.push({
    outcome_code: "Committed",
    command_json: c,
    command_digest: publishingOptionSetPublicationOperationDigest(c),
    recorded_at: at,
    audit_id: m.audit.auditId,
    mutation_json: m,
    mutation_digest: publishingRecordedMutationDigest(m),
  });
  const original = await f.source.inspectOriginalOperation(f.tx, c);
  expect(original.outcome).toBe("Committed");
  expect(f.calls.some((sql) => sql.startsWith("INSERT"))).toBe(false);
  await f.finish();
});
it("absence becomes Abandoned only with actual owning Audit append and terminal persistence", async () => {
  const f = fixture();
  const result = await f.source.resolveOperation(f.tx, command());
  expect(result.outcome).toBe("Abandoned");
  expect(f.calls.some((sql) => sql.startsWith("INSERT INTO platform_audit.audit_record"))).toBe(
    true,
  );
  expect(f.terminal[0]?.outcome_code).toBe("Abandoned");
  await f.finish();
});
it("abandonment scopes actual Brand Audit separately and restores original Store before terminal", async () => {
  const f = fixture();
  await f.source.resolveOperation(f.tx, command());
  const statements = f.query.mock.calls;
  const auditStart = statements.findIndex(([sql]) =>
    sql.startsWith("INSERT INTO platform_audit.audit_chain_head"),
  );
  const terminal = statements.findIndex(([sql]) =>
    sql.startsWith("INSERT INTO bop_publishing.option_set_publication_operation"),
  );
  const scopes = statements.flatMap(([sql, values], index) =>
    sql.includes("set_config('bop.store_id',$3,true)") ? [{ index, store: values[2] }] : [],
  );
  expect(auditStart).toBeGreaterThan(0);
  expect(terminal).toBeGreaterThan(auditStart);
  expect(scopes.filter(({ index }) => index < auditStart).at(-1)?.store).toBe("");
  expect(scopes.filter(({ index }) => index > auditStart && index < terminal).at(-1)?.store).toBe(
    id(3),
  );
  await f.finish();
});
it("expiry during actual Brand Audit poisons host before Store restoration or terminal persistence", async () => {
  const f = fixture();
  f.expireAfterAudit();
  await expect(f.source.resolveOperation(f.tx, command())).rejects.toThrow();
  expect(f.calls.some((sql) => sql.startsWith("INSERT INTO platform_audit.audit_record"))).toBe(
    true,
  );
  expect(f.terminal).toHaveLength(0);
  await expect(required(f.guards[0])()).rejects.toThrow();
  expect(() => required(f.finals[0])()).toThrow();
});
it("an already Abandoned original never exposes a writer or creates another Audit", async () => {
  const f = fixture(),
    c = command();
  f.terminal.push({
    outcome_code: "Abandoned",
    command_json: c,
    command_digest: publishingOptionSetPublicationOperationDigest(c),
    recorded_at: at,
    audit_id: id(9),
    mutation_json: null,
    mutation_digest: null,
  });
  const result = await f.source.inspectOriginalOperation(f.tx, c);
  expect(result.outcome).toBe("Abandoned");
  expect(result).not.toHaveProperty("commit");
  expect(f.calls.some((sql) => sql.startsWith("INSERT"))).toBe(false);
  await f.finish();
});
it("hidden legacy/other-Store collision is refused rather than declared abandoned", async () => {
  const f = fixture();
  f.hideCollision();
  await expect(f.source.resolveOperation(f.tx, command())).rejects.toThrow();
  expect(f.calls.some((sql) => sql.startsWith("INSERT"))).toBe(false);
});
it("changed original body cannot replay a committed identity", async () => {
  const f = fixture(),
    c = command();
  f.terminal.push({
    outcome_code: "Abandoned",
    command_json: c,
    command_digest: publishingOptionSetPublicationOperationDigest(c),
    recorded_at: at,
    audit_id: id(9),
    mutation_json: null,
    mutation_digest: null,
  });
  await expect(
    f.source.resolveOperation(f.tx, { ...c, expectedAggregateVersion: 2 }),
  ).rejects.toThrow();
});
it.each(["permission", "deadline", "query", "clock"])(
  "late %s loss refuses original host finalization",
  async (kind) => {
    const f = fixture();
    await f.source.resolveOperation(f.tx, command());
    if (kind === "permission") f.deny();
    if (kind === "deadline") f.advance(until);
    if (kind === "query") f.tx.query = vi.fn(async () => ({ rows: [] }));
    if (kind === "clock") f.options.clock.now = () => at;
    await expect(required(f.guards[0])()).rejects.toThrow();
    expect(() => required(f.finals[0])()).toThrow();
  },
);
it("skipped/repeated/swallowed asynchronous guards cannot pass synchronous final assertions", async () => {
  const f = fixture();
  await f.source.resolveOperation(f.tx, command());
  expect(() => required(f.finals[0])()).toThrow();
  const next = fixture();
  await next.source.resolveOperation(next.tx, command());
  await required(next.guards[0])();
  await expect(required(next.guards[0])()).rejects.toThrow();
  expect(() => required(next.finals[0])()).toThrow();
});
it("missing final commit and caught writer failures poison the original transaction", async () => {
  const f = fixture();
  await f.source.inspectOriginalOperation(f.tx, command());
  await expect(
    f.source.withOriginalOperation(f.tx, command(), async () => undefined),
  ).rejects.toThrow();
  expect(() => required(f.finals[0])()).toThrow();
  const g = fixture();
  await g.source.inspectOriginalOperation(g.tx, command());
  await expect(
    g.source.withOriginalOperation(g.tx, command(), async (original) => {
      if (original.outcome !== "Absent") throw new Error("expected absent");
      await original.commit(mutations().submit).catch(() => undefined);
    }),
  ).rejects.toThrow();
  expect(() => required(g.finals[0])()).toThrow();
});

it("readonly original inspection preserves Absent without SRE or Audit, then exact same host writes after Catalog admission", async () => {
  const f = fixture(),
    c = command(),
    m = mutations();
  expect(await f.source.inspectOriginalOperation(f.tx, c)).toEqual({ outcome: "Absent" });
  expect(
    f.calls.some((sql) => sql.includes("SHARE ROW EXCLUSIVE") || sql.startsWith("INSERT")),
  ).toBe(false);
  await f.source.withOriginalOperation(f.tx, c, async (original) => {
    if (original.outcome !== "Absent") throw new Error("expected absent");
    await original.createDraft(m.create);
    return original.commit(m.submit);
  });
  expect(f.guards).toHaveLength(2);
  await f.finish();
});
it("current committed inspection avoids both old Draft CAS and Publishing write admission", async () => {
  const f = fixture(),
    m = mutations().submit,
    c = command();
  f.terminal.push({
    outcome_code: "Committed",
    command_json: c,
    command_digest: publishingOptionSetPublicationOperationDigest(c),
    recorded_at: at,
    audit_id: m.audit.auditId,
    mutation_json: m,
    mutation_digest: publishingRecordedMutationDigest(m),
  });
  expect((await f.source.inspectOriginalOperation(f.tx, c)).outcome).toBe("Committed");
  expect(
    f.calls.some((sql) => sql.includes("SHARE ROW EXCLUSIVE") || sql.includes("currentDraft")),
  ).toBe(false);
  await f.finish();
});
it("abandonment Audit uses actual post-lock observation under the same original deadline", async () => {
  const f = fixture();
  f.advance("2026-09-11T12:00:01.000Z");
  const result = await f.source.resolveOperation(f.tx, command());
  expect(result).toMatchObject({ outcome: "Abandoned", recordedAt: "2026-09-11T12:00:01.000Z" });
  await f.finish();
});
it("changed body between readonly absence and writer admission poisons original host", async () => {
  const f = fixture();
  await f.source.inspectOriginalOperation(f.tx, command());
  await expect(
    f.source.withOriginalOperation(
      f.tx,
      { ...command(), expectedAggregateVersion: 2 },
      async () => undefined,
    ),
  ).rejects.toThrow();
  await expect(required(f.guards[0])()).rejects.toThrow();
});
it("a malformed or forged Audit refuses terminal persistence and swallowed failure cannot finalize", async () => {
  const f = fixture((input) =>
    validateAuditRecord({ ...audit(), occurredAt: input.observedAt, targetId: id(99) }),
  );
  await expect(f.source.resolveOperation(f.tx, command())).rejects.toThrow();
  expect(f.terminal).toHaveLength(0);
  expect(() => required(f.finals[0])()).toThrow();
});

it("late Audit creation port replacement is refused", async () => {
  const f = fixture();
  await f.source.resolveOperation(f.tx, command());
  f.options.audit.create = (input) =>
    validateAuditRecord({ ...audit(), occurredAt: input.observedAt });
  await expect(required(f.guards[0])()).rejects.toThrow();
});
it("writer cannot reuse internal CreateDraft allocation or bypass the final committed identity", async () => {
  const f = fixture(),
    m = mutations();
  await f.source.inspectOriginalOperation(f.tx, command());
  await expect(
    f.source.withOriginalOperation(f.tx, command(), async (original) => {
      if (original.outcome !== "Absent") throw new Error("expected absent");
      await original.createDraft({ ...m.create, idempotencyKey: command().operationReference });
      return original.commit(m.submit);
    }),
  ).rejects.toThrow();
  expect(f.terminal).toHaveLength(0);
});

it("ordinary writer admission cannot skip genuine original operation inspection", async () => {
  const f = fixture();
  await expect(
    f.source.withOriginalOperation(f.tx, command(), async () => undefined),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

it("terminal recovery preserves independent Catalog and Publishing Review operations", async () => {
  const f = fixture(),
    c = parsePublishingOptionSetPublicationOperation({
      ...command(),
      action: "Approve",
      expectedReview: {
        reviewOperationReference: id(80),
        publishingReviewOperationReference: id(5),
        recordDigest: hash,
        bindingDigest: hash,
      },
      expectedLifecycle: {
        lifecycleReference: id(10),
        version: 2,
        state: "InReview",
        latestMutationOperationReference: id(5),
      },
    });
  f.terminal.push({
    outcome_code: "Abandoned",
    command_json: c,
    command_digest: publishingOptionSetPublicationOperationDigest(c),
    recorded_at: at,
    audit_id: id(9),
    mutation_json: null,
    mutation_digest: null,
  });
  const original = await f.source.inspectOriginalOperation(f.tx, c);
  if (original.outcome !== "Abandoned") throw new Error("expected abandoned original");
  expect(original.command.expectedReview?.reviewOperationReference).toBe(id(80));
  expect(original.command.expectedReview?.publishingReviewOperationReference).toBe(id(5));
  await f.finish();
});

it("caller refusal retains its identity and poisons the Absent transaction", async () => {
  const f = fixture(),
    refusal = new Error("CALLER_PERMISSION_DENIED");
  await f.source.inspectOriginalOperation(f.tx, command());
  await expect(
    f.source.withOriginalOperation(f.tx, command(), async () => {
      throw refusal;
    }),
  ).rejects.toBe(refusal);
  expect(f.records).toHaveLength(0);
  expect(f.terminal).toHaveLength(0);
  await expect(f.finish()).rejects.toThrow();
});
it("caller refusal after terminal writes still prevents transaction completion", async () => {
  const f = fixture(),
    m = mutations(),
    refusal = new Error("CALLER_PERMISSION_DENIED");
  await f.source.inspectOriginalOperation(f.tx, command());
  await expect(
    f.source.withOriginalOperation(f.tx, command(), async (original) => {
      if (original.outcome !== "Absent") throw new Error("expected absent");
      await original.createDraft(m.create);
      await original.commit(m.submit);
      throw refusal;
    }),
  ).rejects.toBe(refusal);
  // These are uncommitted fixture writes; the mandatory guard refuses completion.
  expect(f.terminal).toHaveLength(1);
  await expect(f.finish()).rejects.toThrow();
});
it("concurrent known original preserves caller refusal without appending history", async () => {
  const f = fixture(),
    c = command(),
    m = mutations().submit;
  await f.source.inspectOriginalOperation(f.tx, c);
  f.records.push(m);
  f.terminal.push({
    outcome_code: "Committed",
    command_json: c,
    command_digest: publishingOptionSetPublicationOperationDigest(c),
    recorded_at: at,
    audit_id: m.audit.auditId,
    mutation_json: m,
    mutation_digest: publishingRecordedMutationDigest(m),
  });
  const refusal = new Error("CALLER_PERMISSION_DENIED");
  await expect(
    f.source.withOriginalOperation(f.tx, c, async (original) => {
      expect(original.outcome).toBe("Committed");
      throw refusal;
    }),
  ).rejects.toBe(refusal);
  expect(f.records).toHaveLength(1);
  expect(f.terminal).toHaveLength(1);
  await expect(f.finish()).rejects.toThrow();
});
it("swallowing an owning commit failure cannot turn it into successful completion", async () => {
  const f = fixture(),
    m = mutations();
  await f.source.inspectOriginalOperation(f.tx, command());
  await expect(
    f.source.withOriginalOperation(f.tx, command(), async (original) => {
      if (original.outcome !== "Absent") throw new Error("expected absent");
      await expect(original.commit(m.submit)).rejects.toThrow();
      return "swallowed";
    }),
  ).rejects.toThrow();
  expect(f.records).toHaveLength(0);
  expect(f.terminal).toHaveLength(0);
  await expect(f.finish()).rejects.toThrow();
});
