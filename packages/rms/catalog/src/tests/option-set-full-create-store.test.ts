import { expect, it, vi } from "vitest";
import { materializeFullOptionSetCreation } from "../contracts/option-set-full-create.js";
import { createPostgresFullOptionSetDraftStore } from "../infrastructure/persistence/option-set-full-draft-store.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: vi.fn(async () => undefined),
}));
vi.mock("@bop/eventing", async (original) => ({
  ...(await original<typeof import("@bop/eventing")>()),
  appendEventInTransaction: vi.fn(async () => undefined),
}));
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-05T00:00:00.000Z",
  scope = { tenantReference: id(11), brandReference: id(10), actorReference: id(40) };
const command = {
  internalCode: "SYNTHETIC_CHOICES",
  draft: {
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic choices" },
    localizedDescriptions: {},
    displayStyle: "MultiChoice",
    minimumSelection: 0,
    maximumSelection: 1,
    allowRepeatedOption: false,
    perOptionMaximumQuantity: 1,
    maximumTotalQuantity: 1,
    options: [
      {
        stableCode: "ONE",
        lifecycle: "Draft",
        localizedNames: { "en-CA": "Synthetic one" },
        localizedDescriptions: {},
        sortOrder: 0,
        defaultEligible: false,
        triggeredOptionSetReference: null,
        conflictOptionCodes: [],
      },
    ],
  },
  additionalContent: {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: [
      {
        stableCode: "ONE",
        quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
        media: null,
        pricingRule: null,
        consumption: null,
        triggeredOptionSetVersionReference: null,
      },
    ],
    conditionalRules: [],
    conflictRules: [],
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
  },
  operationReference: id(30),
  occurredAt: at,
  reasonCode: "SYNTHETIC_CONFIGURATION",
};
const prepared = () =>
  materializeFullOptionSetCreation(command, {
    brandReference: scope.brandReference,
    actorReference: scope.actorReference,
    allocations: {
      optionSetReference: id(1),
      versionReference: id(2),
      options: [{ stableCode: "ONE", optionReference: id(3) }],
    },
  });
const audit = () => ({
  auditId: id(80),
  brandId: scope.brandReference,
  actor: { type: "User" as const, reference: scope.actorReference },
  actionCode: "CATALOG_OPTION_SET_CREATE",
  targetType: "CatalogOptionSet",
  targetId: id(1),
  reasonCode: command.reasonCode,
  correlationId: command.operationReference,
  occurredAt: at,
  sourceChannel: "API",
  dataClassification: "Internal" as const,
  retentionPolicyCode: "AUDIT_DEFAULT",
  retentionPolicyVersion: 1,
});

function fixture() {
  let identity: unknown,
    receipt: Record<string, unknown> | undefined,
    available = true,
    failIdentity = false,
    allocations = 0;
  const calls: string[] = [],
    lockKeys: string[] = [];
  const tx: ProductLifecycleTransaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      calls.push(sql);
      if (sql.includes("pg_advisory_xact_lock")) lockKeys.push(String(values[0]));
      let rows: unknown[] = [],
        rowCount = 0;
      if (sql.includes("transaction_isolation")) rows = [{ isolation: "read committed" }];
      else if (sql.includes("operation_available")) rows = [{ available }];
      else if (sql.includes("FROM rms_catalog.option_set_authoring_identity") && identity)
        rows = [{ coherent: true, identity_json: identity, snapshot_json: receipt?.snapshot }];
      else if (sql.includes("FROM rms_catalog.option_set_operation_record o JOIN") && receipt)
        rows = [receipt];
      else if (sql.startsWith("SELECT jsonb_build_object")) {
        const { sourceAggregate, ...details } = prepared().content;
        rows = [{ aggregate: sourceAggregate, details, coherent: true }];
      } else if (sql.startsWith("INSERT INTO rms_catalog.option_set_draft_content_snapshot")) {
        receipt = {
          snapshot: JSON.parse(String(values[10])),
          intent_digest: String(values[5]),
          source_digest: String(values[7]),
          content_digest: String(values[8]),
          configuration_digest: String(values[9]),
          coherent: true,
        };
        rowCount = 1;
      } else if (sql.startsWith("INSERT INTO rms_catalog.option_set_authoring_identity")) {
        if (failIdentity) throw new Error("Synthetic append unavailable");
        identity = JSON.parse(String(values[18]));
        rowCount = 1;
      } else if (sql.startsWith("INSERT")) rowCount = 1;
      return { rows: rows as Row[], rowCount };
    },
  };
  const options = {
    ...scope,
    clock: { now: () => at },
    transactions: {
      run: async <T>(work: (tx: ProductLifecycleTransaction) => Promise<T>) => {
        const oldIdentity = identity,
          oldReceipt = receipt;
        try {
          return await work(tx);
        } catch (error) {
          identity = oldIdentity;
          receipt = oldReceipt;
          throw error;
        }
      },
    },
    authority: {
      holdUntilTransactionCompletes: async () => ({
        observedAt: at,
        validUntil: "2026-10-05T00:00:05.000Z",
      }),
    },
    creation: {
      authority: {
        holdUntilTransactionCompletes: async () => ({
          observedAt: at,
          validUntil: "2026-10-05T00:00:05.000Z",
        }),
      },
      references: {
        generate: () => {
          allocations++;
          return id(allocations);
        },
      },
    },
    audit: { create: audit },
    events: { generateReference: () => id(81) },
  };
  return {
    store: createPostgresFullOptionSetDraftStore(options),
    options,
    tx,
    calls,
    lockKeys,
    identity: () => identity,
    receipt: () => receipt,
    allocations: () => allocations,
    abandon: () => {
      available = false;
    },
    clearIdentity: () => {
      identity = undefined;
    },
    failAppend: () => {
      failIdentity = true;
    },
  };
}
it("all FullCreate writes automatically append original identity in the same transaction and replay without reallocation", async () => {
  const f = fixture();
  const result = await f.store.create(command);
  expect(result.status).toBe("Applied");
  expect(f.identity()).toMatchObject({
    command: { action: "Create", actorReference: scope.actorReference },
    auditReference: id(80),
  });
  expect(f.allocations()).toBe(3);
  expect((await f.store.create(command)).status).toBe("Replayed");
  expect(f.allocations()).toBe(3);
  expect(
    f.calls.filter((sql) => sql.startsWith("INSERT INTO rms_catalog.option_set_authoring_identity"))
      .length,
  ).toBe(1);
});
it("Abandoned operation refuses before code lock or allocation", async () => {
  const f = fixture();
  f.abandon();
  await expect(f.store.create(command)).rejects.toMatchObject({
    code: "CATALOG_IDEMPOTENCY_CONFLICT",
  });
  expect(f.allocations()).toBe(0);
  expect(f.calls.some((sql) => sql.startsWith("INSERT"))).toBe(false);
  expect(f.lockKeys.some((key) => key.startsWith("CatalogFullOptionCode:"))).toBe(false);
});
it("old FullCreate receipt cannot be silently backfilled", async () => {
  const f = fixture();
  await f.store.create(command);
  f.clearIdentity();
  await expect(f.store.create(command)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.identity()).toBeUndefined();
  expect(f.allocations()).toBe(3);
});
it("mandatory append failure rolls back the source rather than returning success", async () => {
  const f = fixture();
  f.failAppend();
  await expect(f.store.create(command)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.receipt()).toBeUndefined();
  expect(f.identity()).toBeUndefined();
});
it("factory captures actual creation allocation port instead of trusting later replacement", async () => {
  const f = fixture();
  f.options.creation.references.generate = () => id(99);
  await f.store.create(command);
  expect(f.allocations()).toBe(3);
});

it("global original operation arbitration precedes code ownership lock", async () => {
  const f = fixture();
  await f.store.create(command);
  expect(f.lockKeys[0]).toBe("CatalogFullOptionOperation:" + command.operationReference);
  expect(f.lockKeys[1]).toBe(
    "CatalogFullOptionCode:" + scope.brandReference + ":" + command.internalCode,
  );
});
