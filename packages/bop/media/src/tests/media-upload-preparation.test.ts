import { afterEach, expect, it, vi } from "vitest";
import {
  appendAuditRecordInTransaction,
  auditChainContent,
  computeAuditRecordHash,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  parseMediaUploadStorageCommand,
  mediaUploadStorageIntentDigest,
  type MediaUploadStorageCommand,
} from "../contracts/media-upload-storage.js";
import {
  createPreparedPostgresMediaUploadCommitter,
  createPostgresMediaUnitOfWork,
  type PreparedMediaUploadOperation,
  type MediaPersistenceTransaction,
  type MediaPersistenceAuthorityInput,
  type PostgresMediaUnitOfWorkOptions,
} from "../infrastructure/persistence/media-upload-store.js";

vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const id = (n: number) => "019a2421-0020-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  time = (offset: number) => new Date(Date.parse(at) + offset).toISOString(),
  unavailable = expect.objectContaining({ code: "MEDIA_COMMIT_FAILED" }),
  descriptorDigest = "sha256:" + "d".repeat(64),
  lookup =
    "SELECT command_json AS prepared_command FROM bop_media.operation_record WHERE operation_id=$1";
function fixture() {
  const scope = { kind: "Store", brandReference: id(2), storeReference: id(3) },
    session = {
      uploadSessionId: id(4),
      grantReference: id(5),
      actorReference: id(6),
      purpose: "PRODUCT_IMAGE",
      scope,
      mediaKind: "Image",
      declaredContentType: "image/png",
      declaredByteSize: 1024,
      ownerType: "PRODUCT",
      ownerReference: id(7),
      classification: "Internal",
      state: "Pending",
      version: 1,
      createdAt: at,
      expiresAt: time(900000),
    },
    audit = (final: boolean) => ({
      auditId: id(final ? 12 : 11),
      brandId: id(2),
      storeId: id(3),
      actor: { type: "User", reference: id(6) },
      actionCode: final ? "MEDIA_ASSET_FINALIZED" : "MEDIA_UPLOAD_CREATED",
      reasonCode: final ? "MEDIA_ASSET_FINALIZED" : "MEDIA_UPLOAD_CREATED",
      targetType: final ? "MediaAsset" : "MediaUploadSession",
      targetId: final ? id(8) : id(4),
      correlationId: id(13),
      occurredAt: final ? time(1000) : at,
      sourceChannel: "API",
      dataClassification: "Confidential",
      retentionPolicyCode: "MEDIA_OPERATION_AUDIT",
      retentionPolicyVersion: 1,
    }),
    create = parseMediaUploadStorageCommand({
      tenantReference: id(1),
      scope,
      actorReference: id(6),
      action: "CreateUpload",
      input: { idempotencyKey: id(14), session, audit: audit(false) },
    }),
    finalize = parseMediaUploadStorageCommand({
      tenantReference: id(1),
      scope,
      actorReference: id(6),
      action: "FinalizeAsset",
      input: {
        idempotencyKey: id(15),
        expectedSessionVersion: 1,
        closedSession: { ...session, state: "Finalized", version: 2 },
        asset: {
          assetId: id(8),
          purpose: session.purpose,
          scope,
          mediaKind: "Image",
          ownerType: session.ownerType,
          ownerReference: session.ownerReference,
          classification: "Internal",
          currentVersionReference: null,
          version: 1,
        },
        assetVersion: {
          assetVersionId: id(9),
          assetId: id(8),
          version: 1,
          objectEvidenceReference: id(16),
          providerObjectVersion: id(17),
          byteSize: 1024,
          checksum: "sha256:" + "a".repeat(64),
          contentType: "image/png",
          checkState: "Quarantined",
          readinessState: "Pending",
          createdAt: time(1000),
        },
        audit: audit(true),
      },
    });
  if (create.action !== "CreateUpload" || finalize.action !== "FinalizeAsset")
    throw Error("Invalid synthetic commands");
  return { create, finalize };
}
interface Receipt {
  command: MediaUploadStorageCommand;
  result: unknown;
  recorded_at: string;
  coherent: boolean;
  bindingRequired: boolean;
}
interface Tables {
  sessions: Map<string, unknown>;
  assets: Map<string, unknown>;
  versions: Map<string, unknown>;
  operations: Map<string, Receipt>;
  bindings: Set<string>;
  audits: number;
}
function syntheticAuditResult(input: AppendAuditRecordInput, recordedAt: string) {
  const content = auditChainContent(input),
    previousHash = null,
    sequence = 1;
  return {
    version: "AUDIT_CHAIN_V1" as const,
    sequence,
    previousHash,
    recordedAt,
    content,
    recordHash: computeAuditRecordHash({ content, previousHash, sequence, recordedAt }),
  };
}
// Controlled query/authority/Provider collaborators exercise transaction protocol;
// this is not native SQL, real IAM, a signed upload or a verified S3 object.
function harness() {
  const f = fixture(),
    statements: { sql: string; values: readonly unknown[] }[] = [],
    holders: MediaPersistenceAuthorityInput[] = [],
    guards: { guard: () => Promise<void>; finalAssert: () => void }[] = [];
  const state: {
    clock: string;
    tables: Tables;
    savepoint: Tables | null;
    commits: number;
    providers: number;
    preparations: number;
    persists: number;
    deny: boolean;
    beforeWork?: () => void;
    afterWork?: () => void;
    afterAsync?: () => void;
    beforePrepareReturn?: () => void;
    afterPersist?: () => void;
    hostMode?: "skip" | "async-only" | "final-only" | "unawaited";
    swallow?: boolean;
  } = {
    clock: time(1000),
    tables: {
      sessions: new Map(),
      assets: new Map(),
      versions: new Map(),
      operations: new Map(),
      bindings: new Set(),
      audits: 0,
    },
    savepoint: null,
    commits: 0,
    providers: 0,
    preparations: 0,
    persists: 0,
    deny: false,
  };
  const tx: MediaPersistenceTransaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      statements.push({ sql, values });
      let result: readonly unknown[] = [];
      if (sql === lookup) {
        const row = state.tables.operations.get(String(values[0]));
        result = row ? [{ prepared_command: row.command }] : [];
      } else if (sql.includes("transaction_isolation")) result = [{ isolation: "read committed" }];
      else if (sql.startsWith("SELECT command_json")) {
        const row = state.tables.operations.get(String(values[3]));
        result = row
          ? [
              {
                command: row.command,
                result: row.result,
                recorded_at: row.recorded_at,
                coherent: row.coherent,
              },
            ]
          : [];
      } else if (sql.startsWith("SELECT snapshot_json")) {
        const snapshot = state.tables.sessions.get(String(values[3]));
        result = snapshot ? [{ snapshot, coherent: true }] : [];
      } else if (sql.startsWith("INSERT INTO bop_media.upload_session"))
        state.tables.sessions.set(String(values[0]), JSON.parse(String(values[8])));
      else if (sql.startsWith("UPDATE bop_media.upload_session"))
        state.tables.sessions.set(String(values[0]), JSON.parse(String(values[6])));
      else if (sql.startsWith("INSERT INTO bop_media.asset_version"))
        state.tables.versions.set(String(values[0]), JSON.parse(String(values[8])));
      else if (sql.startsWith("INSERT INTO bop_media.asset("))
        state.tables.assets.set(String(values[0]), JSON.parse(String(values[5])));
      else if (sql.startsWith("INSERT INTO bop_media.operation_record"))
        state.tables.operations.set(String(values[0]), {
          command: parseMediaUploadStorageCommand(JSON.parse(String(values[11]))),
          result: JSON.parse(String(values[12])),
          recorded_at: String(values[10]),
          coherent: true,
          bindingRequired: sql.includes("object_binding_required"),
        });
      else if (sql.startsWith("INSERT INTO bop_media.upload_object_binding"))
        state.tables.bindings.add(String(values[0]));
      else if (sql.startsWith("SAVEPOINT")) state.savepoint = structuredClone(state.tables);
      else if (sql.startsWith("ROLLBACK TO SAVEPOINT")) {
        if (!state.savepoint) throw Error("No synthetic savepoint");
        state.tables = state.savepoint;
      } else if (
        !sql.startsWith("SELECT set_config") &&
        !sql.startsWith("SELECT pg_advisory") &&
        !sql.startsWith("RELEASE SAVEPOINT")
      )
        throw Error("Unexpected synthetic SQL");
      return {
        rows: result as readonly Row[],
        rowCount: sql.startsWith("SELECT") ? result.length : 1,
      };
    },
  };
  vi.mocked(appendAuditRecordInTransaction).mockImplementation(async (_transaction, input) => {
    state.tables.audits++;
    return syntheticAuditResult(input, state.clock);
  });
  const options: PostgresMediaUnitOfWorkOptions = {
    tenantReference: f.create.tenantReference,
    scope: f.create.scope,
    actorReference: f.create.actorReference,
    clock: { now: () => state.clock },
    async registerBeforeCommit(actual, guard, finalAssert) {
      expect(actual).toBe(tx);
      guards.push({ guard, finalAssert });
    },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        expect(actual).toBe(tx);
        holders.push(input);
        if (state.deny) throw Error("Synthetic authority denied");
        return { observedAt: input.observedAt, validUntil: input.validUntil };
      },
    },
    transactions: {
      async run<T>(work: (actual: MediaPersistenceTransaction) => Promise<T>): Promise<T> {
        const before = structuredClone(state.tables);
        guards.length = 0;
        try {
          state.beforeWork?.();
          let result: T;
          try {
            result = await work(tx);
          } catch (error) {
            if (!state.swallow) throw error;
            for (const item of guards) await item.guard();
            throw Error("Poisoned host unexpectedly continued", { cause: error });
          }
          state.afterWork?.();
          if (state.hostMode === "skip") return result;
          if (state.hostMode === "final-only") {
            for (const item of guards) item.finalAssert();
            return result;
          }
          if (state.hostMode === "unawaited") {
            const pending = guards.map((item) => item.guard());
            try {
              for (const item of guards) item.finalAssert();
            } finally {
              await Promise.allSettled(pending);
            }
            return result;
          }
          for (const item of guards) await item.guard();
          if (state.hostMode === "async-only") return result;
          state.afterAsync?.();
          for (const item of guards) item.finalAssert();
          state.commits++;
          return result;
        } catch (error) {
          state.tables = before;
          throw error;
        }
      },
    },
  };
  const commit = createPreparedPostgresMediaUploadCommitter(options);
  const operation = (
    command: MediaUploadStorageCommand = f.create,
  ): PreparedMediaUploadOperation => {
    const session =
      command.action === "CreateUpload" ? command.input.session : command.input.closedSession;
    return {
      action: command.action,
      operationReference: command.input.idempotencyKey,
      purposeCode: session.purpose,
      ownerType: session.ownerType,
      ownerReference: session.ownerReference,
      originalIntentDigest: descriptorDigest,
      async prepare(actual) {
        state.preparations++;
        expect(
          statements.some(
            ({ sql, values }) =>
              sql.startsWith("SELECT pg_advisory") &&
              values[0] === "MediaOperation:" + command.input.idempotencyKey,
          ),
        ).toBe(true);
        const found = await actual.query<{ prepared_command: unknown }>(lookup, [
          command.input.idempotencyKey,
        ]);
        const row = found.rows[0];
        if (row) {
          if (!state.tables.bindings.has(command.input.idempotencyKey))
            throw Error("Missing synthetic original mapping");
          return parseMediaUploadStorageCommand(row.prepared_command);
        }
        state.providers++;
        state.beforePrepareReturn?.();
        return command;
      },
      async persist(actual, parsed, recordedAt) {
        state.persists++;
        expect(Object.isFrozen(actual)).toBe(true);
        expect(Object.isFrozen(parsed)).toBe(true);
        expect(state.tables.operations.get(parsed.input.idempotencyKey)?.bindingRequired).toBe(
          true,
        );
        expect(state.tables.operations.get(parsed.input.idempotencyKey)?.recorded_at).toBe(
          recordedAt,
        );
        await actual.query("INSERT INTO bop_media.upload_object_binding(operation_id) VALUES($1)", [
          parsed.input.idempotencyKey,
        ]);
        state.afterPersist?.();
      },
    };
  };
  return { ...f, commit, operation, tx, options, state, statements, holders, guards };
}

it("locks before Provider preparation and atomically persists required mapping before Audit", async () => {
  const h = harness();
  vi.mocked(appendAuditRecordInTransaction).mockImplementationOnce(async (_transaction, input) => {
    expect(h.state.tables.bindings.has(h.create.input.idempotencyKey)).toBe(true);
    h.state.tables.audits++;
    return syntheticAuditResult(input, h.state.clock);
  });
  const result = await h.commit(h.operation());
  expect(result).toEqual(h.create);
  expect(Object.isFrozen(result)).toBe(true);
  expect(h.state.commits).toBe(1);
  expect(h.state.providers).toBe(1);
  expect(h.state.persists).toBe(1);
  expect(h.holders.every((entry) => entry.originalIntentDigest === descriptorDigest)).toBe(true);
  const insert = h.statements.find(({ sql }) =>
    sql.startsWith("INSERT INTO bop_media.operation_record"),
  );
  expect(insert?.values[6]).toBe(mediaUploadStorageIntentDigest(h.create));
  expect(insert?.values[6]).not.toBe(descriptorDigest);
  expect(h.holders.map((entry) => entry.phase)).toEqual(["Intent", "Apply", "Apply", "Apply"]);
});

it("uses the existing session CAS for prepared finalization and preserves legacy writes", async () => {
  const h = harness();
  await createPostgresMediaUnitOfWork(h.options).commitCreateUpload(h.create.input);
  expect(h.state.tables.operations.get(h.create.input.idempotencyKey)?.bindingRequired).toBe(false);
  const result = await h.commit(h.operation(h.finalize));
  expect(result).toEqual(h.finalize);
  expect(h.state.tables.sessions.get(id(4))).toEqual(h.finalize.input.closedSession);
  expect(h.state.tables.versions.get(id(9))).toEqual(h.finalize.input.assetVersion);
  expect(h.state.tables.operations.get(h.finalize.input.idempotencyKey)?.bindingRequired).toBe(
    true,
  );
});

it("recovers the original command after expiry without Provider work, mapping append or Audit", async () => {
  const h = harness(),
    first = await h.commit(h.operation()),
    before = structuredClone(h.state.tables);
  h.state.clock = time(86400000);
  h.statements.length = 0;
  h.holders.length = 0;
  const second = await h.commit(h.operation());
  expect(second).toEqual(first);
  expect(h.state.tables).toEqual(before);
  expect(h.state.preparations).toBe(2);
  expect(h.state.providers).toBe(1);
  expect(h.state.persists).toBe(1);
  expect(h.holders.map((entry) => entry.phase)).toEqual(["Intent", "Replay", "Replay"]);
  expect(h.statements.some(({ sql }) => /^(INSERT|UPDATE|SELECT snapshot_json)/u.test(sql))).toBe(
    false,
  );
});

it.each([
  "tenant",
  "actor",
  "scope",
  "operation",
  "purpose",
  "owner-type",
  "owner",
  "action",
  "extra",
])("refuses prepared %s retargeting before writes", async (fault) => {
  const h = harness(),
    c = h.create,
    scope = fault === "scope" ? { ...c.scope, storeReference: id(99) } : c.scope,
    actor = fault === "actor" ? id(98) : c.actorReference;
  const raw =
    fault === "action"
      ? h.finalize
      : {
          ...c,
          tenantReference: fault === "tenant" ? id(97) : c.tenantReference,
          actorReference: actor,
          scope,
          ...(fault === "extra" ? { ready: true } : {}),
          input: {
            ...c.input,
            idempotencyKey: fault === "operation" ? id(96) : c.input.idempotencyKey,
            session: {
              ...c.input.session,
              scope,
              actorReference: actor,
              purpose: fault === "purpose" ? "BRAND_IMAGE" : c.input.session.purpose,
              ownerType: fault === "owner-type" ? "BRAND" : c.input.session.ownerType,
              ownerReference: fault === "owner" ? id(95) : c.input.session.ownerReference,
            },
            audit: {
              ...c.input.audit,
              storeId: scope.storeReference,
              actor: { type: "User", reference: actor },
            },
          },
        };
  await expect(
    h.commit({ ...h.operation(), prepare: async () => raw as MediaUploadStorageCommand }),
  ).rejects.toThrow(unavailable);
  expect(h.state.tables.operations.size).toBe(0);
  expect(h.state.persists).toBe(0);
});

it.each(["getter", "digest", "purpose", "extra"])(
  "captures a closed descriptor and poisons invalid %s without Provider work",
  async (fault) => {
    const h = harness(),
      operation = { ...h.operation() },
      getter = vi.fn(() => descriptorDigest);
    h.state.swallow = true;
    if (fault === "getter")
      Object.defineProperty(operation, "originalIntentDigest", { enumerable: true, get: getter });
    if (fault === "digest") operation.originalIntentDigest = "not-a-digest";
    if (fault === "purpose") operation.purposeCode = "invalid";
    const input = fault === "extra" ? { ...operation, clean: true } : operation;
    await expect(h.commit(input)).rejects.toThrow(unavailable);
    expect(getter).not.toHaveBeenCalled();
    expect(h.guards).toHaveLength(1);
    expect(h.statements).toHaveLength(0);
    expect(h.state.providers).toBe(0);
    expect(h.state.commits).toBe(0);
  },
);

it("captures callback functions and descriptor scalars before entering the host transaction", async () => {
  const h = harness(),
    operation = { ...h.operation() };
  h.state.beforeWork = () => {
    operation.operationReference = id(99);
    operation.originalIntentDigest = "sha256:" + "e".repeat(64);
    operation.prepare = async () => {
      throw Error("Replaced callback");
    };
    operation.persist = async () => {
      throw Error("Replaced persistence");
    };
  };
  h.options.authority.holdUntilTransactionCompletes = async () => {
    throw Error("Replaced authority");
  };
  expect(await h.commit(operation)).toEqual(h.create);
  expect(
    h.holders.every(
      (entry) =>
        entry.operationReference === h.create.input.idempotencyKey &&
        entry.originalIntentDigest === descriptorDigest,
    ),
  ).toBe(true);
});

it.each([
  "persist-failure",
  "expired-preparation",
  "expired-persistence",
  "late-denial",
  "final-expiry",
  "query-replaced",
])("rejects and rolls back preparation with %s", async (fault) => {
  const h = harness(),
    operation = h.operation(),
    before = structuredClone(h.state.tables);
  if (fault === "persist-failure")
    h.state.afterPersist = () => {
      throw Error("Private locator write failed");
    };
  if (fault === "expired-preparation")
    h.state.beforePrepareReturn = () => {
      h.state.clock = time(31000);
    };
  if (fault === "expired-persistence")
    h.state.afterPersist = () => {
      h.state.clock = time(31000);
    };
  if (fault === "query-replaced")
    h.state.beforePrepareReturn = () => {
      h.tx.query = async () => ({ rows: [], rowCount: 0 });
    };
  if (fault === "late-denial")
    h.state.afterWork = () => {
      expect(h.state.tables.bindings.size).toBe(1);
      expect(h.state.tables.audits).toBe(1);
      h.state.deny = true;
    };
  if (fault === "final-expiry")
    h.state.afterAsync = () => {
      expect(h.state.tables.bindings.size).toBe(1);
      h.state.clock = time(31000);
    };
  await expect(h.commit(operation)).rejects.toThrow(unavailable);
  expect(h.state.tables).toEqual(before);
  expect(h.state.commits).toBe(0);
  if (fault === "persist-failure" || fault === "expired-persistence")
    expect(
      h.statements.some(({ sql }) => sql === "ROLLBACK TO SAVEPOINT media_upload_storage"),
    ).toBe(true);
});

it("poisons a preparation that catches its own failed query", async () => {
  const h = harness();
  await expect(
    h.commit({
      ...h.operation(),
      prepare: async (tx) => {
        await tx.query("SYNTHETIC_QUERY_FAILURE", []).catch(() => undefined);
        return h.create;
      },
    }),
  ).rejects.toThrow(unavailable);
  expect(h.state.tables.operations.size).toBe(0);
  expect(h.state.persists).toBe(0);
});

it.each(["skip", "async-only", "final-only", "unawaited"] as const)(
  "cannot report success when the host uses %s guards",
  async (hostMode) => {
    const h = harness();
    h.state.hostMode = hostMode;
    await expect(h.commit(h.operation())).rejects.toThrow(unavailable);
    expect(h.state.commits).toBe(0);
  },
);

it("retains the original entry deadline while the host delays transaction entry", async () => {
  const h = harness();
  h.state.beforeWork = () => {
    h.state.clock = time(31000);
  };
  await expect(h.commit(h.operation())).rejects.toThrow(unavailable);
  expect(h.guards).toHaveLength(1);
  expect(h.holders).toHaveLength(0);
  expect(h.state.preparations).toBe(0);
});
