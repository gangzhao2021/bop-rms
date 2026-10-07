import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresStoreSetupDraftStore,
  type StoreSetupDraftStoreOptions,
  type StoreSetupDraftTransaction,
} from "../infrastructure/persistence/store-setup-draft-store.js";
import {
  createUnconfiguredStoreSetupDraftContent,
  createUnconfiguredStoreSetupDraftContentV2,
  type StoreSetupActualScope,
} from "../contracts/store-setup-draft.js";
import { parseStoreSetupSaveCommand } from "../contracts/store-setup-operation.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const origin = "2026-10-05T10:00:00.000Z",
  until = "2026-10-05T10:00:05.000Z";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical(Object.getOwnPropertyDescriptor(value, key)?.value)}`,
      )
      .join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("noncanonical test input");
  return encoded;
}
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
interface Database {
  revisions: Record<string, unknown>[];
  operations: Record<string, unknown>[];
}
function fixture(database: Database = { revisions: [], operations: [] }, actor = id(4)) {
  let now = origin,
    next = 100;
  const sql: string[] = [],
    locks: string[] = [],
    audits: unknown[] = [],
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [];
  const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: actor,
  };
  const tx = {
    query: vi.fn(async (statement: string, values: readonly unknown[]) => {
      sql.push(statement);
      if (statement.includes("transaction_isolation"))
        return { rows: [{ isolation: "read committed" }], rowCount: 1 };
      if (statement.includes("pg_advisory")) {
        locks.push(String(values[0]));
        return { rows: [], rowCount: 1 };
      }
      if (
        statement.startsWith("SELECT") &&
        statement.includes("FROM rms_store.store_setup_draft_revision")
      ) {
        const found = statement.includes("AND EXISTS")
          ? database.revisions.filter(
              (row) =>
                row.setup_draft_id === values[3] &&
                row.revision === String(values[4]) &&
                database.operations.some(
                  (operation) =>
                    operation.operation_id === row.operation_id &&
                    operation.outcome === "Committed" &&
                    operation.actor_id === row.actor_id &&
                    operation.result_setup_id === row.setup_draft_id &&
                    operation.result_revision === row.revision &&
                    operation.snapshot_digest === row.snapshot_digest &&
                    operation.occurred_at === row.updated_at &&
                    Number(operation.expected_revision) === Number(row.revision) - 1 &&
                    (Number(row.revision) === 1
                      ? operation.expected_setup_id === null
                      : operation.expected_setup_id === row.setup_draft_id),
                ),
            )
          : statement.includes("ORDER BY")
            ? database.revisions.slice(-1)
            : database.revisions.filter(
                (row) =>
                  row.setup_draft_id === values[3] &&
                  row.revision === String(values[4]) &&
                  row.operation_id === values[5],
              );
        return { rows: found, rowCount: found.length };
      }
      if (
        statement.startsWith("SELECT") &&
        statement.includes("FROM rms_store.store_setup_draft_operation")
      ) {
        const found = database.operations.filter(
          (row) =>
            row.operation_id === values[3] &&
            row.tenant_id === values[0] &&
            row.brand_id === values[1] &&
            row.store_id === values[2],
        );
        return { rows: found, rowCount: found.length };
      }
      if (statement.startsWith("INSERT INTO rms_store.store_setup_draft_revision")) {
        database.revisions.push({
          setup_draft_id: values[3],
          revision: String(values[4]),
          operation_id: values[5],
          actor_id: values[6],
          snapshot_json: JSON.parse(String(values[7])),
          snapshot_digest: values[8],
          created_at: values[9],
          updated_at: values[10],
        });
      }
      if (statement.startsWith("INSERT INTO rms_store.store_setup_draft_operation")) {
        if (database.operations.some((row) => row.operation_id === values[0]))
          throw Object.assign(new Error("controlled SQL failure"), { code: "23505" });
        database.operations.push({
          operation_id: values[0],
          tenant_id: values[1],
          brand_id: values[2],
          store_id: values[3],
          actor_id: values[4],
          intent_digest: values[5],
          expected_setup_id: values[6],
          expected_revision: String(values[7]),
          outcome: values[8],
          result_setup_id: values[9],
          result_revision: values[10] === null ? null : String(values[10]),
          snapshot_digest: values[11],
          audit_reference: values[12],
          occurred_at: values[13],
        });
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  const options: StoreSetupDraftStoreOptions = {
    ...scope,
    transaction: tx,
    clock: { now: () => now },
    originalObservedAt: origin,
    originalValidUntil: until,
    registerBeforeCommit: (_tx, guard, final) => {
      guards.push(guard);
      finals.push(final);
    },
    authority: { holdUntilTransactionCompletes: vi.fn(async () => ({ validUntil: until })) },
    references: {
      canonicalize: canonical,
      hashIntent: hash,
      nextReference: vi.fn(() => id(next++)),
    },
    appendAudit: vi.fn(async (_tx, audit) => {
      audits.push(audit);
    }),
    withCurrentSaveScope: async <T>(
      _tx: StoreSetupDraftTransaction,
      _request: unknown,
      work: (actual: StoreSetupActualScope) => Promise<T>,
    ) =>
      work({
        ...scope,
        defaultLocale: "en-CA",
        currencyCode: "CAD",
        baseConfigurationReference: null,
      }),
  };
  const store = createPostgresStoreSetupDraftStore(options);
  const command = (
    operation = id(5),
    expectedSetupReference: string | null = null,
    expectedRevision = 0,
  ) =>
    parseStoreSetupSaveCommand({
      profile: "StoreSetupSaveV1",
      ...scope,
      operationReference: operation,
      expectedSetupReference,
      expectedRevision,
      purposeCode: "STORE_SETUP_DRAFT",
      content: createUnconfiguredStoreSetupDraftContent(),
    });
  const resolve = (save = command()) => {
    const { content, ...identity } = save;
    void content;
    return { ...identity, profile: "StoreSetupResolveV1", intentDigest: hash(canonical(save)) };
  };
  return {
    store,
    options,
    tx,
    sql,
    locks,
    audits,
    database,
    command,
    resolve,
    guards,
    finals,
    setNow: (value: string) => {
      now = value;
    },
    finish: async () => {
      for (const guard of guards) await guard();
      for (const final of finals) final();
      return store.assertFinalized(tx);
    },
  };
}
describe("Store setup borrowed transaction source (controlled SQL and Audit transport)", () => {
  it("authenticates an exact immutable revision for a different authorized reader without treating it as current", async () => {
    const seed = fixture();
    const command = seed.command();
    const saved = await seed.store.save({
      ...command,
      content: {
        ...command.content,
        enabledServiceModes: { state: "Configured", value: ["Pickup"] },
      },
    });
    await seed.finish();
    const reader = fixture(seed.database, id(10));
    const recorded = await reader.store.readServiceModePreparationVersion({
      setupDraftReference: saved.snapshot?.setupDraftReference,
      sourceRevision: 1,
      sourceSnapshotDigest: seed.database.revisions[0]?.snapshot_digest,
    });
    expect(recorded).toMatchObject({
      profile: "StoreSetupServiceModePreparationVersionV1",
      sourceBasis: "RecordedDraftRevision",
      readerActorReference: id(10),
      preparation: {
        serviceModes: ["Pickup"],
        sourceRevision: 1,
        publicationStatus: "NotPublished",
      },
    });
    expect(reader.options.references.nextReference).not.toHaveBeenCalled();
    expect(reader.audits).toEqual([]);
    await reader.finish();
  });
  it("refuses wrong history pins, absent committed originals, and post-read immutable-tuple drift", async () => {
    const seed = fixture();
    const command = seed.command();
    const saved = await seed.store.save({
      ...command,
      content: {
        ...command.content,
        enabledServiceModes: { state: "Configured", value: ["DineIn"] },
      },
    });
    await seed.finish();
    const selector = {
      setupDraftReference: saved.snapshot?.setupDraftReference,
      sourceRevision: 1,
      sourceSnapshotDigest: seed.database.revisions[0]?.snapshot_digest,
    };
    for (const change of [
      { sourceRevision: 2 },
      { sourceSnapshotDigest: hash("wrong") },
      { setupDraftReference: id(99) },
      { extra: true },
    ]) {
      const wrong = fixture(seed.database);
      await expect(
        wrong.store.readServiceModePreparationVersion({ ...selector, ...change }),
      ).rejects.toThrow();
      expect(wrong.audits).toEqual([]);
    }
    const reader = fixture(seed.database);
    await reader.store.readServiceModePreparationVersion(selector);
    seed.database.operations.splice(0);
    await expect(reader.finish()).rejects.toThrow();
    await expect(
      fixture(seed.database).store.readServiceModePreparationVersion(selector),
    ).rejects.toThrow();
  });
  it("reads actual configured modes as preparation without writes or live eligibility", async () => {
    const seed = fixture();
    const command = seed.command();
    await seed.store.save({
      ...command,
      content: {
        ...command.content,
        enabledServiceModes: { state: "Configured", value: ["Delivery", "DineIn"] },
      },
    });
    await seed.finish();
    const reader = fixture(seed.database);
    const preparation = await reader.store.readServiceModePreparation();
    expect(preparation).toMatchObject({
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      sourceRevision: 1,
      serviceModes: ["DineIn", "Delivery"],
      publicationStatus: "NotPublished",
      businessReferenceValidation: "NotEvaluated",
    });
    expect(preparation.sourceSnapshotDigest).toBe(seed.database.revisions[0]?.snapshot_digest);
    expect(reader.audits).toEqual([]);
    expect(reader.options.references.nextReference).not.toHaveBeenCalled();
    await reader.finish();
  });
  it("does not default missing or unconfigured service modes", async () => {
    await expect(fixture().store.readServiceModePreparation()).rejects.toThrow();
    const seed = fixture();
    await seed.store.save(seed.command());
    await seed.finish();
    await expect(fixture(seed.database).store.readServiceModePreparation()).rejects.toThrow();
  });
  it("keeps the entire source snapshot COMMIT guard even for unrelated field changes", async () => {
    const seed = fixture();
    const command = seed.command();
    await seed.store.save({
      ...command,
      content: {
        ...command.content,
        enabledServiceModes: { state: "Configured", value: ["Pickup"] },
      },
    });
    await seed.finish();
    const reader = fixture(seed.database);
    await reader.store.readServiceModePreparation();
    const row = seed.database.revisions[0];
    if (!row) throw new Error("saved source revision missing");
    const snapshot = JSON.parse(JSON.stringify(row.snapshot_json));
    snapshot.content.taxConfigurationReference = { state: "Configured", value: id(40) };
    row.snapshot_json = snapshot;
    row.snapshot_digest = hash(canonical(snapshot));
    await expect(reader.finish()).rejects.toThrow();
  });
  it("reads empty current without allocating or certifying a configuration", async () => {
    const f = fixture();
    expect((await f.store.readCurrent()).snapshot).toBeNull();
    expect(f.options.references.nextReference).not.toHaveBeenCalled();
    await f.finish();
    expect(f.sql.some((sql) => sql.startsWith("SET CONSTRAINTS"))).toBe(false);
  });
  it("saves a real partial revision and flushes only its two owning constraints", async () => {
    const f = fixture();
    const result = await f.store.save(f.command());
    expect(result.snapshot?.content.addressReference.state).toBe("Unconfigured");
    expect(f.locks.slice(0, 2)).toEqual([
      `StoreSetupOperation:${id(5)}`,
      `StoreSetupRoot:${id(1)}:${id(2)}:${id(3)}`,
    ]);
    expect(f.audits).toHaveLength(1);
    await f.finish();
    expect(f.sql.filter((sql) => sql.startsWith("SET CONSTRAINTS"))).toEqual([
      "SET CONSTRAINTS rms_store.store_setup_revision_coherence,rms_store.store_setup_operation_coherence IMMEDIATE",
    ]);
  });
  it("another authorized writer resumes stable setup while original receipt remains immutable", async () => {
    const first = fixture();
    const original = await first.store.save(first.command());
    await first.finish();
    const second = fixture(first.database, id(8));
    const saved = await second.store.save(
      second.command(id(9), original.snapshot?.setupDraftReference ?? null, 1),
    );
    await second.finish();
    expect(saved.snapshot?.revision).toBe(2);
    expect(saved.snapshot?.setupDraftReference).toBe(original.snapshot?.setupDraftReference);
    expect(saved.snapshot?.authoredByReference).toBe(id(8));
    const replay = fixture(first.database);
    Object.defineProperty(replay.options, "withCurrentSaveScope", {
      value: async () => {
        throw new Error("must not acquire current base");
      },
    });
    const fresh = createPostgresStoreSetupDraftStore(replay.options);
    expect(await fresh.save(replay.command())).toEqual(original);
    for (const guard of replay.guards) await guard();
    for (const final of replay.finals) final();
    fresh.assertFinalized(replay.tx);
    expect(replay.audits).toHaveLength(0);
    expect(replay.options.references.nextReference).not.toHaveBeenCalled();
  });
  it("wrong original content and Actor cannot reuse immutable committed operation", async () => {
    const first = fixture();
    await first.store.save(first.command());
    await first.finish();
    const changed = fixture(first.database);
    await expect(
      changed.store.save({
        ...changed.command(),
        content: {
          ...changed.command().content,
          timeZone: { state: "Configured", value: "America/Toronto" },
        },
      }),
    ).rejects.toHaveProperty("code", "STORE_SETUP_OPERATION_IDEMPOTENCY_CONFLICT");
    const other = fixture(first.database, id(8));
    await expect(other.store.save(other.command())).rejects.toHaveProperty(
      "code",
      "STORE_SETUP_OPERATION_PERMISSION_DENIED",
    );
  });
  it("genuine absence appends Audit and durable Abandoned, then late Save returns same terminal without revisions", async () => {
    const f = fixture();
    const abandoned = await f.store.resolve(f.resolve());
    expect(abandoned.outcome).toBe("Abandoned");
    await f.finish();
    const late = fixture(f.database);
    expect(await late.store.save(late.command())).toEqual(abandoned);
    await late.finish();
    expect(f.database.revisions).toHaveLength(0);
    expect(late.audits).toHaveLength(0);
  });
  it("hidden foreign global operation collision cannot return Abandoned", async () => {
    const db: Database = { revisions: [], operations: [{ operation_id: id(5), tenant_id: id(9) }] };
    const f = fixture(db);
    await expect(f.store.resolve(f.resolve())).rejects.toHaveProperty(
      "code",
      "STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE",
    );
    await expect(f.finish()).rejects.toThrow();
  });
  it("CAS conflict never appends a new Audit or revision", async () => {
    const f = fixture();
    await expect(f.store.save(f.command(id(6), id(7), 2))).rejects.toHaveProperty(
      "code",
      "STORE_SETUP_OPERATION_VERSION_CONFLICT",
    );
    expect(f.audits).toHaveLength(0);
    expect(f.database.revisions).toHaveLength(0);
  });
  it("requires actual completed async and synchronous guards before exposing finalized lease", async () => {
    const f = fixture();
    await f.store.readCurrent();
    expect(() => f.store.assertFinalized(f.tx)).toThrow();
  });
  it.each(["query", "clock", "authority"] as const)(
    "refuses captured %s replacement and poisons COMMIT",
    async (kind) => {
      const f = fixture();
      await f.store.readCurrent();
      if (kind === "query") f.tx.query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
      if (kind === "clock") f.options.clock.now = () => origin;
      if (kind === "authority")
        f.options.authority.holdUntilTransactionCompletes = async () => ({ validUntil: until });
      await expect(f.finish()).rejects.toThrow();
    },
  );
  it("fresh permission withdrawal and original expiry reject finalization", async () => {
    const f = fixture();
    await f.store.readCurrent();
    vi.mocked(f.options.authority.holdUntilTransactionCompletes).mockRejectedValueOnce(
      new Error("controlled denied"),
    );
    await expect(f.finish()).rejects.toThrow();
    const late = fixture();
    await late.store.readCurrent();
    late.setNow(until);
    await expect(late.finish()).rejects.toThrow();
  });
  it("clock reversal within original window is rejected", async () => {
    const f = fixture();
    f.setNow("2026-10-05T10:00:01.000Z");
    await f.store.readCurrent();
    f.setNow(origin);
    await expect(f.finish()).rejects.toThrow();
  });
  it("refuses nonvoid registration before any owning SQL", async () => {
    const f = fixture();
    Object.defineProperty(f.options, "registerBeforeCommit", {
      value: () => Promise.resolve("not registered"),
    });
    const store = createPostgresStoreSetupDraftStore(f.options);
    await expect(store.readCurrent()).rejects.toThrow();
    expect(f.tx.query).not.toHaveBeenCalled();
  });
  it("Audit failure poisons guard and prevents terminal insertion", async () => {
    const f = fixture();
    Object.defineProperty(f.options, "appendAudit", {
      value: async () => {
        throw new Error("controlled failure");
      },
    });
    const store = createPostgresStoreSetupDraftStore(f.options);
    await expect(store.save(f.command())).rejects.toThrow();
    expect(f.database.operations).toHaveLength(0);
    await expect(f.finish()).rejects.toThrow();
  });
  it("validates actual writer scope and rejects mismatched callback return without a terminal", async () => {
    const f = fixture();
    Object.defineProperty(f.options, "withCurrentSaveScope", {
      value: async (
        _tx: StoreSetupDraftTransaction,
        _request: unknown,
        work: (scope: StoreSetupActualScope) => Promise<unknown>,
      ) =>
        work({
          tenantReference: id(1),
          brandReference: id(2),
          storeReference: id(3),
          actorReference: id(9),
          defaultLocale: "en-CA",
          currencyCode: "CAD",
          baseConfigurationReference: null,
        }),
    });
    const store = createPostgresStoreSetupDraftStore(f.options);
    await expect(store.save(f.command())).rejects.toHaveProperty(
      "code",
      "STORE_SETUP_OPERATION_PERMISSION_DENIED",
    );
    expect(f.database.operations).toHaveLength(0);
    await expect(f.finish()).rejects.toThrow();
  });
  it.each([
    { defaultLocale: "fr-CA", baseConfigurationReference: null },
    { defaultLocale: "en-CA", baseConfigurationReference: id(20) },
  ])(
    "rejects stale authoring baseline as version conflict without new artifacts %j",
    async (changed) => {
      const first = fixture();
      const original = await first.store.save(first.command());
      await first.finish();
      const resumed = fixture(first.database);
      Object.defineProperty(resumed.options, "withCurrentSaveScope", {
        value: async (
          _tx: StoreSetupDraftTransaction,
          _request: unknown,
          work: (scope: StoreSetupActualScope) => Promise<unknown>,
        ) =>
          work({
            tenantReference: id(1),
            brandReference: id(2),
            storeReference: id(3),
            actorReference: id(4),
            currencyCode: "CAD",
            ...changed,
          }),
      });
      const store = createPostgresStoreSetupDraftStore(resumed.options);
      await expect(
        store.save(resumed.command(id(21), original.snapshot?.setupDraftReference ?? null, 1)),
      ).rejects.toHaveProperty("code", "STORE_SETUP_OPERATION_VERSION_CONFLICT");
      expect(resumed.database.revisions).toHaveLength(1);
      expect(resumed.database.operations).toHaveLength(1);
      expect(resumed.audits).toHaveLength(0);
      expect(resumed.options.references.nextReference).not.toHaveBeenCalled();
      await expect(resumed.finish()).rejects.toThrow();
    },
  );
  it("late authority narrowing and whole saved snapshot drift fail the existing final guard", async () => {
    const f = fixture();
    await f.store.save(f.command());
    const row = f.database.revisions[0];
    if (!row) throw new Error("missing controlled revision");
    row.snapshot_json = {
      ...(row.snapshot_json as Record<string, unknown>),
      defaultLocale: "fr-CA",
    };
    await expect(f.finish()).rejects.toThrow();
    const short = fixture();
    await short.store.readCurrent();
    vi.mocked(short.options.authority.holdUntilTransactionCompletes).mockResolvedValueOnce({
      validUntil: origin,
    });
    await expect(short.finish()).rejects.toThrow();
  });
  it("checks query timeouts against shrinking original budget and refuses reentry", async () => {
    const f = fixture();
    f.setNow("2026-10-05T10:00:01.000Z");
    await f.store.readCurrent();
    const timeout = f.tx.query.mock.calls.find(([statement]) => statement.includes("lock_timeout"));
    expect(timeout?.[1]).toEqual(["4000"]);
    await f.finish();
    const nested = fixture();
    Object.defineProperty(nested.options, "withCurrentSaveScope", {
      value: async () => {
        return nestedStore.readCurrent();
      },
    });
    const nestedStore = createPostgresStoreSetupDraftStore(nested.options);
    await expect(nestedStore.save(nested.command())).rejects.toThrow();
    await expect(nested.finish()).rejects.toThrow();
  });
});

describe("Store Setup V2 fee preparation persistence", () => {
  it("saves real V2, reads original preparation and preserves exact V1 terminal replay before downgrade refusal", async () => {
    const seed = fixture();
    const v1 = seed.command();
    const old = await seed.store.save(v1);
    await seed.finish();
    if (!old.snapshot) throw new Error("Missing original snapshot");
    const writer = fixture(seed.database);
    const v2 = parseStoreSetupSaveCommand({
      ...writer.command(id(80), old.snapshot.setupDraftReference, 1),
      profile: "StoreSetupSaveV2",
      content: createUnconfiguredStoreSetupDraftContentV2(),
    });
    const saved = await writer.store.save(v2);
    expect(saved.snapshot?.profile).toBe("StoreSetupDraftV2");
    if (!saved.snapshot) throw new Error("Missing V2 snapshot");
    await writer.finish();
    const replay = fixture(seed.database);
    expect(await replay.store.save(v1)).toEqual(old);
    await replay.finish();
    const reader = fixture(seed.database, id(40));
    const preparation = await reader.store.readFeeContextPreparation();
    expect(preparation.completeness).toBe("Incomplete");
    expect(preparation.sourceRevision).toBe(2);
    const historical = await reader.store.readFeeContextPreparationVersion({
      setupDraftReference: preparation.setupDraftReference,
      sourceRevision: 2,
      sourceSnapshotDigest: preparation.sourceSnapshotDigest,
    });
    expect(historical.preparation).toEqual(preparation);
    expect(historical.readerActorReference).toBe(id(40));
    await reader.finish();
    const downgrade = fixture(seed.database);
    await expect(
      downgrade.store.save(downgrade.command(id(81), saved.snapshot.setupDraftReference, 2)),
    ).rejects.toMatchObject({ code: "STORE_SETUP_OPERATION_VERSION_CONFLICT" });
    expect(downgrade.options.references.nextReference).not.toHaveBeenCalled();
    expect(downgrade.audits).toHaveLength(0);
    expect(seed.database.revisions).toHaveLength(2);
  });
  it("keeps original V2 Resolve independent of today's save scope", async () => {
    const f = fixture();
    const command = parseStoreSetupSaveCommand({
      ...f.command(),
      profile: "StoreSetupSaveV2",
      content: createUnconfiguredStoreSetupDraftContentV2(),
    });
    const saved = await f.store.save(command);
    await f.finish();
    const replay = fixture(f.database);
    expect(await replay.store.save(command)).toEqual(saved);
    expect(replay.options.references.nextReference).not.toHaveBeenCalled();
    expect(replay.audits).toHaveLength(0);
    await replay.finish();
    const recovery = fixture(f.database);
    Object.defineProperty(recovery.options, "withCurrentSaveScope", {
      value: async () => {
        throw new Error("must not reacquire");
      },
    });
    const store = createPostgresStoreSetupDraftStore(recovery.options);
    expect(await store.resolve(recovery.resolve(command))).toEqual(saved);
    for (const guard of recovery.guards) await guard();
    for (const final of recovery.finals) final();
    expect(store.assertFinalized(recovery.tx)).toBe(until);
    expect(recovery.audits).toHaveLength(0);
  });
  it("rejects fee mutation during the same held current source guard", async () => {
    const seed = fixture();
    await seed.store.save({
      ...seed.command(),
      profile: "StoreSetupSaveV2",
      content: createUnconfiguredStoreSetupDraftContentV2(),
    });
    await seed.finish();
    const reader = fixture(seed.database);
    await reader.store.readFeeContextPreparation();
    const row = seed.database.revisions[0];
    if (!row) throw new Error("Missing revision");
    const snapshot = row.snapshot_json;
    if (!snapshot || typeof snapshot !== "object") throw new Error("Missing snapshot");
    Object.defineProperty(snapshot, "content", {
      value: {
        ...createUnconfiguredStoreSetupDraftContentV2(),
        feeContexts: {
          state: "Configured",
          value: [
            { chargeType: "ServiceCharge", state: "Disabled" },
            { chargeType: "DeliveryFee", state: "Disabled" },
            { chargeType: "Tip", state: "Disabled" },
          ],
        },
      },
      enumerable: true,
    });
    await expect(reader.finish()).rejects.toThrow();
  });
});
