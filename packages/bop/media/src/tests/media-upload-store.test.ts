import { afterEach, expect, it, vi } from "vitest";
import { appendAuditRecordInTransaction } from "@bop/audit";
import {
  parseMediaUploadStorageCommand,
  type MediaUploadStorageCommand,
} from "../contracts/media-upload-storage.js";
import { parseMediaIdempotencyKey, parseUploadGrantReference } from "../contracts/media.js";
import {
  createPostgresMediaUnitOfWork,
  mediaPersistenceRequiredFields,
  type MediaPersistenceAuthorityInput,
  type MediaPersistenceTransaction,
  type PostgresMediaUnitOfWorkOptions,
} from "../infrastructure/persistence/media-upload-store.js";
vi.mock("@bop/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const id = (n: number) => "019a2421-0017-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  later = "2026-10-03T12:00:01.000Z",
  time = (ms: number) => new Date(Date.parse(at) + ms).toISOString(),
  unavailable = expect.objectContaining({ code: "MEDIA_COMMIT_FAILED" });
function fixture(store: string | null = id(3)) {
  const scope = {
      kind: store === null ? "Brand" : "Store",
      brandReference: id(2),
      storeReference: store,
    },
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
      ...(store === null ? {} : { storeId: store }),
      actor: { type: "User", reference: id(6) },
      actionCode: final ? "MEDIA_ASSET_FINALIZED" : "MEDIA_UPLOAD_CREATED",
      reasonCode: final ? "MEDIA_ASSET_FINALIZED" : "MEDIA_UPLOAD_CREATED",
      targetType: final ? "MediaAsset" : "MediaUploadSession",
      targetId: final ? id(8) : id(4),
      correlationId: id(13),
      occurredAt: final ? later : at,
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
          purpose: "PRODUCT_IMAGE",
          scope,
          mediaKind: "Image",
          ownerType: "PRODUCT",
          ownerReference: id(7),
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
          createdAt: later,
        },
        audit: audit(true),
      },
    });
  if (create.action !== "CreateUpload" || finalize.action !== "FinalizeAsset")
    throw Error("Invalid synthetic fixture");
  return { create, finalize };
}
interface Receipt {
  command: unknown;
  result: unknown;
  recorded_at: string;
  coherent: boolean;
}
interface Tables {
  sessions: Map<string, unknown>;
  assets: Map<string, unknown>;
  versions: Map<string, unknown>;
  operations: Map<string, Receipt>;
}
// Controlled SQL rows and host clocks isolate the owning store. Real PostgreSQL
// uniqueness/RLS/deferred provenance and atomic Audit are separate native evidence.
function harness(storeReference: string | null = id(3)) {
  const f = fixture(storeReference),
    statements: string[] = [],
    holders: MediaPersistenceAuthorityInput[] = [],
    guards: { guard: () => Promise<void>; finalAssert: () => void }[] = [];
  const state: {
    clock: string;
    tables: Tables;
    savepoint: Tables | null;
    commits: number;
    deny: boolean;
    failInsert: boolean;
    coherent: boolean;
    swallow: boolean;
    shortLease: boolean;
    hostMode?: "skip" | "async-only" | "final-only" | "unawaited";
    beforeWork?: () => void;
    onRegister?: () => void;
    afterWork?: () => void;
    afterAsync?: () => void;
    onHold?: () => Promise<void>;
  } = {
    clock: later,
    tables: { sessions: new Map(), assets: new Map(), versions: new Map(), operations: new Map() },
    savepoint: null,
    commits: 0,
    deny: false,
    failInsert: false,
    coherent: true,
    swallow: false,
    shortLease: false,
  };
  const tx: MediaPersistenceTransaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      statements.push(sql);
      let result: readonly unknown[] = [],
        rowCount = 1;
      if (sql.includes("transaction_isolation")) result = [{ isolation: "read committed" }];
      else if (sql.startsWith("SELECT command_json")) {
        const row = state.tables.operations.get(String(values[3]));
        result = row ? [{ ...row, coherent: state.coherent && row.coherent }] : [];
      } else if (sql.startsWith("SELECT snapshot_json")) {
        const snapshot = state.tables.sessions.get(String(values[3]));
        result = snapshot ? [{ snapshot, coherent: state.coherent }] : [];
      } else if (sql.startsWith("INSERT INTO bop_media.upload_session")) {
        if (state.tables.sessions.has(String(values[0]))) throw Error("Controlled duplicate");
        state.tables.sessions.set(String(values[0]), JSON.parse(String(values[8])));
      } else if (sql.startsWith("UPDATE bop_media.upload_session")) {
        state.tables.sessions.set(String(values[0]), JSON.parse(String(values[6])));
      } else if (sql.startsWith("INSERT INTO bop_media.asset_version"))
        state.tables.versions.set(String(values[0]), JSON.parse(String(values[8])));
      else if (sql.startsWith("INSERT INTO bop_media.asset("))
        state.tables.assets.set(String(values[0]), JSON.parse(String(values[5])));
      else if (sql.startsWith("INSERT INTO bop_media.operation_record")) {
        if (state.tables.operations.has(String(values[0])) || state.failInsert)
          throw Error("Controlled operation conflict");
        state.tables.operations.set(String(values[0]), {
          command: JSON.parse(String(values[11])),
          result: JSON.parse(String(values[12])),
          recorded_at: String(values[10]),
          coherent: true,
        });
      } else if (sql.startsWith("SAVEPOINT")) state.savepoint = structuredClone(state.tables);
      else if (sql.startsWith("ROLLBACK TO SAVEPOINT")) {
        if (!state.savepoint) throw Error("Missing controlled savepoint");
        state.tables = state.savepoint;
      } else if (
        !sql.startsWith("SELECT set_config") &&
        !sql.startsWith("SELECT pg_advisory") &&
        !sql.startsWith("RELEASE SAVEPOINT")
      )
        throw Error("Unexpected controlled SQL");
      if (sql.startsWith("SELECT")) rowCount = result.length;
      return { rows: result as readonly Row[], rowCount };
    },
  };
  const options: PostgresMediaUnitOfWorkOptions = {
    tenantReference: f.create.tenantReference,
    scope: f.create.scope,
    actorReference: f.create.actorReference,
    clock: { now: () => state.clock },
    async registerBeforeCommit(actual, guard, finalAssert) {
      expect(actual).toBe(tx);
      guards.push({ guard, finalAssert });
      state.onRegister?.();
    },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        expect(actual).toBe(tx);
        expect(Object.isFrozen(input)).toBe(true);
        holders.push(input);
        expect(input.requiredFields).toBe(mediaPersistenceRequiredFields);
        expect(input.actorKind).toBe("User");
        expect(input.purposeCode).toBe("PRODUCT_IMAGE");
        if (state.onHold) await state.onHold();
        if (state.deny) throw Error("Controlled authority denial");
        const short = new Date(Date.parse(input.observedAt) + 2000).toISOString();
        return {
          observedAt: input.observedAt,
          validUntil: state.shortLease && short < input.validUntil ? short : input.validUntil,
        };
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
            throw Error("Caught work failure escaped its original guard", { cause: error });
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
  const unit = createPostgresMediaUnitOfWork(options);
  return { ...f, unit, tx, options, state, statements, holders, guards };
}
it.each([id(3), null])(
  "atomically persists exact %s-scope metadata and only quarantine finalization",
  async (store) => {
    const h = harness(store);
    await h.unit.commitCreateUpload(h.create.input);
    await h.unit.commitFinalizeAsset(h.finalize.input);
    expect(h.state.tables.sessions.get(id(4))).toEqual(h.finalize.input.closedSession);
    expect(h.state.tables.assets.get(id(8))).toEqual(h.finalize.input.asset);
    expect(h.state.tables.versions.get(id(9))).toEqual(h.finalize.input.assetVersion);
    expect(h.state.tables.operations.get(id(14))?.result).toEqual({
      session: h.create.input.session,
    });
    expect(h.state.tables.operations.get(id(15))?.result).toEqual({
      session: h.finalize.input.closedSession,
      asset: h.finalize.input.asset,
      assetVersion: h.finalize.input.assetVersion,
    });
    expect(appendAuditRecordInTransaction).toHaveBeenCalledTimes(2);
    expect(h.state.commits).toBe(2);
    expect(h.holders.map((entry) => entry.phase)).toContain("Apply");
    expect(h.statements.some((sql) => /outbox|UPDATE bop_media.asset/.test(sql))).toBe(false);
  },
);
it("replays both immutable operations after session expiry without consulting today's state or appending Audit", async () => {
  const h = harness();
  await h.unit.commitCreateUpload(h.create.input);
  await h.unit.commitFinalizeAsset(h.finalize.input);
  const original = structuredClone(h.state.tables);
  h.statements.length = 0;
  h.holders.length = 0;
  h.state.clock = time(86400000);
  vi.mocked(appendAuditRecordInTransaction).mockClear();
  await h.unit.commitCreateUpload(h.create.input);
  await h.unit.commitFinalizeAsset(h.finalize.input);
  expect(h.state.tables).toEqual(original);
  expect(
    h.statements.some(
      (sql) =>
        sql.startsWith("SELECT snapshot_json") ||
        sql.startsWith("INSERT") ||
        sql.startsWith("UPDATE"),
    ),
  ).toBe(false);
  expect(h.holders.map((entry) => entry.phase)).toEqual([
    "Intent",
    "Replay",
    "Replay",
    "Intent",
    "Replay",
    "Replay",
  ]);
  expect(appendAuditRecordInTransaction).not.toHaveBeenCalled();
});
it.each(["changed-intent", "corrupt-result", "corrupt-metadata", "denied"])(
  "does not accept original replay with %s",
  async (fault) => {
    const h = harness();
    await h.unit.commitCreateUpload(h.create.input);
    const row = h.state.tables.operations.get(id(14));
    if (!row) throw Error("Missing receipt");
    if (fault === "corrupt-result") row.result = { session: h.finalize.input.closedSession };
    if (fault === "corrupt-metadata") h.state.coherent = false;
    if (fault === "denied") h.state.deny = true;
    const input =
      fault === "changed-intent"
        ? { ...h.create.input, audit: { ...h.create.input.audit, correlationId: id(99) } }
        : h.create.input;
    await expect(h.unit.commitCreateUpload(input)).rejects.toThrow(unavailable);
    expect(h.state.commits).toBe(1);
  },
);
it.each(["missing", "grant-changed", "already-finalized"])(
  "requires the exact persisted Pending session for %s",
  async (fault) => {
    const h = harness();
    if (fault !== "missing") await h.unit.commitCreateUpload(h.create.input);
    if (fault === "already-finalized") await h.unit.commitFinalizeAsset(h.finalize.input);
    const before = structuredClone(h.state.tables),
      input =
        fault === "grant-changed"
          ? {
              ...h.finalize.input,
              closedSession: {
                ...h.finalize.input.closedSession,
                grantReference: parseUploadGrantReference(id(99)),
              },
            }
          : fault === "already-finalized"
            ? {
                ...h.finalize.input,
                idempotencyKey: parseMediaIdempotencyKey(id(97)),
                audit: { ...h.finalize.input.audit, auditId: id(98) },
              }
            : h.finalize.input;
    await expect(h.unit.commitFinalizeAsset(input)).rejects.toThrow(unavailable);
    expect(h.state.tables).toEqual(before);
  },
);
it.each(["clean", "ready", "current-pointer", "scope", "audit", "unexpected-field"])(
  "refuses caller-supplied %s before any mutation",
  async (fault) => {
    const h = harness(),
      input: unknown = {
        ...h.finalize.input,
        ...(fault === "unexpected-field" ? { ready: true } : {}),
        asset: {
          ...h.finalize.input.asset,
          ...(fault === "current-pointer" ? { currentVersionReference: id(9) } : {}),
          ...(fault === "scope"
            ? { scope: { ...h.finalize.input.asset.scope, storeReference: id(99) } }
            : {}),
        },
        assetVersion: {
          ...h.finalize.input.assetVersion,
          ...(fault === "clean" ? { checkState: "Clean" } : {}),
          ...(fault === "ready" ? { readinessState: "Ready" } : {}),
        },
        audit: {
          ...h.finalize.input.audit,
          ...(fault === "audit" ? { actor: { type: "System" } } : {}),
        },
      };
    // The public boundary receives unknown transport/adapter data at runtime.
    await expect(h.unit.commitFinalizeAsset(input as typeof h.finalize.input)).rejects.toThrow(
      unavailable,
    );
    expect(h.guards).toHaveLength(1);
    expect(h.state.tables.operations.size).toBe(0);
    expect(h.statements).toHaveLength(0);
  },
);
it.each([
  "expired-session",
  "late-denial",
  "original-authority-expired",
  "query-replaced",
  "audit-failure",
  "operation-failure",
])("rolls back all finalization state on %s", async (fault) => {
  const h = harness();
  await h.unit.commitCreateUpload(h.create.input);
  const before = structuredClone(h.state.tables);
  if (fault === "expired-session") h.state.clock = time(900000);
  if (fault === "late-denial")
    h.state.afterWork = () => {
      h.state.deny = true;
    };
  if (fault === "original-authority-expired") {
    h.state.shortLease = true;
    h.state.afterAsync = () => {
      h.state.clock = time(3000);
    };
  }
  if (fault === "query-replaced")
    h.state.afterWork = () => {
      h.tx.query = async () => ({ rows: [], rowCount: 0 });
    };
  if (fault === "audit-failure")
    vi.mocked(appendAuditRecordInTransaction).mockImplementationOnce(async () => {
      expect(h.state.tables.sessions.get(id(4))).toEqual(h.finalize.input.closedSession);
      expect(h.state.tables.versions.size).toBe(1);
      throw Error("Controlled actual Audit append failure");
    });
  if (fault === "operation-failure") h.state.failInsert = true;
  await expect(h.unit.commitFinalizeAsset(h.finalize.input)).rejects.toThrow(unavailable);
  expect(h.state.tables).toEqual(before);
  expect(h.state.commits).toBe(1);
  if (fault === "audit-failure" || fault === "operation-failure")
    expect(h.statements).toContain("ROLLBACK TO SAVEPOINT media_upload_storage");
});
it("captures detached original input and configured ports before the transaction await", async () => {
  const h = harness(),
    input = { ...h.create.input, audit: { ...h.create.input.audit } };
  h.options.clock.now = () => {
    throw Error("Replaced clock");
  };
  h.options.authority.holdUntilTransactionCompletes = async () => {
    throw Error("Replaced authority");
  };
  h.state.onHold = async () => {
    input.audit.correlationId = id(99);
  };
  await h.unit.commitCreateUpload(input);
  expect(h.state.tables.operations.get(id(14))?.command).toEqual(h.create);
});
it("does not invoke input accessors and poisons a host that catches malformed input", async () => {
  const h = harness(),
    getter = vi.fn(() => h.create.input.session);
  h.state.swallow = true;
  const input = { ...h.create.input };
  Object.defineProperty(input, "session", { enumerable: true, get: getter });
  await expect(h.unit.commitCreateUpload(input)).rejects.toThrow(unavailable);
  expect(getter).not.toHaveBeenCalled();
  expect(h.guards).toHaveLength(1);
  expect(h.state.commits).toBe(0);
});
it("poisons caught same-transaction reentry instead of allowing the outer mutation", async () => {
  const h = harness();
  let entered = false;
  h.state.onHold = async () => {
    if (entered) return;
    entered = true;
    await expect(h.unit.commitCreateUpload(h.create.input)).rejects.toThrow(unavailable);
  };
  await expect(h.unit.commitCreateUpload(h.create.input)).rejects.toThrow(unavailable);
  expect(h.state.tables.operations.size).toBe(0);
  expect(h.state.commits).toBe(0);
});
it("rejects a backwards clock permanently even after the clock is restored", async () => {
  const h = harness();
  h.state.onHold = async () => {
    h.state.clock = at;
  };
  await expect(h.unit.commitCreateUpload(h.create.input)).rejects.toThrow(unavailable);
  h.state.clock = later;
  delete h.state.onHold;
  await expect(h.unit.commitCreateUpload(h.create.input)).rejects.toThrow(unavailable);
  expect(h.state.tables.operations.size).toBe(0);
});
it.each(["skip", "async-only", "final-only", "unawaited"] as const)(
  "refuses a host that uses the %s guard protocol",
  async (hostMode) => {
    const h = harness();
    h.state.hostMode = hostMode;
    await expect(h.unit.commitCreateUpload(h.create.input)).rejects.toThrow(unavailable);
    // A deliberately invalid host cannot make this store report commit success.
    // Unawaited authorization also poisons its outstanding asynchronous completion.
    expect(h.state.commits).toBe(0);
  },
);
it.each(["transaction", "registration"])(
  "does not reopen the original 30-second lease after slow %s entry",
  async (point) => {
    const h = harness(),
      delay = () => {
        h.state.clock = time(31000);
      };
    if (point === "transaction") h.state.beforeWork = delay;
    else h.state.onRegister = delay;
    await expect(h.unit.commitCreateUpload(h.create.input)).rejects.toThrow(unavailable);
    expect(h.guards).toHaveLength(1);
    expect(h.holders).toHaveLength(0);
    expect(h.state.tables.operations.size).toBe(0);
    expect(h.state.commits).toBe(0);
  },
);
it("the persistence parser keeps its metadata contracts closed and never mutates the input", () => {
  const f = fixture(),
    raw = structuredClone(f.finalize),
    before = structuredClone(raw);
  const parsed: MediaUploadStorageCommand = parseMediaUploadStorageCommand(raw);
  expect(raw).toEqual(before);
  expect(Object.isFrozen(parsed.input.audit)).toBe(true);
  expect(() =>
    parseMediaUploadStorageCommand({
      ...raw,
      input: { ...raw.input, audit: { ...raw.input.audit, beforeSummary: {} } },
    }),
  ).toThrow();
  expect(() =>
    parseMediaUploadStorageCommand({
      ...raw,
      input: { ...raw.input, audit: { ...raw.input.audit, sourceChannel: ["API"] } },
    }),
  ).toThrow();
  expect(() =>
    parseMediaUploadStorageCommand({
      ...raw,
      input: {
        ...raw.input,
        expectedSessionVersion: 2,
        closedSession: { ...raw.input.closedSession, version: 3 },
      },
    }),
  ).toThrow();
  expect(
    parseMediaUploadStorageCommand({
      ...raw,
      input: { ...raw.input, audit: { ...raw.input.audit, sourceChannel: "A".repeat(128) } },
    }).input.audit.sourceChannel,
  ).toHaveLength(128);
});
