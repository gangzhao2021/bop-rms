import { describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex, type AppendAuditRecordInput } from "@bop/audit";
import { createBrand, createStore, createTenantContext, parseCanonicalInstant } from "@bop/tenant";
import {
  evaluatePermission,
  parseBusinessAction,
  parsePolicyReference,
  parsePolicyVersion,
  parseRoleReference,
  parseEvidenceReference,
} from "@bop/permission";
import { input } from "./price-quote.fixture.js";
import {
  parseTaxConfigAuthoringCommand,
  parseTaxConfigAuthoringScope,
  taxConfigAuthoringIntentDigest,
} from "../contracts/tax-config-authoring.js";
import {
  createPostgresTaxConfigAuthoringStore,
  type TaxConfigAuthoringStoreOptions,
  type TaxConfigAuthoringTransaction,
} from "../infrastructure/persistence/tax-config-authoring-store.js";

// Controlled SQL transport, real Tax service, Domain constructors, Audit chain append
// and Eventing append/read. This fixture does not assert native SQL or IAM acceptance.
const id = (n: number) => `018ff700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T16:00:00.000Z";
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const columns = [
  "operation_id",
  "tenant_id",
  "brand_id",
  "store_id",
  "actor_id",
  "action_code",
  "requested_configuration_id",
  "expected_aggregate_version",
  "intent_digest",
  "outcome",
  "result_configuration_id",
  "result_version_id",
  "result_aggregate_version",
  "service_intent_digest",
  "service_input_json",
  "receipt_json",
  "receipt_digest",
  "audit_id",
  "audit_json",
  "event_id",
  "occurred_at",
  "data_classification",
];
type Row = Record<string, unknown>;
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing controlled fixture fact");
  return value;
}
function database() {
  return {
    serial: 100,
    roots: new Map<string, Row>(),
    versions: new Map<string, Row>(),
    rules: new Map<string, Row[]>(),
    legacy: new Map<string, Row>(),
    originals: new Map<string, Row>(),
    events: new Map<string, Row>(),
    hidden: new Set<string>(),
    audits: [] as (readonly unknown[])[],
    sequence: 1,
    previous: null as string | null,
  };
}
function fixture(db = database(), actor = id(4)) {
  const q = input(),
    scope = parseTaxConfigAuthoringScope({
      tenantReference: id(1),
      brandReference: q.brandReference,
      storeReference: q.storeReference,
      actorReference: actor,
    });
  let now = at,
    allowed = true,
    lease = "2026-08-02T16:00:05.000Z";
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  const hooks: { guard: () => Promise<void>; final: () => void }[] = [];
  let sourceDrift: ((row: Row) => Row) | null = null;
  const query: TaxConfigAuthoringTransaction["query"] = async <R>(
    sql: string,
    values: readonly unknown[],
  ) => {
    queries.push({ sql, values });
    let rows: Row[] = [];
    let rowCount = 1;
    if (sql.includes("tax_config_authoring_operation_available"))
      rows = [
        {
          available:
            !db.originals.has(String(values[0])) &&
            !db.legacy.has(String(values[0])) &&
            !db.hidden.has(String(values[0])),
        },
      ];
    else if (sql.startsWith("SELECT operation_id::text")) {
      const row = db.originals.get(String(values[0]));
      rows = row ? [copy(row)] : [];
    } else if (sql.startsWith("SELECT jsonb_build_object")) {
      const version = db.versions.get(String(values[2])),
        op = db.legacy.get(String(values[3]));
      const root = version ? db.roots.get(String(version.configurationReference)) : null;
      if (root && version && op) {
        let row = {
          root: copy(root),
          version: copy(version),
          operation: copy(op),
          rules: copy(db.rules.get(String(values[2])) ?? []).sort((a, b) =>
            String(a.ruleReference).localeCompare(String(b.ruleReference)),
          ),
          precise: true,
        };
        if (sourceDrift) row = sourceDrift(row) as typeof row;
        rows = [row];
      }
    } else if (sql.startsWith("SELECT v.authoring_operation_id::text")) {
      const version = db.versions.get(String(values[3]));
      rows =
        version &&
        version.configurationReference === values[2] &&
        version.brandReference === values[0] &&
        version.storeReference === values[1]
          ? [{ authoring_operation_id: version.authoringOperationReference }]
          : [];
    } else if (sql.startsWith("SELECT r.aggregate_version")) {
      const root = db.roots.get(String(values[2]));
      const v = root ? db.versions.get(String(root.currentVersionReference)) : null;
      rows = root
        ? [
            {
              aggregate_version: root.aggregateVersion,
              current_version_id: root.currentVersionReference,
              authoring_operation_id: v?.authoringOperationReference ?? null,
            },
          ]
        : [];
    } else if (sql.startsWith("SELECT r.tax_configuration_id"))
      rows = [...db.roots.values()]
        .filter((r) => values[2] === null || String(r.configurationReference) > String(values[2]))
        .sort((a, b) =>
          String(a.configurationReference).localeCompare(String(b.configurationReference)),
        )
        .slice(0, 51)
        .map((r) => ({ tax_configuration_id: r.configurationReference }));
    else if (sql.includes("FROM platform_eventing.outbox_event")) {
      const row = db.events.get(String(values[0]));
      rows = row ? [copy(row)] : [];
    } else if (sql.startsWith("INSERT INTO rms_pricing.tax_config_authoring_operation")) {
      const row = Object.fromEntries(columns.map((key, i) => [key, values[i]]));
      row.receipt_json = JSON.parse(String(row.receipt_json));
      row.audit_json = JSON.parse(String(row.audit_json));
      if (db.originals.has(String(values[0])) || db.hidden.has(String(values[0])))
        throw new Error("controlled unique failure");
      db.originals.set(String(values[0]), row);
    } else if (sql.startsWith("INSERT INTO rms_pricing.tax_configuration("))
      db.roots.set(String(values[0]), {
        configurationReference: values[0],
        brandReference: values[1],
        storeReference: values[2],
        stableCode: values[3],
        aggregateVersion: values[4],
        currentVersionReference: null,
        createdAt: values[5],
        createdByActorReference: values[6],
        updatedAt: values[5],
      });
    else if (sql.startsWith("INSERT INTO rms_pricing.tax_configuration_version"))
      db.versions.set(String(values[0]), {
        versionReference: values[0],
        configurationReference: values[1],
        brandReference: values[2],
        storeReference: values[3],
        versionNumber: values[4],
        snapshotDigest: values[5],
        lifecycle: "Draft",
        jurisdictionCode: "CA-ON",
        currencyCode: values[6],
        currencyMetadataVersion: values[7],
        currencyMetadataVersionReference: values[8],
        currencyMetadataDigest: values[9],
        effectiveFrom: values[10],
        effectiveUntil: values[11],
        timeZone: values[12],
        createdAt: values[13],
        authoringOperationReference: values[14],
        noEvidence: true,
      });
    else if (sql.startsWith("INSERT INTO rms_pricing.tax_configuration_rule")) {
      const list = db.rules.get(String(values[1])) ?? [];
      list.push({
        ruleReference: values[0],
        taxClassificationReference: values[5],
        orderType: values[6],
        chargeType: values[7],
        taxComponentCode: values[8],
        treatment: values[9],
        rate: values[10],
        priceInclusion: values[11],
        roundingMode: values[12],
        calculationOrder: values[13],
        compoundOnPriorTax: values[14],
        exceptionEvidenceReference: values[15],
        receiptPresentationCode: values[16],
      });
      db.rules.set(String(values[1]), list);
    } else if (sql.startsWith("UPDATE rms_pricing.tax_configuration")) {
      const root = db.roots.get(String(values[4]));
      if (!root || root.aggregateVersion !== values[7]) rowCount = 0;
      else
        Object.assign(root, {
          aggregateVersion: values[0],
          currentVersionReference: values[1],
          stableCode: values[2],
          updatedAt: values[3],
        });
    } else if (sql.startsWith("INSERT INTO rms_pricing.tax_configuration_operation_record"))
      db.legacy.set(String(values[0]), {
        operationReference: values[0],
        configurationReference: values[1],
        brandReference: values[2],
        storeReference: values[3],
        action: values[4],
        intentDigest: values[5],
        aggregateVersion: values[6],
        versionReference: values[7],
        occurredAt: values[8],
        eventReference: values[9],
      });
    else if (sql.includes("FROM platform_audit.audit_chain_head"))
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
    return { rows: rows as R[], rowCount };
  };
  const transaction: TaxConfigAuthoringTransaction = { query };
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
  const authority: TaxConfigAuthoringStoreOptions["authority"] = {
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
  const options: TaxConfigAuthoringStoreOptions = {
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
    currency: { readCurrent: vi.fn(async () => q.currencyMetadata) },
    facts: { validateDraft: vi.fn(async () => undefined) },
    references: { generate: vi.fn(() => id(++db.serial)) },
    audit: {
      create: vi.fn(
        ({
          mode,
          auditReference,
          command,
          configurationReference,
          intentDigest,
          occurredAt,
        }): AppendAuditRecordInput => ({
          auditId: auditReference,
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "User", reference: actor },
          actionCode:
            mode === "Abandon"
              ? "PRICING_TAX_CONFIG_RESOLVE"
              : "PRICING_TAX_CONFIG_" + command.action.toUpperCase(),
          targetType:
            mode === "Abandon" ? "PricingTaxAuthoringOperation" : "PricingTaxConfiguration",
          targetId: mode === "Abandon" ? command.operationReference : must(configurationReference),
          reasonCode: "AUTHORIZED_OPERATION",
          correlationId: command.operationReference,
          occurredAt,
          sourceChannel: "API",
          dataClassification: "Internal",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
          afterSummary: { intentDigest },
        }),
      ),
    },
  };
  const source = createPostgresTaxConfigAuthoringStore(options);
  const command = parseTaxConfigAuthoringCommand({
    action: "CreateDraft",
    operationReference: id(20),
    configurationReference: null,
    expectedAggregateVersion: null,
    content: {
      stableCode: "SYNTHETIC_TAX",
      effectivePeriod: q.taxConfiguration.effectivePeriod,
      rules: [
        {
          taxClassificationReference: id(8),
          orderType: "Pickup",
          chargeType: "Sellable",
          taxComponentCode: "SYNTHETIC_TAX",
          treatment: "Taxable",
          rate: "0.13",
          priceInclusion: "Exclusive",
          roundingMode: "HalfUp",
          calculationOrder: 1,
          compoundOnPriorTax: false,
          exceptionEvidenceReference: null,
          receiptPresentationCode: "SYNTHETIC_TAX",
        },
      ],
    },
  });
  const resolve = {
    action: command.action,
    operationReference: command.operationReference,
    configurationReference: null,
    expectedAggregateVersion: null,
    intentDigest: taxConfigAuthoringIntentDigest(scope, command),
  };
  async function finalize() {
    for (const h of hooks) await h.guard();
    for (const h of hooks) h.final();
    return source.assertFinalized();
  }
  return {
    db,
    scope,
    source,
    options,
    command,
    resolve,
    queries,
    hooks,
    finalize,
    setNow: (value: string) => {
      now = value;
    },
    deny: () => {
      allowed = false;
    },
    shorten: (value: string) => {
      lease = value;
    },
    drift: (fn: (row: Row) => Row) => {
      sourceDrift = fn;
    },
  };
}

describe("transaction-held Tax Draft authoring (controlled SQL)", () => {
  it("uses the actual service, Audit chain and seven-field Eventing envelope with distinct original hashes", async () => {
    const f = fixture();
    const result = await f.source.execute(f.command);
    expect(result.outcome).toBe("Committed");
    expect(result.configurationReference).toBeNull();
    expect(result.snapshot?.aggregateVersion).toBe(1);
    expect(result.snapshot?.professionalEvidence).toBeNull();
    expect(result.snapshot?.registrationEvidence).toBeNull();
    expect(result.intentDigest).not.toBe(result.serviceIntentDigest);
    expect(f.db.audits).toHaveLength(1);
    expect(f.db.events.size).toBe(1);
    const event = must([...f.db.events.values()][0]);
    expect(Object.keys(event.payload_json as object)).toHaveLength(7);
    expect((event.payload_json as Row).aggregateVersion).toBe("1");
    expect(f.hooks).toHaveLength(1);
    expect(await f.finalize()).toBe(f.options.originalValidUntil);
    const lock = f.queries.findIndex((q) => q.sql.includes("PricingTaxConfigOriginal:"));
    const root = f.queries.findIndex((q) => q.sql.includes("PricingTaxConfigRoot:"));
    expect(lock).toBeLessThan(root);
    const final = f.queries.findLast((q) => q.sql.startsWith("SET CONSTRAINTS"));
    expect(final?.sql).toBe(
      "SET CONSTRAINTS rms_pricing.tax_config_version_original_coherence,rms_pricing.tax_config_authoring_terminal_coherence IMMEDIATE",
    );
  });
  it("recovers Create with its original null tuple and without today currency, facts or allocation", async () => {
    const first = fixture();
    const original = await first.source.execute(first.command);
    await first.finalize();
    const f = fixture(first.db);
    f.options.currency.readCurrent = vi.fn(async () => {
      throw new Error("today source absent");
    });
    const replaySource = createPostgresTaxConfigAuthoringStore(f.options);
    expect(await replaySource.resolve(f.resolve)).toEqual(original);
    expect(f.options.references.generate).not.toHaveBeenCalled();
    expect(f.options.currency.readCurrent).not.toHaveBeenCalled();
    expect(f.options.facts.validateDraft).not.toHaveBeenCalled();
    for (const h of f.hooks) await h.guard();
    for (const h of f.hooks) h.final();
    replaySource.assertFinalized();
    expect(f.db.audits).toHaveLength(1);
  });
  it("replaces under CAS, keeps the old original immutable and exposes the actual historical writer", async () => {
    const first = fixture();
    const old = await first.source.execute(first.command);
    await first.finalize();
    const f = fixture(first.db, id(5));
    const replace = {
      ...f.command,
      action: "ReplaceDraft",
      operationReference: id(21),
      configurationReference: must(old.snapshot).configurationReference,
      expectedAggregateVersion: 1,
    };
    const changed = await f.source.execute(replace);
    expect(changed.snapshot?.aggregateVersion).toBe(2);
    expect(changed.snapshot?.versionReference).not.toBe(old.snapshot?.versionReference);
    await f.finalize();
    const reader = fixture(first.db);
    expect(
      (await reader.source.readCurrent(must(old.snapshot).configurationReference)).state
        ?.draftAuthorActorReference,
    ).toBe(id(5));
    await reader.finalize();
    const replay = fixture(first.db);
    expect(await replay.source.execute(first.command)).toEqual(old);
    await replay.finalize();
  });
  it("rejects changing stableCode on a genuine current root before allocating new identities", async () => {
    const first = fixture();
    const old = await first.source.execute(first.command);
    await first.finalize();
    const f = fixture(first.db);
    await expect(
      f.source.execute({
        ...f.command,
        action: "ReplaceDraft",
        operationReference: id(21),
        configurationReference: must(old.snapshot).configurationReference,
        expectedAggregateVersion: 1,
        content: { ...f.command.content, stableCode: "OTHER_TAX" },
      }),
    ).rejects.toMatchObject({ code: "TAX_CONFIG_INPUT_INVALID" });
    expect(f.options.references.generate).not.toHaveBeenCalled();
    expect(first.db.audits).toHaveLength(1);
  });
  it("denies a stale CAS before allocation and keeps existing writes unchanged", async () => {
    const first = fixture();
    const old = await first.source.execute(first.command);
    await first.finalize();
    const f = fixture(first.db);
    await expect(
      f.source.execute({
        ...f.command,
        action: "ReplaceDraft",
        operationReference: id(21),
        configurationReference: must(old.snapshot).configurationReference,
        expectedAggregateVersion: 2,
      }),
    ).rejects.toMatchObject({ code: "TAX_CONFIG_VERSION_CONFLICT" });
    expect(f.options.references.generate).not.toHaveBeenCalled();
    expect(f.db.originals.size).toBe(1);
  });
  it("persists genuine Abandoned audit and blocks a late writer without inventing content or events", async () => {
    const f = fixture();
    const abandoned = await f.source.resolve(f.resolve);
    expect(abandoned).toMatchObject({
      outcome: "Abandoned",
      command: null,
      snapshot: null,
      eventReference: null,
      serviceIntentDigest: null,
    });
    expect(f.db.audits).toHaveLength(1);
    expect(f.db.events.size).toBe(0);
    await f.finalize();
    const late = fixture(f.db);
    expect(await late.source.execute(f.command)).toEqual(abandoned);
    await late.finalize();
    expect(late.options.facts.validateDraft).not.toHaveBeenCalled();
    expect(late.options.references.generate).not.toHaveBeenCalled();
  });
  it("does not turn an RLS-hidden legacy global original into Abandoned", async () => {
    const f = fixture();
    f.db.hidden.add(f.command.operationReference);
    await expect(f.source.resolve(f.resolve)).rejects.toMatchObject({
      code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.db.audits).toHaveLength(0);
    expect(f.db.originals.size).toBe(0);
    expect(f.queries.some((q) => q.sql.includes("tax_config_authoring_operation_available"))).toBe(
      true,
    );
  });
  it("does not turn an actual legacy 001 operation into a new authoring receipt", async () => {
    const f = fixture();
    f.db.legacy.set(f.command.operationReference, {
      operationReference: f.command.operationReference,
    });
    await expect(f.source.execute(f.command)).rejects.toMatchObject({
      code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.db.audits).toHaveLength(0);
    expect(f.options.references.generate).not.toHaveBeenCalled();
  });
  it("keeps original Actor and body identity binding", async () => {
    const first = fixture();
    await first.source.execute(first.command);
    await first.finalize();
    const foreign = fixture(first.db, id(5));
    await expect(foreign.source.resolve(foreign.resolve)).rejects.toMatchObject({
      code: "TAX_CONFIG_PERMISSION_DENIED",
    });
    const changed = fixture(first.db);
    await expect(
      changed.source.execute({
        ...changed.command,
        content: { ...changed.command.content, rules: [] },
      }),
    ).rejects.toMatchObject({ code: "TAX_CONFIG_IDEMPOTENCY_CONFLICT" });
  });
  it("requires the actual persisted Outbox event, not just a receipt event ID", async () => {
    const first = fixture();
    const receipt = await first.source.execute(first.command);
    await first.finalize();
    first.db.events.delete(must(receipt.eventReference));
    const f = fixture(first.db);
    await expect(f.source.resolve(f.resolve)).rejects.toMatchObject({
      code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("rejects a corrupted actual event payload and a changed service byte preimage", async () => {
    const first = fixture();
    const receipt = await first.source.execute(first.command);
    await first.finalize();
    const event = must(first.db.events.get(must(receipt.eventReference)));
    const saved = copy(event);
    (event.payload_json as Row).aggregateVersion = "2";
    await expect(fixture(first.db).source.resolve(first.resolve)).rejects.toMatchObject({
      code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    });
    Object.assign(event, saved);
    const row = must(first.db.originals.get(first.command.operationReference));
    row.service_input_json = String(row.service_input_json) + " ";
    await expect(fixture(first.db).source.resolve(first.resolve)).rejects.toMatchObject({
      code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("refuses claiming a legacy current version has a known author and full currency facts", async () => {
    const first = fixture();
    const receipt = await first.source.execute(first.command);
    await first.finalize();
    must(
      first.db.versions.get(must(receipt.snapshot).versionReference),
    ).authoringOperationReference = null;
    await expect(
      fixture(first.db).source.readCurrent(must(receipt.snapshot).configurationReference),
    ).rejects.toMatchObject({ code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE" });
  });
  it("reads a bounded sorted roster and detects a changed current root in its final guard", async () => {
    const first = fixture();
    await first.source.execute(first.command);
    await first.finalize();
    const second = fixture(first.db);
    await second.source.execute({
      ...second.command,
      operationReference: id(21),
      content: { ...second.command.content, stableCode: "SECOND_TAX" },
    });
    await second.finalize();
    const f = fixture(first.db);
    const page = await f.source.readRoster(null);
    expect(page.entries).toHaveLength(2);
    expect(page.nextAfterConfiguration).toBeNull();
    expect(page.entries.map((e) => e.snapshot.configurationReference)).toEqual(
      [...page.entries.map((e) => e.snapshot.configurationReference)].sort(),
    );
    must(f.db.roots.get(must(page.entries[0]).snapshot.configurationReference)).aggregateVersion =
      99;
    await expect(must(f.hooks[0]).guard()).rejects.toMatchObject({
      code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("requires both actual host hooks and refuses reusing a completed source", async () => {
    const f = fixture();
    await f.source.readCurrent(null);
    expect(() => f.source.assertFinalized()).toThrow();
    await must(f.hooks[0]).guard();
    expect(() => f.source.assertFinalized()).toThrow();
    must(f.hooks[0]).final();
    f.source.assertFinalized();
    await expect(f.source.readCurrent(null)).rejects.toMatchObject({
      code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("keeps a shorter source lease and refuses late expiry and clock reversal", async () => {
    const f = fixture();
    f.shorten("2026-08-02T16:00:01.000Z");
    expect((await f.source.readCurrent(null)).validUntil).toBe("2026-08-02T16:00:01.000Z");
    f.setNow("2026-08-02T16:00:01.000Z");
    await expect(must(f.hooks[0]).guard()).rejects.toMatchObject({
      code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    });
    const g = fixture();
    g.setNow("2026-08-02T16:00:00.500Z");
    await g.source.readCurrent(null);
    g.setNow(at);
    await expect(must(g.hooks[0]).guard()).rejects.toMatchObject({
      code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("rechecks real current authority even for an original terminal", async () => {
    const first = fixture();
    await first.source.execute(first.command);
    await first.finalize();
    const f = fixture(first.db);
    await f.source.resolve(f.resolve);
    f.deny();
    await expect(must(f.hooks[0]).guard()).rejects.toMatchObject({
      code: "TAX_CONFIG_PERMISSION_DENIED",
    });
    expect(() => f.source.assertFinalized()).toThrow();
  });
  it("poisons query and callback replacement and cannot hide failed reentry", async () => {
    const f = fixture();
    await f.source.readCurrent(null);
    const capturedQuery = f.options.transaction.query;
    f.options.transaction.query = async <R>(sql: string, values: readonly unknown[]) =>
      capturedQuery<R>(sql, values);
    await expect(must(f.hooks[0]).guard()).rejects.toMatchObject({
      code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    });
    const g = fixture();
    g.options.facts.validateDraft = vi.fn(async () => {
      await source.readCurrent(null).catch(() => undefined);
    });
    const source = createPostgresTaxConfigAuthoringStore(g.options);
    await expect(source.execute(g.command)).rejects.toMatchObject({
      code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("rejects a non-void registration and a live source identity mismatch", async () => {
    const f = fixture();
    Object.defineProperty(f.options, "registerBeforeCommit", { value: () => 1 });
    const source = createPostgresTaxConfigAuthoringStore(f.options);
    await expect(source.readCurrent(null)).rejects.toMatchObject({
      code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    });
    const g = fixture();
    g.options.authority.holdUntilTransactionCompletes = vi.fn(async () => {
      throw new Error("raw source secret must not escape");
    });
    await expect(
      createPostgresTaxConfigAuthoringStore(g.options).readCurrent(null),
    ).rejects.toMatchObject({ code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE" });
  });
  it("retains full-source final coherence rather than only the current version number", async () => {
    const f = fixture();
    await f.source.execute(f.command);
    f.drift((row) => ({
      ...row,
      version: { ...(row.version as Row), currencyMetadataDigest: "sha256:" + "f".repeat(64) },
    }));
    await expect(must(f.hooks[0]).guard()).rejects.toMatchObject({
      code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("matches scope-bound RFC8785 hash instead of the service preimage", () => {
    const f = fixture();
    expect(f.resolve.intentDigest).toBe(
      "sha256:" + sha256Hex(canonicalizeRfc8785({ scope: f.scope, command: f.command })),
    );
  });
});

it("rejects an unsupported fresh effective zone before allocating or appending", async () => {
  const f = fixture();
  const instant = f.command.content.effectivePeriod.effectiveFrom.instant;
  const command = {
    ...f.command,
    content: {
      ...f.command.content,
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant, localDateTime: instant.slice(0, -1), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    },
  };
  await expect(f.source.execute(command)).rejects.toMatchObject({
    code: "TAX_CONFIG_INPUT_INVALID",
  });
  expect(f.options.references.generate).not.toHaveBeenCalled();
});

describe("exact historical Tax Draft read", () => {
  it("reads the original immutable Draft after a rate replacement under a different current reader", async () => {
    const f = fixture(),
      original = await f.source.execute(f.command),
      old = must(original.snapshot);
    await f.finalize();
    const writer = fixture(f.db, id(90)),
      rule = must(writer.command.content.rules[0]);
    const replaced = await writer.source.execute({
      ...writer.command,
      action: "ReplaceDraft",
      operationReference: id(91),
      configurationReference: old.configurationReference,
      expectedAggregateVersion: old.aggregateVersion,
      content: { ...writer.command.content, rules: [{ ...rule, rate: "0.14" }] },
    });
    await writer.finalize();
    expect(replaced.snapshot?.rules[0]?.rate).toBe("0.14");
    const reader = fixture(f.db, id(92));
    reader.options.currency.readCurrent = vi.fn(async () => {
      throw new Error("today currency unavailable");
    });
    const source = createPostgresTaxConfigAuthoringStore(reader.options);
    const historical = await source.readVersion({
      configurationReference: old.configurationReference,
      versionReference: old.versionReference,
    });
    expect(historical.actorReference).toBe(id(92));
    expect(historical.state?.draftAuthorActorReference).toBe(f.scope.actorReference);
    expect(historical.state?.snapshot).toEqual(old);
    expect(reader.options.currency.readCurrent).not.toHaveBeenCalled();
    expect(reader.options.facts.validateDraft).not.toHaveBeenCalled();
    for (const h of reader.hooks) await h.guard();
    for (const h of reader.hooks) h.final();
    source.assertFinalized();
    const currentReader = fixture(f.db);
    expect(
      (await currentReader.source.readCurrent(old.configurationReference)).state?.snapshot,
    ).toEqual(replaced.snapshot);
    await currentReader.finalize();
  });
  it("keeps the accepted stable-code identity rule and refuses Rename before allocation", async () => {
    const f = fixture(),
      original = await f.source.execute(f.command),
      old = must(original.snapshot);
    await f.finalize();
    const writer = fixture(f.db);
    await expect(
      writer.source.execute({
        ...writer.command,
        action: "ReplaceDraft",
        operationReference: id(91),
        configurationReference: old.configurationReference,
        expectedAggregateVersion: old.aggregateVersion,
        content: { ...writer.command.content, stableCode: "RENAMED_TAX" },
      }),
    ).rejects.toMatchObject({ code: "TAX_CONFIG_INPUT_INVALID" });
    expect(writer.options.references.generate).not.toHaveBeenCalled();
    expect(f.db.versions.size).toBe(1);
    const reader = fixture(f.db);
    expect(
      (
        await reader.source.readVersion({
          configurationReference: old.configurationReference,
          versionReference: old.versionReference,
        })
      ).state?.snapshot.stableCode,
    ).toBe(old.stableCode);
    await reader.finalize();
  });
  it("does not silently substitute today's version for a wrong configuration or historical version pin", async () => {
    const f = fixture(),
      original = await f.source.execute(f.command),
      old = must(original.snapshot);
    await f.finalize();
    for (const requested of [
      { configurationReference: id(98), versionReference: old.versionReference },
      { configurationReference: old.configurationReference, versionReference: id(99) },
    ]) {
      const reader = fixture(f.db);
      await expect(reader.source.readVersion(requested)).rejects.toMatchObject({
        code: "TAX_CONFIG_VERSION_CONFLICT",
      });
    }
  });
  it("refuses legacy summary versions without the genuine full authoring original", async () => {
    const f = fixture(),
      original = await f.source.execute(f.command),
      old = must(original.snapshot);
    await f.finalize();
    const version = must(f.db.versions.get(old.versionReference));
    version.authoringOperationReference = null;
    const reader = fixture(f.db);
    await expect(
      reader.source.readVersion({
        configurationReference: old.configurationReference,
        versionReference: old.versionReference,
      }),
    ).rejects.toMatchObject({ code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE" });
    expect(reader.options.references.generate).not.toHaveBeenCalled();
  });
  it("checks genuine current authority again at COMMIT even for an immutable historical Draft", async () => {
    const f = fixture(),
      original = await f.source.execute(f.command),
      old = must(original.snapshot);
    await f.finalize();
    const reader = fixture(f.db);
    await reader.source.readVersion({
      configurationReference: old.configurationReference,
      versionReference: old.versionReference,
    });
    reader.deny();
    await expect(reader.finalize()).rejects.toMatchObject({ code: "TAX_CONFIG_PERMISSION_DENIED" });
  });
  it("retains the original five-second deadline while reading historical content", async () => {
    const f = fixture(),
      original = await f.source.execute(f.command),
      old = must(original.snapshot);
    await f.finalize();
    const reader = fixture(f.db);
    await reader.source.readVersion({
      configurationReference: old.configurationReference,
      versionReference: old.versionReference,
    });
    reader.setNow("2026-08-02T16:00:05.000Z");
    await expect(reader.finalize()).rejects.toMatchObject({
      code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("revalidates actual immutable historical source rules at the final owning guard", async () => {
    const f = fixture(),
      original = await f.source.execute(f.command),
      old = must(original.snapshot);
    await f.finalize();
    const reader = fixture(f.db);
    await reader.source.readVersion({
      configurationReference: old.configurationReference,
      versionReference: old.versionReference,
    });
    const rows = must(f.db.rules.get(old.versionReference)),
      rule = must(rows[0]);
    rule.rate = "0.99";
    await expect(reader.finalize()).rejects.toMatchObject({
      code: "TAX_CONFIG_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("rejects extra selectors and accessors without using them to read another version", async () => {
    const f = fixture();
    await expect(
      f.source.readVersion({
        configurationReference: id(1),
        versionReference: id(2),
        latest: true,
      }),
    ).rejects.toMatchObject({ code: "TAX_CONFIG_INPUT_INVALID" });
    let calls = 0;
    const request = { configurationReference: id(1), versionReference: id(2) };
    Object.defineProperty(request, "versionReference", {
      enumerable: true,
      get() {
        calls++;
        return id(2);
      },
    });
    const other = fixture();
    await expect(other.source.readVersion(request)).rejects.toMatchObject({
      code: "TAX_CONFIG_INPUT_INVALID",
    });
    expect(calls).toBe(0);
  });
});
