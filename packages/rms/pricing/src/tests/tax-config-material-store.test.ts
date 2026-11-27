import { describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, type AppendAuditRecordInput } from "@bop/audit";
import { createBrand, createStore, createTenantContext, parseCanonicalInstant } from "@bop/tenant";
import {
  evaluatePermission,
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  parseRoleReference,
  parseEvidenceReference,
} from "@bop/permission";
import { parseTaxConfigAuthoringScope } from "../contracts/tax-config-authoring.js";
import {
  parseTaxConfigMaterialCommand,
  taxConfigMaterialIntentDigest,
} from "../contracts/tax-config-material.js";
import {
  createPostgresTaxConfigMaterialStore,
  type TaxConfigMaterialStoreOptions,
  type TaxConfigMaterialTransaction,
} from "../infrastructure/persistence/tax-config-material-store.js";
// Controlled SQL transport with genuine public Audit/Eventing append/read and Permission evaluator.
// This suite makes no native PostgreSQL or real workforce IAM qualification claim.
const id = (n: number) => `018ff700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T16:00:00.000Z";
type Row = Record<string, unknown>;
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function must<T>(v: T | null | undefined): T {
  if (v === null || v === undefined) throw new Error("Missing controlled fixture fact");
  return v;
}
const rootColumns = [
  "tenant_id",
  "brand_id",
  "store_id",
  "material_id",
  "material_kind",
  "revision",
  "current_version_id",
  "created_at",
  "updated_at",
  "data_classification",
];
const versionColumns = [
  "tenant_id",
  "brand_id",
  "store_id",
  "material_id",
  "version_id",
  "material_kind",
  "revision",
  "previous_version_id",
  "operation_id",
  "actor_id",
  "version_json",
  "version_text",
  "version_digest",
  "content_digest",
  "recorded_at",
  "data_classification",
];
const operationColumns = [
  "operation_id",
  "tenant_id",
  "brand_id",
  "store_id",
  "actor_id",
  "action_code",
  "requested_material_id",
  "expected_revision",
  "material_kind",
  "intent_digest",
  "outcome",
  "result_material_id",
  "result_version_id",
  "result_revision",
  "receipt_json",
  "receipt_text",
  "receipt_digest",
  "audit_id",
  "audit_json",
  "event_id",
  "occurred_at",
  "data_classification",
];
function database() {
  return {
    serial: 100,
    roots: new Map<string, Row>(),
    versions: new Map<string, Row>(),
    originals: new Map<string, Row>(),
    events: new Map<string, Row>(),
    hidden: new Set<string>(),
    audits: [] as (readonly unknown[])[],
    sequence: 1,
    previous: null as string | null,
  };
}
function fixture(
  db = database(),
  actor = id(4),
  auditClassification: "Confidential" | "Internal" = "Confidential",
) {
  const scope = parseTaxConfigAuthoringScope({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: actor,
  });
  let now = at,
    allowed = true,
    lease = "2026-08-02T16:00:05.000Z";
  const queries: { sql: string; values: readonly unknown[] }[] = [],
    hooks: { guard: () => Promise<void>; final: () => void }[] = [];
  const query: TaxConfigMaterialTransaction["query"] = async <R>(
    sql: string,
    values: readonly unknown[],
  ) => {
    queries.push({ sql, values });
    let rows: Row[] = [],
      rowCount = 1;
    const mapped = (cols: readonly string[], json: readonly number[] = []) =>
      Object.fromEntries(
        cols.map((c, i) => [c, json.includes(i) ? JSON.parse(String(values[i])) : values[i]]),
      );
    if (sql.includes("tax_config_material_operation_available"))
      rows = [
        { available: !db.hidden.has(String(values[0])) && !db.originals.has(String(values[0])) },
      ];
    else if (
      sql.startsWith("SELECT operation_id::text") &&
      sql.includes("FROM rms_pricing.tax_config_material_operation")
    ) {
      const r = db.originals.get(String(values[0]));
      rows = r ? [copy(r)] : [];
    } else if (sql.startsWith("SELECT operation_id::text")) {
      const r = db.versions.get(String(values[3]));
      rows = r ? [{ operation_id: r.operation_id }] : [];
    } else if (
      sql.startsWith("SELECT tenant_id::text") &&
      sql.includes("FROM rms_pricing.tax_config_material_version")
    ) {
      const r = db.versions.get(String(values[3]));
      rows = r ? [copy(r)] : [];
    } else if (sql.startsWith("SELECT tenant_id::text")) {
      const r = db.roots.get(String(values[3]));
      rows = r ? [copy(r)] : [];
    } else if (sql.startsWith("SELECT material_id::text")) {
      rows = [...db.roots.values()]
        .filter(
          (r) =>
            r.material_kind === values[3] &&
            (values[4] === null || String(r.material_id) > String(values[4])),
        )
        .sort((a, b) => String(a.material_id).localeCompare(String(b.material_id)))
        .slice(0, 51)
        .map((r) => ({ material_id: r.material_id }));
    } else if (sql.startsWith("INSERT INTO rms_pricing.tax_config_material_operation")) {
      if (db.hidden.has(String(values[0]))) throw new Error("controlled hidden original collision");
      db.originals.set(String(values[0]), mapped(operationColumns, [14, 18]));
    } else if (sql.startsWith("INSERT INTO rms_pricing.tax_config_material_version"))
      db.versions.set(String(values[4]), mapped(versionColumns, [10]));
    else if (sql.startsWith("INSERT INTO rms_pricing.tax_config_material("))
      db.roots.set(String(values[3]), mapped(rootColumns));
    else if (sql.startsWith("UPDATE rms_pricing.tax_config_material")) {
      const r = db.roots.get(String(values[6]));
      if (!r || r.revision !== values[7] || r.current_version_id !== values[8]) rowCount = 0;
      else
        Object.assign(r, {
          revision: values[0],
          current_version_id: values[1],
          updated_at: values[2],
        });
    } else if (sql.includes("FROM platform_audit.audit_chain_head"))
      rows = [{ next_sequence: String(db.sequence), previous_hash: db.previous, recorded_at: now }];
    else if (sql.startsWith("INSERT INTO platform_audit.audit_record"))
      db.audits = [...db.audits, values];
    else if (sql.startsWith("UPDATE platform_audit.audit_chain_head")) {
      db.sequence++;
      db.previous = (values[2] as Buffer).toString("hex");
      rows = [{ next_sequence: String(db.sequence) }];
    } else if (sql.startsWith("INSERT INTO platform_eventing.outbox_event"))
      db.events.set(
        String(values[0]),
        Object.fromEntries(
          [
            "event_id",
            "event_type",
            "schema_version",
            "producer_module",
            "brand_id",
            "store_id",
            "aggregate_type",
            "aggregate_id",
            "aggregate_version",
            "correlation_id",
            "causation_id",
            "actor_type",
            "actor_id",
            "payload_json",
            "redaction_classification",
            "replay_metadata_json",
            "occurred_at",
          ].map((key, i) => [
            key,
            i === 13 || i === 15 ? JSON.parse(String(values[i])) : values[i],
          ]),
        ),
      );
    else if (sql.includes("FROM platform_eventing.outbox_event")) {
      const r = db.events.get(String(values[0]));
      rows = r ? [copy(r)] : [];
    }
    return { rows: rows as R[], rowCount };
  };
  const transaction: TaxConfigMaterialTransaction = { query };
  const brand = createBrand({
    brandReference: scope.brandReference,
    code: "TAX",
    displayName: "Controlled Tax",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const store = createStore({
    storeReference: scope.storeReference,
    brandReference: scope.brandReference,
    code: "TAX",
    displayName: "Controlled Store",
    timeZone: "America/Toronto",
    locale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const authority: TaxConfigMaterialStoreOptions["authority"] = {
    holdUntilTransactionCompletes: vi.fn(async () => {
      const actorInput = {
        actorType: "User",
        actorReference: actor,
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt: at,
        recentMfaAt: null,
      } as Parameters<typeof createTenantContext>[0];
      const tenantContext = createTenantContext(actorInput, brand, store, now);
      const actorReference = tenantContext.actor.actorReference;
      if (actorReference === null) throw new Error("controlled workforce Actor required");
      const action = parseBusinessAction("pricing.tax-config.manage");
      const permission = evaluatePermission({
        tenantContext,
        action,
        resourceScope: {
          kind: "Store",
          brandReference: brand.brandReference,
          storeReference: store.storeReference,
        },
        policySnapshotReference: parsePolicyReference(id(9)),
        policyVersion: parsePolicyVersion(1),
        evidence: allowed
          ? [
              {
                source: "RolePermission",
                evidenceReference: parseEvidenceReference(id(10)),
                action,
                actorReference,
                roleReference: parseRoleReference(id(11)),
                brandReference: brand.brandReference,
                storeReference: store.storeReference,
                effectiveFrom: parseCanonicalInstant(at),
                effectiveUntil: null,
              },
            ]
          : [],
      });
      return { scope, tenantContext, permission, validUntil: lease };
    }),
  };
  const options: TaxConfigMaterialStoreOptions = {
    transaction,
    scope,
    originalObservedAt: at,
    originalValidUntil: lease,
    clock: { now: () => now },
    registerBeforeCommit: (tx, guard, final) => {
      expect(tx).toBe(transaction);
      hooks.push({ guard, final });
    },
    authority,
    facts: { validateMaterial: vi.fn(async () => undefined) },
    references: { generate: vi.fn(() => id(++db.serial)) },
    audit: {
      create: vi.fn(
        ({
          mode,
          auditReference,
          command,
          materialReference,
          intentDigest,
          occurredAt,
        }): AppendAuditRecordInput => ({
          auditId: auditReference,
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "User", reference: actor },
          actionCode:
            mode === "Abandon"
              ? "PRICING_TAX_MATERIAL_RESOLVE"
              : "PRICING_TAX_MATERIAL_" + command.action.toUpperCase(),
          targetType:
            mode === "Abandon" ? "PricingTaxMaterialOperation" : "PricingTaxConfigMaterial",
          targetId: mode === "Abandon" ? command.operationReference : must(materialReference),
          reasonCode: "AUTHORIZED_OPERATION",
          correlationId: command.operationReference,
          occurredAt,
          sourceChannel: "API",
          dataClassification: auditClassification,
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
          afterSummary: { intentDigest },
        }),
      ),
    },
  };
  const source = createPostgresTaxConfigMaterialStore(options);
  const command = parseTaxConfigMaterialCommand({
    action: "CreateMaterial",
    operationReference: id(20),
    materialReference: null,
    expectedRevision: null,
    materialKind: "RegistrationApplicability",
    content: {
      operatingEntityProfileVersionReference: id(21),
      operatingEntityTaxReference: id(22),
      jurisdictionCode: "CA-ON",
      applicability: "Applicable",
      sourceIssuedAt: at,
      effectiveFrom: at,
      effectiveUntil: null,
      declaredSourceDigest: null,
    },
  });
  const resolve = {
    action: command.action,
    operationReference: command.operationReference,
    materialReference: command.materialReference,
    expectedRevision: command.expectedRevision,
    materialKind: command.materialKind,
    intentDigest: taxConfigMaterialIntentDigest(scope, command),
  };
  async function finalize() {
    for (const h of hooks) await h.guard();
    for (const h of hooks) h.final();
    return source.assertFinalized();
  }
  // Controlled transaction rollback marker, not a PostgreSQL rollback proof.
  async function atomic<T>(work: () => Promise<T>) {
    const backup = {
      roots: new Map(db.roots),
      versions: new Map(db.versions),
      originals: new Map(db.originals),
      events: new Map(db.events),
      audits: [...db.audits],
      sequence: db.sequence,
      previous: db.previous,
    };
    try {
      const value = await work();
      await finalize();
      return value;
    } catch (error) {
      db.roots = backup.roots;
      db.versions = backup.versions;
      db.originals = backup.originals;
      db.events = backup.events;
      db.audits = backup.audits;
      db.sequence = backup.sequence;
      db.previous = backup.previous;
      throw error;
    }
  }
  return {
    db,
    scope,
    options,
    source,
    command,
    resolve,
    hooks,
    queries,
    finalize,
    atomic,
    setNow: (value: string) => {
      now = value;
    },
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    setLease: (value: string) => {
      lease = value;
    },
  };
}
const unavailable = { code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE" },
  denied = { code: "TAX_CONFIG_PERMISSION_DENIED" },
  conflict = { code: "TAX_CONFIG_VERSION_CONFLICT" },
  intentConflict = { code: "TAX_CONFIG_IDEMPOTENCY_CONFLICT" };

describe("transaction-held Tax material persistence", () => {
  it("writes immutable root/version/original and real Audit/Outbox, then verifies actual original source", async () => {
    const f = fixture(),
      receipt = await f.atomic(() => f.source.execute(f.command));
    expect(receipt.version).toMatchObject({
      revision: 1,
      status: "Recorded",
      qualification: "NotEvaluated",
      dataClassification: "Confidential",
    });
    expect(f.db.roots.size).toBe(1);
    expect(f.db.versions.size).toBe(1);
    expect(f.db.originals.size).toBe(1);
    expect(f.db.audits).toHaveLength(1);
    expect(f.db.events.size).toBe(1);
    expect(f.options.facts.validateMaterial).toHaveBeenCalledTimes(2);
    const event = must([...f.db.events.values()][0]);
    expect(event.payload_json).not.toHaveProperty("content");
    expect(event.payload_json).not.toHaveProperty("declaredIssuer");
    expect(event.redaction_classification).toBe("indirect_identifier");
    const original = f.queries.findIndex((q) => q.sql.includes("PricingTaxMaterialOriginal:")),
      root = f.queries.findIndex((q) => q.sql.includes("PricingTaxMaterialRoot:"));
    expect(original).toBeGreaterThanOrEqual(0);
    expect(root).toBeGreaterThan(original);
    const flush = must(f.queries.find((q) => q.sql.startsWith("SET CONSTRAINTS")));
    expect(flush.sql).toContain("tax_config_material_root_coherence");
    expect(flush.sql).not.toContain("ALL");
  });
  it("replays exact immutable original with current IAM but no today's material facts or new IDs", async () => {
    const f = fixture(),
      receipt = await f.atomic(() => f.source.execute(f.command)),
      replay = fixture(f.db);
    replay.options.facts.validateMaterial = vi.fn(async () => {
      throw new Error("today material source unavailable");
    });
    // Construct after the fixed port has been configured, preserving captured-port identity.
    const store = createPostgresTaxConfigMaterialStore(replay.options);
    const result = await store.execute(replay.command);
    expect(result).toEqual(receipt);
    expect(replay.options.references.generate).not.toHaveBeenCalled();
    expect(replay.options.facts.validateMaterial).not.toHaveBeenCalled();
    for (const h of replay.hooks) await h.guard();
    for (const h of replay.hooks) h.final();
    store.assertFinalized();
  });
  it("replacement retains root creation time, new immutable predecessor and independent revision writer", async () => {
    const f = fixture(),
      first = await f.atomic(() => f.source.execute(f.command)),
      old = must(first.version),
      next = fixture(f.db, id(90));
    const command = parseTaxConfigMaterialCommand({
      ...next.command,
      action: "ReplaceMaterial",
      operationReference: id(91),
      materialReference: old.materialReference,
      expectedRevision: 1,
    });
    const receipt = await next.atomic(() => next.source.execute(command));
    expect(receipt.version).toMatchObject({
      revision: 2,
      previousVersionReference: old.versionReference,
      createdAt: old.createdAt,
      recordedByActorReference: id(90),
    });
    expect(f.db.versions.size).toBe(2);
    const reader = fixture(f.db, id(92)),
      view = await reader.atomic(() =>
        reader.source.readVersion({
          materialKind: old.materialKind,
          versionReference: old.versionReference,
        }),
      );
    expect(view.actorReference).toBe(id(92));
    expect(view.version?.recordedByActorReference).toBe(f.scope.actorReference);
  });
  it("refuses stale CAS before Version/Audit/Event allocation or artifacts", async () => {
    const f = fixture(),
      receipt = await f.atomic(() => f.source.execute(f.command)),
      next = fixture(f.db),
      version = must(receipt.version);
    await expect(
      next.source.execute({
        ...next.command,
        action: "ReplaceMaterial",
        operationReference: id(95),
        materialReference: version.materialReference,
        expectedRevision: 2,
      }),
    ).rejects.toMatchObject(conflict);
    expect(next.options.references.generate).not.toHaveBeenCalled();
    expect(next.db.audits).toHaveLength(1);
  });
  it("Resolve absent appends a genuine intent Audit and durable Abandoned; late Execute never calls producer", async () => {
    const f = fixture(),
      receipt = await f.atomic(() => f.source.resolveOriginal(f.resolve));
    expect(receipt).toMatchObject({
      outcome: "Abandoned",
      command: null,
      version: null,
      eventReference: null,
    });
    expect(f.db.audits).toHaveLength(1);
    expect(f.db.events.size).toBe(0);
    const late = fixture(f.db);
    expect(await late.atomic(() => late.source.execute(late.command))).toEqual(receipt);
    expect(late.options.facts.validateMaterial).not.toHaveBeenCalled();
    expect(late.options.references.generate).not.toHaveBeenCalled();
  });
  it("rejects foreign original Actor and changed body/hash without appending recovery Audit", async () => {
    const f = fixture();
    await f.atomic(() => f.source.execute(f.command));
    const actor = fixture(f.db, id(90));
    await expect(actor.source.resolveOriginal(actor.resolve)).rejects.toMatchObject(denied);
    const mismatch = fixture(f.db);
    await expect(
      mismatch.source.execute({
        ...mismatch.command,
        content: { ...mismatch.command.content, applicability: "NotApplicable" },
      }),
    ).rejects.toMatchObject(intentConflict);
    expect(f.db.audits).toHaveLength(1);
  });
  it("hidden cross-scope global original availability fails closed without false Abandoned", async () => {
    const f = fixture();
    f.db.hidden.add(f.command.operationReference);
    await expect(f.source.resolveOriginal(f.resolve)).rejects.toMatchObject(unavailable);
    expect(f.db.originals.size).toBe(0);
    expect(f.db.audits).toHaveLength(0);
  });
  it("current reads and roster have current reader authority and metadata-only summary output", async () => {
    const f = fixture(),
      receipt = await f.atomic(() => f.source.execute(f.command)),
      reader = fixture(f.db, id(90)),
      version = must(receipt.version);
    const view = await reader.source.readCurrent({
      materialKind: version.materialKind,
      materialReference: version.materialReference,
    });
    expect(view.actorReference).toBe(id(90));
    expect(view.version).toEqual(version);
    const page = await reader.source.readRoster({
      materialKind: version.materialKind,
      afterMaterial: null,
    });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).not.toHaveProperty("content");
    expect(page.entries[0]).not.toHaveProperty("recordedByActorReference");
    await reader.finalize();
  });
  it("real public Eventing source corruption prevents replay", async () => {
    const f = fixture(),
      receipt = await f.atomic(() => f.source.execute(f.command)),
      row = must(f.db.events.get(must(receipt.eventReference)));
    const payload = row.payload_json;
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("fixture event payload missing");
    row.payload_json = { ...payload, revision: 99 };
    const replay = fixture(f.db);
    await expect(replay.source.execute(replay.command)).rejects.toMatchObject(unavailable);
  });
  it("canonical source preimage text and immutable material digest cannot be replaced with another JSON packet", async () => {
    const f = fixture(),
      receipt = await f.atomic(() => f.source.execute(f.command)),
      row = must(f.db.versions.get(must(receipt.version).versionReference));
    row.version_text = " " + canonicalizeRfc8785(row.version_json);
    expect(row.version_text).not.toBe(canonicalizeRfc8785(row.version_json));
    expect(JSON.parse(String(row.version_text))).toEqual(row.version_json);
    const replay = fixture(f.db);
    await expect(replay.source.execute(replay.command)).rejects.toMatchObject(unavailable);
  });
  it("late permission withdrawal during actual host guard rolls back the controlled transaction", async () => {
    const f = fixture();
    await expect(
      f.atomic(async () => {
        await f.source.execute(f.command);
        f.setAllowed(false);
      }),
    ).rejects.toMatchObject(denied);
    expect(f.db.originals.size).toBe(0);
    expect(f.db.versions.size).toBe(0);
    expect(f.db.events.size).toBe(0);
    expect(f.db.audits).toHaveLength(0);
  });
  it("source reference invalidation at COMMIT refuses the write and never promotes qualification", async () => {
    const f = fixture();
    vi.mocked(f.options.facts.validateMaterial)
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        throw new Error("actual candidate removed");
      });
    await expect(f.atomic(() => f.source.execute(f.command))).rejects.toMatchObject(unavailable);
    expect(f.db.roots.size).toBe(0);
  });
  it("shortest actual permission lease and original five-second clock remain enforced", async () => {
    const f = fixture();
    f.setLease("2026-08-02T16:00:01.000Z");
    await expect(
      f.atomic(async () => {
        await f.source.execute(f.command);
        f.setNow("2026-08-02T16:00:01.000Z");
      }),
    ).rejects.toMatchObject(unavailable);
    expect(f.db.audits).toHaveLength(0);
  });
  it("backwards clock poisons the operation even if caller swallows the initial failure", async () => {
    const f = fixture();
    f.setNow("2026-08-02T15:59:59.999Z");
    await expect(
      f.source.readCurrent({ materialKind: "RegistrationApplicability", materialReference: null }),
    ).rejects.toMatchObject(unavailable);
    f.setNow(at);
    await expect(f.source.execute(f.command)).rejects.toMatchObject(unavailable);
  });
  it("port replacement and finalization without both actual host hooks cannot be accepted", async () => {
    const f = fixture();
    await f.source.readCurrent({
      materialKind: "RegistrationApplicability",
      materialReference: null,
    });
    expect(() => f.source.assertFinalized()).toThrow(expect.objectContaining(unavailable));
    f.options.transaction.query = async () => ({ rows: [], rowCount: 0 });
    await expect(f.finalize()).rejects.toMatchObject(unavailable);
  });
  it("same transaction reentry poisons outer work and all future guards", async () => {
    const f = fixture();
    vi.mocked(f.options.facts.validateMaterial).mockImplementation(async () => {
      try {
        await f.source.readCurrent({
          materialKind: "RegistrationApplicability",
          materialReference: null,
        });
      } catch {
        /* Deliberate adversarial swallowed callback failure. */
      }
    });
    await expect(f.source.execute(f.command)).rejects.toMatchObject(unavailable);
    await expect(f.finalize()).rejects.toMatchObject(unavailable);
  });
  it("roster continuation lists independent material roots without returning their Confidential bodies", async () => {
    const f = fixture();
    const originals = await f.atomic(async () => [
      await f.source.execute(f.command),
      await f.source.execute({ ...f.command, operationReference: id(99) }),
    ]);
    const first = must(must(originals[0]).version),
      second = must(must(originals[1]).version),
      reader = fixture(f.db, id(90));
    const page = await reader.atomic(() =>
      reader.source.readRoster({
        materialKind: first.materialKind,
        afterMaterial: first.materialReference,
      }),
    );
    expect(page.entries.map((e) => e.materialReference)).toEqual([second.materialReference]);
    expect(page.entries[0]).not.toHaveProperty("content");
  });
  it("an actual authority packet from another selected Store is denied, not treated as current source", async () => {
    const f = fixture(),
      original = f.options.authority.holdUntilTransactionCompletes;
    vi.mocked(original).mockImplementation(async (...args) => {
      const fresh = fixture().options.authority.holdUntilTransactionCompletes;
      const packet = await fresh(...args);
      return {
        ...packet,
        scope: parseTaxConfigAuthoringScope({ ...packet.scope, storeReference: id(95) }),
      };
    });
    await expect(f.source.execute(f.command)).rejects.toMatchObject(denied);
    expect(f.options.references.generate).not.toHaveBeenCalled();
  });
  it("boolean source qualification or Confidential Audit content cannot substitute for actual reference validation", async () => {
    const f = fixture();
    Object.defineProperty(f.options.facts, "validateMaterial", { value: async () => true });
    const store = createPostgresTaxConfigMaterialStore(f.options);
    await expect(store.execute(f.command)).rejects.toMatchObject(unavailable);
    expect(f.db.audits).toHaveLength(0);
    const audit = fixture(),
      factory = audit.options.audit.create;
    vi.mocked(factory).mockImplementation((input) => ({
      auditId: input.auditReference,
      brandId: audit.scope.brandReference,
      storeId: audit.scope.storeReference,
      actor: { type: "User", reference: audit.scope.actorReference },
      actionCode: "PRICING_TAX_MATERIAL_CREATEMATERIAL",
      targetType: "PricingTaxConfigMaterial",
      targetId: must(input.materialReference),
      reasonCode: "AUTHORIZED_OPERATION",
      correlationId: input.command.operationReference,
      occurredAt: input.occurredAt,
      sourceChannel: "API",
      dataClassification: "Confidential",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
      afterSummary: { intentDigest: input.intentDigest, issuer: "private issuer" },
    }));
    await expect(audit.source.execute(audit.command)).rejects.toMatchObject(unavailable);
    expect(audit.db.audits).toHaveLength(0);
  });
  it("refuses a non-Confidential Audit from the originally captured factory before append", async () => {
    const f = fixture(database(), id(4), "Internal");
    await expect(f.source.execute(f.command)).rejects.toMatchObject(unavailable);
    expect(f.db.audits).toHaveLength(0);
    expect(f.db.originals.size).toBe(0);
    expect(f.db.versions.size).toBe(0);
    expect(f.db.events.size).toBe(0);
  });
  it("a nonvoid host registration return refuses without accepting a missing actual hook", async () => {
    const f = fixture();
    Object.defineProperty(f.options, "registerBeforeCommit", {
      value: () => Promise.resolve("not registered"),
    });
    const store = createPostgresTaxConfigMaterialStore(f.options);
    await expect(
      store.readCurrent({ materialKind: "RegistrationApplicability", materialReference: null }),
    ).rejects.toMatchObject(unavailable);
    expect(f.db.originals.size).toBe(0);
    expect(() => store.assertFinalized()).toThrow(expect.objectContaining(unavailable));
  });
});
