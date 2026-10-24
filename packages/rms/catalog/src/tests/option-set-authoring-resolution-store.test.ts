import { afterEach, expect, it, vi } from "vitest";
import {
  canonicalizeRfc8785,
  sha256Hex,
  appendAuditRecordInTransaction,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { CatalogError, parseCatalogReference, parseCatalogInstant } from "../contracts/product.js";
import {
  parseCatalogOptionSetAuthoringResolutionCommand,
  createCatalogOptionSetAuthoringIdentity,
  type CatalogOptionSetAuthoringIdentity,
  type CatalogOptionSetAuthoringResolution,
} from "../contracts/option-set-authoring-resolution.js";
import { parseCatalogOptionSetEditorContent } from "../contracts/option-set-editor-content.js";
import { parseFullOptionSetEditCommand } from "../contracts/option-set-full-edit.js";
import {
  parseFullOptionSetCreateCommand,
  materializeFullOptionSetCreation,
} from "../contracts/option-set-full-create.js";
import {
  createPostgresOptionSetAuthoringResolutionStore,
  type OptionSetAuthoringResolutionStoreOptions,
} from "../infrastructure/persistence/option-set-authoring-resolution-store.js";
import type { ProductLifecycleTransaction as Transaction } from "../infrastructure/persistence/product-lifecycle-store.js";
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());
const id = (n: number) =>
    parseCatalogReference("01902421-7007-7000-8000-" + n.toString(16).padStart(12, "0")),
  at = parseCatalogInstant("2026-09-30T12:00:00.000Z"),
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function fixture(action: "Create" | "Edit" = "Create") {
  const command = parseCatalogOptionSetAuthoringResolutionCommand({
    profile: "CatalogOptionSetAuthoringResolutionCommandV1",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    action,
    reasonCode: "SYNTHETIC",
    operationReference: id(4),
    optionSetReference: action === "Create" ? null : id(5),
    expectedAggregateVersion: action === "Create" ? null : 7,
  });
  const initial = parseFullOptionSetCreateCommand({
    internalCode: "SYNTHETIC",
    draft: {
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
      localizedDescriptions: {},
      displayStyle: "MultiChoice",
      minimumSelection: 0,
      maximumSelection: 1,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 1,
      options: [],
    },
    additionalContent: {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: [],
      conditionalRules: [],
      conflictRules: [],
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    },
    operationReference: id(4),
    occurredAt: at,
    reasonCode: "SYNTHETIC",
  });
  const full =
      action === "Create"
        ? initial
        : parseFullOptionSetEditCommand({
            optionSetReference: id(5),
            expectedAggregateVersion: 7,
            draft: initial.draft,
            additionalContent: initial.additionalContent,
            archiveOptionReferences: [],
            operationReference: id(4),
            occurredAt: at,
            reasonCode: "SYNTHETIC",
          }),
    created = materializeFullOptionSetCreation(initial, {
      brandReference: id(2),
      actorReference: id(3),
      allocations: { optionSetReference: id(5), versionReference: id(6), options: [] },
    }),
    { sourceAggregate, ...details } = created.content,
    prepared =
      action === "Create"
        ? created
        : parseCatalogOptionSetEditorContent(
            { ...sourceAggregate, aggregateVersion: 8, createdByActorReference: id(9) },
            details,
          );
  const identity = createCatalogOptionSetAuthoringIdentity({
    command,
    sourceOperationReference: id(4),
    optionSetReference: id(5),
    versionReference: id(6),
    aggregateVersion: action === "Create" ? 1 : 8,
    originalOccurredAt: at,
    auditReference: id(7),
    originalIntentDigest: hash({
      profile: action === "Create" ? "CatalogFullOptionSetCreateV1" : "CatalogFullOptionSetEditV1",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      command: full,
    }),
    sourceDigest: prepared.sourceDigest,
    contentDigest: prepared.contentDigest,
    configurationDigest: prepared.configurationDigest,
  });
  const state = {
      time: Date.parse(at),
      deny: false,
      available: true,
      identity: null as CatalogOptionSetAuthoringIdentity | null,
      fence: null as CatalogOptionSetAuthoringResolution | null,
      coherent: true,
      insertCount: 1,
      lateLease: false,
    },
    calls: { sql: string; values: readonly unknown[] }[] = [],
    guards: { guard: () => Promise<void>; final: () => void }[] = [];
  const tx: Transaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      calls.push({ sql, values });
      let found: readonly unknown[] = [];
      if (sql.startsWith("SELECT i.identity_json"))
        found = state.identity
          ? [
              {
                identity_json: state.identity,
                snapshot_json: prepared.content,
                coherent: state.coherent,
              },
            ]
          : [];
      else if (sql.startsWith("SELECT command_json"))
        found = state.fence
          ? [{ command_json: state.fence.command, snapshot_json: state.fence }]
          : [];
      else if (sql.includes("operation_available")) found = [{ available: state.available }];
      else if (sql.startsWith("INSERT INTO rms_catalog.option_set_authoring_identity")) {
        state.identity = JSON.parse(String(values[18]));
        return { rows: [], rowCount: state.insertCount };
      } else if (sql.startsWith("INSERT INTO rms_catalog.option_set_authoring_abandonment")) {
        state.fence = JSON.parse(String(values[9]));
        return { rows: [], rowCount: state.insertCount };
      }
      return { rows: found as readonly Row[], rowCount: found.length };
    },
  };
  const audit: AppendAuditRecordInput = {
    auditId: id(7),
    brandId: id(2),
    actor: { type: "User", reference: id(3) },
    actionCode:
      action === "Create" ? "CATALOG_OPTION_SET_CREATE" : "CATALOG_OPTION_SET_REPLACEDRAFT",
    targetType: "CatalogOptionSet",
    targetId: id(5),
    reasonCode: "SYNTHETIC",
    correlationId: id(4),
    occurredAt: at,
    sourceChannel: "API",
    dataClassification: "Internal",
    retentionPolicyCode: "OPERATIONAL",
    retentionPolicyVersion: 1,
  };
  const hold = vi.fn<
    OptionSetAuthoringResolutionStoreOptions["authority"]["holdUntilTransactionCompletes"]
  >(async (_tx, input) => {
    if (state.deny) throw new Error("controlled denial");
    return {
      observedAt: input.observedAt,
      validUntil: new Date(
        Date.parse(input.observedAt) + (state.lateLease ? 0 : 5000),
      ).toISOString(),
    };
  });
  const options: OptionSetAuthoringResolutionStoreOptions = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => new Date(state.time).toISOString() },
    originalValidUntil: new Date(Date.parse(at) + 5000).toISOString(),
    transactions: {
      run: async (work) => {
        const result = await work(tx);
        for (const entry of guards) await entry.guard();
        for (const entry of guards) entry.final();
        return result;
      },
    },
    registerBeforeCommit: async (_tx, guard, final) => {
      guards.push({ guard, final });
    },
    authority: { holdUntilTransactionCompletes: hold },
    audit: {
      create: (input) => ({
        ...audit,
        actionCode: "CATALOG_OPTION_SET_AUTHORING_ABANDONED",
        targetType: "CatalogOptionSetAuthoringOperation",
        targetId: id(4),
        occurredAt: input.resolution.recordedAt,
      }),
    },
  };
  return {
    command,
    full,
    prepared,
    identity,
    state,
    calls,
    guards,
    tx,
    audit,
    hold,
    options,
    store: createPostgresOptionSetAuthoringResolutionStore(options),
  };
}
it("inspects a first Write without inventing a committed original clock or writing a fence", async () => {
  const f = fixture();
  await f.store.withOriginalOperation(f.tx, f.command, async (original) => {
    expect(original).toEqual({ outcome: "Absent" });
  });
  for (const g of f.guards) await g.guard();
  for (const g of f.guards) g.final();
  expect(f.calls.some((c) => c.sql.startsWith("INSERT"))).toBe(false);
  expect(f.hold.mock.calls[0]?.[1].requiredPermissions).toEqual([
    "catalog.manage",
    "catalog.option_set.create",
  ]);
});
it("records exact same-tx writer metadata from full command and actual Audit, not caller identity/digest", async () => {
  const f = fixture();
  const result = await f.store.recordCommitted(
    f.tx,
    { action: "Create", command: f.full },
    f.prepared.content,
    f.audit,
  );
  expect(result).toEqual(f.identity);
  expect(f.state.identity).toEqual(f.identity);
  for (const g of f.guards) await g.guard();
  for (const g of f.guards) g.final();
  expect(appendAuditRecordInTransaction).not.toHaveBeenCalled();
});
it("supports record inside original host inspection then exact final holds", async () => {
  const f = fixture();
  await f.store.withOriginalOperation(f.tx, f.command, async (original) => {
    expect(original.outcome).toBe("Absent");
    await f.store.recordCommitted(
      f.tx,
      { action: "Create", command: f.full },
      f.prepared.content,
      f.audit,
    );
  });
  for (const g of f.guards) await g.guard();
  for (const g of f.guards) g.final();
  expect(f.state.identity).toEqual(f.identity);
});
it("recovers original metadata/full snapshot without today's root qualification or new Audit", async () => {
  const f = fixture();
  f.state.identity = f.identity;
  const result = await f.store.resolve(f.command);
  expect(result.resolution.identity).toEqual(f.identity);
  expect(result.content).toEqual(f.prepared.content);
  expect(appendAuditRecordInTransaction).not.toHaveBeenCalled();
  expect(f.calls.some((c) => c.sql.includes("FROM rms_catalog.option_set s"))).toBe(false);
  expect(f.hold.mock.calls[0]?.[1].requiredPermissions).toEqual([
    "catalog.manage",
    "catalog.option_set.read",
  ]);
});
it("durably abandons real empty operation once, replaying the original terminal receipt", async () => {
  const f = fixture();
  const first = await f.store.resolve(f.command);
  expect(first.resolution.outcome).toBe("Abandoned");
  expect(first.content).toBeNull();
  expect(appendAuditRecordInTransaction).toHaveBeenCalledTimes(1);
  const second = fixture();
  second.state.fence = first.resolution;
  expect((await second.store.resolve(second.command)).resolution).toEqual(first.resolution);
  expect(appendAuditRecordInTransaction).toHaveBeenCalledTimes(1);
});
it.each(["actorReference", "reasonCode"])(
  "refuses changed original %s without a new terminal receipt",
  async (field) => {
    const f = fixture();
    f.state.identity = f.identity;
    const changed = { ...f.command, [field]: field === "actorReference" ? id(9) : "CHANGED" };
    await expect(f.store.resolve(changed)).rejects.toHaveProperty(
      "code",
      field === "actorReference" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_IDEMPOTENCY_CONFLICT",
    );
    expect(appendAuditRecordInTransaction).not.toHaveBeenCalled();
  },
);
it("refuses hidden foreign or legacy source instead of claiming true absence", async () => {
  const f = fixture();
  f.state.available = false;
  await expect(f.store.resolve(f.command)).rejects.toHaveProperty(
    "code",
    "CATALOG_IDEMPOTENCY_CONFLICT",
  );
  expect(f.state.fence).toBeNull();
  expect(appendAuditRecordInTransaction).not.toHaveBeenCalled();
});
it("refuses source corruption and partial inserts", async () => {
  const f = fixture();
  f.state.identity = f.identity;
  f.state.coherent = false;
  await expect(f.store.resolve(f.command)).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  const partial = fixture();
  partial.state.insertCount = 0;
  await expect(partial.store.resolve(partial.command)).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
});
it("retains original five-second host deadline and late current permission", async () => {
  const f = fixture();
  await f.store.withOriginalOperation(f.tx, f.command, async () => {
    return undefined;
  });
  f.state.deny = true;
  const guard = f.guards[0];
  if (!guard) throw new Error("missing guard");
  await expect(guard.guard()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(() => guard.final()).toThrow();
  const expired = fixture();
  await expired.store.withOriginalOperation(expired.tx, expired.command, async () => {
    return undefined;
  });
  expired.state.time += 5000;
  const expiryGuard = expired.guards[0];
  if (!expiryGuard) throw new Error("missing guard");
  await expect(expiryGuard.guard()).rejects.toThrow();
});
it("rejects zero validity leases, changed query and swallowed reentry", async () => {
  const lease = fixture();
  lease.state.lateLease = true;
  await expect(lease.store.resolve(lease.command)).rejects.toThrow();
  const f = fixture();
  await f.store.withOriginalOperation(f.tx, f.command, async () => {
    return undefined;
  });
  f.tx.query = fixture().tx.query;
  const guard = f.guards[0];
  if (!guard) throw new Error("missing guard");
  await expect(guard.guard()).rejects.toThrow();
  const reenter = fixture();
  await expect(
    reenter.store.withOriginalOperation(reenter.tx, reenter.command, async () => {
      await reenter.store
        .withOriginalOperation(reenter.tx, reenter.command, async () => {
          return undefined;
        })
        .catch(() => undefined);
    }),
  ).rejects.toThrow();
});
it("rejects pending/duplicate async guards and use after host finalization", async () => {
  const f = fixture();
  await f.store.withOriginalOperation(f.tx, f.command, async () => {
    return undefined;
  });
  const guard = f.guards[0];
  if (!guard) throw new Error("missing guard");
  expect(() => guard.final()).toThrow();
  await expect(guard.guard()).rejects.toThrow();
  const ended = fixture();
  await ended.store.withOriginalOperation(ended.tx, ended.command, async () => {
    return undefined;
  });
  const end = ended.guards[0];
  if (!end) throw new Error("missing guard");
  await end.guard();
  end.final();
  await expect(
    ended.store.withOriginalOperation(ended.tx, ended.command, async () => {
      return undefined;
    }),
  ).rejects.toThrow();
  const second = fixture();
  await second.store.withOriginalOperation(second.tx, second.command, async () => {
    return undefined;
  });
  const g = second.guards[0];
  if (!g) throw new Error("missing guard");
  await g.guard();
  await expect(g.guard()).rejects.toThrow();
});
it("rejects writer metadata from wrong Audit Actor/reason/time before INSERT", async () => {
  for (const changed of [
    { actor: { type: "User" as const, reference: id(9) } },
    { reasonCode: "CHANGED" },
    { occurredAt: "2026-10-05T12:00:01.000Z" },
  ]) {
    const f = fixture();
    await expect(
      f.store.recordCommitted(f.tx, { action: "Create", command: f.full }, f.prepared.content, {
        ...f.audit,
        ...changed,
      }),
    ).rejects.toThrow();
    expect(f.state.identity).toBeNull();
  }
});

it("poisons unexpected guard registration results before any source callback/write", async () => {
  const f = fixture(),
    options = { ...f.options };
  Object.defineProperty(options, "registerBeforeCommit", { value: async () => 123 });
  const store = createPostgresOptionSetAuthoringResolutionStore(options),
    work = vi.fn(async () => {
      return undefined;
    });
  await expect(store.withOriginalOperation(f.tx, f.command, work)).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  expect(work).not.toHaveBeenCalled();
  expect(f.state.identity).toBeNull();
  expect(f.state.fence).toBeNull();
});

it("records and resolves Edit author/reason/root from original identity instead of the original Create Actor", async () => {
  const f = fixture("Edit");
  const result = await f.store.recordCommitted(
    f.tx,
    { action: "Edit", command: f.full },
    f.prepared.content,
    f.audit,
  );
  expect(result.command.actorReference).toBe(id(3));
  expect(result.command.expectedAggregateVersion).toBe(7);
  expect(result.aggregateVersion).toBe(8);
  expect(f.prepared.content.sourceAggregate.createdByActorReference).toBe(id(9));
  expect(f.hold.mock.calls[0]?.[1].requiredPermissions).toEqual([
    "catalog.manage",
    "catalog.option_set.update",
  ]);
  for (const g of f.guards) await g.guard();
  for (const g of f.guards) g.final();
  const recovery = fixture("Edit");
  recovery.state.identity = result;
  const receipt = await recovery.store.resolve(recovery.command);
  expect(receipt.resolution.identity).toEqual(result);
  expect(receipt.content).toEqual(f.prepared.content);
  const wrong = fixture("Edit");
  wrong.state.identity = result;
  await expect(
    wrong.store.resolve({ ...wrong.command, expectedAggregateVersion: 6 }),
  ).rejects.toHaveProperty("code", "CATALOG_IDEMPOTENCY_CONFLICT");
});

it("refuses an owning runner that returns a receipt without executing registered final guards", async () => {
  const f = fixture(),
    options = {
      ...f.options,
      transactions: { run: async <T>(work: (tx: Transaction) => Promise<T>) => work(f.tx) },
    };
  f.state.identity = f.identity;
  await expect(
    createPostgresOptionSetAuthoringResolutionStore(options).resolve(f.command),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
it("retains resolution on the caller's original transaction until its host guards complete", async () => {
  const f = fixture();
  f.state.identity = f.identity;
  const result = await f.store.resolveInTransaction(f.tx, f.command);
  expect(result.resolution.identity).toEqual(f.identity);
  for (const g of f.guards) await g.guard();
  for (const g of f.guards) g.final();
});

it("preserves actual Catalog permission denial at the final guard and sanitizes unknown failures", async () => {
  const denied = fixture();
  await denied.store.withOriginalOperation(denied.tx, denied.command, async () => {
    return undefined;
  });
  denied.hold.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  const guard = denied.guards[0];
  if (!guard) throw new Error("missing guard");
  await expect(guard.guard()).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(() => guard.final()).toThrow();
  const unknown = fixture();
  await unknown.store.withOriginalOperation(unknown.tx, unknown.command, async () => {
    return undefined;
  });
  unknown.hold.mockRejectedValue(new Error("unrestricted dependency error"));
  const other = unknown.guards[0];
  if (!other) throw new Error("missing guard");
  await expect(other.guard()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    message: "catalog is unavailable",
  });
});
