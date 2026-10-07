import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEventEnvelope } from "@bop/eventing";
import { input } from "./price-quote.fixture.js";
import { parsePricingReference } from "../domain/money-tax-contract.js";
import {
  OptionPriceAuthoringError,
  materializeOptionPriceVersion,
  optionPriceWireSnapshot,
  parseOptionPriceAuthoringCommand,
  parseOptionPriceAuthoringContent,
} from "../contracts/option-price-authoring.js";
import {
  createPostgresOptionPriceAuthoringStore,
  type OptionPriceAuthoringStoreOptions,
  type OptionPriceAuthoringTransaction,
} from "../infrastructure/persistence/option-price-authoring-store.js";
// Controlled SQL and public Audit/Eventing boundaries. This is owner behavior
// coverage, not PostgreSQL, real IAM, policy acquisition or durable COMMIT proof.
const boundary = vi.hoisted(() => ({
  events: new Map<string, DomainEventEnvelope>(),
  audits: vi.fn(),
  append: vi.fn(),
}));
vi.mock("@bop/audit", async () => {
  const actual = await vi.importActual<typeof import("@bop/audit")>("@bop/audit");
  return { ...actual, appendAuditRecordInTransaction: boundary.audits };
});
vi.mock("@bop/eventing", async () => {
  const actual = await vi.importActual<typeof import("@bop/eventing")>("@bop/eventing");
  return {
    ...actual,
    appendEventInTransaction: async (_tx: unknown, event: DomainEventEnvelope) => {
      void _tx;
      actual.validateDomainEventEnvelope(event);
      boundary.append(event);
      boundary.events.set(event.eventId, event);
    },
    loadOutboxEnvelope: async (_tx: unknown, id: string) => {
      void _tx;
      return boundary.events.get(id) ?? null;
    },
  };
});
const id = (n: number) =>
  parsePricingReference("018fb000-0000-7000-8000-" + n.toString(16).padStart(12, "0"));
function fixture(publication?: "NotRequired" | "Required" | "SelfApproval", deferredModel = false) {
  const q = input(),
    entry = q.priceBook.entries[0];
  if (!entry) throw new Error("controlled fixture incomplete");
  let at = q.createdAt,
    allowed = true,
    available = true,
    serial = 300;
  const queries: { sql: string; values: readonly unknown[] }[] = [],
    versions = new Map<string, { snapshot: unknown; number: string }>(),
    originals = new Map<string, Record<string, unknown>>();
  let root: Record<string, unknown> | null = null;
  let currentStore: unknown = null,
    pendingConstraint = false,
    constraintDenied = false;
  const checkDeferred = () => {
    if (!pendingConstraint) return;
    if (constraintDenied || currentStore !== q.storeReference || originals.size === 0)
      throw new OptionPriceAuthoringError("OPTION_PRICE_DEPENDENCY_UNAVAILABLE");
    pendingConstraint = false;
  };
  let listRows: unknown[] | undefined;
  const publicationEntries: number[] = [];
  const acquisitionOrder: string[] = [];
  const command = parseOptionPriceAuthoringCommand({
    action: "CreateDraft",
    operationReference: id(250),
    ruleReference: id(251),
    expectedAggregateVersion: null,
    bindingReference: id(252),
    optionReference: id(253),
    content: {
      skuReference: null,
      scopeKind: "Brand",
      scopeReference: null,
      channelCode: null,
      orderType: null,
      unitAmountMinor: "125",
      includedQuantity: 1,
      effectivePeriod: entry.effectivePeriod,
    },
  });
  const tx: OptionPriceAuthoringTransaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      queries.push({ sql, values });
      if (deferredModel) {
        if (sql.includes("set_config('bop.store_id',$2,true)")) currentStore = values[1];
        else if (sql.includes("set_config('bop.store_id',$1,true)")) currentStore = values[0];
        else if (sql.includes("set_config('bop.store_id','',true)")) currentStore = null;
        if (sql.startsWith("SET CONSTRAINTS rms_pricing.")) checkDeferred();
      }
      if (sql.includes("SHARE ROW EXCLUSIVE")) acquisitionOrder.push("PricingSRE");
      if (String(values[0]).startsWith("PricingOptionPriceRule:"))
        acquisitionOrder.push("PricingRule");
      let rows: unknown[] = [];
      let rowCount = 1;
      if (sql.includes("operation_available")) rows = [{ available }];
      else if (sql.startsWith("SELECT receipt_json"))
        rows = originals.has(String(values[1])) ? [originals.get(String(values[1]))] : [];
      else if (sql.startsWith("SELECT option_price_rule_id::text rule_reference"))
        rows =
          listRows ??
          (root &&
          root.brand_id === values[0] &&
          root.binding_id === values[1] &&
          root.option_id === values[2]
            ? [{ rule_reference: root.rule_id }]
            : []);
      else if (sql.startsWith("SELECT r.option_price_rule_id"))
        rows = root
          ? [...versions.values()]
              .sort((a, b) => Number(b.number) - Number(a.number))
              .map((v) => ({
                ...root,
                version_number: v.number,
                snapshot: v.snapshot,
                precise: true,
              }))
          : [];
      else if (sql.includes("FROM rms_pricing.option_price_rule_version v")) {
        const v = versions.get(String(values[2]));
        rows = v ? [{ version_number: v.number, snapshot: v.snapshot }] : [];
      } else if (sql.startsWith("SELECT jsonb_build_object")) rows = [];
      else if (sql.startsWith("INSERT INTO rms_pricing.option_price_rule("))
        root = {
          rule_id: values[0],
          brand_id: values[1],
          binding_id: values[2],
          option_id: values[3],
          aggregate_version: "1",
          current_version_id: null,
          draft_version_id: null,
          draft_author_actor_id: null,
          created_at: values[4],
          created_by_actor_id: values[5],
          updated_at: values[4],
        };
      else if (sql.startsWith("INSERT INTO rms_pricing.option_price_rule_version")) {
        const current = command;
        const version = materializeOptionPriceVersion({
          command: {
            ...current,
            content: parseOptionPriceAuthoringContent({
              ...current.content,
              unitAmountMinor: String(values[18]),
            }),
          },
          current: null,
          brandReference: q.brandReference,
          versionReference: String(values[0]),
          occurredAt: String(values[24]),
          currencyMetadata: q.currencyMetadata,
        });
        versions.set(String(values[0]), {
          number: String(values[5]),
          snapshot: {
            ...optionPriceWireSnapshot(version),
            snapshotDigest: values[6],
            lifecycle: values[7],
          },
        });
      } else if (sql.startsWith("UPDATE rms_pricing.option_price_rule SET")) {
        if (!root || root.aggregate_version !== String(values[7])) rowCount = 0;
        else
          root = {
            ...root,
            aggregate_version: String(values[0]),
            current_version_id: values[1],
            draft_version_id: values[2],
            draft_author_actor_id: values[3],
            updated_at: values[4],
          };
      } else if (sql.startsWith("INSERT INTO rms_pricing.option_price_authoring_operation")) {
        originals.set(String(values[0]), {
          receipt_json: JSON.parse(String(values[11])),
          record_digest: values[12],
          audit_json: JSON.parse(String(values[14])),
          event_id: values[15],
        });
        if (deferredModel) pendingConstraint = true;
      }
      return { rows: rows as Row[], rowCount };
    },
  };
  const hooks: { guard: () => Promise<void>; final: () => void }[] = [];
  const authority = vi.fn(
    async (
      currentTx: OptionPriceAuthoringTransaction,
      request: Parameters<
        OptionPriceAuthoringStoreOptions["authority"]["holdUntilTransactionCompletes"]
      >[1],
    ) => {
      expect(currentTx).toBe(tx);
      acquisitionOrder.push(request.mode === "Write" ? "CatalogWrite" : "CurrentRead");
      if (!allowed) throw new OptionPriceAuthoringError("OPTION_PRICE_PERMISSION_DENIED");
      return until;
    },
  );
  const generate = vi.fn(() => id(++serial));
  const until = "2026-08-02T16:00:05.000Z";
  const options: OptionPriceAuthoringStoreOptions = {
    transaction: tx,
    tenantReference: id(260),
    brandReference: q.brandReference,
    selectedStoreReference: q.storeReference,
    actorReference: id(261),
    currencyMetadata: q.currencyMetadata,
    originalObservedAt: at,
    originalValidUntil: until,
    clock: { now: () => at },
    authority: { holdUntilTransactionCompletes: authority },
    references: { generate },
    audit: {
      create: ({ auditReference, command: cmd, occurredAt, mode }) => ({
        auditId: auditReference,
        brandId: q.brandReference,
        actor: { type: "User", reference: id(261) },
        actionCode:
          mode === "Abandon"
            ? "PRICING_OPTION_PRICE_RESOLVE"
            : "PRICING_OPTION_PRICE_" + cmd.action.toUpperCase(),
        targetType: "PricingOptionPriceRule",
        targetId: cmd.ruleReference,
        reasonCode: "AUTHORIZED_OPERATION",
        correlationId: cmd.operationReference,
        occurredAt,
        sourceChannel: "API",
        dataClassification: "Internal",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      }),
    },
    registerBeforeCommit: (_tx, guard, final) => {
      expect(_tx).toBe(tx);
      hooks.push({ guard, final });
    },
  };
  const configured: OptionPriceAuthoringStoreOptions = publication
    ? {
        ...options,
        publicationPolicyFamilyReference: id(279),
        publicationSource: {
          async withCurrentAuthorization<T>(
            _tx: OptionPriceAuthoringTransaction,
            request: Parameters<
              NonNullable<
                OptionPriceAuthoringStoreOptions["publicationSource"]
              >["withCurrentAuthorization"]
            >[1],
            work: (
              packet: import("../infrastructure/persistence/option-price-authoring-store.js").OptionPricePublicationAuthorization,
            ) => Promise<T>,
          ): Promise<T> {
            publicationEntries.push(queries.length);
            acquisitionOrder.push("PublishingSource");
            expect(_tx).toBe(tx);
            const draft = request.state.draft,
              author = request.state.draftAuthorActorReference;
            if (!draft || !author) throw new Error("missing actual controlled Draft");
            return work({
              policy: {
                profile: "PublishingOptionPricePublicationPolicyV1",
                tenantReference: options.tenantReference,
                brandReference: q.brandReference,
                familyReference: id(279),
                policyReference: id(280),
                policyVersion: 1,
                approvalPolicy: publication === "NotRequired" ? "NotRequired" : "Required",
                effectiveFrom: at,
                effectiveUntil: null,
              },
              currentPolicyPublicationReference: id(281),
              draftVersionReference: draft.versionReference,
              draftSnapshotDigest: draft.snapshotDigest,
              draftAuthorActorReference: author,
              approvalEvidenceReference: publication === "NotRequired" ? null : id(282),
              approvedActorReference:
                publication === "NotRequired"
                  ? null
                  : publication === "SelfApproval"
                    ? author
                    : id(283),
              observedAt: at,
              validUntil: until,
            });
          },
        },
      }
    : options;
  const source = createPostgresOptionPriceAuthoringStore(configured);
  async function finalize() {
    for (const hook of hooks) await hook.guard();
    for (const hook of hooks) hook.final();
    return source.assertFinalized();
  }
  return {
    q,
    command,
    tx,
    options: configured,
    source,
    queries,
    publicationEntries,
    acquisitionOrder,
    corruptList: (rows: unknown[]) => {
      listRows = rows;
    },
    versions,
    originals,
    hooks,
    authority,
    generate,
    finalize,
    checkDeferred,
    denyConstraint: () => {
      constraintDenied = true;
    },
    setTime: (value: string) => {
      at = value;
    },
    withdraw: () => {
      allowed = false;
    },
    unavailable: () => {
      available = false;
    },
  };
}
beforeEach(() => {
  boundary.events.clear();
  boundary.audits.mockReset();
  boundary.append.mockReset();
});
describe("fixed Option price authoring owning transaction", () => {
  it("checks new originals in their selected scope before later Catalog guards clear Store", async () => {
    const f = fixture(undefined, true);
    await f.source.execute(f.command);
    f.hooks.push({
      guard: async () => {
        await f.tx.query("SELECT set_config('bop.store_id','',true)", []);
        // Model the real outer deferred check under Catalog's final Brand scope.
        // An unflushed original would now be hidden by selected-Store RLS.
        f.checkDeferred();
      },
      final: () => undefined,
    });
    await f.finalize();
    expect(boundary.append).toHaveBeenCalledTimes(1);
    expect(boundary.audits).toHaveBeenCalledTimes(1);
  });
  it("refuses finalization and further work when the owning deferred constraint rejects", async () => {
    const f = fixture(undefined, true);
    await f.source.execute(f.command);
    f.denyConstraint();
    await expect(f.finalize()).rejects.toMatchObject({
      code: "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
    });
    expect(() => f.source.assertFinalized()).toThrow();
    await expect(f.source.resolve(f.command)).rejects.toBeDefined();
  });
  it("does not let a successful owning constraint check skip a later permission withdrawal", async () => {
    const f = fixture(undefined, true);
    await f.source.execute(f.command);
    f.hooks.push({
      guard: async () => {
        f.withdraw();
        const original = f.authority.mock.calls[0];
        if (!original) throw new Error("missing controlled original admission");
        await f.authority(f.tx, original[1]);
      },
      final: () => undefined,
    });
    await expect(f.finalize()).rejects.toMatchObject({ code: "OPTION_PRICE_PERMISSION_DENIED" });
    expect(() => f.source.assertFinalized()).toThrow();
  });
  it("flushes a new Abandoned original without a version while read and existing replay do not flush", async () => {
    const f = fixture(undefined, true);
    const abandoned = await f.source.resolve(f.command);
    f.hooks.push({
      guard: async () => {
        await f.tx.query("SELECT set_config('bop.store_id','',true)", []);
        f.checkDeferred();
      },
      final: () => undefined,
    });
    await f.finalize();
    expect(f.queries.some((entry) => entry.sql.startsWith("SET CONSTRAINTS"))).toBe(true);
    expect(f.versions.size).toBe(0);
    const replay = createPostgresOptionPriceAuthoringStore(f.options);
    const beforeReplay = f.queries.length;
    expect(await replay.resolve(f.command)).toEqual(abandoned);
    const replayHook = f.hooks.at(-1);
    if (!replayHook) throw new Error("missing controlled replay guard");
    await replayHook.guard();
    replayHook.final();
    expect(() => replay.assertFinalized()).not.toThrow();
    expect(
      f.queries.slice(beforeReplay).some((entry) => entry.sql.startsWith("SET CONSTRAINTS")),
    ).toBe(false);
    const read = fixture(undefined, true);
    await read.source.readCurrent(read.command.ruleReference);
    await read.finalize();
    expect(read.queries.some((entry) => entry.sql.startsWith("SET CONSTRAINTS"))).toBe(false);
    expect(boundary.append).not.toHaveBeenCalled();
  });
  it("treats malformed or duplicate owning discovery rows as unavailable and poisons finalization", async () => {
    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "rule_reference", {
      enumerable: true,
      get() {
        accessorCalls++;
        return id(251);
      },
    });
    for (const rows of [[accessor], [{ rule_reference: id(251) }, { rule_reference: id(251) }]]) {
      const f = fixture();
      await f.source.execute(f.command);
      f.corruptList(rows);
      await expect(
        f.source.listForBinding({
          bindingReference: f.command.bindingReference,
          optionReference: f.command.optionReference,
        }),
      ).rejects.toMatchObject({ code: "OPTION_PRICE_DEPENDENCY_UNAVAILABLE" });
      await expect(f.finalize()).rejects.toMatchObject({
        code: "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
      });
    }
    expect(accessorCalls).toBe(0);
  });
  it("lists actual Draft and published state by immutable Binding and Choice under owning read lock", async () => {
    const f = fixture("NotRequired");
    await f.source.execute(f.command);
    await f.source.execute({
      ...f.command,
      action: "Publish",
      operationReference: id(320),
      expectedAggregateVersion: 1,
      bindingReference: null,
      optionReference: null,
      content: null,
    });
    await f.source.execute({
      ...f.command,
      operationReference: id(321),
      expectedAggregateVersion: 2,
    });
    const entered = f.queries.length;
    const result = await f.source.listForBinding({
      bindingReference: f.command.bindingReference,
      optionReference: f.command.optionReference,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.currentPublished?.lifecycle).toBe("Published");
    expect(result[0]?.draft?.lifecycle).toBe("Draft");
    expect(result[0]?.aggregateVersion).toBe(3);
    expect(f.queries.slice(entered).findIndex((q) => q.sql.includes("IN SHARE MODE"))).toBeLessThan(
      f.queries
        .slice(entered)
        .findIndex((q) => q.sql.startsWith("SELECT option_price_rule_id::text rule_reference")),
    );
    expect(
      await f.source.listForBinding({
        bindingReference: id(322),
        optionReference: f.command.optionReference,
      }),
    ).toEqual([]);
    expect(
      await f.source.listForBinding({
        bindingReference: f.command.bindingReference,
        optionReference: id(323),
      }),
    ).toEqual([]);
    await f.finalize();
  });
  it("refuses a Binding list when current owning permission is revoked", async () => {
    const f = fixture();
    await f.source.execute(f.command);
    f.withdraw();
    await expect(
      f.source.listForBinding({
        bindingReference: f.command.bindingReference,
        optionReference: f.command.optionReference,
      }),
    ).rejects.toMatchObject({ code: "OPTION_PRICE_PERMISSION_DENIED" });
    expect(
      f.queries.some((q) => q.sql.startsWith("SELECT option_price_rule_id::text rule_reference")),
    ).toBe(false);
  });
  it("writes Draft with server version, actual Audit then Outbox and original terminal", async () => {
    const f = fixture();
    const result = await f.source.execute(f.command);
    expect(result.state?.draft?.unitAmount.amountMinor).toBe(125n);
    expect(result.state?.currentPublished).toBeNull();
    expect(boundary.audits).toHaveBeenCalledTimes(1);
    expect(boundary.append).toHaveBeenCalledTimes(1);
    expect(f.queries.find((q) => q.sql.includes("rule_version("))?.values[25]).toBe(
      f.command.operationReference,
    );
    expect(
      f.queries.findIndex((q) => q.sql.includes("authoring_operation(operation")),
    ).toBeGreaterThan(f.queries.findIndex((q) => q.sql.startsWith("UPDATE")));
    await expect(f.finalize()).resolves.toBe(f.options.originalValidUntil);
  });
  it("replays exact original with no allocation or new Audit/Event and real public Event read", async () => {
    const f = fixture();
    const first = await f.source.execute(f.command),
      allocations = f.generate.mock.calls.length;
    const second = await f.source.execute({ ...f.command });
    expect(second).toEqual(first);
    expect(f.generate).toHaveBeenCalledTimes(allocations);
    expect(boundary.audits).toHaveBeenCalledTimes(1);
    expect(boundary.append).toHaveBeenCalledTimes(1);
    await f.finalize();
  });
  it("refuses changed original intent before new allocation", async () => {
    const f = fixture();
    await f.source.execute(f.command);
    const calls = f.generate.mock.calls.length;
    await expect(
      f.source.execute({ ...f.command, content: { ...f.command.content, unitAmountMinor: "126" } }),
    ).rejects.toMatchObject({ code: "OPTION_PRICE_IDEMPOTENCY_CONFLICT" });
    expect(f.generate).toHaveBeenCalledTimes(calls);
    await expect(f.finalize()).rejects.toBeDefined();
  });
  it("refuses original Actor or selected Store substitution without new allocation", async () => {
    const f = fixture();
    await f.source.execute(f.command);
    const actorSource = createPostgresOptionPriceAuthoringStore({
      ...f.options,
      actorReference: id(294),
    });
    await expect(actorSource.execute(f.command)).rejects.toMatchObject({
      code: "OPTION_PRICE_IDEMPOTENCY_CONFLICT",
    });
    const storeSource = createPostgresOptionPriceAuthoringStore({
      ...f.options,
      selectedStoreReference: id(295),
    });
    await expect(storeSource.execute(f.command)).rejects.toMatchObject({
      code: "OPTION_PRICE_IDEMPOTENCY_CONFLICT",
    });
    expect(boundary.append).toHaveBeenCalledTimes(1);
  });
  it("rejects corrupt original envelope rather than inventing history", async () => {
    const f = fixture();
    const first = await f.source.execute(f.command);
    if (!first.eventReference) throw new Error("missing event");
    boundary.events.delete(first.eventReference);
    await expect(f.source.execute(f.command)).rejects.toMatchObject({
      code: "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("authorizes before original inspection and refuses unavailable global scope without allocation", async () => {
    const f = fixture();
    f.unavailable();
    await expect(f.source.execute(f.command)).rejects.toMatchObject({
      code: "OPTION_PRICE_IDEMPOTENCY_CONFLICT",
    });
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.queries.some((q) => q.sql.startsWith("INSERT"))).toBe(false);
  });
  it("durably abandons a genuine fenced absence with Audit and no Event then denies late writes", async () => {
    const f = fixture();
    const abandoned = await f.source.resolve(f.command);
    expect(abandoned.outcome).toBe("Abandoned");
    expect(abandoned.state).toBeNull();
    expect(boundary.audits).toHaveBeenCalledTimes(1);
    expect(boundary.append).not.toHaveBeenCalled();
    expect(await f.source.execute(f.command)).toEqual(abandoned);
    expect(
      f.queries.some((q) => q.sql.startsWith("INSERT INTO rms_pricing.option_price_rule(")),
    ).toBe(false);
    await f.finalize();
  });
  it("retains current permission on replay and poisons swallowed failure", async () => {
    const f = fixture();
    await f.source.execute(f.command);
    f.withdraw();
    await expect(f.source.execute(f.command)).rejects.toMatchObject({
      code: "OPTION_PRICE_PERMISSION_DENIED",
    });
    await expect(f.finalize()).rejects.toBeDefined();
  });
  it("refuses CAS mismatch without Audit or allocated version", async () => {
    const f = fixture();
    await expect(
      f.source.execute({ ...f.command, expectedAggregateVersion: 1 }),
    ).rejects.toMatchObject({ code: "OPTION_PRICE_VERSION_CONFLICT" });
    expect(f.generate).not.toHaveBeenCalled();
    expect(boundary.audits).not.toHaveBeenCalled();
  });
  it("cannot publish without an actual held policy producer", async () => {
    const f = fixture();
    await f.source.execute(f.command);
    await expect(
      f.source.execute({
        ...f.command,
        action: "Publish",
        operationReference: id(270),
        expectedAggregateVersion: 1,
        bindingReference: null,
        optionReference: null,
        content: null,
      }),
    ).rejects.toMatchObject({ code: "OPTION_PRICE_DEPENDENCY_UNAVAILABLE" });
    expect(boundary.append).toHaveBeenCalledTimes(1);
  });
  it("consumes a controlled held producer and keeps Published content when adding editable successor", async () => {
    const f = fixture("NotRequired");
    await f.source.execute(f.command);
    const published = await f.source.execute({
      ...f.command,
      action: "Publish",
      operationReference: id(290),
      expectedAggregateVersion: 1,
      bindingReference: null,
      optionReference: null,
      content: null,
    });
    expect(published.state?.currentPublished?.lifecycle).toBe("Published");
    const entered = f.publicationEntries[0];
    if (entered === undefined) throw new Error("missing held producer entry");
    expect(
      f.queries
        .slice(entered)
        .findIndex((q) => String(q.values[0]).startsWith("PricingOptionPriceRule:")),
    ).toBeGreaterThanOrEqual(0);
    expect(
      f.queries.slice(entered).findIndex((q) => q.sql.includes("SHARE ROW EXCLUSIVE")),
    ).toBeGreaterThan(
      f.queries
        .slice(entered)
        .findIndex((q) => String(q.values[0]).startsWith("PricingOptionPriceRule:")),
    );
    expect(published.state?.draft).toBeNull();
    const next = await f.source.execute({
      ...f.command,
      operationReference: id(291),
      expectedAggregateVersion: 2,
    });
    expect(next.state?.currentPublished?.versionReference).toBe(
      published.state?.currentPublished?.versionReference,
    );
    expect(next.state?.draft?.lifecycle).toBe("Draft");
    await f.finalize();
  });
  it("acquires actual Write sources before Publishing and Pricing while exact replay only rechecks Read", async () => {
    const f = fixture("NotRequired");
    await f.source.execute(f.command);
    f.acquisitionOrder.length = 0;
    const command = {
      ...f.command,
      action: "Publish" as const,
      operationReference: id(298),
      expectedAggregateVersion: 1,
      bindingReference: null,
      optionReference: null,
      content: null,
    };
    await f.source.execute(command);
    expect(f.acquisitionOrder.indexOf("CatalogWrite")).toBeLessThan(
      f.acquisitionOrder.indexOf("PublishingSource"),
    );
    expect(f.acquisitionOrder.indexOf("PublishingSource")).toBeLessThan(
      f.acquisitionOrder.indexOf("PricingRule"),
    );
    expect(f.acquisitionOrder.indexOf("PricingRule")).toBeLessThan(
      f.acquisitionOrder.indexOf("PricingSRE"),
    );
    f.acquisitionOrder.length = 0;
    await f.source.execute(command);
    expect(f.acquisitionOrder).toEqual(["CurrentRead"]);
  });
  it("requires independent approval of the actual stored Draft instead of approval by its author", async () => {
    const f = fixture("SelfApproval");
    await f.source.execute(f.command);
    await expect(
      f.source.execute({
        ...f.command,
        action: "Publish",
        operationReference: id(292),
        expectedAggregateVersion: 1,
        bindingReference: null,
        optionReference: null,
        content: null,
      }),
    ).rejects.toMatchObject({ code: "OPTION_PRICE_APPROVAL_REQUIRED" });
    expect(boundary.append).toHaveBeenCalledTimes(1);
  });
  it("recovers Published original with immutable historic proof and actual event without new allocation", async () => {
    const f = fixture("Required");
    await f.source.execute(f.command);
    const cmd = {
      ...f.command,
      action: "Publish" as const,
      operationReference: id(293),
      expectedAggregateVersion: 1,
      bindingReference: null,
      optionReference: null,
      content: null,
    };
    const published = await f.source.execute(cmd);
    const calls = f.generate.mock.calls.length;
    expect(await f.source.execute(cmd)).toEqual(published);
    expect(f.generate).toHaveBeenCalledTimes(calls);
    await f.finalize();
  });
  it("recovers original Publish after server governing-family configuration changes without requalification", async () => {
    const f = fixture("Required");
    await f.source.execute(f.command);
    const cmd = {
      ...f.command,
      action: "Publish" as const,
      operationReference: id(296),
      expectedAggregateVersion: 1,
      bindingReference: null,
      optionReference: null,
      content: null,
    };
    const original = await f.source.execute(cmd);
    const recovery = createPostgresOptionPriceAuthoringStore({
      ...f.options,
      publicationPolicyFamilyReference: id(297),
    });
    expect(await recovery.execute(cmd)).toEqual(original);
    expect(boundary.append).toHaveBeenCalledTimes(2);
  });
  it("clamps every owning SQL timeout to the remaining original lease", async () => {
    const f = fixture();
    f.setTime("2026-08-02T16:00:04.000Z");
    await f.source.readCurrent(f.command.ruleReference);
    expect(
      f.queries
        .filter((q) => q.sql.includes("statement_timeout"))
        .every((q) => q.values[0] === "1000"),
    ).toBe(true);
  });
  it("refuses missing async/final hooks and expired original deadline", async () => {
    const f = fixture();
    await f.source.readCurrent(f.command.ruleReference);
    expect(() => f.source.assertFinalized()).toThrow();
    const other = fixture();
    await other.source.readCurrent(other.command.ruleReference);
    other.setTime(other.options.originalValidUntil);
    await expect(other.finalize()).rejects.toBeDefined();
  });
  it("captures tx query and authority ports, refusing late replacement", async () => {
    const f = fixture();
    await f.source.readCurrent(f.command.ruleReference);
    f.tx.query = async () => ({ rows: [] });
    await expect(f.finalize()).rejects.toBeDefined();
  });
  it("refuses async reentry and repeated finalization", async () => {
    const f = fixture();
    await f.source.readCurrent(f.command.ruleReference);
    await f.finalize();
    expect(() => f.source.assertFinalized()).not.toThrow();
    await expect(f.source.readCurrent(f.command.ruleReference)).rejects.toBeDefined();
  });
});
