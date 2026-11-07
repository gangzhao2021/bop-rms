import { beforeEach, expect, it, vi } from "vitest";
import type { AppendAuditRecordInput } from "@bop/audit";
import { CatalogError } from "../contracts/product.js";
import { sha256Hex } from "@bop/audit";
import {
  parseCatalogSellingUnitRegistryCommand,
  catalogSellingUnitRegistryDigest,
  catalogSellingUnitDefinitionsDigest,
  type CatalogSellingUnitRegistrationResolution,
} from "../contracts/selling-unit-registry.js";
import {
  createPostgresSellingUnitRegistryStore,
  sellingUnitRegistryFields,
  type SellingUnitRegistryStoreOptions,
} from "../infrastructure/persistence/selling-unit-registry-store.js";
function sellingUnitRegistryRequest(
  command: ReturnType<typeof parseCatalogSellingUnitRegistryCommand>,
) {
  const { intentDigest, snapshotDigest, ...request } = command;
  void intentDigest;
  void snapshotDigest;
  return request;
}
function sellingUnitRegistryEventId(
  command: ReturnType<typeof parseCatalogSellingUnitRegistryCommand>,
) {
  const digest = sha256Hex(
    "CatalogSellingUnitRegistryEvent:v1:" +
      command.tenantReference +
      ":" +
      command.brandReference +
      ":" +
      command.operationReference,
  );
  return (
    command.operationReference.slice(0, 14) +
    "7" +
    digest.slice(0, 3) +
    "-8" +
    digest.slice(3, 6) +
    "-" +
    digest.slice(6, 18)
  );
}
const append = vi.hoisted(() => ({ audit: vi.fn(), event: vi.fn() }));
vi.mock("@bop/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: append.audit,
}));
vi.mock("@bop/eventing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/eventing")>()),
  appendEventInTransaction: append.event,
}));
type Options = SellingUnitRegistryStoreOptions;
type Transaction = Parameters<Options["authority"]["holdUntilTransactionCompletes"]>[0];
const id = (n: number) => "01902433-0001-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-02T10:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const time = (milliseconds: number) => new Date(Date.parse(at) + milliseconds).toISOString();
const observation = (milliseconds = 5000) => ({
  originalIntentDigest: digest,
  observedAt: at,
  validUntil: time(milliseconds),
});
function command() {
  return {
    purposeCode: "CATALOG_SELLING_UNIT_REGISTRY",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(5),
    actorKind: "User",
    operationReference: id(6),
    expectedRegistryVersion: 0,
    occurredAt: at,
    reasonCode: "SYNTHETIC",
    registry: {
      profile: "CatalogSellingUnitRegistryV1",
      tenantReference: id(1),
      brandReference: id(2),
      registryReference: id(3),
      versionReference: id(4),
      registryVersion: 1,
      defaultLocale: "en-CA",
      previousSnapshotDigest: null as string | null,
      registeredAt: at,
      units: [
        {
          unitReference: id(10),
          semanticDefinition: "Synthetic package",
          quantityDecimalPlaces: 2,
          code: "SYNTHETIC",
          localizedNames: { "en-CA": "Synthetic selling unit" },
          lifecycle: "Active",
        },
      ],
    },
  };
}
function first<T>(value: readonly T[]): T {
  const item = value[0];
  if (item === undefined) throw new Error("Missing fixture");
  return item;
}
function row(value: unknown) {
  const parsed = parseCatalogSellingUnitRegistryCommand(value);
  return {
    command: sellingUnitRegistryRequest(parsed),
    registry: parsed.registry,
    intent_digest: parsed.intentDigest,
    snapshot_digest: parsed.snapshotDigest,
    event_id: sellingUnitRegistryEventId(parsed),
    coherent: true,
  };
}
// Controlled SQL/authority transport here. The separately coordinated native
// acceptance is still required for PostgreSQL, RLS, real Audit/Outbox and actual write rollback.
function harness(seed = true, kind: "User" | "System" = "User") {
  const state = {
    fences: [] as {
      command: CatalogSellingUnitRegistrationResolution["command"];
      resolution: CatalogSellingUnitRegistrationResolution;
    }[],
    assignedUnits: [] as string[],
    historicalUnits: [] as string[],
    invalidHistory: false,
    records: seed ? [row(command())] : [],
    at,
    denied: false,
    holdCount: 0,
    statements: [] as string[],
    holds: [] as Parameters<Options["authority"]["holdUntilTransactionCompletes"]>[1][],
    afterHold: undefined as undefined | (() => void),
    afterWork: undefined as undefined | ((tx: Transaction) => void),
    afterRunner: undefined as undefined | (() => void),
    doubleRunner: false,
    replaceResult: false,
    swallowWorkError: false,
    swallowedWorkErrors: 0,
    outerCommitted: false,
    reuseTx: undefined as Transaction | undefined,
    lastTx: undefined as Transaction | undefined,
    commitGuards: [] as (() => Promise<void>)[],
    finalAssertions: [] as (() => void)[],
  };
  const query: Transaction["query"] = async <Row = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[],
  ) => {
    state.statements.push(sql);
    let result: { rows: readonly unknown[]; rowCount?: number } = { rows: [] };
    if (sql.includes("transaction_isolation")) result = { rows: [{ isolation: "read committed" }] };
    else if (sql.startsWith("SELECT EXISTS(SELECT 1 FROM rms_catalog.product_operation_record"))
      result = { rows: [{ invalid: state.invalidHistory }] };
    else if (sql.startsWith("SELECT (SELECT count(*)::text FROM rms_catalog.sku"))
      result = {
        rows: [
          {
            current_count: String(state.assignedUnits.length),
            snapshot_count: String(state.historicalUnits.length),
            snapshot_bytes: String(state.historicalUnits.length * 2048),
          },
        ],
      };
    else if (sql.startsWith("SELECT s.sku_id::text"))
      result = {
        rows: state.assignedUnits.map((code, index) => ({
          sku_reference: id(150 + index),
          product_reference: id(30),
          version_reference: id(32),
          aggregate_version: 1,
          unit_code: code,
          unit_quantity: "1.25",
        })),
      };
    else if (sql.startsWith("SELECT operation_id::text operation_reference"))
      result = {
        rows: state.historicalUnits.map((code, index) => ({
          operation_reference: id(200 + index),
          product_reference: id(30),
          aggregate_version: 1,
          aggregate: candidate(code).aggregate,
        })),
      };
    else if (sql.startsWith("SELECT count(*)::text"))
      result = {
        rows: [{ n: String(state.records.length), bytes: String(state.records.length * 2048) }],
      };
    else if (
      sql.startsWith("SELECT operation_id FROM rms_catalog.selling_unit_registration_abandonment")
    )
      result = {
        rows: state.fences
          .filter((row) => row.command.operationReference === values[2])
          .map((row) => ({ operation_id: row.command.operationReference })),
      };
    else if (
      sql.startsWith(
        "SELECT command_json command,snapshot_json resolution FROM rms_catalog.selling_unit_registration_abandonment",
      )
    )
      result = { rows: state.fences.filter((row) => row.command.operationReference === values[2]) };
    else if (sql.startsWith("INSERT INTO rms_catalog.selling_unit_registration_abandonment")) {
      state.fences.push({
        command: JSON.parse(values[6] as string),
        resolution: JSON.parse(values[7] as string),
      });
      result = { rows: [], rowCount: 1 };
    } else if (sql.startsWith("SELECT command_json"))
      result = {
        rows:
          values.length === 3
            ? state.records.filter((r) => r.command.operationReference === values[2])
            : state.records,
      };
    else if (sql.startsWith("SELECT (octet_length"))
      result = { rows: [{ bytes: "2048", command_bytes: "1024", snapshot_bytes: "1024" }] };
    else if (sql.startsWith("INSERT INTO rms_catalog.selling_unit_registry_record")) {
      state.records.push(row(JSON.parse(values[10] as string)));
      result = { rows: [], rowCount: 1 };
    }
    return result as { rows: readonly Row[]; rowCount?: number };
  };
  const options: Options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(5),
    actorKind: kind,
    clock: { now: () => state.at },
    registerBeforeCommit: async (tx, guard, finalAssert) => {
      expect(tx).toBe(state.lastTx);
      state.commitGuards.push(guard);
      state.finalAssertions.push(finalAssert);
    },
    authority: {
      async holdUntilTransactionCompletes(_tx, input) {
        state.holdCount++;
        state.holds.push(input);
        if (state.denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        state.afterHold?.();
      },
    },
    audit: {
      createAbandonment: ({ command, resolution }): AppendAuditRecordInput => ({
        auditId: id(900),
        brandId: id(2),
        actor: { type: "User", reference: id(5) },
        actionCode: "CATALOG_SELLING_UNIT_REGISTRATION_ABANDONED",
        targetType: "SellingUnitRegistrationOperation",
        targetId: command.operationReference,
        reasonCode: "ORIGINAL_OPERATION_ABANDONED",
        correlationId: command.operationReference,
        occurredAt: resolution.recordedAt,
        sourceChannel: "INTERNAL_TEST",
        dataClassification: "Internal",
        retentionPolicyCode: "AUDIT",
        retentionPolicyVersion: 1,
      }),
      create: (value): AppendAuditRecordInput => ({
        auditId: id(100 + value.registry.registryVersion),
        brandId: id(2),
        actor: { type: "User", reference: id(5) },
        actionCode: "CATALOG_SELLING_UNIT_REGISTRY_RECORDED",
        targetType: "CatalogSellingUnitRegistry",
        targetId: value.registry.registryReference,
        reasonCode: value.reasonCode,
        correlationId: id(1010),
        occurredAt: value.occurredAt,
        sourceChannel: "INTERNAL_TEST",
        dataClassification: "Internal",
        retentionPolicyCode: "AUDIT",
        retentionPolicyVersion: 1,
      }),
    },
    transactions: {
      async run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
        const saved = [...state.records],
          savedFences = [...state.fences],
          tx = state.reuseTx ?? { query };
        state.lastTx = tx;
        state.commitGuards = [];
        state.finalAssertions = [];
        try {
          let value: T;
          try {
            value = await work(tx);
          } catch (error) {
            if (!state.swallowWorkError) throw error;
            state.swallowedWorkErrors++;
            value = undefined as T;
          }
          if (state.doubleRunner) {
            try {
              await work(tx);
            } catch {
              /* adversarial runner swallows callback refusal */
            }
          }
          state.afterWork?.(tx);
          for (const guard of state.commitGuards) await guard();
          for (const finalAssert of state.finalAssertions) finalAssert();
          state.outerCommitted = true;
          state.afterRunner?.();
          return state.replaceResult ? (Object.freeze({}) as T) : value;
        } catch (error) {
          state.records = saved;
          state.fences = savedFences;
          throw error;
        }
      },
    },
  };
  return { state, options, store: createPostgresSellingUnitRegistryStore(options) };
}
beforeEach(() => {
  append.audit.mockReset();
  append.event.mockReset();
});

it("reads actual complete registry under shared lock with current source authority", async () => {
  const h = harness();
  const source = await h.store.withCurrentRegistry(observation(), async (value, tx) => {
    expect(tx).toBe(h.state.lastTx);
    return value;
  });
  expect(source.registry.units[0]?.code).toBe("SYNTHETIC");
  expect(source.sourceAuthority).toBe("CurrentTransactionHeld");
  expect(
    h.state.holds.every(
      (v) =>
        v.action === "catalog.manage" &&
        JSON.stringify(v.requiredFields) === JSON.stringify(sellingUnitRegistryFields),
    ),
  ).toBe(true);
  expect(h.state.statements.some((sql) => sql.includes("pg_advisory_xact_lock_shared"))).toBe(true);
});
it("records original command with Audit/Outbox and replays without manufacturing a new snapshot", async () => {
  const h = harness(false);
  const first = await h.store.execute(command());
  expect(first.status).toBe("Applied");
  expect(append.audit).toHaveBeenCalledTimes(1);
  expect(append.event).toHaveBeenCalledTimes(1);
  h.state.assignedUnits = ["SYNTHETIC"];
  const original = await h.store.execute(command());
  expect(original.status).toBe("Replayed");
  expect(original.registry).toEqual(first.registry);
  expect(append.audit).toHaveBeenCalledTimes(1);
  expect(append.event).toHaveBeenCalledTimes(1);
});
it("refuses initial registration over real pre-existing SKU assignment facts", async () => {
  const h = harness(false);
  h.state.assignedUnits = ["SYNTHETIC"];
  await expect(h.store.execute(command())).rejects.toMatchObject({
    code: "CATALOG_LIFECYCLE_CONFLICT",
  });
  expect(h.state.records).toHaveLength(0);
  expect(append.audit).not.toHaveBeenCalled();
});
it("allows versioned display updates but prevents semantic or precision mutation of assigned units", async () => {
  const h = harness();
  h.state.assignedUnits = ["SYNTHETIC"];
  const next = {
    ...command(),
    operationReference: id(7),
    expectedRegistryVersion: 1,
    registry: {
      ...command().registry,
      versionReference: id(8),
      registryVersion: 2,
      previousSnapshotDigest: catalogSellingUnitRegistryDigest(command().registry),
      units: command().registry.units.map((u) => ({ ...u, semanticDefinition: "Changed meaning" })),
    },
  };
  await expect(h.store.execute(next)).rejects.toMatchObject({ code: "CATALOG_LIFECYCLE_CONFLICT" });
  next.registry.units = command().registry.units.map((u) => ({
    ...u,
    localizedNames: { "en-CA": "Changed display" },
  }));
  expect((await h.store.execute(next)).status).toBe("Applied");
});
it("original operation intent and expected registry version remain separate conflicts", async () => {
  const h = harness();
  await expect(h.store.execute({ ...command(), reasonCode: "CHANGED" })).rejects.toMatchObject({
    code: "CATALOG_IDEMPOTENCY_CONFLICT",
  });
  await expect(h.store.execute({ ...command(), operationReference: id(20) })).rejects.toMatchObject(
    { code: "CATALOG_VERSION_CONFLICT" },
  );
});
it("refuses missing real registry without an invented EA default", async () => {
  const h = harness(false);
  await expect(h.store.withCurrentRegistry(observation(), async () => true)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it("allows System reads and rejects System registration before database work", async () => {
  const h = harness(true, "System");
  await h.store.withCurrentRegistry(observation(), async () => true);
  const before = h.state.statements.length;
  await expect(h.store.execute(command())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(h.state.statements).toHaveLength(before);
});
it("late current authority loss rolls back tentative registry persistence", async () => {
  const h = harness(false);
  h.state.afterWork = () => {
    h.state.denied = true;
  };
  await expect(h.store.execute(command())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(h.state.records).toHaveLength(0);
});
it("original source deadline is not renewed by a later asynchronous guard", async () => {
  const h = harness();
  h.state.afterWork = () => {
    h.state.at = time(5000);
  };
  await expect(h.store.withCurrentRegistry(observation(), async () => true)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it("query replacement and swallowed source failures cannot commit borrowed transaction", async () => {
  const h = harness();
  h.state.afterWork = (tx) => {
    tx.query = vi.fn() as Transaction["query"];
  };
  await expect(h.store.withCurrentRegistry(observation(), async () => true)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it("scope mismatch refuses registration without invoking owner transaction", async () => {
  const h = harness(false);
  const c = command();
  c.actorReference = id(55);
  await expect(h.store.execute(c)).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(h.state.statements).toHaveLength(0);
});

function candidate(unitCode = "SYNTHETIC", quantity = "1.25") {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(30),
    operationReference: id(31),
    purposeCode: "CATALOG_PRODUCT_CREATE" as const,
    ...observation(),
    aggregate: {
      productReference: id(30),
      brandReference: id(2),
      internalCode: "SYNTHETIC_PRODUCT",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      createdByActorReference: id(5),
      updatedAt: at,
      draft: {
        versionReference: id(32),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic product" },
        taxClassificationReference: null,
        createdAt: at,
        updatedAt: at,
        optionBindings: [],
        skus: [
          {
            skuReference: id(33),
            productReference: id(30),
            brandReference: id(2),
            skuCode: "SYNTHETIC_SKU",
            lifecycle: "Draft",
            localizedNames: { "en-CA": "Synthetic SKU" },
            variantSelections: [],
            unitOfSale: unitCode,
            unitQuantity: quantity,
            createdAt: at,
            createdByActorReference: id(5),
          },
        ],
      },
    },
  };
}
it("holds original complete SKU candidate and actual registry through outer COMMIT", async () => {
  const h = harness();
  const input = candidate();
  const source = await h.store.withRegisteredProductSkuQuantities(input, async (value, tx) => {
    expect(tx).toBe(h.state.lastTx);
    const sku = input.aggregate.draft.skus[0];
    if (sku === undefined) throw new Error("Missing fixture SKU");
    sku.unitOfSale = "MUTATED";
    return value;
  });
  expect(source.request.aggregate).toMatchObject({
    draft: { skus: [{ unitOfSale: "SYNTHETIC", unitQuantity: "1.25" }] },
  });
  expect(source.registry.registryVersion).toBe(1);
});
it.each([
  ["UNKNOWN", "1"],
  ["SYNTHETIC", "0"],
  ["SYNTHETIC", "1.234"],
])("refuses unknown or nonpositive or overprecision candidate %s/%s", async (code, quantity) => {
  const h = harness();
  await expect(
    h.store.withRegisteredProductSkuQuantities(candidate(code, quantity), async () => true),
  ).rejects.toMatchObject({
    code: quantity === "0" ? "CATALOG_INPUT_INVALID" : "CATALOG_LIFECYCLE_CONFLICT",
  });
});
it("candidate scope and Product mismatch are refused before source acquisition", async () => {
  const h = harness();
  const input = candidate();
  input.productReference = id(50);
  await expect(
    h.store.withRegisteredProductSkuQuantities(input, async () => true),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(h.state.statements).toHaveLength(0);
});

it("retains historically assigned unit meaning after an own Draft removed that SKU", async () => {
  const h = harness();
  h.state.historicalUnits = ["SYNTHETIC"];
  const next = {
    ...command(),
    operationReference: id(7),
    expectedRegistryVersion: 1,
    registry: {
      ...command().registry,
      versionReference: id(8),
      registryVersion: 2,
      previousSnapshotDigest: catalogSellingUnitRegistryDigest(command().registry),
      units: command().registry.units.map((u) => ({ ...u, quantityDecimalPlaces: 3 })),
    },
  };
  await expect(h.store.execute(next)).rejects.toMatchObject({ code: "CATALOG_LIFECYCLE_CONFLICT" });
});
it("missing immutable legacy operation snapshot refuses assignment provenance", async () => {
  const h = harness(false);
  h.state.invalidHistory = true;
  await expect(h.store.execute(command())).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(h.state.records).toHaveLength(0);
});

it("honest absent inspection holds complete actual current/history coverage", async () => {
  const h = harness(false);
  h.state.assignedUnits = ["SYNTHETIC"];
  h.state.historicalUnits = ["SYNTHETIC"];
  const source = await h.store.withCurrentInspection(observation(), async (value) => value);
  expect(source.presence).toBe("Absent");
  expect(source.registry).toBeNull();
  expect(source.assignments).toHaveLength(2);
  expect(source.assignments.map((item) => item.source).sort()).toEqual([
    "CurrentSku",
    "OperationSnapshot",
  ]);
  expect(source.assignments.every((item) => item.unitQuantity === "1.25")).toBe(true);
  expect(Object.isFrozen(source.assignments)).toBe(true);
  expect(source.historyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(
    h.state.holds.every(
      (input) =>
        input.mode === "Inspect" &&
        JSON.stringify(input.requiredPermissions) ===
          JSON.stringify([
            "catalog.manage",
            "catalog.product.read",
            "catalog.product.history.read",
            "catalog.sku.read",
          ]),
    ),
  ).toBe(true);
  const locks = h.state.statements.filter((sql) => sql.includes("pg_advisory_xact_lock_shared"));
  expect(locks).toHaveLength(2);
});
it("present inspection returns real definitions, not absent or guessed defaults", async () => {
  const h = harness();
  const source = await h.store.withCurrentInspection(observation(), async (value) => value);
  expect(source.presence).toBe("Present");
  expect(source.registry?.units[0]?.code).toBe("SYNTHETIC");
});
it("explicit initial semantic confirmation registers actual complete historical assignments", async () => {
  const h = harness(false);
  h.state.assignedUnits = ["SYNTHETIC"];
  h.state.historicalUnits = ["SYNTHETIC"];
  const source = await h.store.withCurrentInspection(observation(), async (value) => value),
    c = command();
  const bootstrapConfirmation = {
    profile: "CatalogSellingUnitBootstrapConfirmationV1",
    historyDigest: source.historyDigest,
    definitionsDigest: catalogSellingUnitDefinitionsDigest(c.registry),
    confirmations: [
      {
        unitCode: "SYNTHETIC",
        semanticDefinition: first(c.registry.units).semanticDefinition,
        confirmed: true,
      },
    ],
  };
  expect((await h.store.execute({ ...c, bootstrapConfirmation })).status).toBe("Applied");
  expect(h.state.records[0]?.command).toMatchObject({ bootstrapConfirmation });
  expect((await h.store.execute({ ...c, bootstrapConfirmation })).status).toBe("Replayed");
  expect(append.audit).toHaveBeenCalledOnce();
});
it("history mutation invalidates the explicit confirmation before first registration", async () => {
  const h = harness(false);
  h.state.assignedUnits = ["SYNTHETIC"];
  const source = await h.store.withCurrentInspection(observation(), async (value) => value),
    c = command();
  h.state.historicalUnits = ["SYNTHETIC"];
  await expect(
    h.store.execute({
      ...c,
      bootstrapConfirmation: {
        profile: "CatalogSellingUnitBootstrapConfirmationV1",
        historyDigest: source.historyDigest,
        definitionsDigest: catalogSellingUnitDefinitionsDigest(c.registry),
        confirmations: [
          {
            unitCode: "SYNTHETIC",
            semanticDefinition: first(c.registry.units).semanticDefinition,
            confirmed: true,
          },
        ],
      },
    }),
  ).rejects.toMatchObject({ code: "CATALOG_VERSION_CONFLICT" });
  expect(h.state.records).toHaveLength(0);
});
it("wrong precision cannot be confirmed into compatibility with actual historical quantities", async () => {
  const h = harness(false);
  h.state.historicalUnits = ["SYNTHETIC"];
  const source = await h.store.withCurrentInspection(observation(), async (value) => value),
    c = command();
  first(c.registry.units).quantityDecimalPlaces = 1;
  await expect(
    h.store.execute({
      ...c,
      bootstrapConfirmation: {
        profile: "CatalogSellingUnitBootstrapConfirmationV1",
        historyDigest: source.historyDigest,
        definitionsDigest: catalogSellingUnitDefinitionsDigest(c.registry),
        confirmations: [
          {
            unitCode: "SYNTHETIC",
            semanticDefinition: first(c.registry.units).semanticDefinition,
            confirmed: true,
          },
        ],
      },
    }),
  ).rejects.toMatchObject({ code: "CATALOG_LIFECYCLE_CONFLICT" });
  expect(h.state.records).toHaveLength(0);
});
it("missing source is unavailable and cannot be reclassified as proven registry absence", async () => {
  const h = harness(false);
  h.state.invalidHistory = true;
  await expect(
    h.store.withCurrentInspection(observation(), async () => true),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("absent inspection retains actual source authority until COMMIT", async () => {
  const h = harness(false);
  h.state.afterWork = () => {
    h.state.denied = true;
  };
  await expect(
    h.store.withCurrentInspection(observation(), async () => true),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});
it("registration preparation holds exclusive source locks and original identities for safe replay", async () => {
  const h = harness();
  const original = await h.store.withRegistrationOperation(
    { ...observation(), operationReference: id(6) },
    async (value, current, tx) => {
      expect(tx).toBe(h.state.lastTx);
      expect(current).toEqual(value?.registry);
      return value;
    },
  );
  expect(original?.occurredAt).toBe(at);
  expect(original?.registry.versionReference).toBe(id(4));
  expect(
    h.state.statements.filter((sql) => sql.includes("pg_advisory_xact_lock_shared")),
  ).toHaveLength(0);
  expect(
    h.state.statements.filter((sql) => sql.includes("pg_advisory_xact_lock(hash")),
  ).toHaveLength(3);
  expect(
    h.state.holds.every(
      (input) => JSON.stringify(input.requiredPermissions) === JSON.stringify(["catalog.manage"]),
    ),
  ).toBe(true);
});
it("preparation distinguishes a genuinely unrecorded operation under exclusive locks", async () => {
  const h = harness(false);
  await h.store.withRegistrationOperation(
    { ...observation(), operationReference: id(20) },
    async (original, current) => {
      expect(original).toBeNull();
      expect(current).toBeNull();
    },
  );
  expect(h.state.records).toHaveLength(0);
  expect(append.audit).not.toHaveBeenCalled();
});
it("original registration metadata is private to the actual original Actor", async () => {
  const h = harness();
  h.state.records = [row({ ...command(), actorReference: id(99) })];
  await expect(
    h.store.withRegistrationOperation(
      { ...observation(), operationReference: id(6) },
      async () => true,
    ),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});

function resolutionCommand(operationReference = id(6)) {
  return {
    profile: "CatalogSellingUnitRegistrationResolutionCommandV1",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(5),
    action: "Create",
    operationReference,
    expectedRegistryVersion: 0,
  };
}
it("absent registration resolution permanently fences the original operation with one Audit only", async () => {
  const h = harness(false),
    request = resolutionCommand();
  const resolution = await h.store.resolveRegistrationOperation(request);
  expect(resolution).toMatchObject({
    outcome: "Abandoned",
    registryReference: null,
    registryVersion: null,
    recordedAt: at,
  });
  expect(h.state.fences).toHaveLength(1);
  expect(append.audit).toHaveBeenCalledOnce();
  expect(append.event).not.toHaveBeenCalled();
  expect(await h.store.resolveRegistrationOperation(request)).toEqual(resolution);
  expect(append.audit).toHaveBeenCalledOnce();
  await expect(
    h.store.execute({ ...command(), reasonCode: "PRODUCT_CREATE_UNITS" }),
  ).rejects.toMatchObject({ code: "CATALOG_IDEMPOTENCY_CONFLICT" });
  expect(h.state.records).toHaveLength(0);
});
it("committed resolution consumes exact original Actor/action/version and clock without new artifacts", async () => {
  const h = harness(false);
  await h.store.execute({ ...command(), reasonCode: "PRODUCT_CREATE_UNITS" });
  const result = await h.store.resolveRegistrationOperation(resolutionCommand());
  expect(result).toMatchObject({
    outcome: "Committed",
    registryReference: id(3),
    versionReference: id(4),
    registryVersion: 1,
    recordedAt: at,
  });
  expect(h.state.fences).toHaveLength(0);
  expect(append.audit).toHaveBeenCalledOnce();
  expect(append.event).toHaveBeenCalledOnce();
  await expect(
    h.store.resolveRegistrationOperation({ ...resolutionCommand(), action: "ReplaceDraft" }),
  ).rejects.toMatchObject({ code: "CATALOG_IDEMPOTENCY_CONFLICT" });
  await expect(
    h.store.resolveRegistrationOperation({ ...resolutionCommand(), expectedRegistryVersion: 1 }),
  ).rejects.toMatchObject({ code: "CATALOG_IDEMPOTENCY_CONFLICT" });
  h.state.records = [
    row({ ...command(), reasonCode: "PRODUCT_CREATE_UNITS", actorReference: id(99) }),
  ];
  await expect(h.store.resolveRegistrationOperation(resolutionCommand())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
});
it("resolution denial or original lease expiry is not terminal absence", async () => {
  const h = harness(false);
  h.state.afterWork = () => {
    h.state.denied = true;
  };
  await expect(h.store.resolveRegistrationOperation(resolutionCommand())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(h.state.fences).toHaveLength(0);
  const expired = harness(false);
  expired.state.afterWork = () => {
    expired.state.at = time(5000);
  };
  await expect(
    expired.store.resolveRegistrationOperation(resolutionCommand()),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(expired.state.fences).toHaveLength(0);
});
