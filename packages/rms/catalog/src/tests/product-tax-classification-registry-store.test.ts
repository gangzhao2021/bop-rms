import { beforeEach, expect, it, vi } from "vitest";
import type { AppendAuditRecordInput } from "@bop/audit";
import { CatalogError } from "../contracts/product.js";
import {
  parseCatalogTaxClassificationRegistryCommand,
  catalogTaxClassificationRegistryRequest,
  catalogTaxClassificationRegistryEventId,
  catalogProductTaxClassificationRegistryDigest,
  taxClassificationRegistryFields,
} from "../contracts/product-tax-classification-registry.js";
import {
  createPostgresProductTaxClassificationRegistryStore,
  type ProductTaxClassificationRegistryStoreOptions,
} from "../infrastructure/persistence/product-tax-classification-registry-store.js";

const append = vi.hoisted(() => ({ audit: vi.fn(), event: vi.fn() }));
vi.mock("@bop/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: append.audit,
}));
vi.mock("@bop/eventing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/eventing")>()),
  appendEventInTransaction: append.event,
}));
type Options = ProductTaxClassificationRegistryStoreOptions;
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
    purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(5),
    actorKind: "User",
    operationReference: id(6),
    expectedRegistryVersion: 0,
    occurredAt: at,
    reasonCode: "SYNTHETIC",
    registry: {
      profile: "CatalogProductTaxClassificationRegistryV1",
      tenantReference: id(1),
      brandReference: id(2),
      registryReference: id(3),
      versionReference: id(4),
      registryVersion: 1,
      defaultLocale: "en-CA",
      previousSnapshotDigest: null as string | null,
      registeredAt: at,
      defaultClassificationReference: id(10) as string | null,
      definitions: [
        {
          classificationReference: id(10),
          code: "SYNTHETIC",
          localizedNames: { "en-CA": "Synthetic classification" },
          lifecycle: "Active",
        },
      ],
    },
  };
}
function row(value: unknown) {
  const parsed = parseCatalogTaxClassificationRegistryCommand(value);
  return {
    command: catalogTaxClassificationRegistryRequest(parsed),
    registry: parsed.registry,
    intent_digest: parsed.intentDigest,
    snapshot_digest: parsed.snapshotDigest,
    event_id: catalogTaxClassificationRegistryEventId(parsed),
    coherent: true,
  };
}
// Controlled SQL/authority transport here. The separately coordinated native
// acceptance covers PostgreSQL, RLS, real Audit/Outbox and actual write rollback.
function harness(seed = true, kind: "User" | "System" = "User") {
  const state = {
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
    else if (sql.startsWith("SELECT count(*)::text"))
      result = {
        rows: [{ n: String(state.records.length), bytes: String(state.records.length * 2048) }],
      };
    else if (sql.startsWith("SELECT command_json"))
      result = {
        rows:
          values.length === 3
            ? state.records.filter((r) => r.command.operationReference === values[2])
            : state.records,
      };
    else if (sql.startsWith("SELECT (octet_length")) result = { rows: [{ bytes: "2048" }] };
    else if (sql.startsWith("INSERT INTO rms_catalog.product_tax_classification_registry_record")) {
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
      create: (value): AppendAuditRecordInput => ({
        auditId: id(100 + value.registry.registryVersion),
        brandId: id(2),
        actor: { type: "User", reference: id(5) },
        actionCode: "CATALOG_TAX_CLASSIFICATION_REGISTRY_RECORDED",
        targetType: "CatalogTaxClassificationRegistry",
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
          throw error;
        }
      },
    },
  };
  return { state, options, store: createPostgresProductTaxClassificationRegistryStore(options) };
}
beforeEach(() => {
  append.audit.mockReset();
  append.event.mockReset();
});

it("reads the actual complete registry and resolves only its declared classification/default", async () => {
  const h = harness();
  const resolved = await h.store.withCurrentResolution(
    { ...observation(), classificationReference: null },
    async (value, tx) => {
      expect(tx).toBe(h.state.lastTx);
      return value;
    },
  );
  expect(resolved).toMatchObject({
    selection: "BrandDefault",
    classificationReference: id(10),
    check: { outcome: "Pass" },
    request: { ...observation(), classificationReference: null },
  });
  expect(h.state.holds).toHaveLength(4);
  expect(
    h.state.holds.every(
      (v) =>
        v.action === "catalog.tax-classification.read" &&
        v.mode === "Read" &&
        JSON.stringify(v.requiredFields) === JSON.stringify(taxClassificationRegistryFields),
    ),
  ).toBe(true);
  expect(h.state.statements.some((sql) => sql.includes("pg_advisory_xact_lock_shared"))).toBe(true);
});
it("allows System reads while refusing System writes before a transaction", async () => {
  const h = harness(true, "System");
  await h.store.withCurrentRegistry(observation(), async () => true);
  const count = h.state.statements.length;
  await expect(h.store.execute(command())).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(h.state.statements).toHaveLength(count);
});
it("records the actual command, audit and minimal event, then returns immutable original replay", async () => {
  const h = harness(false),
    original = command();
  const applied = await h.store.execute(original);
  expect(applied.status).toBe("Applied");
  expect(h.state.records).toHaveLength(1);
  expect(append.audit).toHaveBeenCalledTimes(1);
  expect(append.event).toHaveBeenCalledTimes(1);
  expect(append.event.mock.calls[0]?.[1]).toMatchObject({
    eventType: "ProductTaxClassificationRegistryVersionRecorded",
    payload: { snapshotDigest: applied.snapshotDigest },
  });
  const next = {
    ...command(),
    operationReference: id(7),
    expectedRegistryVersion: 1,
    occurredAt: time(1),
    registry: {
      ...command().registry,
      versionReference: id(8),
      registryVersion: 2,
      registeredAt: time(1),
      previousSnapshotDigest: applied.snapshotDigest,
      defaultClassificationReference: null,
    },
  };
  h.state.at = time(1);
  await h.store.execute(next);
  h.state.at = time(86400000);
  const replayed = await h.store.execute(original);
  expect(replayed).toEqual({ ...applied, status: "Replayed" });
  expect(h.state.records).toHaveLength(2);
  expect(append.audit).toHaveBeenCalledTimes(2);
  expect(append.event).toHaveBeenCalledTimes(2);
  expect(h.state.holds.at(-1)?.mode).toBe("Replay");
});
it("keeps exact original intent and expected-version CAS distinct", async () => {
  const h = harness();
  await expect(h.store.execute({ ...command(), reasonCode: "CHANGED" })).rejects.toMatchObject({
    code: "CATALOG_IDEMPOTENCY_CONFLICT",
  });
  await expect(h.store.execute({ ...command(), operationReference: id(99) })).rejects.toMatchObject(
    { code: "CATALOG_VERSION_CONFLICT" },
  );
  expect(h.state.records).toHaveLength(1);
  expect(append.audit).not.toHaveBeenCalled();
});
it("keeps nine accepted 1000-definition revisions readable within the full history budget", async () => {
  const h = harness(false),
    definitions = Array.from({ length: 1000 }, (_, index) => ({
      classificationReference: id(10000 + index),
      code: "CLASS_" + index,
      localizedNames: { "en-CA": "Class " + index },
      lifecycle: "Active",
    }));
  let previousSnapshotDigest: string | null = null;
  for (let version = 1; version <= 9; version++) {
    const applied = await h.store.execute({
      ...command(),
      operationReference: id(2000 + version),
      expectedRegistryVersion: version - 1,
      registry: {
        ...command().registry,
        versionReference: id(3000 + version),
        registryVersion: version,
        defaultClassificationReference: null,
        previousSnapshotDigest,
        definitions,
      },
    });
    previousSnapshotDigest = applied.snapshotDigest;
  }
  expect(h.state.records).toHaveLength(9);
  expect(
    h.state.records.reduce(
      (total, record) =>
        total +
        Buffer.byteLength(JSON.stringify(record.command)) +
        Buffer.byteLength(JSON.stringify(record.registry)),
      0,
    ),
  ).toBeLessThan(8388608);
  const current = await h.store.withCurrentRegistry(observation(), async (source) => source);
  expect(current.registry.registryVersion).toBe(9);
  expect(current.registry.definitions).toHaveLength(1000);
  expect(current.snapshotDigest).toBe(previousSnapshotDigest);
});
it("reads and replays an accepted large localized snapshot without merging duplicate payload budgets", async () => {
  const h = harness(false),
    localizedNames = {
      "en-CA": "C",
      ...Object.fromEntries(
        Array.from({ length: 60 }, (_, index) => [
          String.fromCharCode(97 + Math.floor(index / 26), 97 + (index % 26)),
          "C",
        ]),
      ),
    },
    original = {
      ...command(),
      registry: {
        ...command().registry,
        defaultClassificationReference: null,
        definitions: Array.from({ length: 1000 }, (_, index) => ({
          classificationReference: id(10000 + index),
          code: "CLASS_" + index,
          localizedNames,
          lifecycle: "Active",
        })),
      },
    };
  expect(Buffer.byteLength(JSON.stringify(original.registry))).toBeLessThan(1048576);
  const applied = await h.store.execute(original),
    current = await h.store.withCurrentRegistry(observation(), async (source) => source);
  expect(current.registry).toEqual(applied.registry);
  expect(current.snapshotDigest).toBe(applied.snapshotDigest);
  h.state.at = time(86400000);
  await expect(h.store.execute(original)).resolves.toEqual({ ...applied, status: "Replayed" });
  expect(h.state.records).toHaveLength(1);
  expect(append.audit).toHaveBeenCalledOnce();
  expect(append.event).toHaveBeenCalledOnce();
});
it.each(["extra", "accessor"])("rejects unsafe persisted row wrappers: %s", async (fault) => {
  const h = harness(),
    record = h.state.records[0],
    getter = vi.fn(() => digest),
    consumer = vi.fn();
  if (record === undefined) throw new Error("Missing fixture registry record");
  if (fault === "extra") Object.assign(record, { assertedRegistered: true });
  else Object.defineProperty(record, "snapshot_digest", { enumerable: true, get: getter });
  await expect(h.store.withCurrentRegistry(observation(), consumer)).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(consumer).not.toHaveBeenCalled();
});
it.each(["missing", "coherence", "digest", "gap", "foreign"])(
  "refuses absent or incomplete current evidence: %s",
  async (fault) => {
    const h = harness(fault !== "missing");
    const firstRecord = h.state.records[0];
    if (fault !== "missing" && firstRecord === undefined)
      throw new Error("Missing fixture registry record");
    if (fault === "coherence" && firstRecord !== undefined) firstRecord.coherent = false;
    if (fault === "digest" && firstRecord !== undefined) firstRecord.snapshot_digest = digest;
    if (fault === "foreign" && firstRecord !== undefined)
      firstRecord.registry = { ...firstRecord.registry, tenantReference: id(99) };
    if (fault === "gap")
      h.state.records = [
        row({
          ...command(),
          expectedRegistryVersion: 1,
          registry: { ...command().registry, registryVersion: 2, previousSnapshotDigest: digest },
        }),
      ];
    const consumer = vi.fn();
    await expect(h.store.withCurrentRegistry(observation(), consumer)).rejects.toThrow();
    expect(consumer).not.toHaveBeenCalled();
  },
);
it("returns a real missing-default HardError, without upgrading known absence to dependency failure", async () => {
  const h = harness();
  h.state.records = [
    row({
      ...command(),
      registry: { ...command().registry, defaultClassificationReference: null },
    }),
  ];
  const result = await h.store.withCurrentResolution(
    { ...observation(), classificationReference: null },
    async (value) => value,
  );
  expect(result).toMatchObject({ reason: "DefaultMissing", check: { outcome: "HardError" } });
});
it.each(["expiry", "denial", "rollback", "query"])(
  "checks the original source lease after consumer return before COMMIT: %s",
  async (fault) => {
    const h = harness();
    let returned = false;
    h.state.afterWork = (tx) => {
      if (fault === "expiry") h.state.at = time(1000);
      if (fault === "denial") h.state.denied = true;
      if (fault === "rollback") h.state.at = time(1);
      if (fault === "query") tx.query = vi.fn();
    };
    await expect(
      h.store.withCurrentRegistry(observation(1000), async () => {
        h.state.at = time(2);
        returned = true;
        return "tentative";
      }),
    ).rejects.toMatchObject({
      code: fault === "denial" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(returned).toBe(true);
  },
);
it("checks a clock advance then partial rollback within the holder, not just the original lower bound", async () => {
  const h = harness();
  h.state.afterHold = () => {
    h.state.at = time(h.state.holdCount === 1 ? 2 : 1);
  };
  const consumer = vi.fn();
  await expect(h.store.withCurrentRegistry(observation(), consumer)).rejects.toThrow();
  expect(consumer).not.toHaveBeenCalled();
});
it("refuses COMMIT when a later async guard exhausts the earlier source's original lease", async () => {
  const h = harness(),
    laterGuard = vi.fn(async () => {
      expect(h.state.holds).toHaveLength(4);
      h.state.at = time(1000);
    }),
    laterFinalAssert = vi.fn();
  let returned = false;
  await expect(
    h.store.withCurrentRegistry(observation(1000), async (_source, tx) => {
      await h.options.registerBeforeCommit(tx, laterGuard, laterFinalAssert);
      returned = true;
      return "tentative";
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(returned).toBe(true);
  expect(laterGuard).toHaveBeenCalledOnce();
  expect(h.state.commitGuards).toHaveLength(2);
  expect(h.state.finalAssertions).toHaveLength(2);
  expect(laterFinalAssert).not.toHaveBeenCalled();
  expect(h.state.outerCommitted).toBe(false);
});
it.each(["clock", "expired", "doubleRunner", "runnerResult", "afterRunner"])(
  "rejects invalid acquisition completion: %s",
  async (fault) => {
    const h = harness();
    if (fault === "clock") h.state.at = "malformed";
    if (fault === "expired") h.state.at = time(5000);
    if (fault === "doubleRunner") h.state.doubleRunner = true;
    if (fault === "runnerResult") h.state.replaceResult = true;
    if (fault === "afterRunner")
      h.state.afterRunner = () => {
        h.state.at = time(5000);
      };
    await expect(
      h.store.withCurrentRegistry(observation(), async () => "value"),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it.each(["lateWriteExpiry", "lateWriteDenial", "outbox"])(
  "rolls back a tentative registry write: %s",
  async (fault) => {
    const h = harness(false);
    if (fault === "lateWriteExpiry")
      h.state.afterWork = () => {
        h.state.at = time(30000);
      };
    if (fault === "lateWriteDenial")
      h.state.afterWork = () => {
        h.state.denied = true;
      };
    if (fault === "outbox")
      append.event.mockRejectedValueOnce(new Error("synthetic outbox refusal"));
    await expect(h.store.execute(command())).rejects.toThrow();
    expect(h.state.records).toHaveLength(0);
  },
);
it("captures configured methods and rejects missing mandatory before-COMMIT integration", async () => {
  const h = harness();
  h.options.clock.now = () => {
    throw new Error("replaced clock");
  };
  h.options.authority.holdUntilTransactionCompletes = vi
    .fn()
    .mockRejectedValue(new Error("replaced holder"));
  await expect(h.store.withCurrentRegistry(observation(), async () => true)).resolves.toBe(true);
  expect(() =>
    createPostgresProductTaxClassificationRegistryStore({
      ...h.options,
      registerBeforeCommit: undefined,
    } as unknown as Options),
  ).toThrow();
});
it("does not reuse a poisoned transaction after a swallowed source failure", async () => {
  const h = harness();
  await h.store.withCurrentRegistry(observation(), async () => true);
  h.state.reuseTx = h.state.lastTx;
  h.state.denied = true;
  await expect(h.store.withCurrentRegistry(observation(), async () => true)).rejects.toThrow();
  h.state.denied = false;
  await expect(h.store.withCurrentRegistry(observation(), async () => true)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it.each(["missing", "initialDenial", "corruptHistory"])(
  "prevents outer COMMIT after an early source refusal is swallowed: %s",
  async (fault) => {
    const h = harness(fault !== "missing"),
      consumer = vi.fn(),
      afterWork = vi.fn();
    h.state.swallowWorkError = true;
    h.state.afterWork = afterWork;
    if (fault === "initialDenial") h.state.denied = true;
    if (fault === "corruptHistory") {
      const record = h.state.records[0];
      if (record === undefined) throw new Error("Missing fixture registry record");
      record.coherent = false;
    }
    await expect(h.store.withCurrentRegistry(observation(), consumer)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(h.state.swallowedWorkErrors).toBe(1);
    expect(afterWork).toHaveBeenCalledOnce();
    expect(consumer).not.toHaveBeenCalled();
    expect(h.state.commitGuards).toHaveLength(1);
    expect(h.state.outerCommitted).toBe(false);
  },
);
it("binds the original explicit/default request rather than any asserted registered flag", async () => {
  const h = harness();
  const input = { ...observation(), classificationReference: id(10), assertedRegistered: true };
  await expect(h.store.withCurrentResolution(input, async (value) => value)).rejects.toThrow();
  expect(h.state.statements).toHaveLength(0);
  expect(catalogProductTaxClassificationRegistryDigest(command().registry)).toBe(
    row(command()).snapshot_digest,
  );
});
it("poisons the outer borrowed transaction after a caught nested registry acquisition", async () => {
  const h = harness(),
    tx = await h.options.transactions.run(async (actual) => actual),
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [];
  let outerConsumers = 0,
    innerConsumers = 0,
    commitAttempts = 0,
    commits = 0,
    innerError: unknown,
    outerError: unknown;
  const store = createPostgresProductTaxClassificationRegistryStore({
    ...h.options,
    transactions: { run: async <T>(work: (actual: Transaction) => Promise<T>) => work(tx) },
    async registerBeforeCommit(actual, guard, finalAssert) {
      expect(actual).toBe(tx);
      guards.push(guard);
      finals.push(finalAssert);
    },
  });
  await expect(
    (async () => {
      try {
        await store.withCurrentRegistry(observation(), async () => {
          outerConsumers++;
          try {
            await store.withCurrentRegistry(observation(), async () => {
              innerConsumers++;
              return "inner";
            });
          } catch (error) {
            innerError = error;
          }
          return "outer tentative";
        });
      } catch (error) {
        outerError = error;
      }
      commitAttempts++;
      for (const guard of guards) await guard();
      for (const finalAssert of finals) finalAssert();
      commits++;
    })(),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(innerError).toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(outerError).toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(outerConsumers).toBe(1);
  expect(innerConsumers).toBe(0);
  expect(guards).toHaveLength(1);
  expect(commitAttempts).toBe(1);
  expect(commits).toBe(0);
});
