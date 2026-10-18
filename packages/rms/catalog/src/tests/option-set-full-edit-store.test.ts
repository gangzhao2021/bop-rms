import { expect, it, vi } from "vitest";
import { materializeFullOptionSetCreation } from "../contracts/option-set-full-create.js";
import { parseCatalogInstant, CatalogError } from "../contracts/product.js";
import { parseCatalogOption, parseOptionSetDraft } from "../contracts/option-set.js";
import {
  createPostgresFullOptionSetDraftStore,
  type FullOptionSetEditAuthority,
} from "../infrastructure/persistence/option-set-full-draft-store.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";
vi.mock("@bop/audit", async () => ({
  ...(await vi.importActual<typeof import("@bop/audit")>("@bop/audit")),
  appendAuditRecordInTransaction: vi.fn(async () => undefined),
}));
vi.mock("@bop/eventing", () => ({ appendEventInTransaction: vi.fn(async () => undefined) }));
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const initialAt = "2026-10-04T00:00:00.000Z",
  at = "2026-10-04T00:00:01.000Z";
function fixture() {
  const additional = {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: [
      {
        stableCode: "OLD",
        quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
        media: null,
        pricingRule: null,
        consumption: {
          kind: "Inventory",
          reference: id(60),
          versionReference: id(61),
          quantity: "1",
          unitCode: "GRAM",
        },
        triggeredOptionSetVersionReference: null,
      },
    ],
    conditionalRules: [],
    conflictRules: [],
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: {
        instant: initialAt,
        localDateTime: initialAt.slice(0, 23),
        utcOffsetMinutes: 0,
      },
      effectiveUntil: null,
    },
  };
  const core = {
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic choices" },
    localizedDescriptions: {},
    displayStyle: "MultiChoice",
    minimumSelection: 0,
    maximumSelection: 2,
    allowRepeatedOption: false,
    perOptionMaximumQuantity: 1,
    maximumTotalQuantity: 2,
  };
  const option = {
    stableCode: "OLD",
    lifecycle: "Active",
    localizedNames: { "en-CA": "Synthetic old" },
    localizedDescriptions: {},
    sortOrder: 0,
    defaultEligible: true,
    triggeredOptionSetReference: null,
    conflictOptionCodes: [],
  };
  const original = materializeFullOptionSetCreation(
    {
      internalCode: "CHOICES",
      draft: { ...core, options: [option] },
      additionalContent: additional,
      operationReference: id(30),
      occurredAt: initialAt,
      reasonCode: "INITIAL_CONFIGURATION",
    },
    {
      brandReference: id(10),
      actorReference: id(40),
      allocations: {
        optionSetReference: id(1),
        versionReference: id(2),
        options: [{ stableCode: "OLD", optionReference: id(3) }],
      },
    },
  );
  const command = {
    optionSetReference: id(1),
    expectedAggregateVersion: 1,
    draft: {
      ...core,
      options: [
        {
          ...option,
          stableCode: "NEW",
          localizedNames: { "en-CA": "Synthetic new" },
          defaultEligible: false,
          identity: { kind: "New" },
        },
      ],
    },
    additionalContent: {
      ...additional,
      optionDetails: [
        {
          stableCode: "NEW",
          quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
          media: null,
          pricingRule: null,
          consumption: null,
          triggeredOptionSetVersionReference: null,
        },
      ],
    },
    archiveOptionReferences: [id(3)],
    operationReference: id(31),
    occurredAt: at,
    reasonCode: "CONFIGURATION_EDIT",
  };
  const allocation = [{ stableCode: "NEW", optionReference: id(4) }];
  return { original, command, allocation };
}

interface StoredRow {
  snapshot: unknown;
  source_digest: string;
  content_digest: string;
  configuration_digest: string;
  intent_digest: string;
  coherent: boolean;
}
function ownerFixture() {
  const f = fixture();
  let current = structuredClone(f.original.content.sourceAggregate),
    additional: unknown = (() => {
      const { sourceAggregate, ...details } = f.original.content;
      void sourceAggregate;
      return details;
    })();
  const baseline: StoredRow = {
    snapshot: f.original.content,
    source_digest: f.original.sourceDigest,
    content_digest: f.original.contentDigest,
    configuration_digest: f.original.configurationDigest,
    intent_digest: "sha256:" + "a".repeat(64),
    coherent: true,
  };
  const snapshots = new Map<number, StoredRow>([[1, baseline]]),
    operations = new Map<string, StoredRow>(),
    identities = new Map<string, unknown>();
  let available = true,
    failIdentity = false;
  let now = at,
    allowed = true,
    autoGuard = true,
    repeatGuard = false,
    swallowGuard = false,
    beforeCommit: (() => void) | undefined;
  let guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [];
  const calls: Parameters<FullOptionSetEditAuthority["holdUntilTransactionCompletes"]>[1][] = [],
    sqls: string[] = [];
  const allocate = vi.fn(() => id(4));
  const editAuthority: FullOptionSetEditAuthority = {
    async holdUntilTransactionCompletes(actual, input) {
      expect(actual).toBe(tx);
      calls.push(input);
      if (!allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return {
        observedAt: input.observedAt,
        validUntil: new Date(Date.parse(input.observedAt) + 5000).toISOString(),
      };
    },
  };
  const tx: ProductLifecycleTransaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      sqls.push(sql);
      let rows: unknown[] = [],
        rowCount = 0;
      if (sql.includes("option_set_authoring_operation_available")) rows = [{ available }];
      else if (sql.includes("FROM rms_catalog.option_set_authoring_identity")) {
        const identity = identities.get(String(values[2]));
        const source = operations.get(String(values[2]));
        if (identity && source)
          rows = [{ identity_json: identity, snapshot_json: source.snapshot, coherent: true }];
      } else if (sql.startsWith("INSERT INTO rms_catalog.option_set_authoring_identity")) {
        if (failIdentity) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        identities.set(String(values[0]), JSON.parse(String(values[18])));
        rowCount = 1;
      } else if (sql.includes("transaction_isolation")) rows = [{ isolation: "read committed" }];
      else if (sql.includes("FROM rms_catalog.option_set_draft_content_snapshot f JOIN")) {
        const row = snapshots.get(Number(values[3]));
        if (row) rows = [row];
      } else if (sql.includes("FROM rms_catalog.option_set_operation_record o JOIN")) {
        const row = operations.get(String(values[2]));
        if (row) rows = [row];
      } else if (sql.startsWith("SELECT jsonb_build_object"))
        rows = [{ aggregate: current, details: additional, coherent: true }];
      else if (sql.startsWith("SELECT (SELECT count"))
        rows = [{ n: String(current.draft.options.length), conflicts: "0" }];
      else if (sql.startsWith("SELECT option_set_id")) rows = [{}];
      else if (sql.startsWith("UPDATE rms_catalog.option_set SET")) {
        if (current.aggregateVersion === values[2]) {
          current = {
            ...current,
            aggregateVersion: current.aggregateVersion + 1,
            updatedAt: parseCatalogInstant(values[3]),
          };
          rowCount = 1;
        }
      } else if (sql.startsWith("UPDATE rms_catalog.option_set_version")) {
        current = {
          ...current,
          draft: parseOptionSetDraft({
            ...current.draft,
            defaultLocale: values[3],
            localizedNames: JSON.parse(String(values[4])),
            localizedDescriptions: JSON.parse(String(values[5])),
            displayStyle: values[6],
            minimumSelection: values[7],
            maximumSelection: values[8],
            allowRepeatedOption: values[9],
            perOptionMaximumQuantity: values[10],
            maximumTotalQuantity: values[11],
            updatedAt: values[12],
          }),
        };
        additional = JSON.parse(String(values[13]));
        rowCount = 1;
      } else if (sql.startsWith("UPDATE rms_catalog.option SET")) {
        current = {
          ...current,
          draft: {
            ...current.draft,
            options: current.draft.options
              .map((option) => {
                if (option.optionReference !== values[0]) return option;
                rowCount = 1;
                return parseCatalogOption(
                  sql.includes("SET sort_order")
                    ? { ...option, sortOrder: values[3] }
                    : {
                        ...option,
                        lifecycle: values[3],
                        localizedNames: JSON.parse(String(values[4])),
                        localizedDescriptions: JSON.parse(String(values[5])),
                        sortOrder: values[6],
                        defaultEligible: values[7],
                        triggeredOptionSetReference: values[8],
                      },
                );
              })
              .sort((a, b) => a.sortOrder - b.sortOrder),
          },
        };
      } else if (sql.startsWith("INSERT INTO rms_catalog.option(")) {
        const option = parseCatalogOption({
          optionReference: values[0],
          optionSetReference: values[1],
          brandReference: values[3],
          stableCode: values[4],
          lifecycle: values[5],
          localizedNames: JSON.parse(String(values[6])),
          localizedDescriptions: JSON.parse(String(values[7])),
          sortOrder: values[8],
          defaultEligible: values[9],
          triggeredOptionSetReference: values[10],
          createdAt: values[11],
          createdByActorReference: values[12],
          conflictOptionReferences: [],
        });
        current = {
          ...current,
          draft: {
            ...current.draft,
            options: [...current.draft.options, option].sort((a, b) => a.sortOrder - b.sortOrder),
          },
        };
        rowCount = 1;
      } else if (sql.startsWith("DELETE FROM rms_catalog.option_conflict")) rowCount = 0;
      else if (sql.startsWith("INSERT INTO rms_catalog.option_set_operation_record")) {
        operations.set(String(values[0]), { ...baseline, intent_digest: String(values[3]) });
        rowCount = 1;
      } else if (sql.startsWith("INSERT INTO rms_catalog.option_set_draft_content_snapshot")) {
        const row: StoredRow = {
          snapshot: JSON.parse(String(values[11])),
          source_digest: String(values[8]),
          content_digest: String(values[9]),
          configuration_digest: String(values[10]),
          intent_digest: String(values[5]),
          coherent: true,
        };
        snapshots.set(Number(values[6]), row);
        operations.set(String(values[0]), row);
        rowCount = 1;
      }
      return { rows: rows as Row[], rowCount };
    },
  };
  const options = {
    tenantReference: id(11),
    brandReference: id(10),
    actorReference: id(41),
    clock: { now: () => now },
    authority: {
      holdUntilTransactionCompletes: vi.fn(async () => ({
        observedAt: now,
        validUntil: new Date(Date.parse(now) + 5000).toISOString(),
      })),
    },
    transactions: {
      run: async <T>(work: (actual: ProductLifecycleTransaction) => Promise<T>): Promise<T> => {
        guards = [];
        finals = [];
        const oldCurrent = current,
          oldAdditional = additional,
          oldSnapshots = new Map(snapshots),
          oldOperations = new Map(operations),
          oldIdentities = new Map(identities);
        try {
          const result = await work(tx);
          beforeCommit?.();
          if (autoGuard)
            for (const guard of guards) {
              if (swallowGuard) await guard().catch(() => undefined);
              else await guard();
            }
          if (repeatGuard) for (const guard of guards) await guard();
          for (const final of finals) final();
          return result;
        } catch (error) {
          current = oldCurrent;
          additional = oldAdditional;
          snapshots.clear();
          operations.clear();
          for (const [key, value] of oldSnapshots) snapshots.set(key, value);
          for (const [key, value] of oldOperations) operations.set(key, value);
          identities.clear();
          for (const [key, value] of oldIdentities) identities.set(key, value);
          throw error;
        }
      },
    },
    editing: {
      authority: editAuthority,
      references: { generateOption: allocate },
      registerBeforeCommit: (
        actual: ProductLifecycleTransaction,
        guard: () => Promise<void>,
        final: () => void,
      ) => {
        expect(actual).toBe(tx);
        guards.push(guard);
        finals.push(final);
      },
    },
    audit: {
      create: (input: { operationReference: string; reasonCode: string; occurredAt: string }) => ({
        auditId: id(80),
        brandId: id(10),
        actor: { type: "User" as const, reference: id(41) },
        actionCode: "CATALOG_OPTION_SET_REPLACEDRAFT",
        targetType: "CatalogOptionSet",
        targetId: id(1),
        reasonCode: input.reasonCode,
        correlationId: input.operationReference,
        occurredAt: input.occurredAt,
        sourceChannel: "API",
        dataClassification: "Internal" as const,
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      }),
    },
    events: { generateReference: () => id(81) },
  };
  const store = createPostgresFullOptionSetDraftStore(options);
  return {
    ...f,
    store,
    options,
    tx,
    calls,
    sqls,
    allocate,
    operations,
    snapshots,
    identities,
    abandon: () => {
      available = false;
    },
    failIdentity: () => {
      failIdentity = true;
    },
    current: () => current,
    deny: () => {
      allowed = false;
    },
    skipGuard: () => {
      autoGuard = false;
    },
    repeatGuard: () => {
      repeatGuard = true;
    },
    swallowGuard: () => {
      swallowGuard = true;
    },
    beforeCommit: (work: () => void) => {
      beforeCommit = work;
    },
    advance: (time: string) => {
      now = time;
    },
  };
}
it("ordinary append/remove uses one locked owner write with server identity and immutable receipt", async () => {
  const f = ownerFixture(),
    result = await f.store.edit(f.command);
  expect(result.status).toBe("Applied");
  expect(f.allocate).toHaveBeenCalledTimes(1);
  expect(f.current().aggregateVersion).toBe(2);
  expect(
    result.content.sourceAggregate.draft.options.find((option) => option.optionReference === id(3)),
  ).toMatchObject({
    lifecycle: "Archived",
    defaultEligible: false,
    createdByActorReference: id(40),
  });
  expect(
    result.content.sourceAggregate.draft.options.find((option) => option.optionReference === id(4)),
  ).toMatchObject({ createdByActorReference: id(41), createdAt: at });
  expect(f.sqls.some((sql) => /^DELETE FROM rms_catalog\.option(?:\s|$)/u.test(sql))).toBe(false);
  expect(f.calls.map((call) => call.phase)).toEqual(["Intent", "Apply", "Apply", "Apply"]);
  expect(f.operations.size).toBe(1);
  expect(f.snapshots.size).toBe(2);
});
it("same-operation replay restores original allocated ID before any current Draft read or allocator call", async () => {
  const f = ownerFixture(),
    first = await f.store.edit(f.command),
    offset = f.sqls.length;
  f.allocate.mockImplementation(() => id(99));
  const replay = await f.store.edit(f.command);
  expect(replay.status).toBe("Replayed");
  expect(replay.content).toEqual(first.content);
  expect(f.allocate).toHaveBeenCalledTimes(1);
  expect(f.sqls.slice(offset).some((sql) => sql.startsWith("SELECT jsonb_build_object"))).toBe(
    false,
  );
  expect(f.operations.size).toBe(1);
  expect(f.calls.slice(-3).map((call) => call.phase)).toEqual(["Intent", "Replay", "Replay"]);
});
it("changed original intent conflicts before allocation or another receipt", async () => {
  const f = ownerFixture();
  await f.store.edit(f.command);
  await expect(f.store.edit({ ...f.command, reasonCode: "DIFFERENT_EDIT" })).rejects.toMatchObject({
    code: "CATALOG_IDEMPOTENCY_CONFLICT",
  });
  expect(f.allocate).toHaveBeenCalledTimes(1);
  expect(f.current().aggregateVersion).toBe(2);
  expect(f.operations.size).toBe(1);
});
it("stale expected root refuses before new identity allocation", async () => {
  const f = ownerFixture();
  await f.store.edit(f.command);
  await expect(f.store.edit({ ...f.command, operationReference: id(99) })).rejects.toMatchObject({
    code: "CATALOG_VERSION_CONFLICT",
  });
  expect(f.allocate).toHaveBeenCalledTimes(1);
});
it("late authority refusal and original expiry veto the transaction and owning receipts", async () => {
  const denied = ownerFixture();
  denied.beforeCommit(() => denied.deny());
  await expect(denied.store.edit(denied.command)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(denied.current().aggregateVersion).toBe(1);
  expect(denied.operations.size).toBe(0);
  const expired = ownerFixture();
  expired.beforeCommit(() => expired.advance("2026-10-04T00:00:06.000Z"));
  await expect(expired.store.edit(expired.command)).rejects.toThrow();
  expect(expired.current().aggregateVersion).toBe(1);
  expect(expired.operations.size).toBe(0);
});
it("skipping mandatory async source guard cannot pass synchronous final assertion", async () => {
  const f = ownerFixture();
  f.skipGuard();
  await expect(f.store.edit(f.command)).rejects.toThrow();
  expect(f.current().aggregateVersion).toBe(1);
});
it("legacy replace retains its identity/length contract and allocates no new IDs", async () => {
  const f = ownerFixture(),
    { sourceAggregate, ...details } = f.original.content;
  const result = await f.store.replace({
    optionSetReference: id(1),
    expectedAggregateVersion: 1,
    draft: { ...sourceAggregate.draft, updatedAt: at },
    additionalContent: details,
    operationReference: id(31),
    occurredAt: at,
    reasonCode: "CONFIGURATION_EDIT",
  });
  expect(result.status).toBe("Applied");
  expect(f.allocate).not.toHaveBeenCalled();
  expect(result.content.sourceAggregate.draft.options).toHaveLength(1);
  expect(result.content.sourceAggregate.draft.options[0]).toMatchObject({
    optionReference: id(3),
    createdByActorReference: id(40),
  });
});
it("captured allocator and source ports cannot be replaced with later configuration callbacks", async () => {
  const f = ownerFixture(),
    replacement = vi.fn(() => id(99));
  f.options.editing.references.generateOption = replacement;
  const result = await f.store.edit(f.command);
  expect(
    result.content.sourceAggregate.draft.options.some((option) => option.optionReference === id(4)),
  ).toBe(true);
  expect(replacement).not.toHaveBeenCalled();
});

it("repeated or swallowed failed source checks still poison the final transaction assertion", async () => {
  const repeated = ownerFixture();
  repeated.repeatGuard();
  await expect(repeated.store.edit(repeated.command)).rejects.toThrow();
  expect(repeated.operations.size).toBe(0);
  const swallowed = ownerFixture();
  swallowed.swallowGuard();
  swallowed.beforeCommit(() => swallowed.deny());
  await expect(swallowed.store.edit(swallowed.command)).rejects.toThrow();
  expect(swallowed.operations.size).toBe(0);
});
it("transaction query substitution after writes refuses the final owning proof", async () => {
  const f = ownerFixture(),
    replacement = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  f.beforeCommit(() => {
    f.tx.query = replacement;
  });
  await expect(f.store.edit(f.command)).rejects.toThrow();
  expect(f.operations.size).toBe(0);
  expect(replacement).not.toHaveBeenCalled();
});
it("retained old identity cannot be dropped through the legacy replace entry", async () => {
  const f = ownerFixture(),
    { sourceAggregate, ...additional } = f.original.content;
  await expect(
    f.store.replace({
      optionSetReference: id(1),
      expectedAggregateVersion: 1,
      draft: { ...sourceAggregate.draft, options: [], updatedAt: at },
      additionalContent: { ...additional, optionDetails: [] },
      operationReference: id(31),
      occurredAt: at,
      reasonCode: "CONFIGURATION_EDIT",
    }),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(f.current().aggregateVersion).toBe(1);
  expect(f.allocate).not.toHaveBeenCalled();
});

it("automatically appends original Edit identity and rejects legacy receipt without backfill", async () => {
  const f = ownerFixture();
  await f.store.edit(f.command);
  expect(f.identities.size).toBe(1);
  f.identities.clear();
  await expect(f.store.edit(f.command)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.identities.size).toBe(0);
  expect(f.allocate).toHaveBeenCalledTimes(1);
});
it("permanent operation absence fence rejects Edit before allocation and source write", async () => {
  const f = ownerFixture();
  f.abandon();
  await expect(f.store.edit(f.command)).rejects.toMatchObject({
    code: "CATALOG_IDEMPOTENCY_CONFLICT",
  });
  expect(f.allocate).not.toHaveBeenCalled();
  expect(f.operations.size).toBe(0);
  expect(f.current().aggregateVersion).toBe(1);
});
it("mandatory identity append failure rolls back original Edit rather than returning an untracked success", async () => {
  const f = ownerFixture();
  f.failIdentity();
  await expect(f.store.edit(f.command)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.current().aggregateVersion).toBe(1);
  expect(f.operations.size).toBe(0);
  expect(f.identities.size).toBe(0);
});
