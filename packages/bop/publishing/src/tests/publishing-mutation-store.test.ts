import { expect, it, vi } from "vitest";
import {
  createPostgresPublishingMutationStore,
  parseRecordedPublishingMutation,
  publishingRecordedMutationDigest,
  type PublishingTransaction,
} from "../infrastructure/persistence/publishing-mutation-store.js";
import { createPublishingScope } from "../contracts/publishing.js";
import type { CommitPublishingMutationInput } from "../application/ports/publishing-ports.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-04T10:00:00.000Z";
// Real owner service and audit SQL with controlled database transport; this is not PostgreSQL contention proof.
function fixture(storeScoped = false) {
  const scope = createPublishingScope({
    kind: storeScoped ? "Store" : "Brand",
    brandReference: id(2),
    storeReference: storeScoped ? id(3) : null,
  });
  const current = {
    lifecycleId: id(4),
    familyReference: id(2),
    configurationType: "BRAND_CONFIGURATION",
    purposeCode: "BRAND_CONFIGURATION",
    snapshotReference: id(6),
    snapshotDigest: "sha256:" + "a".repeat(64),
    scope,
    version: 1,
    state: "Draft",
    validationEvidenceReference: null,
    approvalEvidenceReference: null,
    createdAt: at,
    changedAt: at,
  };
  const audit = (action: string, n: number) => ({
    auditId: id(n),
    brandId: id(2),
    ...(storeScoped ? { storeId: id(3) } : {}),
    actor: { type: "User", reference: id(7) },
    actionCode: action,
    targetType: "PublishingLifecycle",
    targetId: id(4),
    reasonCode: action,
    correlationId: id(n + 100),
    occurredAt: at,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Confidential",
    retentionPolicyCode: "AUDIT_SECURITY",
    retentionPolicyVersion: 1,
  });
  const base = {
    release: null,
    supersededReleaseId: null,
    rollbackTargetReleaseId: null,
    approvalEvidence: null,
  };
  const create = parseRecordedPublishingMutation({
    ...base,
    operation: "CreateDraft",
    expectedVersion: 1,
    idempotencyKey: id(8),
    current: null,
    next: current,
    validationEvidence: null,
    audit: audit("PUBLISHING_DRAFT_CREATED", 10),
  });
  const submit = parseRecordedPublishingMutation({
    ...base,
    operation: "SubmitReview",
    expectedVersion: 1,
    idempotencyKey: id(9),
    current,
    next: { ...current, state: "InReview", version: 2, validationEvidenceReference: id(12) },
    validationEvidence: {
      evidenceReference: id(12),
      snapshotReference: id(6),
      snapshotDigest: current.snapshotDigest,
      scope,
      result: "Pass",
      checkedAt: at,
      validUntil: "2026-10-04T11:00:00.000Z",
      checkCodes: ["CURRENT_REFERENCES"],
    },
    audit: audit("PUBLISHING_REVIEW_SUBMITTED", 11),
  });
  const records: CommitPublishingMutationInput[] = [],
    calls: string[] = [];
  let sequence = 1;
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    calls.push(sql);
    if (sql.includes("current_setting('transaction_isolation')"))
      return { rows: [{ isolation: "read committed" }] };
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
    if (sql.startsWith("SELECT mutation_json,intent_hash"))
      return {
        rows: records
          .slice(-1)
          .map((m) => ({ mutation_json: m, intent_hash: publishingRecordedMutationDigest(m) })),
      };
    if (sql.startsWith("SELECT mutation_json FROM"))
      return { rows: [...records].reverse().map((m) => ({ mutation_json: m })) };
    if (sql.startsWith("INSERT INTO bop_publishing.publishing_mutation_record")) {
      records.push(parseRecordedPublishingMutation(values[14]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM platform_audit.audit_chain_head"))
      return {
        rows: [
          {
            next_sequence: String(sequence),
            previous_hash: sequence === 1 ? null : "b".repeat(64),
            recorded_at: at,
          },
        ],
      };
    if (sql.startsWith("UPDATE platform_audit.audit_chain_head"))
      return { rows: [{ next_sequence: String(++sequence) }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  const tx: PublishingTransaction = { query },
    runner = { run: <T>(work: (actual: PublishingTransaction) => Promise<T>) => work(tx) },
    store = createPostgresPublishingMutationStore(runner, id(1), scope);
  return {
    store,
    tx,
    runner,
    scope,
    create,
    submit,
    calls,
    records,
    query,
    read: () =>
      store.resolveCurrentLifecycleMutation({
        familyReference: id(2),
        lifecycleReference: id(4),
        configurationType: "BRAND_CONFIGURATION",
        purposeCode: "BRAND_CONFIGURATION",
        observedAt: at,
      }),
  };
}

it("holds actual Brand SRE before existing public current reads and mutations on the same borrowed transaction", async () => {
  const f = fixture(),
    callback = vi.fn(async (held: PublishingTransaction) => {
      expect(held).toBe(f.tx);
      expect(held.query).toBe(f.query);
      expect(f.calls.at(-1)).toBe(
        "LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE ROW EXCLUSIVE MODE",
      );
      const owner = createPostgresPublishingMutationStore(
        { run: (work) => work(held) },
        id(1),
        f.scope,
      );
      for (const mutation of [f.create, f.submit]) {
        await owner.commit(mutation);
        await expect(
          owner.resolveCurrentLifecycleMutation({
            familyReference: id(2),
            lifecycleReference: id(4),
            configurationType: "BRAND_CONFIGURATION",
            purposeCode: "BRAND_CONFIGURATION",
            observedAt: at,
          }),
        ).resolves.toEqual(mutation);
      }
      return f.records.length;
    });
  await expect(
    f.store.withBrandConfigurationWrite({ familyReference: id(2) }, callback),
  ).resolves.toBe(2);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(f.query.mock.calls[1]?.[1]).toEqual([id(1), id(2)]);
  expect(f.calls).not.toContain("COMMIT");
  expect(f.calls).not.toContain("ROLLBACK");
  const admission = f.calls.findIndex((sql) => sql.includes("SHARE ROW EXCLUSIVE")),
    firstRead = f.calls.findIndex((sql) => sql.startsWith("SELECT mutation_json")),
    firstInsert = f.calls.findIndex((sql) => sql.startsWith("INSERT INTO"));
  expect(firstRead).toBeGreaterThan(admission);
  expect(firstInsert).toBeGreaterThan(admission);
});

it("captures closed family input before awaiting admission", async () => {
  const f = fixture(),
    input = { familyReference: id(2) },
    result = f.store.withBrandConfigurationWrite(input, async (tx) => tx);
  input.familyReference = id(99);
  await expect(result).resolves.toBe(f.tx);
});

it("waits for the single callback to finish before returning its result", async () => {
  const f = fixture();
  let complete: ((value: string) => void) | undefined,
    start: (() => void) | undefined,
    settled = false;
  const pending = new Promise<string>((resolve) => {
    complete = resolve;
  });
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const result = f.store
    .withBrandConfigurationWrite({ familyReference: id(2) }, async () => {
      start?.();
      return pending;
    })
    .finally(() => {
      settled = true;
    });
  await started;
  expect(settled).toBe(false);
  complete?.("finished");
  await expect(result).resolves.toBe("finished");
});

it("rejects Store scope and a noncanonical Brand family before SQL or callback", async () => {
  for (const [f, familyReference] of [
    [fixture(true), id(2)],
    [fixture(), id(99)],
  ] as const) {
    const work = vi.fn(async () => null);
    await expect(
      f.store.withBrandConfigurationWrite({ familyReference }, work),
    ).rejects.toMatchObject({
      code: "PUBLISHING_INPUT_INVALID",
    });
    expect(work).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  }
});

it("refuses accessors, extra fields and symbols without reading the family getter", async () => {
  const getter = vi.fn(() => id(2));
  for (const input of [
    {
      get familyReference() {
        return getter();
      },
    },
    { familyReference: id(2), configurationType: "BRAND_CONFIGURATION" },
    { familyReference: id(2), [Symbol("mode")]: "Write" },
  ]) {
    const f = fixture();
    await expect(
      f.store.withBrandConfigurationWrite(input, async () => null),
    ).rejects.toMatchObject({
      code: "PUBLISHING_INPUT_INVALID",
    });
    expect(f.query).not.toHaveBeenCalled();
  }
  expect(getter).not.toHaveBeenCalled();
});

it("normalizes hostile input descriptor failures before SQL", async () => {
  const f = fixture(),
    input = new Proxy(
      { familyReference: id(2) },
      {
        ownKeys() {
          throw new Error("private trap detail");
        },
      },
    );
  await expect(f.store.withBrandConfigurationWrite(input, async () => null)).rejects.toMatchObject({
    code: "PUBLISHING_INPUT_INVALID",
    message: "publishing contract input is invalid",
  });
  expect(f.query).not.toHaveBeenCalled();
});

it("rejects unsupported isolation before acquiring admission or invoking work", async () => {
  const f = fixture(),
    work = vi.fn(async () => null);
  f.query.mockImplementationOnce(async () => ({ rows: [{ isolation: "repeatable read" }] }));
  await expect(
    f.store.withBrandConfigurationWrite({ familyReference: id(2) }, work),
  ).rejects.toMatchObject({
    code: "PUBLISHING_INPUT_INVALID",
  });
  expect(f.query).toHaveBeenCalledTimes(1);
  expect(work).not.toHaveBeenCalled();
});

it("poisons the outer admission when its callback catches reentry", async () => {
  const f = fixture(),
    nested = vi.fn(async () => null);
  await expect(
    f.store.withBrandConfigurationWrite({ familyReference: id(2) }, async () => {
      await expect(
        f.store.withBrandConfigurationWrite({ familyReference: id(2) }, nested),
      ).rejects.toMatchObject({
        code: "PUBLISHING_INPUT_INVALID",
      });
      return "cannot escape caught refusal";
    }),
  ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
  expect(nested).not.toHaveBeenCalled();
  const count = f.calls.length;
  await expect(
    f.store.withBrandConfigurationWrite({ familyReference: id(2) }, nested),
  ).rejects.toMatchObject({
    code: "PUBLISHING_INPUT_INVALID",
  });
  expect(f.calls).toHaveLength(count);
});

it("rejects query and runner drift, including a runner replaced after owner creation", async () => {
  for (const kind of ["query", "runner", "before"] as const) {
    const f = fixture(),
      replacement = async () => ({ rows: [] });
    if (kind === "before")
      f.runner.run = async () => {
        throw new Error("changed port");
      };
    await expect(
      f.store.withBrandConfigurationWrite({ familyReference: id(2) }, async () => {
        if (kind === "query") f.tx.query = replacement;
        else
          f.runner.run = async () => {
            throw new Error("changed port");
          };
        return null;
      }),
    ).rejects.toMatchObject({ code: "PUBLISHING_INPUT_INVALID" });
    if (kind === "before") expect(f.query).not.toHaveBeenCalled();
  }
});

it("requires exactly one awaited runner callback and rejects a swallowed duplicate failure", async () => {
  for (const invoke of [false, true]) {
    const f = fixture(),
      work = vi.fn(async () => "value"),
      store = createPostgresPublishingMutationStore(
        {
          async run<T>(callback: (tx: PublishingTransaction) => Promise<T>): Promise<T> {
            if (!invoke) return "forged" as T;
            const value = await callback(f.tx);
            try {
              await callback(f.tx);
            } catch {
              /* A swallowed refusal must poison the owner. */
            }
            return value;
          },
        },
        id(1),
        f.scope,
      );
    await expect(
      store.withBrandConfigurationWrite({ familyReference: id(2) }, work),
    ).rejects.toMatchObject({
      code: "PUBLISHING_INPUT_INVALID",
    });
    expect(work).toHaveBeenCalledTimes(invoke ? 1 : 0);
  }
});

it("maps unknown SQL and callback errors without leaking raw dependency detail", async () => {
  for (const sqlFailure of [false, true]) {
    const f = fixture();
    if (sqlFailure) f.query.mockRejectedValueOnce(new Error("private dependency detail"));
    await expect(
      f.store.withBrandConfigurationWrite({ familyReference: id(2) }, async () => {
        throw new Error("private callback detail");
      }),
    ).rejects.toMatchObject({
      code: "PUBLISHING_INPUT_INVALID",
      message: "publishing contract input is invalid",
    });
    const count = f.calls.length;
    await expect(
      f.store.withBrandConfigurationWrite({ familyReference: id(2) }, async () => null),
    ).rejects.toMatchObject({
      code: "PUBLISHING_INPUT_INVALID",
    });
    expect(f.calls).toHaveLength(count);
  }
});
