import { afterEach, expect, it, vi } from "vitest";
import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { CatalogError, parseProductAggregate } from "../contracts/product.js";
import {
  parseProductPublicationCommand,
  planCatalogProductPublication,
  productPublicationCheckCodes,
  type ProductPublicationFacts,
} from "../contracts/product-publication.js";
import {
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
} from "../contracts/product-publication-v2.js";
import { parseCatalogProductPublicationWarningAcknowledgementCommand } from "../contracts/product-publication-warning-acknowledgement.js";
import {
  parseCatalogProductPublicationResolutionCommand,
  buildCatalogProductPublicationResolution,
} from "../contracts/product-publication-resolution.js";
import {
  createPostgresProductPublicationResolutionStore as create,
  assertProductPublicationOperationNotAbandoned as assertNotAbandoned,
  productPublicationResolutionFields,
  type ProductPublicationResolutionStoreOptions as Options,
} from "../infrastructure/persistence/product-publication-resolution-store.js";
import type { ProductLifecycleTransaction as Tx } from "../infrastructure/persistence/product-lifecycle-store.js";
vi.mock("@bop/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());
const id = (n: number) => "019a2421-0014-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  now = "2026-10-03T14:00:00.000Z",
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
  time = (ms: number) => new Date(Date.parse(now) + ms).toISOString(),
  unavailable = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  conflict = expect.objectContaining({ code: "CATALOG_IDEMPOTENCY_CONFLICT" });
function fixture(
  kind: "PublicationV1" | "PublicationV2" | "WarningAcknowledgementV1" = "PublicationV2",
) {
  const original = parseProductPublicationCommand({
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(4),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 1,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: hash("content"),
      configurationDigest: hash("configuration"),
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_ORIGINAL",
    }),
    intent = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    v2 = parseProductPublicationCommandV2({
      ...original,
      profile: "CatalogProductPublicationCommandV2",
      replacementIntent: { ...intent, digest: hash(intent) },
      replacementIntentDigest: hash(intent),
    }),
    ack = parseCatalogProductPublicationWarningAcknowledgementCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      actorKind: "User",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      operationReference: id(4),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 1,
      reportOperationReference: id(7),
      reportDigest: hash("original report"),
      warningBindingDigest: hash("warning binding"),
      warningCodes: ["ChangeImpact"],
      reasonCode: "SYNTHETIC_ORIGINAL",
      occurredAt: at,
    }),
    command = parseCatalogProductPublicationResolutionCommand({
      profile: "CatalogProductPublicationResolutionCommandV1",
      originalKind: kind,
      originalCommand: kind === "PublicationV1" ? original : kind === "PublicationV2" ? v2 : ack,
    }),
    facts: ProductPublicationFacts = {
      now: at,
      productAggregateVersion: 1,
      contentDigest: original.contentDigest,
      configurationDigest: original.configurationDigest,
      scopeDigest: hash(original.scopeSet),
      periodDigest: hash(original.effectivePeriod),
      approval: null,
      reviewReference: null,
      replacement: null,
      validation: {
        evidenceReference: id(8),
        productAggregateVersion: 1,
        contentDigest: original.contentDigest,
        configurationDigest: original.configurationDigest,
        scopeDigest: hash(original.scopeSet),
        periodDigest: hash(original.effectivePeriod),
        policyReference: id(9),
        policyVersion: 1,
        approvalPolicy: "NotRequired",
        checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
        warningAcknowledgement: null,
        checkedAt: at,
        validUntil: "2026-10-03T12:00:05.000Z",
      },
    },
    publication =
      kind === "PublicationV1"
        ? planCatalogProductPublication(original, null, facts)
        : planCatalogProductPublicationV2(v2, null, {
            ...facts,
            validation: {
              ...facts.validation,
              profile: "CatalogProductPublicationValidationV2",
              replacementIntentDigest: v2.replacementIntentDigest,
            },
          }),
    aggregate = parseProductAggregate({
      productReference: id(5),
      brandReference: id(2),
      internalCode: "SYNTHETIC_RESOLUTION",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 2,
      createdAt: at,
      updatedAt: at,
      createdByActorReference: id(3),
      draft: {
        versionReference: id(6),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic recovery" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: [],
        createdAt: at,
        updatedAt: at,
      },
    });
  return { command, publication, aggregate };
}

// Controlled query rows and transaction host. The actual database race, RLS,
// append-only exclusion and Audit transaction are covered by the native case.
function harness(kind: Parameters<typeof fixture>[0] = "PublicationV2") {
  interface Fence {
    command: unknown;
    resolution: unknown;
    coherent: boolean;
  }
  const f = fixture(kind),
    sql: string[] = [],
    parameters: (readonly unknown[])[] = [],
    guards: { asyncGuard: () => Promise<void>; finalAssert: () => void }[] = [];
  const state: {
    clock: string;
    root: number | null;
    committed: boolean;
    original: unknown | null;
    fence: Fence | null;
    fenceBefore: Fence | null;
    denies: boolean;
    holds: number;
    afterWork?: () => void;
    afterAsync?: () => void;
    swallowWorkFailure: boolean;
    fault?: "wrong-intent" | "wrong-action" | "incoherent" | "wrong-root" | "invalid-insert";
  } = {
    clock: now,
    root: 19,
    committed: false,
    original: null,
    fence: null,
    fenceBefore: null,
    denies: false,
    holds: 0,
    swallowWorkFailure: false,
  };
  const tx: Tx = {
    async query<Row>(text: string, values: readonly unknown[]) {
      sql.push(text);
      parameters.push(values);
      let found: readonly unknown[] = [],
        rowCount = 0;
      if (text.includes("transaction_isolation")) found = [{ isolation: "read committed" }];
      else if (text.startsWith("SELECT aggregate_version"))
        found = state.root === null ? [] : [{ aggregate_version: state.root }];
      else if (text.includes("SELECT o.action_code,o.intent_digest"))
        found =
          state.original === null
            ? []
            : [
                {
                  action_code:
                    state.fault === "wrong-action" ? "ReplaceDraft" : "ProductPublication",
                  intent_digest:
                    state.fault === "wrong-intent"
                      ? hash("different")
                      : hash(f.command.originalCommand),
                  publication: state.original,
                  aggregate:
                    state.fault === "wrong-root"
                      ? { ...f.aggregate, aggregateVersion: 3 }
                      : f.aggregate,
                  coherent: state.fault !== "incoherent",
                },
              ];
      else if (text.includes("FROM rms_catalog.product_publication_warning_acknowledgement"))
        found = state.original === null ? [] : [state.original];
      else if (text.startsWith("SELECT command_json command"))
        found = state.fence === null ? [] : [state.fence];
      else if (
        text.startsWith(
          "SELECT operation_id FROM rms_catalog.product_publication_operation_abandonment",
        )
      )
        found = state.fence === null ? [] : [{ operation_id: id(4) }];
      else if (
        text.startsWith("INSERT INTO rms_catalog.product_publication_operation_abandonment")
      ) {
        const command: unknown = JSON.parse(String(values[11])),
          resolution: unknown = JSON.parse(String(values[12]));
        state.fence = { command, resolution, coherent: true };
        rowCount = state.fault === "invalid-insert" ? 0 : 1;
      } else if (text.startsWith("SAVEPOINT")) state.fenceBefore = state.fence;
      else if (text.startsWith("ROLLBACK TO SAVEPOINT")) state.fence = state.fenceBefore;
      else if (
        !text.startsWith("SELECT set_config") &&
        !text.startsWith("SELECT pg_advisory") &&
        !text.startsWith("RELEASE SAVEPOINT")
      )
        throw Error("Unexpected controlled SQL");
      return { rows: found as readonly Row[], rowCount: rowCount || found.length };
    },
  };
  const options: Options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => state.clock },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        expect(actual).toBe(tx);
        state.holds++;
        expect(input.requiredFields).toBe(productPublicationResolutionFields);
        expect(input.requiredPermissions).toEqual([
          "catalog.manage",
          "catalog.product.manage",
          "catalog.product.read",
          "catalog.product.history.read",
        ]);
        expect(input.command.originalCommand.actorReference).toBe(id(3));
        if (state.denies) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      },
    },
    async registerBeforeCommit(actual, asyncGuard, finalAssert) {
      expect(actual).toBe(tx);
      guards.push({ asyncGuard, finalAssert });
    },
    audit: {
      create({ resolution }) {
        return {
          auditId: id(90),
          brandId: id(2),
          actor: { type: "User", reference: id(3) },
          actionCode: "CATALOG_PRODUCT_PUBLICATION_OPERATION_ABANDONED",
          targetType: "ProductPublicationOperation",
          targetId: id(4),
          reasonCode: "ORIGINAL_OPERATION_ABANDONED",
          correlationId: id(91),
          occurredAt: resolution.recordedAt,
          sourceChannel: "API",
          dataClassification: "Internal",
          retentionPolicyCode: "SYNTHETIC",
          retentionPolicyVersion: 1,
        } satisfies AppendAuditRecordInput;
      },
    },
    transactions: {
      async run<T>(work: (actual: Tx) => Promise<T>): Promise<T> {
        const before = state.fence;
        guards.length = 0;
        state.committed = false;
        try {
          let result: T;
          try {
            result = await work(tx);
          } catch (error) {
            if (!state.swallowWorkFailure) throw error;
            for (const entry of guards) await entry.asyncGuard();
            throw Error("Caught failure escaped its poison guard", { cause: error });
          }
          state.afterWork?.();
          for (const entry of guards) await entry.asyncGuard();
          state.afterAsync?.();
          for (const entry of guards) entry.finalAssert();
          state.committed = true;
          return result;
        } catch (error) {
          state.fence = before;
          throw error;
        }
      },
    },
  };
  return { ...f, options, state, tx, sql, parameters, guards, store: create(options) };
}

it.each(["PublicationV1", "PublicationV2", "WarningAcknowledgementV1"] as const)(
  "permanently abandons absent %s without comparing the obsolete root or reading qualification",
  async (kind) => {
    const h = harness(kind),
      result = await h.store.execute(h.command);
    expect(result.currentAggregateVersion).toBe(19);
    expect(result.resolution).toEqual(
      buildCatalogProductPublicationResolution(h.command, "Abandoned", now),
    );
    expect(h.state.committed).toBe(true);
    expect(h.sql.filter((s) => s.startsWith("INSERT INTO"))).toHaveLength(1);
    expect(
      h.sql.some((s) =>
        /UPDATE rms_catalog.product|product_source_head|product_editor|policy|outbox/i.test(s),
      ),
    ).toBe(false);
    expect(appendAuditRecordInTransaction).toHaveBeenCalledTimes(1);
    const namespace =
      kind === "WarningAcknowledgementV1"
        ? "CatalogProductWarningAcknowledgement"
        : "CatalogProductOperation";
    expect(h.parameters).toContainEqual(["CatalogProductSource:" + id(2)]);
    expect(h.parameters).toContainEqual([namespace + ":" + id(2) + ":" + id(4)]);
  },
);
it.each(["PublicationV1", "PublicationV2"] as const)(
  "recovers committed %s without executing it or renewing its historical validation",
  async (kind) => {
    const h = harness(kind);
    h.state.original = h.publication;
    const result = await h.store.execute(h.command);
    expect(result).toEqual({
      resolution: buildCatalogProductPublicationResolution(h.command, "Committed", at),
      currentAggregateVersion: 19,
    });
    expect(h.state.fence).toBeNull();
    expect(h.sql.some((s) => s.startsWith("INSERT") || s.startsWith("SAVEPOINT"))).toBe(false);
    expect(appendAuditRecordInTransaction).not.toHaveBeenCalled();
  },
);
it("returns identical abandoned evidence after the root advances and the first response was lost", async () => {
  const h = harness(),
    first = await h.store.execute(h.command);
  h.state.clock = time(60000);
  h.state.root = 25;
  const repeated = await h.store.execute(h.command);
  expect(repeated.resolution).toEqual(first.resolution);
  expect(repeated.currentAggregateVersion).toBe(25);
  expect(h.sql.filter((s) => s.startsWith("INSERT"))).toHaveLength(1);
  expect(appendAuditRecordInTransaction).toHaveBeenCalledTimes(1);
});
it.each(["wrong-intent", "wrong-action", "wrong-root"] as const)(
  "refuses committed %s instead of fencing it",
  async (fault) => {
    const h = harness();
    h.state.original = h.publication;
    h.state.fault = fault;
    await expect(h.store.execute(h.command)).rejects.toThrow(conflict);
    expect(h.state.fence).toBeNull();
    expect(appendAuditRecordInTransaction).not.toHaveBeenCalled();
  },
);
it("refuses corrupt immutable receipt joins and corrupt Ack rows instead of interpreting absence", async () => {
  const publication = harness();
  publication.state.original = publication.publication;
  publication.state.fault = "incoherent";
  await expect(publication.store.execute(publication.command)).rejects.toThrow(unavailable);
  const ack = harness("WarningAcknowledgementV1");
  ack.state.original = { receipt: null, bounded: true, metadata: {} };
  await expect(ack.store.execute(ack.command)).rejects.toThrow(unavailable);
  expect(ack.state.fence).toBeNull();
});
it.each(["reason", "actor", "kind"])(
  "does not disclose or replace an existing fence for a changed %s",
  async (field) => {
    const h = harness(),
      original = h.command.originalCommand;
    h.state.fence = {
      command:
        field === "kind"
          ? fixture("PublicationV1").command
          : {
              ...h.command,
              originalCommand: {
                ...original,
                ...(field === "reason"
                  ? { reasonCode: "OTHER_REASON" }
                  : { actorReference: id(99) }),
              },
            },
      resolution: buildCatalogProductPublicationResolution(h.command, "Abandoned", at),
      coherent: true,
    };
    await expect(h.store.execute(h.command)).rejects.toThrow(conflict);
    expect(appendAuditRecordInTransaction).not.toHaveBeenCalled();
  },
);
it("requires current Product visibility but accepts an obsolete expected root", async () => {
  const h = harness();
  h.state.root = null;
  await expect(h.store.execute(h.command)).rejects.toMatchObject({ code: "CATALOG_UNAVAILABLE" });
  expect(h.state.fence).toBeNull();
  expect(appendAuditRecordInTransaction).not.toHaveBeenCalled();
});
it.each(["entry-denial", "late-denial", "later-expiry", "query-replaced", "audit-failure"])(
  "rolls back abandonment and refuses outer commit on %s",
  async (fault) => {
    const h = harness();
    if (fault === "entry-denial") h.state.denies = true;
    if (fault === "late-denial")
      h.state.afterWork = () => {
        h.state.denies = true;
      };
    if (fault === "later-expiry")
      h.state.afterAsync = () => {
        h.state.clock = time(5000);
      };
    if (fault === "query-replaced")
      h.state.afterWork = () => {
        h.tx.query = async () => ({ rows: [], rowCount: 0 });
      };
    if (fault === "audit-failure")
      vi.mocked(appendAuditRecordInTransaction).mockRejectedValueOnce(
        Error("Controlled Audit failure"),
      );
    await expect(h.store.execute(h.command)).rejects.toThrow();
    expect(h.state.committed).toBe(false);
    expect(h.state.fence).toBeNull();
    if (fault === "audit-failure")
      expect(h.sql).toContain("ROLLBACK TO SAVEPOINT catalog_product_publication_resolution");
  },
);
it.each(["malformed", "missing-product", "denied"])(
  "poisons a caught early %s failure before the host can commit",
  async (fault) => {
    const h = harness();
    h.state.swallowWorkFailure = true;
    if (fault === "missing-product") h.state.root = null;
    if (fault === "denied") h.state.denies = true;
    await expect(
      h.store.execute(fault === "malformed" ? { ...h.command, extra: true } : h.command),
    ).rejects.toThrow(unavailable);
    expect(h.guards).toHaveLength(1);
    expect(h.state.committed).toBe(false);
    expect(h.state.fence).toBeNull();
  },
);
it("captures configured authority and Audit ports and rejects an authenticated Actor mismatch", async () => {
  const h = harness();
  h.options.authority.holdUntilTransactionCompletes = async () => {
    throw Error("Replaced authority");
  };
  h.options.audit.create = () => {
    throw Error("Replaced Audit factory");
  };
  await expect(h.store.execute(h.command)).resolves.toMatchObject({
    resolution: { outcome: "Abandoned" },
  });
  const foreign = harness();
  await expect(
    foreign.store.execute({
      ...foreign.command,
      originalCommand: { ...foreign.command.originalCommand, actorReference: id(99) },
    }),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(foreign.state.fence).toBeNull();
});
it.each(["CatalogProductOperation", "CatalogProductWarningAcknowledgement"] as const)(
  "rejects every late intent in fenced %s, independent of its Actor or digest",
  async (namespace) => {
    const h = harness();
    await expect(assertNotAbandoned(h.tx, namespace, id(2), id(4))).resolves.toBeUndefined();
    h.state.fence = {
      command: h.command,
      resolution: buildCatalogProductPublicationResolution(h.command, "Abandoned", at),
      coherent: true,
    };
    await expect(assertNotAbandoned(h.tx, namespace, id(2), id(4))).rejects.toThrow(conflict);
    expect(h.parameters.at(-1)).toEqual([namespace, id(2), id(4)]);
  },
);
