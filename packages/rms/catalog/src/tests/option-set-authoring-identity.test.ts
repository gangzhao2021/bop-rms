import { expect, it, vi } from "vitest";
import { materializeFullOptionSetCreation } from "../contracts/option-set-full-create.js";
import {
  appendOptionSetAuthoringIdentity,
  requireOriginalOptionSetAuthoringIdentity,
  requireOptionSetAuthoringOperationAvailable,
} from "../infrastructure/persistence/option-set-authoring-identity.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";
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
    available = true;
  const calls: string[] = [];
  const tx: ProductLifecycleTransaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      calls.push(sql);
      let rows: unknown[] = [];
      let rowCount = 0;
      if (sql.includes("operation_available")) rows = [{ available }];
      else if (sql.includes("FROM rms_catalog.option_set_authoring_identity") && identity)
        rows = [{ coherent: true, identity_json: identity, snapshot_json: prepared().content }];
      else if (sql.startsWith("INSERT INTO rms_catalog.option_set_authoring_identity")) {
        identity = JSON.parse(String(values[18]));
        rowCount = 1;
      }
      return { rows: rows as Row[], rowCount };
    },
  };
  return {
    tx,
    calls,
    identity: () => identity,
    abandon: () => {
      available = false;
    },
  };
}
it("derives original identity only from complete owning command/content and validated actual Audit", async () => {
  const f = fixture();
  const result = await appendOptionSetAuthoringIdentity(
    f.tx,
    scope,
    { action: "Create", command },
    prepared().content,
    audit(),
  );
  expect(result.command.actorReference).toBe(scope.actorReference);
  expect(result.auditReference).toBe(id(80));
  expect(result.sourceDigest).toBe(prepared().sourceDigest);
  expect(
    await requireOriginalOptionSetAuthoringIdentity(
      f.tx,
      scope,
      { action: "Create", command },
      prepared().content,
    ),
  ).toEqual(result);
  expect(f.calls.some((sql) => sql.includes("platform_audit"))).toBe(false);
  expect(f.calls.filter((sql) => sql.startsWith("INSERT")).length).toBe(1);
});
it.each([
  { actor: { type: "User" as const, reference: id(99) } },
  { brandId: id(99) },
  { reasonCode: "OTHER_REASON" },
  { actionCode: "CATALOG_OPTION_SET_REPLACEDRAFT" },
  { occurredAt: "2026-10-05T00:00:01.000Z" },
])("rejects unrelated Audit tuple before identity SQL", async (change) => {
  const f = fixture();
  await expect(
    appendOptionSetAuthoringIdentity(
      f.tx,
      scope,
      { action: "Create", command },
      prepared().content,
      { ...audit(), ...change },
    ),
  ).rejects.toThrow();
  expect(f.calls).toEqual([]);
});
it("refuses missing legacy identity without backfill", async () => {
  const f = fixture();
  await expect(
    requireOriginalOptionSetAuthoringIdentity(
      f.tx,
      scope,
      { action: "Create", command },
      prepared().content,
    ),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.calls.some((sql) => sql.startsWith("INSERT"))).toBe(false);
});
it("keeps allocation-independent intent exact and rejects changed replay", async () => {
  const f = fixture();
  await appendOptionSetAuthoringIdentity(
    f.tx,
    scope,
    { action: "Create", command },
    prepared().content,
    audit(),
  );
  await expect(
    requireOriginalOptionSetAuthoringIdentity(
      f.tx,
      scope,
      { action: "Create", command: { ...command, reasonCode: "OTHER_REASON" } },
      prepared().content,
    ),
  ).rejects.toMatchObject({ code: "CATALOG_IDEMPOTENCY_CONFLICT" });
});
it("permanent abandoned/foreign operation probe refuses before writer work", async () => {
  const f = fixture();
  await requireOptionSetAuthoringOperationAvailable(f.tx, command.operationReference);
  f.abandon();
  await expect(
    requireOptionSetAuthoringOperationAvailable(f.tx, command.operationReference),
  ).rejects.toMatchObject({ code: "CATALOG_IDEMPOTENCY_CONFLICT" });
});
it("failed identity insert cannot become positive metadata", async () => {
  const f = fixture();
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  await expect(
    appendOptionSetAuthoringIdentity(
      { query },
      scope,
      { action: "Create", command },
      prepared().content,
      audit(),
    ),
  ).rejects.toThrow();
  expect(f.identity()).toBeUndefined();
});

it("original replay requires the complete immutable source rather than a matching current root number", async () => {
  const f = fixture();
  await appendOptionSetAuthoringIdentity(
    f.tx,
    scope,
    { action: "Create", command },
    prepared().content,
    audit(),
  );
  const content = prepared().content;
  await expect(
    requireOriginalOptionSetAuthoringIdentity(
      f.tx,
      scope,
      { action: "Create", command },
      {
        ...content,
        sourceAggregate: {
          ...content.sourceAggregate,
          draft: {
            ...content.sourceAggregate.draft,
            localizedNames: { "en-CA": "Different complete content" },
          },
        },
      },
    ),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
